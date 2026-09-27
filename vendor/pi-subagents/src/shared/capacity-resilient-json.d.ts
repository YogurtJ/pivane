type TimerApi = {
    setTimeout(handler: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
};
export type CapacityResilientJsonWriterOptions = {
    /** The underlying write operation. It must be atomic for each target path. */
    write?: (filePath: string, payload: object) => void;
    /** Keep retry timers referenced by the event loop (needed by child runners). */
    keepAlive?: boolean;
    retryDelayMs?: number;
    timerApi?: TimerApi;
    onError?: (error: unknown, filePath: string) => void;
    onSuccess?: (filePath: string, payload: object) => void;
};
export type CapacityResilientJsonWriter = {
    write(filePath: string, payload: object, writeOperation?: (filePath: string, payload: object) => void): void;
    pendingCount(): number;
    dispose(): void;
};
/**
 * Defers only storage-capacity failures, retaining the newest payload per path.
 * Initial/ordinary writes remain synchronous and preserve their throwing contract;
 * only ENOSPC-like failures enter the guarded retry loop.
 */
export declare function createCapacityResilientJsonWriter(options?: CapacityResilientJsonWriterOptions): CapacityResilientJsonWriter;
export {};
//# sourceMappingURL=capacity-resilient-json.d.ts.map