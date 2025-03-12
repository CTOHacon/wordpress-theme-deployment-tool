import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import { minimatch } from "minimatch";
import { ConfigService } from "../config/ConfigService";
import fs from "fs";
import path from "path";
import archiver from "archiver";

/**
 * Represents information about a file or directory on the remote server
 */
export interface SSHFileInfo {
    filename: string;
    longname: string;
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
    fullPath: string;
    time: Date;
}

/**
 * Client to interact with remote servers via SSH/SFTP
 */
export class SSHClient {
    private client: Client;
    private sftp: SFTPWrapper | null = null;

    constructor() {
        this.client = new Client();
    }

    /**
     * Establishes SSH connection and initializes SFTP session
     * @param config SSH configuration object
     * @throws Error if connection fails
     */
    public async connect(config: ConnectConfig): Promise<void> {
        if (config.privateKey) config.privateKey = fs.readFileSync(config.privateKey).toString();

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
     * Closes the SSH connection
     */
    public disconnect(): void {
        if (this.client) {
            this.client.end();
        }
    }

    /**
     * Lists files and directories at the specified remote path
     * @param remotePath Path on the server
     * @param recursive Include nested files and directories recursively
     * @param excludePatterns Patterns to exclude files and directories
     * @returns Array of file information objects
     * @throws Error if SFTP session is not established
     */
    public async listRemoteFiles(
        remotePath: string,
        recursive = false,
        excludePatterns: string[] = []
    ): Promise<SSHFileInfo[]> {
        this.ensureSftpSession();

        const entries = await this.readRemoteDirectory(remotePath);
        const filteredEntries = this.filterEntriesByPatterns(entries, excludePatterns);

        if (!recursive) {
            return filteredEntries;
        }

        return await this.collectFilesRecursively(filteredEntries, excludePatterns);
    }

    /**
     * Reads contents of a remote directory
     * @param remotePath Path to read on the remote server
     * @returns Array of file information objects
     */
    private async readRemoteDirectory(remotePath: string): Promise<SSHFileInfo[]> {
        return new Promise<SSHFileInfo[]>((resolve, reject) => {
            this.sftp!.readdir(remotePath, (err, list) => {
                if (err) {
                    reject(new Error(`Failed to read directory ${remotePath}: ${err.message}`));
                } else {
                    const entriesWithPath = list.map(entry => ({
                        ...entry,
                        fullPath: `${remotePath}/${entry.filename}`,
                        time: new Date(entry.attrs.mtime * 1000)
                    }));
                    resolve(entriesWithPath);
                }
            });
        });
    }

    /**
     * Filters entries based on exclude patterns
     * @param entries Array of file information objects
     * @param excludePatterns Patterns to exclude files and directories
     * @returns Filtered array of file information objects
     */
    private filterEntriesByPatterns(entries: SSHFileInfo[], excludePatterns: string[]): SSHFileInfo[] {
        return entries.filter(entry => {
            return !excludePatterns.some(pattern =>
                minimatch(entry.fullPath, pattern) || minimatch(entry.filename, pattern)
            );
        });
    }

    /**
     * Deletes a file on the remote server
     * @param filePath Path to the file on the server
     * @throws Error if SFTP session is not established or file deletion fails
     */
    public async deleteRemoteFile(filePath: string): Promise<void> {
        this.ensureSftpSession();

        try {
            await new Promise<void>((resolve, reject) => {
                this.sftp!.unlink(filePath, (err) => {
                    if (err) reject(new Error(`Failed to delete file ${filePath}: ${err.message}`));
                    else resolve();
                });
            });
        } catch (err: any) {
            if (err.code !== 'ENOENT') { // Ignore if file doesn't exist
                throw err;
            }
        }
    }

    /**
     * Recursively deletes a directory on the remote server
     * @param directoryPath Path to the directory on the server
     * @throws Error if SFTP session is not established or directory deletion fails
     */
    public async deleteRemoteDirectory(directoryPath: string): Promise<void> {
        this.ensureSftpSession();

        // Check if directory exists
        if (!await this.remotePathExists(directoryPath)) {
            return; // Directory already deleted, skip operation
        }

        try {
            // Delete directory contents
            const list = await this.listRemoteFiles(directoryPath);

            for (const item of list) {
                const itemPath = `${directoryPath}/${item.filename}`;

                if (this.isDirectory(item)) {
                    await this.deleteRemoteDirectory(itemPath);
                } else {
                    await this.deleteRemoteFile(itemPath);
                }
            }

            // Remove the empty directory
            await new Promise<void>((resolve, reject) => {
                this.sftp!.rmdir(directoryPath, (err) => {
                    if (err) reject(new Error(`Failed to delete directory ${directoryPath}: ${err.message}`));
                    else resolve();
                });
            });
        } catch (err: any) {
            if (err.code !== 'ENOENT') { // Ignore if directory doesn't exist
                throw err;
            }
        }
    }

    /**
     * Uploads a local file to the remote server
     * @param localFilePath Path to the local file
     * @param remoteFilePath Path where to save the file on the server
     * @param remoteBasePath Base path on the server for creating directories
     * @throws Error if SFTP session is not established, local file doesn't exist, or upload fails
     */
    public async uploadFile(
        localFilePath: string,
        remoteFilePath: string,
        remoteBasePath: string = ""
    ): Promise<void> {
        this.ensureSftpSession();

        // Verify local file exists
        try {
            await fs.promises.stat(localFilePath);
        } catch (error) {
            throw new Error(`Local file not found: ${localFilePath}`);
        }

        // Create remote directory structure if needed
        const remoteDirPath = path.dirname(remoteFilePath);
        if (remoteDirPath) {
            await this.ensureRemoteDirectoryExists(remoteDirPath, remoteBasePath);
        }

        // Upload the file
        return new Promise<void>((resolve, reject) => {
            this.sftp!.fastPut(localFilePath, remoteFilePath, (err) => {
                if (err) {
                    reject(new Error(`Failed to upload file to ${remoteFilePath}: ${err.message}`));
                } else {
                    resolve();
                }
            });
        });
    }

    // Private helper methods

    /**
     * Ensures that SFTP session is established
     * @throws Error if SFTP session is not established
     */
    private ensureSftpSession(): void {
        if (!this.sftp) {
            throw new Error("SFTP session is not established. Please connect first.");
        }
    }

    /**
     * Collects all files recursively from directories
     * @param entries Array of file information objects
     * @param excludePatterns Patterns to exclude files and directories
     * @returns Expanded array with all nested files and directories
     */
    private async collectFilesRecursively(
        entries: SSHFileInfo[],
        excludePatterns: string[]
    ): Promise<SSHFileInfo[]> {
        const result = [...entries];

        for (const entry of entries) {
            if (this.isDirectory(entry)) {
                const subEntries = await this.listRemoteFiles(
                    entry.fullPath,
                    true,
                    excludePatterns
                );
                result.push(...subEntries);
            }
        }

        return result;
    }

    /**
     * Checks if remote path exists
     * @param remotePath Path to check on the remote server
     * @returns True if the path exists, false otherwise
     */
    private async remotePathExists(remotePath: string): Promise<boolean> {
        try {
            await new Promise((resolve, reject) => {
                this.sftp!.stat(remotePath, (err, stats) => {
                    if (err) reject(err);
                    else resolve(stats);
                });
            });
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * Checks if a file entry is a directory
     * @param entry File information object
     * @returns True if the entry is a directory
     */
    private isDirectory(entry: SSHFileInfo): boolean {
        return entry.longname ? entry.longname[0] === 'd' : false;
    }

    /**
     * Ensures that the remote directory exists, creating it if necessary
     * @param remoteDirPath Directory path to ensure exists
     * @param remoteBasePath Base path on the server
     */
    private async ensureRemoteDirectoryExists(
        remoteDirPath: string,
        remoteBasePath: string
    ): Promise<void> {
        const pathSegments = remoteDirPath.startsWith(remoteBasePath)
            ? remoteDirPath.substring(remoteBasePath.length).split('/').filter(Boolean)
            : remoteDirPath.split('/').filter(Boolean);

        let currentPath = remoteBasePath || '/';

        for (const segment of pathSegments) {
            currentPath = path.join(currentPath, segment);

            if (!await this.remotePathExists(currentPath)) {
                await this.createRemoteDirectory(currentPath);
            }
        }
    }

    /**
     * Creates a directory on the remote server
     * @param dirPath Path of the directory to create
     */
    private async createRemoteDirectory(dirPath: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.sftp!.mkdir(dirPath, (err) => {
                if (err) reject(new Error(`Failed to create directory ${dirPath}: ${err.message}`));
                else resolve();
            });
        });
    }

    /**
     * Creates a ZIP file of localFolderPath and uploads it to remoteFolderPath, executes the unzip command on the server and cleans up the zip files on both local and remote
     * 
     * @param localFolderPath Path to the local folder
     * @param remoteFolderPath Path on the server where files should be extracted
     * @returns Promise that resolves when the operation is complete
     * @throws Error if any part of the process fails
     */
    public async uploadFolderAsZip(
        localFolderPath: string,
        remoteFolderPath: string
    ): Promise<void> {
        this.ensureSftpSession();

        // Generate a temporary filename for the zip
        const zipFileName = `temp_upload_${Date.now()}_${Math.random().toString(36).substring(2, 10)}.zip`;
        const localZipPath = path.join(process.cwd(), zipFileName);
        const remoteZipPath = path.join(remoteFolderPath, zipFileName);

        try {
            // Ensure the remote directory exists
            await this.ensureRemoteDirectoryExists(remoteFolderPath, "");

            // Create a zip file of the local folder
            await this.createZipFromFolder(localFolderPath, localZipPath);

            // Upload the zip file to the remote server
            await this.uploadFile(localZipPath, remoteZipPath);

            // Execute the unzip command on the server
            try {
                await this.executeCommand(`unzip -o "${remoteZipPath}" -d "${remoteFolderPath}"`);
            } catch (error: any) {
                throw new Error(`Failed to extract ZIP file on server: ${error.message}. Ensure 'unzip' is installed on the server.`);
            }

            // Clean up the zip file on the remote server   ;
            await this.deleteRemoteFile(remoteZipPath);
        } finally {
            // Clean up the local zip file
            if (fs.existsSync(localZipPath)) {
                await fs.promises.unlink(localZipPath);
            }
        }
    }

    /**
     * Creates a ZIP file from a folder
     * @param folderPath Path to the folder to zip
     * @param outputPath Path where the ZIP file should be saved
     */
    private async createZipFromFolder(folderPath: string, outputPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            const archive = archiver('zip', {
                zlib: { level: 9 } // Maximum compression
            });

            output.on('close', () => resolve());
            archive.on('error', err => reject(new Error(`Failed to create ZIP file: ${err.message}`)));

            archive.pipe(output);

            if (!fs.existsSync(folderPath)) {
                reject(new Error(`Local folder not found: ${folderPath}`));
                return;
            }

            archive.directory(folderPath, false);
            archive.finalize();
        });
    }

    /**
     * Executes a shell command on the remote server
     * @param command Command to execute
     */
    public async executeCommand(command: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.client.exec(command, (err, stream) => {
                if (err) {
                    reject(new Error(`Failed to execute command: ${err.message}`));
                    return;
                }

                let output = '';
                let errorOutput = '';

                stream.on('data', (data: any) => {
                    output += data.toString();
                });

                stream.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                stream.on('close', (code: any) => {
                    if (code !== 0) {
                        reject(new Error(`Command failed with exit code ${code}: ${errorOutput || output}`));
                    } else {
                        resolve(output);
                    }
                });
            });
        });
    }
}