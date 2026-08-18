import type { FileInfo } from "../FileCollector";
import type { SSHFileInfo } from "../SSHClient";

/**
 * Encapsulates how "changed since last deploy" is determined.
 * Deployer only talks to this interface; the concrete strategy decides
 * whether to trust remote mtimes or a local snapshot.
 */
export interface ChangeDetectionStrategy {
    /** Human-readable name for logging */
    readonly name: string;

    /**
     * Whether this run needs the (slow) recursive remote file listing.
     * When false, change detection AND stale-file deletion are both
     * derived locally and the listing can be skipped entirely.
     */
    needsRemoteListing(): Promise<boolean>;

    /**
     * Whether uploads should set the remote file's mtime after transfer
     * (sftp utimes). Only useful when remote mtimes are the comparison
     * source; snapshot mode doesn't need it — and some servers reject it.
     */
    shouldPreserveRemoteMtimes(): boolean;

    /**
     * Relative paths that existed at the last commit but are gone locally —
     * i.e. files to delete on the server without consulting a remote listing.
     * Strategies that rely on the remote listing for deletions return [].
     */
    selectDeletedPaths(localFiles: FileInfo[]): Promise<string[]>;

    /**
     * Selects local files that need uploading.
     * @param localFiles Files collected from the local theme
     * @param remoteFileMap Remote files keyed by full remote path (may be empty with --skip-compair)
     * @param remoteThemePath Root theme path on the server
     */
    selectChangedFiles(
        localFiles: FileInfo[],
        remoteFileMap: Map<string, SSHFileInfo>,
        remoteThemePath: string
    ): Promise<FileInfo[]>;

    /**
     * Called once after a fully successful deploy (uploads + deletions done).
     * Strategies persist their state here; a failed deploy never commits.
     */
    commit(localFiles: FileInfo[]): Promise<void>;
}
