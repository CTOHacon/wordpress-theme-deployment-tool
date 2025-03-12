import { SSHClient, type SSHFileInfo } from "./SSHClient";
import type { FileInfo } from "../filesystem/FileCollector";
import path from "path";
import { minimatch } from "minimatch";
import logBlock from "../utils/logBlock";

// Operation types for logging and tracking
enum Operation {
    UPLOAD = "UPLOAD",
    UPDATE = "UPDATE",
    DELETE = "DELETE",
    ERROR = "ERROR"
}

// Result interface to track sync statistics
interface SyncResult {
    added: number;
    updated: number;
    deleted: number;
}

export class Deployer {
    /**
     * Synchronizes local build files (.output) with the remote directory.
     * Files matching exclude patterns will be removed from the server.
     *
     * @param sshClient Active SSHClient instance
     * @param localFiles Array of local files collected by FileCollector (already filtered by exclude)
     * @param remoteFiles Array of remote files obtained through SSHClient
     * @param remoteThemePath Root theme path on the server
     * @param excludePatterns Array of glob patterns for file exclusion
     * @returns Statistics of performed operations: added, updated, deleted
     */
    public static async syncToRemote(
        sshClient: SSHClient,
        localFiles: FileInfo[],
        remoteFiles: SSHFileInfo[],
        remoteThemePath: string,
        excludePatterns: string[]
    ): Promise<SyncResult> {
        const result: SyncResult = { added: 0, updated: 0, deleted: 0 };

        const localFileMap = this.createLocalFileMap(localFiles);
        const remoteFileMap = this.createRemoteFileMap(remoteFiles);

        // Handle file deletion first
        await this.deleteUnneededRemoteFiles(
            sshClient,
            remoteFileMap,
            localFileMap,
            remoteThemePath,
            excludePatterns,
            result
        );

        await this.deployUsingZip(sshClient, '.output', remoteThemePath);

        return result;
    }

    private static createLocalFileMap(localFiles: FileInfo[]): Map<string, FileInfo> {
        const fileMap = new Map<string, FileInfo>();
        for (const file of localFiles) {
            fileMap.set(file.relativePath, file);
        }
        return fileMap;
    }

    private static createRemoteFileMap(remoteFiles: SSHFileInfo[]): Map<string, SSHFileInfo> {
        const fileMap = new Map<string, SSHFileInfo>();
        for (const file of remoteFiles) {
            fileMap.set(file.fullPath, file);
        }
        return fileMap;
    }

    private static async deleteUnneededRemoteFiles(
        sshClient: SSHClient,
        remoteFileMap: Map<string, SSHFileInfo>,
        localFileMap: Map<string, FileInfo>,
        remoteThemePath: string,
        excludePatterns: string[],
        result?: SyncResult
    ): Promise<void> {
        const deletedDirectories: string[] = [];
        const remoteEntries = Array.from(remoteFileMap.entries());

        for (const [fullPath, remoteFile] of remoteEntries) {
            // Skip files in already deleted directories
            if (this.isInDeletedDirectory(fullPath, deletedDirectories)) {
                remoteFileMap.delete(fullPath);
                continue;
            }

            // Skip files matching exclude patterns
            if (this.matchesExcludePattern(fullPath, excludePatterns)) {
                continue;
            }

            if (!this.isFileInLocalMap(fullPath, localFileMap, remoteThemePath)) {
                await this.deleteRemoteEntry(
                    sshClient,
                    remoteFile,
                    remoteThemePath,
                    remoteFileMap,
                    deletedDirectories,
                    result
                );
            }
        }
    }

    private static isInDeletedDirectory(fullPath: string, deletedDirectories: string[]): boolean {
        return deletedDirectories.some(dir => fullPath.startsWith(dir + '/'));
    }

