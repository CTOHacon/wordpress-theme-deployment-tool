import type { SSHFileInfo, SSHClient } from "./SSHClient";
import type { FileInfo } from "./FileCollector";
import { FileCollector } from "./FileCollector";
import path from "path";
import { minimatch } from "minimatch";
import { normalizePath } from "../utils/PathUtils";
import { DeploymentConfigService } from "../config/DeploymentConfig";
import type { Config } from "../config/ConfigService";
import Logger from "../utils/Logger";

// Modification-time tolerance (sec): unzip restores mtime with DOS-time precision (2s),
// so without tolerance some files would look "newer" and be re-uploaded on every deploy.
const MTIME_TOLERANCE_SECONDS = 2;

enum Operation {
    UPLOAD = "UPLOAD",
    UPDATE = "UPDATE",
    DELETE = "DELETE",
    ERROR = "ERROR"
}

export interface SyncResult {
    added: number;
    updated: number;
    deleted: number;
}

export class Deployer {
    /**
     * Syncs the local build to the remote directory.
     * Deletes stale files, deploys via ZIP, then runs additional commands.
     *
     * @param sshClient Active SSHClient instance
     * @param localFiles Array of local files from FileCollector
     * @param remoteFiles Array of files from the server via SSHClient
     * @param remoteThemePath Root theme path on the server
     * @param excludePatterns Array of glob patterns to exclude files/folders
     * @param config Main configuration from config.json
     * @returns Statistics of completed operations
     */
    public static async syncToRemote(
        sshClient: SSHClient,
        localFiles: FileInfo[],
        remoteFiles: SSHFileInfo[],
        remoteThemePath: string,
        excludePatterns: string[],
        config: Config
    ): Promise<SyncResult> {
        const result: SyncResult = { added: 0, updated: 0, deleted: 0 };

        const localFileMap = this.createLocalFileMap(localFiles);
        const remoteFileMap = this.createRemoteFileMap(remoteFiles);

        // Incremental deploy: upload only new/changed files.
        // Compared by size and modification time against what is already on the server.
        const changedFiles = this.selectChangedFiles(localFiles, remoteFileMap, remoteThemePath);
        Logger.info(`To upload: ${changedFiles.length} of ${localFiles.length} files (new/changed)`);

        if (changedFiles.length > 0) {
            // Build the output dir from changed files only
            await FileCollector.copyFilesToOutput(changedFiles, ".output");
            result.added = changedFiles.length;

            // Check unzip availability on server and choose deploy method
            Logger.info("Checking unzip command availability on server...");
            const hasUnzip = await sshClient.checkUnzipAvailable();

            if (hasUnzip) {
                Logger.success("unzip command available, using ZIP deploy method");
                await this.deployUsingZip(sshClient, ".output", remoteThemePath);
            } else {
                Logger.warn("unzip command unavailable, using direct SFTP upload");
                await this.deployUsingSFTP(sshClient, ".output", remoteThemePath);
            }
        } else {
            Logger.info("No changed files — upload skipped");
        }

        // Delete files not present in the local build
        await this.deleteUnneededRemoteFiles(
            sshClient,
            remoteFileMap,
            localFileMap,
            remoteThemePath,
            excludePatterns,
            result
        );

        // Run additional commands (e.g. Composer install)
        const deploymentConfig = DeploymentConfigService.getDeploymentConfig(config);
        if (deploymentConfig.steps && deploymentConfig.steps.composerInstall) {
            const cmd = deploymentConfig.steps.composerInstall.replace("{remote_theme_path}", remoteThemePath);
            Logger.info(`Running deploy command: ${cmd}`);
            await sshClient.executeCommand(cmd);
        }

        return result;
    }

    /**
     * Selects local files that need uploading: missing on the server,
     * differing in size, or locally newer (within MTIME_TOLERANCE_SECONDS).
     * If there is no server data (e.g. --skip-compair) — all are treated as changed.
     */
    private static selectChangedFiles(
        localFiles: FileInfo[],
        remoteFileMap: Map<string, SSHFileInfo>,
        remoteThemePath: string
    ): FileInfo[] {
        const normalizedBase = normalizePath(remoteThemePath);
        return localFiles.filter((file) => {
            const remoteKey = normalizePath(path.join(normalizedBase, file.relativePath));
            const remote = remoteFileMap.get(remoteKey);
            if (!remote) {
                return true;
            }
            if (remote.attrs.size !== file.size) {
                return true;
            }
            const localSeconds = Math.floor(file.updateTime.getTime() / 1000);
            const remoteSeconds = Math.floor(remote.attrs.mtime);
            return localSeconds - remoteSeconds > MTIME_TOLERANCE_SECONDS;
        });
    }

    private static createLocalFileMap(localFiles: FileInfo[]): Map<string, FileInfo> {
        const map = new Map<string, FileInfo>();
        for (const file of localFiles) {
            map.set(file.relativePath, file);
        }
        return map;
    }

