import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import fs from "fs";
import path from "path";
import { normalizePath } from "../utils/PathUtils";
import { minimatch } from "minimatch";

// Interface for describing a file on the remote server
export interface SSHFileInfo {
    filename: string;
    longname?: string; // Optional property
    fullPath: string;
    attrs: {
        mode: number;
        uid: number;
        gid: number;
        size: number;
        atime: number;
        mtime: number;
        isDirectory: () => boolean;
        isFile: () => boolean;
    };
    time: Date;
}

export class SSHClient {
    private client: Client;
    private sftp: SFTPWrapper | null = null;
    private preserveRemoteTimes: boolean = true;

    constructor() {
        this.client = new Client();
    }

    /**
     * Controls whether uploads set the remote file's mtime after transfer.
     * Disable when remote mtimes are not used for comparison (local snapshot
     * mode) — saves a round-trip per file and avoids warnings on servers
     * that reject setstat.
     */
    public setPreserveRemoteTimes(preserve: boolean): void {
        this.preserveRemoteTimes = preserve;
    }

    /**
     * Establishes an SSH connection and initializes an SFTP session.
     * If privateKey is provided, it is read from the file.
     */
    public async connect(config: ConnectConfig): Promise<void> {
        if (config.privateKey) {
            config.privateKey = fs.readFileSync(config.privateKey).toString();
        }

        return new Promise((resolve, reject) => {
            this.client
                .on("ready", () => {
                    this.client.sftp((err, sftp) => {
                        if (err) {
                            reject(new Error(`Failed to initialize SFTP session: ${err.message}`));
                        } else {
                            this.sftp = sftp;
                            resolve();
                        }
                    });
                })
                .on("error", (err) => {
                    reject(new Error(`SSH connection error: ${err.message}`));
                })
                .connect(config);
        });
    }

    /**
     * Closes the SSH connection.
     */
    public disconnect(): void {
        this.client.end();
    }

    /**
     * Returns a list of files and directories at the given path on the server.
     * @param remotePath Path on the server
     * @param recursive Recursive traversal (default false)
     * @param excludePatterns Array of glob patterns to exclude
     */
    public async listRemoteFiles(
        remotePath: string,
        recursive: boolean = false,
        excludePatterns: string[] = []
    ): Promise<SSHFileInfo[]> {
        this.ensureSftpSession();

        if (!recursive) {
            const entries = await this.readRemoteDirectory(remotePath);
            return this.filterEntriesByPatterns(entries, excludePatterns);
        }

        // Recursive listing via a single `find` command = one network round-trip.
        // The SFTP-walk fallback does one readdir per directory — hundreds of
        // serial round-trips, each paying full latency (the source of long hangs).
        try {
            const entries = await this.listRemoteFilesViaFind(remotePath);
            return this.filterRecursiveEntries(entries, excludePatterns);
        } catch (error) {
            let entries = await this.readRemoteDirectory(remotePath);
            entries = this.filterEntriesByPatterns(entries, excludePatterns);
            return await this.collectFilesRecursively(entries, excludePatterns);
        }
    }

    /**
     * Recursively lists files on the server with a single `find` command
     * (GNU find, `-printf`). Returns a flat list of entries.
     */
    private async listRemoteFilesViaFind(remotePath: string): Promise<SSHFileInfo[]> {
        const normalizedRoot = normalizePath(remotePath);
        const output = await this.executeCommand(
            `find "${normalizedRoot}" -mindepth 1 -printf '%y\\t%s\\t%T@\\t%p\\n'`
        );

        const entries: SSHFileInfo[] = [];
        for (const line of output.split("\n")) {
            if (!line) continue;
            const tab1 = line.indexOf("\t");
            const tab2 = line.indexOf("\t", tab1 + 1);
            const tab3 = line.indexOf("\t", tab2 + 1);
            if (tab1 < 0 || tab2 < 0 || tab3 < 0) continue;

            const type = line.slice(0, tab1);
            const size = parseInt(line.slice(tab1 + 1, tab2), 10) || 0;
            const mtime = Math.floor(parseFloat(line.slice(tab2 + 1, tab3)) || 0);
            const fullPath = normalizePath(line.slice(tab3 + 1));
            const isDir = type === "d";

            entries.push({
                filename: path.basename(fullPath),
                fullPath,
                attrs: {
                    mode: 0,
                    uid: 0,
                    gid: 0,
                    size,
                    atime: mtime,
                    mtime,
                    isDirectory: () => isDir,
                    isFile: () => type === "f",
                },
                time: new Date(mtime * 1000),
            });
        }
        return entries;
    }

