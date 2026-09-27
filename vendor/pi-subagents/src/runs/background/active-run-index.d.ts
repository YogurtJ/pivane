import type { AsyncStatus } from "../../shared/types.ts";
export declare const ACTIVE_RUN_INDEX_DIR = ".active-runs";
export declare const DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS: number;
export declare function isActiveAsyncState(state: AsyncStatus["state"]): boolean;
export declare function releaseActiveRunIndex(asyncDir: string): void;
export declare function updateActiveRunIndex(asyncDir: string, state: AsyncStatus["state"], toolCallId?: string, options?: {
    retryCapacityErrors?: boolean;
    terminalIndexBeforeRelease?: boolean;
}): void;
export declare function activeRunMarkerAgeMs(asyncDir: string, now?: number): number | undefined;
export declare function readActiveRunIndex(asyncDirRoot: string): string[] | undefined;
export declare function readActiveRunToolCallIndex(asyncDirRoot: string, toolCallId: string): string[];
//# sourceMappingURL=active-run-index.d.ts.map