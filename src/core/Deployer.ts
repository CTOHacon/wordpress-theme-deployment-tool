import type { SSHFileInfo, SSHClient } from "./SSHClient";
import type { FileInfo } from "./FileCollector";
import path from "path";
import { minimatch } from "minimatch";
import { DeploymentConfigService } from "../config/DeploymentConfig";
import type { Config } from "../config/ConfigService";
import Logger from "../utils/Logger";

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
     * Синхронизирует локальную сборку с удалённой директорией.
     * Выполняет удаление устаревших файлов, деплой через ZIP и последующий запуск дополнительных команд.
     *
     * @param sshClient Активный экземпляр SSHClient
     * @param localFiles Массив локальных файлов, полученных через FileCollector
     * @param remoteFiles Массив файлов, полученных с сервера через SSHClient
     * @param remoteThemePath Корневой путь темы на сервере
     * @param excludePatterns Массив glob-паттернов для исключения файлов/папок
     * @param config Основная конфигурация из config.json
     * @returns Статистика выполненных операций
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

        // Проверяем доступность unzip на сервере и выбираем метод деплоя
        Logger.info("Проверка доступности команды unzip на сервере...");
        const hasUnzip = await sshClient.checkUnzipAvailable();

        if (hasUnzip) {
            Logger.success("Команда unzip доступна, используется ZIP-метод деплоя");
            await this.deployUsingZip(sshClient, ".output", remoteThemePath);
        } else {
            Logger.warn("Команда unzip недоступна, используется прямая загрузка через SFTP");
            await this.deployUsingSFTP(sshClient, ".output", remoteThemePath);
        }

        // Удаляем файлы, которых нет в локальной сборке
        await this.deleteUnneededRemoteFiles(
            sshClient,
            remoteFileMap,
            localFileMap,
            remoteThemePath,
            excludePatterns,
            result
        );

        // Выполнение дополнительных команд (например, установка Composer)
        const deploymentConfig = DeploymentConfigService.getDeploymentConfig(config);
        if (deploymentConfig.steps && deploymentConfig.steps.composerInstall) {
            const cmd = deploymentConfig.steps.composerInstall.replace("{remote_theme_path}", remoteThemePath);
            Logger.info(`Выполняется команда деплоя: ${cmd}`);
            await sshClient.executeCommand(cmd);
        }

        return result;
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
        // Если это директория (нет расширения), проверяем, существует ли внутри хоть какой-либо файл
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
     * Деплой сборки через ZIP-архив (быстрее для больших объёмов файлов).
     * Создаёт ZIP-архив, загружает его на сервер, распаковывает и удаляет.
     */
    private static async deployUsingZip(sshClient: SSHClient, localFolderPath: string, remoteDestPath: string): Promise<void> {
        Logger.info("Запуск деплоя через ZIP-архив...");
        await sshClient.uploadFolderAsZip(localFolderPath, remoteDestPath);
        Logger.log(Operation.UPLOAD, "Деплой через ZIP завершён успешно");
    }

    /**
     * Деплой сборки напрямую через SFTP (без использования ZIP и shell-команд).
     * Загружает только изменённые или новые файлы.
     */
    private static async deployUsingSFTP(sshClient: SSHClient, localFolderPath: string, remoteDestPath: string): Promise<void> {
        Logger.info("Запуск деплоя через SFTP (прямая загрузка файлов)...");
        const result = await sshClient.uploadFolderViaSFTP(localFolderPath, remoteDestPath);
        Logger.log(Operation.UPLOAD, `Деплой через SFTP завершён: ${result.uploaded} загружено, ${result.skipped} пропущено (без изменений)`);
    }

    /**
     * Определяет, является ли переданный объект директорией.
     */
    private static isDirectory(remoteFile: SSHFileInfo): boolean {
        if (typeof remoteFile.attrs.isDirectory === "function") {
            return remoteFile.attrs.isDirectory();
        }
        return remoteFile.longname ? remoteFile.longname.startsWith("d") : false;
    }
}