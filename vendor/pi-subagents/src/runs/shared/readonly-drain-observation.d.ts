/**
 * Private, installation-owned evidence. Never changes drain/query behavior or retains statuses.
 * Observes the ordinary indexed drain, not historical ownership or outside work appearing later.
 */
export declare class ReadonlyDrainObservation {
    private state;
    private started;
    private first;
    private readonly file;
    private readonly guard;
    constructor(file: string, guard: () => boolean);
    deny(): void;
    check(): boolean;
    begin(file: string | null, native: boolean): void;
    /** Called at the existing initial read, before reconciliation or filtering. */
    readonly status: RawDrainStatusObserver;
    predicate(hasWork: boolean): void;
    complete(): void;
    settled(): boolean;
}
/** Internal synchronous sink; null means an existing query encountered uncertainty. */
export type RawDrainStatusObserver = (status: {
    sessionId?: unknown;
    state?: unknown;
} | null) => void;
//# sourceMappingURL=readonly-drain-observation.d.ts.map