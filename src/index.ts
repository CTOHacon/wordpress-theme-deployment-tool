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

        await sshClient.executeCommand(`cd ${config.remote_theme_path} && composer install`);
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
