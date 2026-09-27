export declare const FS_RETRY_MAX_TOTAL_MS_ENV = "PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS";
/**
 * Clamp the retry ladder to a total sleep budget, preserving its length.
 *
 * waitForFileSystemRetry blocks the calling thread, so the ladder above is also
 * a ceiling on how long a single contended rename can stall that thread: about
 * 7.9s. That is fine for a short-lived CLI. A long-lived host that loads this
 * extension in-process runs the same writers on its event loop, where an 8s
 * stall stops it serving anything at all -- and because Atomics.wait parks
 * rather than spins, it presents as an unresponsive process at 0% CPU.
 *
 * The length is preserved deliberately: run-fanout-budget.ts and
 * workflow-state.ts index this array by attempt number and treat running off
 * the end as "timed out acquiring lock". Shortening it would quietly shrink
 * those attempt budgets too, so only the sleeps shrink here.
 *
 * Unset by default, so behaviour is unchanged unless a host opts in. Opting in
 * trades lock-wait tolerance for responsiveness: entries clamped to 0 return
 * immediately, so contention that would previously have been waited out is
 * surfaced as an error sooner.
 */
export declare function resolveFileSystemRetryDelays(env?: NodeJS.ProcessEnv, base?: readonly number[]): readonly number[];
export declare const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS: readonly number[];
export type FileSystemRetryOptions = {
    retryDelaysMs?: readonly number[];
    wait?: (delayMs: number) => void;
};
export declare function waitForFileSystemRetry(delayMs: number): void;
export declare function isRetryableFileSystemError(error: unknown): boolean;
export declare function isStorageCapacityError(error: unknown): boolean;
export declare function runFileSystemOperationWithRetry<T>(operation: () => T, options?: FileSystemRetryOptions): T;
//# sourceMappingURL=file-system-retry.d.ts.map