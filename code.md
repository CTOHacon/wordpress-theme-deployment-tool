# config.json
```json
{
    "ssh": {
        "host": "194.31.52.246",
        "port": 22,
        "username": "hacon-waterproofing",
        "password": "xz10nIhi4HODC4It009D"
    },
    "remote_theme_path": "/home/hacon-waterproofing/htdocs/waterproofing.hacon.com.ua/wp-content/themes/waterproofing",
    "local_theme_path": "../",
    "exclude": [
        ".git",
        "Deployment",
        ".deployment",
        "**/node_modules",
        "**/vendor",
        "docs",
        ".gitignore",
        "package-lock.json",
        "package.json",
        "composer.lock",
        "source/dev",
        "**/vite.config.js",
        "**/tsconfig.json",
        "**/package.json",
        "**/package-lock.json",
        "**/*.DS_Store",
        "**/*.scss",
        "**/*.ts",
        "gutenberg/components",
        "gutenberg/constants",
        "gutenberg/src",
        "**/*.jsx"
    ]
}
```

# package.json
```json
{
  "name": "deploy-tool",
  "module": "index.ts",
  "type": "module",
  "devDependencies": {
    "@types/archiver": "^6.0.3",
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "@types/ssh2": "^1.15.4",
    "archiver": "^7.0.1",
    "chalk": "^5.4.1",
    "minimatch": "^10.0.1",
    "pino": "^9.6.0",
    "ssh2": "^1.16.0"
  },
  "scripts": {
    "deploy": "bun run src/index.ts"
  }
}
```

# src/index.ts
```typescript
import { ConfigService } from "./config/ConfigService";
import { FileCollector } from "./filesystem/FileCollector";
import { SSHClient } from "./sftp/SSHClient";
import { Deployer } from "./sftp/Deployer";
import { rm, mkdir } from 'fs/promises';
import chalk from "chalk";

async function main() {
    try {
        // 1. Загрузка и валидация конфигурации
        const config = await ConfigService.loadConfig();
        console.info(chalk.green("Конфигурация загружена"));

        // 2. Сбор файлов локальной темы с учётом exclude-паттернов
        const localFiles = await FileCollector.collectFiles(config.local_theme_path, config.exclude);

        // 3. Копирование файлов в директорию сборки (.output)
        const outputDir = ".output";
        try {
            await rm(outputDir, { recursive: true, force: true });
        } catch (error) {
            // Ошибки удаления можно обработать при необходимости
        }

        await mkdir(outputDir, { recursive: true });
        await FileCollector.copyFilesToOutput(localFiles, outputDir);
        console.info(chalk.blue(`Файлы скопированы в ${outputDir}`));

        // 4. Предварительная сборка PHP-файлов
        // Comming soon...

        // 5. Установка SSH-соединения с сервером
        const sshClient = new SSHClient();
        await sshClient.connect(config.ssh);
        console.info(chalk.green("SSH соединение установлено"));

        // 6. Получение списка файлов на сервере
        const remoteFiles = await sshClient.listRemoteFiles(config.remote_theme_path, true, config.exclude);
        console.info(chalk.magenta(`На сервере найдено ${remoteFiles.length} файлов`));

        // 7. Синхронизация локальных файлов с удалёнными
        await Deployer.syncToRemote(sshClient, localFiles, remoteFiles, config.remote_theme_path, config.exclude);
        console.info(chalk.yellow(`Синхронизация завершена`));

        await sshClient.executeCommand(`cd ${config.remote_theme_path}/ThemeCore && composer install`);
        console.info(chalk.yellow(`Composer завершён`));

        // 8. Завершение SSH-соединения
        sshClient.disconnect();
        console.info(chalk.green("SSH соединение закрыто"));

        // remove output dir
        await rm(outputDir, { recursive: true, force: true });
    } catch (error) {
        console.error(chalk.red(`Ошибка в процессе деплоя: ${error}`));
        process.exit(1);
    }
}

main();
```

