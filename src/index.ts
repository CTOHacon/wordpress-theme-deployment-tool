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
        // 1. Load configuration
        const config = await ConfigService.loadConfig();
        Logger.info("Configuration loaded");

        // Back sync: download theme from server and exit
        if (args.pullMode) {
            const sshClient = new SSHClient();
            await sshClient.connect(config.ssh);
            Logger.info("SSH connection established");

            await BackSync.pullFromRemote(sshClient, config);

            sshClient.disconnect();
            Logger.info("SSH connection closed");
            return;
        }

        // 2. Collect local files respecting exclude patterns
        const localFiles = await FileCollector.collectFiles(config.local_theme_path, config.exclude);
        Logger.info(`Found ${localFiles.length} local files`);

        // 3. Copy files to build directory (.output)
        const outputDir = ".output";
        try {
            await rm(outputDir, { recursive: true, force: true });
            Logger.info(`Old directory ${outputDir} removed`);
        } catch (error) {
            Logger.warn(`Error removing ${outputDir}: ${error}`);
        }
        await mkdir(outputDir, { recursive: true });
        await FileCollector.copyFilesToOutput(localFiles, outputDir);
        Logger.info(`Files copied to ${outputDir}`);

        // 4. Establish SSH connection
        const sshClient = new SSHClient();
        await sshClient.connect(config.ssh);
        Logger.info("SSH connection established");

        // 5. Get file list from server
        const remoteFiles = !args.skipCompair ? await sshClient.listRemoteFiles(config.remote_theme_path, true, config.exclude) : [];
        if (!args.skipCompair) {
            Logger.info(`Found ${remoteFiles.length} files on server`);
        }

        // 6. Sync local build to server
        const syncResult = await Deployer.syncToRemote(
            sshClient,
            localFiles,
            remoteFiles,
            config.remote_theme_path,
            config.exclude,
            config
        );
        Logger.success(
            `Sync complete: deleted ${syncResult.deleted}`
        );

        // 7. Clean up build directory
        await rm(outputDir, { recursive: true, force: true });
        Logger.info(`Build directory ${outputDir} removed`);

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
                    Logger.info("SSH connection closed");
                    process.exit(0);
                });

                process.on('SIGTERM', () => {
                    Logger.info("\nReceived SIGTERM, shutting down...");
                    watcher.stop();
                    sshClient.disconnect();
                    Logger.info("SSH connection closed");
                    process.exit(0);
                });
            });
        } else {
            // 9. Close SSH connection (normal mode only)
            sshClient.disconnect();
            Logger.info("SSH connection closed");
        }

    } catch (error) {
        Logger.error(`Deploy error: ${error}`);
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