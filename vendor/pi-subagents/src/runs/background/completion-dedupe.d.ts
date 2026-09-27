interface CompletionDataLike {
    id?: unknown;
    agent?: unknown;
    timestamp?: unknown;
    sessionId?: unknown;
    state?: unknown;
    taskIndex?: unknown;
    totalTasks?: unknown;
    success?: unknown;
}
export declare function buildCompletionKey(data: CompletionDataLike, fallback: string): string;
export declare function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean;
export {};
//# sourceMappingURL=completion-dedupe.d.ts.map