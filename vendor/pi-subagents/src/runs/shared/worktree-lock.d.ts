export declare function withHandoffWriteLock<T>(manifestPath: string, action: () => T): T;
export declare function withRepositoryWorktreeLock<T>(repo: string, action: () => T | Promise<T>, options?: {
    signal?: AbortSignal;
    waitMs?: number;
}): Promise<T>;
//# sourceMappingURL=worktree-lock.d.ts.map