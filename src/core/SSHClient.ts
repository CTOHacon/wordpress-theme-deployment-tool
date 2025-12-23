import { Client } from "ssh2";
import type { ConnectConfig, SFTPWrapper } from "ssh2";
import fs from "fs";
import path from "path";
import { normalizePath } from "../utils/PathUtils";
import { minimatch } from "minimatch";

// Интерфейс для описания файла на удалённом сервере
export interface SSHFileInfo {
    filename: string;
    longname?: string; // Добавлено опциональное свойство
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

    constructor() {
        this.client = new Client();
    }

    /**
     * Устанавливает SSH-соединение и инициализирует SFTP-сессию.
     * Если указан privateKey, он считывается из файла.
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
     * Закрывает SSH-соединение.
     */
    public disconnect(): void {
        this.client.end();
    }

    /**
     * Возвращает список файлов и директорий по указанному пути на сервере.
     * @param remotePath Путь на сервере
     * @param recursive Рекурсивный обход (по умолчанию false)
     * @param excludePatterns Массив glob-паттернов для исключения
     */
    public async listRemoteFiles(
        remotePath: string,
        recursive: boolean = false,
        excludePatterns: string[] = []
    ): Promise<SSHFileInfo[]> {
        this.ensureSftpSession();
        let entries = await this.readRemoteDirectory(remotePath);
        entries = this.filterEntriesByPatterns(entries, excludePatterns);

        if (!recursive) {
            return entries;
        }
        return await this.collectFilesRecursively(entries, excludePatterns);
    }

    /**
     * Читает содержимое директории на удалённом сервере.
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
     * Фильтрует записи на основе exclude-паттернов.
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
     * Рекурсивно собирает файлы из директорий.
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
     * Удаляет файл на сервере.
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
     * Рекурсивно удаляет директорию на сервере.
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
     * Загружает локальный файл на сервер с сохранением времени модификации.
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
     * Получает информацию о файле на сервере (время модификации и размер).
     * Возвращает null если файл не существует.
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
     * Загружает файлы из локальной папки на сервер через SFTP.
     * Загружает только файлы, которые отсутствуют на сервере или были изменены.
     * Сохраняет время модификации файлов для оптимизации последующих деплоев.
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
     * Рекурсивно собирает локальные файлы из директории.
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
     * Выполняет команду на удалённом сервере.
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
     * Загружает локальную папку на сервер в виде ZIP-архива, затем извлекает её и удаляет архив.
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
            // Создание ZIP-архива
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
            // Загрузка архива на сервер
            await this.uploadFile(localZipPath, remoteZipPath);
            // Извлечение архива на сервере
            await this.executeCommand(`unzip -o "${remoteZipPath}" -d "${remoteFolderPath}"`);
            // Удаление ZIP-файла с сервера
            await this.deleteRemoteFile(remoteZipPath);
        } finally {
            if (fs.existsSync(localZipPath)) {
                await fs.promises.unlink(localZipPath);
            }
        }
    }

    /**
     * Проверяет, установлена ли SFTP-сессия.
     */
    private ensureSftpSession(): void {
        if (!this.sftp) {
            throw new Error("SFTP session not established. Call connect() first.");
        }
    }

    /**
     * Проверяет существование удалённого пути.
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
     * Определяет, является ли переданный объект директорией.
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
     * Обеспечивает существование удалённой директории, создавая недостающие сегменты пути.
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
     * Создает директорию на удалённом сервере.
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