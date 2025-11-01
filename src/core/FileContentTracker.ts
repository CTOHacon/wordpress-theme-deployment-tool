import { createHash } from "crypto";
import Logger from "../utils/Logger";

/**
 * Tracks file content hashes to detect actual content changes
 * rather than just timestamp changes
 */
export class FileContentTracker {
    private fileHashes: Map<string, string> = new Map();

    /**
     * Computes SHA-256 hash of file content
     */
    private async computeFileHash(filePath: string): Promise<string | null> {
        try {
            const file = Bun.file(filePath);
            const exists = await file.exists();

            if (!exists) {
                return null;
            }

            const buffer = await file.arrayBuffer();
            const hash = createHash('sha256');
            hash.update(Buffer.from(buffer));
            return hash.digest('hex');
        } catch (error) {
            Logger.warn(`Failed to compute hash for ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Checks if file content has actually changed since last check
     * @returns true if content changed or file is new, false if content is the same
     */
    public async hasContentChanged(filePath: string, relativePath: string): Promise<boolean> {
        const newHash = await this.computeFileHash(filePath);

        // File doesn't exist or couldn't be read - treat as deleted/changed
        if (newHash === null) {
            const hadHash = this.fileHashes.has(relativePath);
            if (hadHash) {
                // File was tracked but now doesn't exist - it was deleted
                this.fileHashes.delete(relativePath);
                return true;
            }
            // File never existed, no change
            return false;
        }

        const oldHash = this.fileHashes.get(relativePath);

        // New file or content changed
        if (oldHash !== newHash) {
            this.fileHashes.set(relativePath, newHash);
            return true;
        }

        // Content is the same
        return false;
    }

    /**
     * Registers a file deletion
     */
    public markAsDeleted(relativePath: string): void {
        this.fileHashes.delete(relativePath);
    }

    /**
     * Updates the hash for a file without checking
     * Useful after successful upload
     */
    public async updateHash(filePath: string, relativePath: string): Promise<void> {
        const hash = await this.computeFileHash(filePath);
        if (hash !== null) {
            this.fileHashes.set(relativePath, hash);
        }
    }

    /**
     * Clears all tracked hashes
     */
    public clear(): void {
        this.fileHashes.clear();
    }

    /**
     * Returns the number of tracked files
     */
    public size(): number {
        return this.fileHashes.size;
    }

    /**
     * Indexes multiple files at once (for initial baseline)
     * @param files Array of {fullPath, relativePath} objects
     */
    public async indexFiles(files: Array<{ fullPath: string; relativePath: string }>): Promise<void> {
        for (const file of files) {
            await this.updateHash(file.fullPath, file.relativePath);
        }
    }
}
