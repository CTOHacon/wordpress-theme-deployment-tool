import { ConfigService } from "./config/ConfigService";
import { FileCollector } from "./core/FileCollector";
import { SSHClient } from "./core/SSHClient";
import { Deployer } from "./core/Deployer";
import Logger from "./utils/Logger";
import { rm, mkdir } from "fs/promises";

async function main(args: {
    skipCompair?: boolean;
}) {
    try {
        // 1. Загрузка конфигурации
        const config = await ConfigService.loadConfig();
        Logger.info("Конфигурация загружена");

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

        // 7. Завершение SSH-соединения
        sshClient.disconnect();
        Logger.info("SSH соединение закрыто");

        // 8. Очистка сборочной директории
        await rm(outputDir, { recursive: true, force: true });
        Logger.info(`Сборочная директория ${outputDir} удалена`);
    } catch (error) {
        Logger.error(`Ошибка в процессе деплоя: ${error}`);
        process.exit(1);
    }
}

const skipCompair = process.argv.includes("--skip-compair");

main(
    {
        skipCompair
    }
);