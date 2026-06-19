import { ConfigService } from "./config/ConfigService";
import { FileCollector } from "./core/FileCollector";
import { SSHClient } from "./core/SSHClient";
import { Deployer } from "./core/Deployer";
import { BackSync } from "./core/BackSync";
import { FileWatcher } from "./core/FileWatcher";
import Logger from "./utils/Logger";
import { rm, mkdir } from "fs/promises";

async function main(args: {
    skipCompair?: boolean;
    syncMode?: boolean;
    pullMode?: boolean;
}) {
    try {
        // 1. Загрузка конфигурации
        const config = await ConfigService.loadConfig();
        Logger.info("Конфигурация загружена");

        // Обратная синхронизация (backward sync): скачать тему с сервера и выйти
        if (args.pullMode) {
            const sshClient = new SSHClient();
            await sshClient.connect(config.ssh);
            Logger.info("SSH соединение установлено");

            await BackSync.pullFromRemote(sshClient, config);

            sshClient.disconnect();
            Logger.info("SSH соединение закрыто");
            return;
        }

        // 2. Сбор локальных файлов с учётом exclude-паттернов
        const localFiles = await FileCollector.collectFiles(config.local_theme_path, config.exclude);
        Logger.info(`Найдено ${localFiles.length} локальных файлов`);

        // 3. Копирование файлов в сборочную директорию (.output)
        const outputDir = ".output";
        try {
            await rm(outputDir, { recursive: true, force: true });
            Logger.info(`Старая директория ${outputDir} удалена`);
        } catch (error) {
            Logger.warn(`Ошибка при удалении ${outputDir}: ${error}`);
        }
        await mkdir(outputDir, { recursive: true });
        await FileCollector.copyFilesToOutput(localFiles, outputDir);
        Logger.info(`Файлы скопированы в ${outputDir}`);

        // 4. Установка SSH-соединения
        const sshClient = new SSHClient();
        await sshClient.connect(config.ssh);
        Logger.info("SSH соединение установлено");

        // 5. Получение списка файлов на сервере
        const remoteFiles = !args.skipCompair ? await sshClient.listRemoteFiles(config.remote_theme_path, true, config.exclude) : [];
        if (!args.skipCompair) {
            Logger.info(`На сервере найдено ${remoteFiles.length} файлов`);
        }

        // 6. Синхронизация локальной сборки с сервером
        const syncResult = await Deployer.syncToRemote(
            sshClient,
            localFiles,
            remoteFiles,
            config.remote_theme_path,
            config.exclude,
            config
        );
        Logger.success(
            `Синхронизация завершена: удалено ${syncResult.deleted}`
        );

        // 7. Очистка сборочной директории
        await rm(outputDir, { recursive: true, force: true });
        Logger.info(`Сборочная директория ${outputDir} удалена`);

        // 8. SYNC MODE: Watch for file changes
        if (args.syncMode) {
            Logger.info("=".repeat(60));
            Logger.success("SYNC MODE: Watching for file changes...");
            Logger.info("Press Ctrl+C to stop watching");
            Logger.info("=".repeat(60));

            const watcher = new FileWatcher(
                config.local_theme_path,
                config.remote_theme_path,
                config.exclude,
                sshClient
            );

            // Initialize by indexing existing files
            await watcher.initialize();

            watcher.start();

            // Keep the process running
            await new Promise(() => {
                // Handle graceful shutdown
                process.on('SIGINT', () => {
                    Logger.info("\nReceived SIGINT, shutting down...");
                    watcher.stop();
                    sshClient.disconnect();
                    Logger.info("SSH соединение закрыто");
                    process.exit(0);
                });

                process.on('SIGTERM', () => {
                    Logger.info("\nReceived SIGTERM, shutting down...");
                    watcher.stop();
                    sshClient.disconnect();
                    Logger.info("SSH соединение закрыто");
                    process.exit(0);
                });
            });
        } else {
            // 9. Завершение SSH-соединения (только для обычного режима)
            sshClient.disconnect();
            Logger.info("SSH соединение закрыто");
        }

    } catch (error) {
        Logger.error(`Ошибка в процессе деплоя: ${error}`);
        process.exit(1);
    }
}

const skipCompair = process.argv.includes("--skip-compair");
const syncMode = process.argv.includes("--sync");
const pullMode = process.argv.includes("--pull");

main({
    skipCompair,
    syncMode,
    pullMode
});