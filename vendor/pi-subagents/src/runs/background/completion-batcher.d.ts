/**
 * Smart completion batching with straggler handling.
 *
 * Holds successful async-completion notifications briefly so sibling jobs that
 * finish within a short window arrive as a single grouped message. A hard
 * max-wait cap (measured from the first item in a group) prevents holding
 * notifications indefinitely. After a group is emitted, late-finishing
 * siblings that arrive within the straggler window join a shorter "straggler"
 * group with reduced debounce and max-wait timers.
 *
 * Failure and attention signals bypass this batcher entirely. Callers must
 * flush() held items and emit those signals immediately so failures and
 * needs-attention notices are never delayed.
 */
import type { CompletionBatchConfig } from "../../shared/types.ts";
export type { CompletionBatchConfig };
export interface ResolvedCompletionBatchConfig {
    enabled: boolean;
    debounceMs: number;
    maxWaitMs: number;
    stragglerDebounceMs: number;
    stragglerMaxWaitMs: number;
    stragglerWindowMs: number;
}
export declare const DEFAULT_COMPLETION_BATCH_CONFIG: ResolvedCompletionBatchConfig;
export declare function resolveCompletionBatchConfig(globalConfig?: CompletionBatchConfig, override?: CompletionBatchConfig): ResolvedCompletionBatchConfig;
type TimerHandle = unknown;
interface TimerApi {
    setTimeout(handler: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}
export interface CompletionBatcherOptions<T> {
    config: ResolvedCompletionBatchConfig;
    emit: (items: T[]) => void;
    timers?: TimerApi;
    now?: () => number;
}
export interface CompletionBatcher<T> {
    /** Add a batchable item. Emits immediately when batching is disabled. */
    push(item: T): void;
    /** Emit any held items immediately as a single group. */
    flush(): void;
    /** Clear timers and return items that were never emitted. */
    dispose(): T[];
}
/**
 * Create a completion batcher. The batcher is single-use per registration: it
 * holds at most one open group. `flush` forces emission; `dispose` tears down
 * timers for reload/shutdown without emitting.
 */
export declare function createCompletionBatcher<T>(options: CompletionBatcherOptions<T>): CompletionBatcher<T>;
//# sourceMappingURL=completion-batcher.d.ts.map