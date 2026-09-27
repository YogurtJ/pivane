import * as fs from "node:fs";
export declare const ASYNC_RETENTION_DAYS = 30;
export declare const ASYNC_RETENTION_BATCH_SIZE = 100;
export declare const ASYNC_RETENTION_DELAY_MS = 60000;
export declare const ASYNC_RETENTION_TOMBSTONE_GRACE_MS: number;
export interface AsyncRetentionOptions {
    asyncDirRoot: string;
    resultsDir: string;
    waitSubscriptionsDir?: string;
    protectedRunIds?: Iterable<string>;
    now?: () => number;
    retentionMs?: number;
    tombstoneGraceMs?: number;
    batchSize?: number;
    randomId?: () => string;
    maintenanceRoot?: string;
    pid?: number;
    hostname?: string;
    processStartIdentity?: string;
    isProcessAlive?: (pid: number) => boolean | undefined;
    getProcessStartIdentity?: (pid: number) => string | undefined;
    lstatSync?: typeof fs.lstatSync;
    signal?: AbortSignal;
    discoveryWorkerUrl?: URL;
    reconcileKill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}
export interface AsyncRetentionResult {
    acquired: boolean;
    scanned: number;
    repairedRuns: number;
    deletedRuns: number;
    deletedResults: number;
    reapedTombstones: number;
    skipped: Record<string, number>;
    errors: string[];
    rawReads: number;
    sourceExhausted: Record<string, boolean>;
    discoveryDurationMs: number;
    commitDurationMs: number;
    cancelled: boolean;
    workerFailed: boolean;
    durationMs: number;
}
export declare function cleanupAsyncRetention(options: AsyncRetentionOptions): Promise<AsyncRetentionResult>;
//# sourceMappingURL=async-retention.d.ts.map