    private static matchesExcludePattern(fullPath: string, excludePatterns: string[]): boolean {
        return excludePatterns.some(pattern =>
            typeof pattern === "string" && minimatch(fullPath, pattern)
        );
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

        // If no extension, it might be a directory - check if any local path starts with it
        if (!path.extname(relativePath)) {
            for (const localPath of localMap.keys()) {
                if (localPath.startsWith(relativePath + '/')) {
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
        deletedDirectories: string[],
        result?: SyncResult
    ): Promise<void> {
        const relativePath = remoteFile.fullPath.replace(remoteThemePath, '');
        if (!result) result = { added: 0, updated: 0, deleted: 0 };


        try {
            if (remoteFile.attrs.isDirectory()) {
                await sshClient.deleteRemoteDirectory(remoteFile.fullPath);
                logBlock(Operation.DELETE, relativePath);
                deletedDirectories.push(remoteFile.fullPath);

                this.removeChildrenFromMap(remoteFile.fullPath, remoteFileMap);
            } else {
                await sshClient.deleteRemoteFile(remoteFile.fullPath);
                logBlock(Operation.DELETE, relativePath);
            }

            remoteFileMap.delete(remoteFile.fullPath);
            result.deleted++;
        } catch (error) {
            logBlock(Operation.ERROR, `${relativePath}: ${error}`);
        }
    }

    private static removeChildrenFromMap(
        parentPath: string,
        fileMap: Map<string, SSHFileInfo>
    ): void {
        for (const mapPath of Array.from(fileMap.keys())) {
            if (mapPath.startsWith(parentPath + '/')) {
                fileMap.delete(mapPath);
            }
        }
    }

    private static async uploadLocalFiles(
        sshClient: SSHClient,
        localFileMap: Map<string, FileInfo>,
        remoteFileMap: Map<string, SSHFileInfo>,
        remoteThemePath: string,
        result: SyncResult
    ): Promise<void> {
        for (const [relativePath, localFile] of localFileMap.entries()) {
            const remoteFullPath = path.join(remoteThemePath, relativePath);
            const remoteFile = remoteFileMap.get(remoteFullPath);

            if (!remoteFile) {
                await this.addNewFile(
                    sshClient,
                    localFile,
                    remoteFullPath,
                    remoteThemePath,
                    result
                );
            } else {
                await this.updateExistingFileIfNewer(
                    sshClient,
                    localFile,
                    remoteFile,
                    remoteFullPath,
                    remoteThemePath,
                    result
                );
            }
        }
    }

    private static async addNewFile(
        sshClient: SSHClient,
        localFile: FileInfo,
        remoteFullPath: string,
        remoteThemePath: string,
        result: SyncResult
    ): Promise<void> {
        try {
            await sshClient.uploadFile(localFile.absolutePath, remoteFullPath, remoteThemePath);
            logBlock(Operation.UPLOAD, remoteFullPath.replace(remoteThemePath, ''));
            result.added++;
        } catch (error) {
            logBlock(Operation.ERROR, `${remoteFullPath}: ${error}`);
        }
    }

    private static async updateExistingFileIfNewer(
        sshClient: SSHClient,
        localFile: FileInfo,
        remoteFile: SSHFileInfo,
        remoteFullPath: string,
        remoteThemePath: string,
        result: SyncResult
    ): Promise<void> {
        const localTime = localFile.updateTime.getTime();
        const remoteTime = remoteFile.time.getTime();

        if (localTime > remoteTime) {
            try {
                await sshClient.uploadFile(localFile.absolutePath, remoteFullPath, remoteThemePath);
                logBlock(Operation.UPDATE, remoteFullPath.replace(remoteThemePath, ''));
                result.updated++;
            } catch (error) {
                logBlock(Operation.ERROR, `Error updating ${remoteFullPath}: ${error}`);
            }
        }
    }

    /**
     * Deploys a local folder to the remote server by zipping it,
     * uploading it, and extracting it on the server.
     *
     * @param sshClient Active SSHClient instance
     * @param localFolderPath Path to the local folder to deploy
     * @param remoteDestPath Path on the remote server where to extract
     * @returns Promise that resolves when the operation is complete
     * @throws Error if the deployment fails
     */
    public static async deployUsingZip(
        sshClient: SSHClient,
        localFolderPath: string,
        remoteDestPath: string
    ): Promise<void> {
        try {
            logBlock("INFO", `Deploying .output as zip`);
            await sshClient.uploadFolderAsZip(localFolderPath, remoteDestPath);
            logBlock("UPLOAD", "Deploy Completed successfully");
        } catch (error) {
            logBlock(Operation.ERROR, `INFO failed: ${error}`);
            throw error;
        }
    }
}