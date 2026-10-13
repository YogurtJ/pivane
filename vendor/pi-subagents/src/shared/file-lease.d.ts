/** Unknown owners and live processes are never evicted merely because a lock is old. */
export declare function tryLease(lockPath: string): (() => void) | undefined;
/** Hold a lease beside `filePath` for a short synchronous update, waiting at most `waitMs` for another owner. */
export declare function withFileLease<T>(filePath: string, action: () => T, waitMs?: number): T;
//# sourceMappingURL=file-lease.d.ts.map