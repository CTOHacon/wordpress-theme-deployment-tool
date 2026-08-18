import path from "path";
import type { FileInfo } from "../FileCollector";
import type { SSHFileInfo } from "../SSHClient";
import type { ChangeDetectionStrategy } from "./ChangeDetectionStrategy";
import { normalizePath } from "../../utils/PathUtils";

// Modification-time tolerance (sec): unzip restores mtime with DOS-time precision (2s),
// so without tolerance some files would look "newer" and be re-uploaded on every deploy.
const MTIME_TOLERANCE_SECONDS = 2;

/**
 * Compares local files against the mtimes/sizes reported by the server.
 * Requires a server that preserves modification times on upload.
 */
export class RemoteMtimeStrategy implements ChangeDetectionStrategy {
    public readonly name = "remote-mtime";

    public async needsRemoteListing(): Promise<boolean> {
        return true;
    }

    public shouldPreserveRemoteMtimes(): boolean {
        // Remote mtimes are the comparison source — keep them accurate.
        return true;
    }

    public async selectDeletedPaths(_localFiles: FileInfo[]): Promise<string[]> {
        // Deletions are derived from the remote listing in Deployer.
        return [];
    }

    /**
     * Selects local files that need uploading: missing on the server,
     * differing in size, or locally newer (within MTIME_TOLERANCE_SECONDS).
     * If there is no server data (e.g. --skip-compair) — all are treated as changed.
     */
    public async selectChangedFiles(
        localFiles: FileInfo[],
        remoteFileMap: Map<string, SSHFileInfo>,
        remoteThemePath: string
    ): Promise<FileInfo[]> {
        const normalizedBase = normalizePath(remoteThemePath);
        return localFiles.filter((file) => {
            const remoteKey = normalizePath(path.join(normalizedBase, file.relativePath));
            const remote = remoteFileMap.get(remoteKey);
            if (!remote) {
                return true;
            }
            if (remote.attrs.size !== file.size) {
                return true;
            }
            const localSeconds = Math.floor(file.updateTime.getTime() / 1000);
            const remoteSeconds = Math.floor(remote.attrs.mtime);
            return localSeconds - remoteSeconds > MTIME_TOLERANCE_SECONDS;
        });
    }

    public async commit(_localFiles: FileInfo[]): Promise<void> {
        // Remote mtimes are the source of truth — nothing to persist.
    }
}
