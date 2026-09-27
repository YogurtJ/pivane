interface TimerApi {
    setTimeout(handler: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
interface FileCoalescer {
    schedule(file: string, delayMs?: number): boolean;
    flush(file: string): boolean;
    clear(): void;
}
export declare function createFileCoalescer(handler: (file: string) => void, defaultDelayMs: number, timerApi?: TimerApi): FileCoalescer;
export {};
//# sourceMappingURL=file-coalescer.d.ts.map