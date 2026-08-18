import type { Config } from "../../config/ConfigService";
import type { ChangeDetectionStrategy } from "./ChangeDetectionStrategy";
import { RemoteMtimeStrategy } from "./RemoteMtimeStrategy";
import { LocalSnapshotStrategy } from "./LocalSnapshotStrategy";
import Logger from "../../utils/Logger";

export type { ChangeDetectionStrategy } from "./ChangeDetectionStrategy";

/**
 * Picks the change-detection strategy for this deploy run.
 * All mtime routing lives here — callers just use the returned strategy.
 */
export function createChangeDetection(useLocalTimes: boolean, config: Config): ChangeDetectionStrategy {
    const remote = new RemoteMtimeStrategy();
    if (!useLocalTimes) {
        return remote;
    }
    const targetKey = `${config.ssh.host}:${config.remote_theme_path}`;
    Logger.info(`Change detection: local update-times snapshot (target "${targetKey}")`);
    return new LocalSnapshotStrategy(targetKey, remote);
}
