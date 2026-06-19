import { rm, mkdir } from "fs/promises";
import type { SSHClient } from "./SSHClient";
import type { Config } from "../config/ConfigService";
import Logger from "../utils/Logger";

export interface BackSyncResult {
    downloaded: number;
    total: number;
    stagingDir: string;
}

/**
 * Обратная синхронизация (backward sync): скачивает тему с сервера в локальную
 * staging-директорию для сравнения с локальным исходником и переноса правок,
 * сделанных клиентом напрямую на сервере (включая собранные build-файлы).
 *
 * В отличие от деплоя НЕ использует config.exclude (он исключает scss/ts/md,
 * которые при обратной синхронизации как раз и нужны). Пропускаются только
 * vcs/зависимости/служебные директории из SKIP_DIRS.
 */
export class BackSync {
    /** Директории, которые никогда не скачиваются с сервера. */
    public static readonly SKIP_DIRS = [".git", "node_modules", "vendor", ".deployment"];

    /** Директория, в которую складывается скачанная с сервера тема. */
    public static readonly DEFAULT_STAGING_DIR = ".backsync";

    public static async pullFromRemote(
        sshClient: SSHClient,
        config: Config,
        stagingDir: string = BackSync.DEFAULT_STAGING_DIR
    ): Promise<BackSyncResult> {
        Logger.log("SYNC", `Обратная синхронизация: ${config.remote_theme_path} -> ${stagingDir}`);

        // Чистим staging-директорию перед скачиванием
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });

        const { downloaded, total } = await sshClient.downloadFolderViaSFTP(
            config.remote_theme_path,
            stagingDir,
            BackSync.SKIP_DIRS
        );

        Logger.success(`Обратная синхронизация завершена: скачано ${downloaded}/${total} файлов -> ${stagingDir}`);
        Logger.info(`Сравните со своим исходником, напр.: diff -rq ${config.local_theme_path} ${stagingDir}`);

        return { downloaded, total, stagingDir };
    }
}