    private static createRemoteFileMap(remoteFiles: SSHFileInfo[]): Map<string, SSHFileInfo> {
        const map = new Map<string, SSHFileInfo>();
        for (const file of remoteFiles) {
            map.set(file.fullPath, file);
        }
        return map;
    }

    private static async deleteUnneededRemoteFiles(
        sshClient: SSHClient,
        remoteFileMap: Map<string, SSHFileInfo>,
        localFileMap: Map<string, FileInfo>,
        remoteThemePath: string,
        excludePatterns: string[],
        result: SyncResult
    ): Promise<void> {
        const deletedDirs: string[] = [];
        for (const [fullPath, remoteFile] of remoteFileMap.entries()) {
            if (this.isInDeletedDirectory(fullPath, deletedDirs)) {
                remoteFileMap.delete(fullPath);
                continue;
            }
            if (this.matchesExcludePattern(fullPath, excludePatterns)) {
                continue;
            }
            if (!this.isFileInLocalMap(fullPath, localFileMap, remoteThemePath)) {
                await this.deleteRemoteEntry(sshClient, remoteFile, remoteThemePath, remoteFileMap, deletedDirs, result);
            }
        }
    }

    private static isInDeletedDirectory(fullPath: string, deletedDirs: string[]): boolean {
        return deletedDirs.some((dir) => fullPath.startsWith(dir + '/'));
    }

    private static matchesExcludePattern(fullPath: string, excludePatterns: string[]): boolean {
        return excludePatterns.some((pattern) => minimatch(fullPath, pattern));
    }

    private static isFileInLocalMap(
        remotePath: string,
        localMap: Map<string, FileInfo>,
        remoteThemePath: string
    ): boolean {
        const relativePath = remotePath.replace(remoteThemePath, '').replace(/^\//, '');
        if (localMap.has(relativePath)) {
            return true;
        }
        // If directory (no extension), check if any file exists inside
        if (!path.extname(relativePath)) {
            for (const key of localMap.keys()) {
                if (key.startsWith(relativePath + '/')) {
                    return true;
                }
            }
        }
        return false;
    }

    private static async deleteRemoteEntry(
        sshClient: SSHClient,
        remoteFile: SSHFileInfo,
        remoteThemePath: string,
        remoteFileMap: Map<string, SSHFileInfo>,
        deletedDirs: string[],
        result: SyncResult
    ): Promise<void> {
        const relativePath = remoteFile.fullPath.replace(remoteThemePath, '');
        try {
            if (this.isDirectory(remoteFile)) {
                await sshClient.deleteRemoteDirectory(remoteFile.fullPath);
                Logger.log(Operation.DELETE, relativePath);
                deletedDirs.push(remoteFile.fullPath);
                this.removeChildrenFromMap(remoteFile.fullPath, remoteFileMap);
            } else {
                await sshClient.deleteRemoteFile(remoteFile.fullPath);
                Logger.log(Operation.DELETE, relativePath);
            }
            remoteFileMap.delete(remoteFile.fullPath);
            result.deleted++;
        } catch (error) {
            Logger.log(Operation.ERROR, `${relativePath}: ${error}`);
        }
    }

    private static removeChildrenFromMap(parentPath: string, fileMap: Map<string, SSHFileInfo>): void {
        for (const key of Array.from(fileMap.keys())) {
            if (key.startsWith(parentPath + '/')) {
                fileMap.delete(key);
            }
        }
    }

    /**
     * Deploy build via ZIP archive (faster for large file sets).
     * Creates a ZIP archive, uploads it to the server, extracts and deletes it.
     */
    private static async deployUsingZip(sshClient: SSHClient, localFolderPath: string, remoteDestPath: string): Promise<void> {
        Logger.info("Starting ZIP deploy...");
        await sshClient.uploadFolderAsZip(localFolderPath, remoteDestPath);
        Logger.log(Operation.UPLOAD, "ZIP deploy completed successfully");
    }

    /**
     * Deploy build directly via SFTP (without ZIP or shell commands).
     * Uploads only changed or new files.
     */
    private static async deployUsingSFTP(sshClient: SSHClient, localFolderPath: string, remoteDestPath: string): Promise<void> {
        Logger.info("Starting SFTP deploy (direct file upload)...");
        const result = await sshClient.uploadFolderViaSFTP(localFolderPath, remoteDestPath);
        Logger.log(Operation.UPLOAD, `SFTP deploy complete: ${result.uploaded} uploaded, ${result.skipped} skipped (unchanged)`);
    }

    /**
     * Determines whether the given object is a directory.
     */
    private static isDirectory(remoteFile: SSHFileInfo): boolean {
        if (typeof remoteFile.attrs.isDirectory === "function") {
            return remoteFile.attrs.isDirectory();
        }
        return remoteFile.longname ? remoteFile.longname.startsWith("d") : false;
    }
}