    /**
     * Filters the flat recursive list: an excluded directory takes its whole
     * subtree with it — just as the old walk did not descend into excluded folders.
     */
    private filterRecursiveEntries(
        entries: SSHFileInfo[],
        excludePatterns: string[]
    ): SSHFileInfo[] {
        if (excludePatterns.length === 0) return entries;

        const isExcluded = (entry: SSHFileInfo): boolean =>
            excludePatterns.some((pattern) =>
                minimatch(entry.fullPath, pattern) || minimatch(entry.filename, pattern)
            );

        const excludedDirPrefixes = entries
            .filter((entry) => this.isDirectory(entry) && isExcluded(entry))
            .map((entry) => entry.fullPath + "/");

        return entries.filter((entry) => {
            if (isExcluded(entry)) return false;
            return !excludedDirPrefixes.some((prefix) => entry.fullPath.startsWith(prefix));
        });
    }

    /**
     * Reads the contents of a directory on the remote server.
     */
    private async readRemoteDirectory(remotePath: string): Promise<SSHFileInfo[]> {
        return new Promise((resolve, reject) => {
            this.sftp!.readdir(remotePath, (err, list) => {
                if (err) {
                    reject(new Error(`Failed to read directory ${remotePath}: ${err.message}`));
                } else {
                    const normalizedRemotePath = normalizePath(remotePath);
                    const files: SSHFileInfo[] = list.map((entry) => ({
                        ...entry,
                        fullPath: normalizePath(path.join(normalizedRemotePath, entry.filename)),
                        time: new Date(entry.attrs.mtime * 1000)
                    })) as SSHFileInfo[];
                    resolve(files);
                }
            });
        });
    }

    /**
     * Filters entries based on exclude patterns.
     */
    private filterEntriesByPatterns(
        entries: SSHFileInfo[],
        excludePatterns: string[]
    ): SSHFileInfo[] {
        return entries.filter((entry: SSHFileInfo) => {
            return !excludePatterns.some((pattern: string) =>
                minimatch(entry.fullPath, pattern) || minimatch(entry.filename, pattern)
            );
        });
    }

    /**
     * Recursively collects files from directories.
     */
    private async collectFilesRecursively(
        entries: SSHFileInfo[],
        excludePatterns: string[]
    ): Promise<SSHFileInfo[]> {
        let result: SSHFileInfo[] = [...entries];
        for (const entry of entries) {
            if (this.isDirectory(entry)) {
                const subEntries = await this.listRemoteFiles(entry.fullPath, true, excludePatterns);
                result.push(...subEntries);
            }
        }
        return result;
    }