# src/config/ConfigService.ts
```typescript
import { promises as fs } from "fs";
import path from "path";
import type { ConnectConfig } from "ssh2";

export interface Config {
    ssh: ConnectConfig;
    remote_theme_path: string;
    local_theme_path: string;
    exclude: string[];
}

export class ConfigService {
    /**
     * Загружает конфигурацию из указанного файла и валидирует её.
     * @param configPath Путь к файлу конфигурации (по умолчанию "config.json")
     * @returns Объект с конфигурационными данными
     * @throws Если файл не найден или данные не проходят валидацию
     */
    public static async loadConfig(configPath: string = "config.json"): Promise<Config> {
        try {
            const absolutePath = path.resolve(configPath);
            const data = await fs.readFile(absolutePath, { encoding: "utf-8" });
            const configObj = JSON.parse(data);
            return this.validateConfig(configObj);
        } catch (error) {
            throw new Error(`Ошибка загрузки конфигурации: ${error}`);
        }
    }

    /**
     * Валидирует объект конфигурации.
     * @param config Объект, полученный из файла конфигурации
     * @returns Объект, приведённый к типу Config
     * @throws Если обнаружены несоответствия типов или отсутствуют обязательные поля
     */
    public static validateConfig(config: any): Config {
        if (typeof config.remote_theme_path !== "string") {
            throw new Error("Поле 'remote_theme_path' должно быть строкой");
        }
        if (typeof config.local_theme_path !== "string") {
            throw new Error("Поле 'local_theme_path' должно быть строкой");
        }
        if (!Array.isArray(config.exclude)) {
            throw new Error("Поле 'exclude' должно быть массивом строк");
        }
        if (!config.exclude.every((item: any) => typeof item === "string")) {
            throw new Error("Все элементы в 'exclude' должны быть строками");
        }
        return config as Config;
    }
}
```

# src/filesystem/FileCollector.ts
```typescript
import { promises as fs } from "fs";
import path from "path";
import { minimatch } from "minimatch";

// Интерфейс для описания файла
export interface FileInfo {
    absolutePath: string;
    relativePath: string;
    updateTime: Date;
}

export class FileCollector {
    /**
     * Рекурсивно обходит директорию basePath, собирает файлы, за исключением тех,
     * чьи относительные пути содержат один из паттернов в excludePatterns.
     * @param basePath Путь к корневой директории
     * @param excludePatterns Массив строк-паттернов для исключения файлов/папок
     * @returns Массив объектов FileInfo с информацией о найденных файлах
     */
    public static async collectFiles(
        basePath: string,
        excludePatterns: string[]
    ): Promise<FileInfo[]> {
        const files: FileInfo[] = [];

        // Рекурсивная функция обхода
        const traverse = async (currentPath: string, relativePath: string) => {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(currentPath, entry.name);
                const entryRelativePath = path.join(relativePath, entry.name);

                // Если текущая папка или файл удовлетворяет паттерну исключения, пропускаем
                if (this.shouldExclude(entryRelativePath, excludePatterns)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverse(entryPath, entryRelativePath);
                } else if (entry.isFile()) {
                    const stats = await fs.stat(entryPath);
                    files.push({
                        absolutePath: entryPath,
                        relativePath: entryRelativePath,
                        updateTime: stats.mtime
                    });
                }
            }
        };

        await traverse(basePath, "");
        return files;
    }

    /**
     * Копирует файлы из массива files в директорию outputPath, сохраняя структуру папок
     * и устанавливая время последнего изменения, равное исходному.
     * @param files Массив объектов FileInfo, полученный из collectFiles
     * @param outputPath Путь к директории, куда будут скопированы файлы
     */
    public static async copyFilesToOutput(
        files: FileInfo[],
        outputPath: string
    ): Promise<void> {
        for (const file of files) {
            const targetPath = path.join(outputPath, file.relativePath);
            // Создаем необходимые директории
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(file.absolutePath, targetPath);
            // Устанавливаем время последнего изменения, равное оригинальному
            await fs.utimes(targetPath, new Date(), file.updateTime);
        }
    }

    /**
     * Проверяет, нужно ли исключить файл/папку, если его относительный путь содержит
     * один из заданных паттернов.
     * @param filePath Относительный путь файла или директории
     * @param excludePatterns Массив паттернов
     * @returns true, если нужно исключить, иначе false
     */
    private static shouldExclude(
        filePath: string,
        excludePatterns: string[]
    ): boolean {
        return excludePatterns.some(pattern => minimatch(filePath, pattern, { dot: true }));
    }
}
```

# src/sftp/Deployer.ts
```typescript
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
```

# src/sftp/SSHClient.ts
```typescript

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
```

# src/utils/logBlock.ts
```typescript
import chalk from "chalk";

const logBlock = (type: "INFO" | "UPLOAD" | "UPDATE" | "DELETE" | "ERROR", message: string) => {
    let title: string;
    let styledTitle: string;
    switch (type) {
        case "INFO":
            title = " INFO ";
            styledTitle = chalk.bgBlue.white.bold(title);
            break;
        case "UPLOAD":
            title = " UPLOAD ";
            styledTitle = chalk.bgGreen.white.bold(title);
            break;
        case "UPDATE":
            title = " UPDATE ";
            styledTitle = chalk.bgYellow.black.bold(title);
            break;
        case "DELETE":
            title = " DELETE ";
            styledTitle = chalk.bgRed.white.bold(title);
            break;
        case "ERROR":
            title = " ERROR ";
            styledTitle = chalk.bgRed.white.bold(title);
            break;
        default:
            title = " LOG ";
            styledTitle = chalk.bgMagenta.white.bold(title);
    }
    console.log(`${styledTitle} ${message}`);
};

export default logBlock;
```

