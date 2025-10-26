import { watch } from "fs";
import path from "path";
import { minimatch } from "minimatch";
import Logger from "../utils/Logger";
import type { SSHClient } from "./SSHClient";
import { FileCollector } from "./FileCollector";
import { rm } from "fs/promises";

export enum FileChangeType {
    ADD = "ADD",
    CHANGE = "CHANGE",
    DELETE = "DELETE"
}

export interface FileChange {
    type: FileChangeType;
    localPath: string;
    relativePath: string;
}

export class FileWatcher {
    private watchers: ReturnType<typeof watch>[] = [];
    private debounceTimers: Map<string, Timer> = new Map();
    private readonly debounceDelay = 500; // ms
    private isProcessing = false;
    private pendingChanges: Set<string> = new Set();

    constructor(
        private localThemePath: string,
        private remoteThemePath: string,
        private excludePatterns: string[],
        private sshClient: SSHClient
    ) { }

    /**
     * Starts watching the local theme directory for changes
     */
    public start(): void {
        Logger.info(`Starting file watcher for: ${this.localThemePath}`);

        const absolutePath = path.resolve(this.localThemePath);

        const watcher = watch(
            absolutePath,
            { recursive: true },
            (eventType, filename) => {
                if (!filename) return;

                const fullPath = path.join(absolutePath, filename);
                const relativePath = path.relative(absolutePath, fullPath);

                // Skip if matches exclude patterns
                if (this.shouldExclude(relativePath, fullPath)) {
                    return;
                }

                // Debounce rapid changes
                this.debounceChange(relativePath, fullPath, eventType);
            }
        );

        this.watchers.push(watcher);
        Logger.success("File watcher started successfully");
    }

    /**
     * Stops all file watchers
     */
    public stop(): void {
        Logger.info("Stopping file watchers...");
        this.watchers.forEach(watcher => watcher.close());
        this.watchers = [];

        // Clear all debounce timers
        this.debounceTimers.forEach(timer => clearTimeout(timer));
        this.debounceTimers.clear();

        Logger.success("File watchers stopped");
    }

    /**
     * Checks if a file should be excluded based on patterns
     */
    private shouldExclude(relativePath: string, fullPath: string): boolean {
        // Always exclude .output directory
        if (relativePath.includes('.output') || relativePath.startsWith('.output')) {
            return true;
        }

        // Normalize paths for consistent comparison
        const normalizedRelative = relativePath.replace(/\\/g, '/');
        const normalizedFull = fullPath.replace(/\\/g, '/');
        const filename = path.basename(fullPath);

        return this.excludePatterns.some(pattern => {
            // Normalize pattern
            const normalizedPattern = pattern.replace(/\\/g, '/');

            // Direct match against relative path (e.g., ".deployment" matches ".deployment" or ".deployment/...")
            if (normalizedRelative === normalizedPattern || normalizedRelative.startsWith(normalizedPattern + '/')) {
                return true;
            }

            // Check with minimatch for glob patterns (e.g., "**/*.ts", "**/node_modules")
            if (minimatch(normalizedRelative, normalizedPattern, { dot: true })) {
                return true;
            }

            // Check filename only for patterns like "*.scss"
            if (minimatch(filename, normalizedPattern, { dot: true })) {
                return true;
            }

            return false;
        });
    }

    /**
     * Debounces file changes to avoid multiple rapid syncs
     */
    private debounceChange(relativePath: string, fullPath: string, eventType: string): void {
        const key = relativePath;

        // Clear existing timer
        if (this.debounceTimers.has(key)) {
            clearTimeout(this.debounceTimers.get(key)!);
        }

        // Set new timer
        const timer = setTimeout(() => {
            this.debounceTimers.delete(key);
            this.handleFileChange(relativePath, fullPath, eventType);
        }, this.debounceDelay);

        this.debounceTimers.set(key, timer);
    }

    /**
     * Handles a file change event
     */
    private async handleFileChange(relativePath: string, fullPath: string, eventType: string): Promise<void> {
        // Add to pending changes
        this.pendingChanges.add(relativePath);

        // If already processing, skip - the pending changes will be picked up
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;

        try {
            // Process all pending changes
            const changes = Array.from(this.pendingChanges);
            this.pendingChanges.clear();

            Logger.info(`Processing ${changes.length} file change(s)...`);

            for (const changePath of changes) {
                const changeFullPath = path.join(path.resolve(this.localThemePath), changePath);
                await this.syncSingleFile(changePath, changeFullPath);
            }

        } catch (error) {
            Logger.error(`Error handling file change: ${error}`);
        } finally {
            this.isProcessing = false;

            // If new changes accumulated, process them
            if (this.pendingChanges.size > 0) {
                setTimeout(() => this.handleFileChange('', '', ''), 100);
            }
        }
    }

    /**
     * Syncs a single file to the remote server
     */
    private async syncSingleFile(relativePath: string, fullPath: string): Promise<void> {
        try {
            // Check if file exists (to determine if it's add/update or delete)
            const exists = await this.fileExists(fullPath);

            if (exists) {
                // File was added or modified
                const remotePath = path.join(this.remoteThemePath, relativePath).replace(/\\/g, '/');

                Logger.log("SYNC", `Uploading: ${relativePath}`);
                await this.sshClient.uploadFile(fullPath, remotePath, this.remoteThemePath);
                Logger.log("SUCCESS", `Synced: ${relativePath}`);

            } else {
                // File was deleted
                const remotePath = path.join(this.remoteThemePath, relativePath).replace(/\\/g, '/');

                Logger.log("SYNC", `Deleting: ${relativePath}`);

                // Try to delete as file first, then as directory
                try {
                    await this.sshClient.deleteRemoteFile(remotePath);
                } catch (error) {
                    // If file deletion fails, try directory deletion
                    try {
                        await this.sshClient.deleteRemoteDirectory(remotePath);
                    } catch (dirError) {
                        // File/directory might already be deleted, log but don't throw
                        Logger.warn(`Could not delete ${relativePath}: ${dirError}`);
                    }
                }

                Logger.log("SUCCESS", `Deleted: ${relativePath}`);
            }

        } catch (error) {
            Logger.error(`Failed to sync ${relativePath}: ${error}`);
        }
    }

    /**
     * Checks if a file exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            const file = Bun.file(filePath);
            return await file.exists();
        } catch {
            return false;
        }
    }
}
