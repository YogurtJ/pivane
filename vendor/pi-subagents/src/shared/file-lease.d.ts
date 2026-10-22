/** Unknown owners and live processes are never evicted merely because a lock is old. */
export declare function tryLease(lockPath: string): (() => void) | undefined;
/** Another live owner held the lease for the whole wait. */
export declare class FileLeaseBusyError extends Error {
}
/**
 * Hold a lease beside `filePath` for a short synchronous update, waiting at most `waitMs` for another owner.
 * The wait blocks the calling thread; `waitMs: 0` makes one attempt and never waits.
 */
export declare function withFileLease<T>(filePath: string, action: () => T, waitMs?: number): T;