    /**
     * Deletes a file on the server.
     */
    public async deleteRemoteFile(remoteFilePath: string): Promise<void> {
        this.ensureSftpSession();
        return new Promise((resolve, reject) => {
            this.sftp!.unlink(remoteFilePath, (err) => {
                if (err) {
                    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                        resolve();
                    } else {
                        reject(new Error(`Failed to delete file ${remoteFilePath}: ${err.message}`));
                    }
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Recursively deletes a directory on the server.
     */
    public async deleteRemoteDirectory(remoteDirectoryPath: string): Promise<void> {
        this.ensureSftpSession();
        if (!(await this.remotePathExists(remoteDirectoryPath))) {
            return;
        }
        const list = await this.readRemoteDirectory(remoteDirectoryPath);
        for (const item of list) {
            const itemPath = normalizePath(path.join(remoteDirectoryPath, item.filename));
            if (this.isDirectory(item)) {
                await this.deleteRemoteDirectory(itemPath);
            } else {
                await this.deleteRemoteFile(itemPath);
            }
        }
        return new Promise((resolve, reject) => {
            this.sftp!.rmdir(remoteDirectoryPath, (err) => {
                if (err) reject(new Error(`Failed to delete directory ${remoteDirectoryPath}: ${err.message}`));
                else resolve();
            });
        });
    }

    /**
     * Uploads a local file to the server, preserving the modification time.
     */
    public async uploadFile(
        localFilePath: string,
        remoteFilePath: string,
        remoteBasePath: string = ""
    ): Promise<void> {
        this.ensureSftpSession();
        const remoteDir = path.dirname(remoteFilePath);
        if (remoteDir) {
            await this.ensureRemoteDirectoryExists(remoteDir, remoteBasePath);
        }

        // Get local file modification time
        const localStats = await fs.promises.stat(localFilePath);
        const mtime = Math.floor(localStats.mtime.getTime() / 1000);

        return new Promise((resolve, reject) => {
            this.sftp!.fastPut(localFilePath, remoteFilePath, async (err) => {
                if (err) {
                    reject(new Error(`Failed to upload file to ${remoteFilePath}: ${err.message}`));
                } else if (!this.preserveRemoteTimes) {
                    resolve();
                } else {
                    // Preserve modification time on the remote file
                    this.sftp!.utimes(remoteFilePath, mtime, mtime, (utimesErr) => {
                        if (utimesErr) {
                            // Non-critical error, just log and continue
                            console.warn(`Warning: Could not set mtime for ${remoteFilePath}`);
                        }
                        resolve();
                    });
                }
            });
        });
    }

    /**
     * Gets file info on the server (modification time and size).
     * Returns null if the file does not exist.
     */
    public async getRemoteFileStat(remotePath: string): Promise<{ mtime: Date; size: number } | null> {
        this.ensureSftpSession();
        return new Promise((resolve) => {
            this.sftp!.stat(remotePath, (err, stats) => {
                if (err) {
                    resolve(null);
                } else {
                    resolve({
                        mtime: new Date(stats.mtime * 1000),
                        size: stats.size
                    });
                }
            });
        });
    }

    /**
     * Uploads files from a local folder to the server via SFTP.
     * Uploads only files that are missing on the server or have been modified.
     * Preserves file modification times to optimize subsequent deploys.
     */
    public async uploadFolderViaSFTP(
        localFolderPath: string,
        remoteFolderPath: string
    ): Promise<{ uploaded: number; skipped: number; total: number }> {
        this.ensureSftpSession();
        await this.ensureRemoteDirectoryExists(remoteFolderPath, "");

        const files = await this.collectLocalFiles(localFolderPath);
        let uploaded = 0;
        let skipped = 0;
        const total = files.length;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const remoteFilePath = normalizePath(path.join(remoteFolderPath, file.relativePath));

            // Get local file stats
            const localStats = await fs.promises.stat(file.absolutePath);
            const localMtime = Math.floor(localStats.mtime.getTime() / 1000);
            const localSize = localStats.size;

            // Get remote file stats (if exists)
            const remoteStat = await this.getRemoteFileStat(remoteFilePath);

            // Compare: upload if file doesn't exist, size differs, or local is newer
            const needsUpload = !remoteStat ||
                remoteStat.size !== localSize ||
                localMtime > Math.floor(remoteStat.mtime.getTime() / 1000);

            if (needsUpload) {
                await this.uploadFile(file.absolutePath, remoteFilePath, remoteFolderPath);
                uploaded++;
            } else {
                skipped++;
            }

            // Progress indicator
            const processed = i + 1;
            if (processed % 10 === 0 || processed === total) {
                process.stdout.write(`\r  Processing: ${processed}/${total} files (${uploaded} uploaded, ${skipped} skipped)`);
            }
        }
        console.log(); // New line after progress

        return { uploaded, skipped, total };
    }

    /**
     * Recursively collects local files from a directory.
     */
    private async collectLocalFiles(basePath: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
        const files: Array<{ absolutePath: string; relativePath: string }> = [];
        const absoluteBasePath = path.resolve(basePath);

        const traverse = async (currentPath: string): Promise<void> => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryAbsolutePath = path.join(currentPath, entry.name);
                const entryRelativePath = normalizePath(path.relative(absoluteBasePath, entryAbsolutePath));

                if (entry.isDirectory()) {
                    await traverse(entryAbsolutePath);
                } else if (entry.isFile()) {
                    files.push({
                        absolutePath: entryAbsolutePath,
                        relativePath: entryRelativePath,
                    });
                }
            }
        };

        await traverse(absoluteBasePath);
        return files;
    }

    /**
     * Downloads a single file from the server, creating local directories as needed.
     */
    public async downloadFile(remoteFilePath: string, localFilePath: string): Promise<void> {
        this.ensureSftpSession();
        await fs.promises.mkdir(path.dirname(localFilePath), { recursive: true });
        return new Promise((resolve, reject) => {
            this.sftp!.fastGet(remoteFilePath, localFilePath, (err) => {
                if (err) reject(new Error(`Failed to download file ${remoteFilePath}: ${err.message}`));
                else resolve();
            });
        });
    }

    /**
     * Recursively downloads a remote folder into a local directory via SFTP.
     * Mirror operation of uploadFolderViaSFTP — used for back sync.
     * @param skipDirs Directory names to skip (vcs, dependencies, etc.)
     */
    public async downloadFolderViaSFTP(
        remoteFolderPath: string,
        localFolderPath: string,
        skipDirs: string[] = []
    ): Promise<{ downloaded: number; total: number }> {
        this.ensureSftpSession();
        const skip = new Set(skipDirs);

        // First collect the full file list (without directories)
        const files: Array<{ remote: string; local: string }> = [];
        const collect = async (remoteDir: string, localDir: string): Promise<void> => {
            const entries = await this.readRemoteDirectory(remoteDir);
            for (const entry of entries) {
                const remotePath = normalizePath(path.join(remoteDir, entry.filename));
                const localPath = path.join(localDir, entry.filename);
                if (this.isDirectory(entry)) {
                    if (skip.has(entry.filename)) continue;
                    await collect(remotePath, localPath);
                } else {
                    files.push({ remote: remotePath, local: localPath });
                }
            }
        };
        await collect(remoteFolderPath, localFolderPath);

        let downloaded = 0;
        const total = files.length;
        for (const file of files) {
            await this.downloadFile(file.remote, file.local);
            downloaded++;
            if (downloaded % 10 === 0 || downloaded === total) {
                process.stdout.write(`\r  Downloading: ${downloaded}/${total} files`);
            }
        }
        console.log(); // New line after progress

        return { downloaded, total };
    }

    /**
     * Checks whether the unzip command is available on the server.
     */
    public async checkUnzipAvailable(): Promise<boolean> {
        try {
            const result = await this.executeCommand('which unzip');
            return result.trim().length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Executes a command on the remote server.
     */
    public async executeCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.client.exec(command, (err, stream) => {
                if (err) {
                    reject(new Error(`Failed to execute command: ${err.message}`));
                    return;
                }
                let output = "";
                let errorOutput = "";
                stream.on("data", (data: Buffer) => {
                    output += data.toString();
                });
                stream.stderr.on("data", (data: Buffer) => {
                    errorOutput += data.toString();
                });
                stream.on("close", (code: number) => {
                    if (code !== 0) {
                        reject(new Error(`Command failed with exit code ${code}: ${errorOutput || output}`));
                    } else {
                        resolve(output);
                    }
                });
            });
        });
    }

    /**
     * Uploads a local folder to the server as a ZIP archive, then extracts and deletes the archive.
     */
    public async uploadFolderAsZip(
        localFolderPath: string,
        remoteFolderPath: string
    ): Promise<void> {
        this.ensureSftpSession();
        const archiver = require("archiver");
        const zipFileName = `temp_upload_${Date.now()}_${Math.random().toString(36).substring(2, 10)}.zip`;
        const localZipPath = path.join(process.cwd(), zipFileName);
        const remoteZipPath = normalizePath(path.join(remoteFolderPath, zipFileName));

        try {
            await this.ensureRemoteDirectoryExists(remoteFolderPath, "");
            // Create ZIP archive
            await new Promise<void>((resolve, reject) => {
                const output = fs.createWriteStream(localZipPath);
                const archive = archiver("zip", { zlib: { level: 9 } });
                output.on("close", () => resolve());
                archive.on("error", (err: Error) =>
                    reject(new Error(`Failed to create ZIP file: ${err.message}`))
                );
                archive.pipe(output);
                archive.directory(localFolderPath, false);
                archive.finalize();
            });
            // Upload archive to server
            await this.uploadFile(localZipPath, remoteZipPath);
            // Extract archive on server
            await this.executeCommand(`unzip -o "${remoteZipPath}" -d "${remoteFolderPath}"`);
            // Delete ZIP file from server
            await this.deleteRemoteFile(remoteZipPath);
        } finally {
            if (fs.existsSync(localZipPath)) {
                await fs.promises.unlink(localZipPath);
            }
        }
    }

    /**
     * Checks whether the SFTP session is established.
     */
    private ensureSftpSession(): void {
        if (!this.sftp) {
            throw new Error("SFTP session not established. Call connect() first.");
        }
    }

    /**
     * Checks whether the remote path exists.
     */
    private async remotePathExists(remotePath: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.sftp!.stat(remotePath, (err) => {
                if (err) resolve(false);
                else resolve(true);
            });
        });
    }

    /**
     * Determines whether the given object is a directory.
     */
    private isDirectory(entry: SSHFileInfo): boolean {
        if (typeof entry.attrs.isDirectory === "function") {
            return entry.attrs.isDirectory();
        }
        if (entry.longname) {
            return entry.longname.startsWith("d");
        }
        return false;
    }

    /**
     * Ensures the remote directory exists, creating missing path segments.
     */
    private async ensureRemoteDirectoryExists(remoteDirPath: string, remoteBasePath: string): Promise<void> {
        const normalizedDirPath = normalizePath(remoteDirPath);
        const normalizedBasePath = normalizePath(remoteBasePath);

        // If remoteBasePath is provided, calculate relative path from base
        let pathToCreate = normalizedDirPath;
        if (normalizedBasePath && normalizedDirPath.startsWith(normalizedBasePath)) {
            pathToCreate = normalizedDirPath.substring(normalizedBasePath.length).replace(/^\//, '');
        }

        const pathSegments = pathToCreate.split('/').filter(Boolean);
        let currentPath = normalizedBasePath || '/';

        for (const segment of pathSegments) {
            currentPath = normalizePath(path.join(currentPath, segment));
            if (!(await this.remotePathExists(currentPath))) {
                await this.createRemoteDirectory(currentPath);
            }
        }
    }

    /**
     * Creates a directory on the remote server.
     */
    private async createRemoteDirectory(dirPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp!.mkdir(dirPath, (err) => {
                if (err) reject(new Error(`Failed to create directory ${dirPath}: ${err.message}`));
                else resolve();
            });
        });
    }
}