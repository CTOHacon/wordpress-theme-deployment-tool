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
 * Back sync: downloads the theme from the server into a local staging directory
 * for comparison with the local source and for merging changes made directly
 * on the server (including compiled build files).
 *
 * Unlike deploy, does NOT use config.exclude (which excludes scss/ts/md files
 * that are needed for back sync). Only vcs/dependency/service directories
 * from SKIP_DIRS are skipped.
 */
export class BackSync {
    /** Directories that are never downloaded from the server. */
    public static readonly SKIP_DIRS = [".git", "node_modules", "vendor", ".deployment"];

    /** Directory where the downloaded theme from the server is stored. */
    public static readonly DEFAULT_STAGING_DIR = ".backsync";

    public static async pullFromRemote(
        sshClient: SSHClient,
        config: Config,
        stagingDir: string = BackSync.DEFAULT_STAGING_DIR
    ): Promise<BackSyncResult> {
        Logger.log("SYNC", `Back sync: ${config.remote_theme_path} -> ${stagingDir}`);

        // Clean staging directory before downloading
        await rm(stagingDir, { recursive: true, force: true });
        await mkdir(stagingDir, { recursive: true });

        const { downloaded, total } = await sshClient.downloadFolderViaSFTP(
            config.remote_theme_path,
            stagingDir,
            BackSync.SKIP_DIRS
        );

        Logger.success(`Back sync complete: downloaded ${downloaded}/${total} files -> ${stagingDir}`);
        Logger.info(`Compare with your source, e.g.: diff -rq ${config.local_theme_path} ${stagingDir}`);

        return { downloaded, total, stagingDir };
    }
}
