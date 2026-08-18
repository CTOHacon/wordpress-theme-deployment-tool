import { promises as fs } from "fs";
import type { FileInfo } from "../FileCollector";
import type { SSHFileInfo } from "../SSHClient";
import type { ChangeDetectionStrategy } from "./ChangeDetectionStrategy";
import Logger from "../../utils/Logger";

interface SnapshotEntry {
    mtimeMs: number;
    size: number;
}

interface SnapshotTarget {
    updatedAt: string;
    files: Record<string, SnapshotEntry>;
}

interface SnapshotDocument {
    targets: Record<string, SnapshotTarget>;
}

export const DEFAULT_SNAPSHOT_PATH = ".mtime-snapshot.json";

/**
 * Compares local files against a locally stored snapshot of update times,
 * for servers that do not preserve/allow setting mtimes on upload.
 * The snapshot is keyed by deploy target (host + remote path) so config
 * swaps between targets never cross-pollute.
 */
export class LocalSnapshotStrategy implements ChangeDetectionStrategy {
    public readonly name = "local-snapshot";

    private document: SnapshotDocument | null = null;

    constructor(
        private readonly targetKey: string,
        private readonly fallback: ChangeDetectionStrategy,
        private readonly snapshotPath: string = DEFAULT_SNAPSHOT_PATH
    ) {}

    /**
     * Remote listing is only needed on the first run for a target
     * (no snapshot yet — comparison and deletions must come from the server).
     */
    public async needsRemoteListing(): Promise<boolean> {
        const target = (await this.loadDocument()).targets[this.targetKey];
        return !target;
    }

    public shouldPreserveRemoteMtimes(): boolean {
        // Comparison source is the local snapshot — remote mtimes are
        // irrelevant, and servers like WP Engine reject setting them anyway.
        return false;
    }

    /**
     * Files present at the last commit but missing locally now — delete them
     * on the server without listing it. Empty when no snapshot exists yet
     * (that run's deletions come from the remote listing instead).
     */
    public async selectDeletedPaths(localFiles: FileInfo[]): Promise<string[]> {
        const target = (await this.loadDocument()).targets[this.targetKey];
        if (!target) {
            return [];
        }
        const localSet = new Set(localFiles.map((file) => file.relativePath));
        return Object.keys(target.files).filter((relativePath) => !localSet.has(relativePath));
    }

    public async selectChangedFiles(
        localFiles: FileInfo[],
        remoteFileMap: Map<string, SSHFileInfo>,
        remoteThemePath: string
    ): Promise<FileInfo[]> {
        const target = (await this.loadDocument()).targets[this.targetKey];
        if (!target) {
            Logger.warn(
                `No local mtime snapshot for target "${this.targetKey}" — falling back to ${this.fallback.name} comparison for this run`
            );
            return this.fallback.selectChangedFiles(localFiles, remoteFileMap, remoteThemePath);
        }

        return localFiles.filter((file) => {
            const entry = target.files[file.relativePath];
            if (!entry) {
                return true;
            }
            // Same filesystem on both sides of the comparison — exact match, no tolerance.
            return entry.size !== file.size || entry.mtimeMs !== file.updateTime.getTime();
        });
    }

    public async commit(localFiles: FileInfo[]): Promise<void> {
        const document = await this.loadDocument();
        const files: Record<string, SnapshotEntry> = {};
        for (const file of localFiles) {
            files[file.relativePath] = {
                mtimeMs: file.updateTime.getTime(),
                size: file.size,
            };
        }
        document.targets[this.targetKey] = {
            updatedAt: new Date().toISOString(),
            files,
        };
        await fs.writeFile(this.snapshotPath, JSON.stringify(document, null, 2));
        Logger.info(`Local mtime snapshot updated (${localFiles.length} files, target "${this.targetKey}")`);
    }

    private async loadDocument(): Promise<SnapshotDocument> {
        if (this.document) {
            return this.document;
        }
        try {
            const raw = await fs.readFile(this.snapshotPath, "utf-8");
            const parsed = JSON.parse(raw);
            this.document = parsed && typeof parsed.targets === "object" && parsed.targets !== null
                ? parsed
                : { targets: {} };
        } catch {
            // Missing or corrupt snapshot — start fresh; fallback handles selection.
            this.document = { targets: {} };
        }
        return this.document!;
    }
}
