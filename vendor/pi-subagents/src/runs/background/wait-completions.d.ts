import type { SubagentState, WaitCompletion } from "../../shared/types.ts";
import type { AsyncRunSummary } from "./async-status.ts";
export declare function projectStructuredOutput(value: unknown): unknown;
/**
 * Project a terminal result payload into the slim shape that is safe to surface in
 * tool_result details: run identity, per-child outcome, and the artifact trail.
 * Output text is deliberately excluded — it already travels in the tool result
 * content, and duplicating it in details would double the payload for every wait.
 */
export declare function toWaitCompletion(data: Record<string, unknown>, runId: string): WaitCompletion;
/**
 * Record a consumed terminal payload for later surfacing by bg_wait, pruning
 * stale entries with the same TTL that dedupes completion notifications. The result
 * file is deleted after durable replay succeeds, so this record is the in-process
 * source once the watcher has consumed it. Payload ownership must be explicit and
 * agree with persistence ownership. Returns whether that replay is durable.
 */
export declare function recordWaitCompletion(state: SubagentState, runId: string, data: Record<string, unknown>, now: number, ttlMs: number, persistence?: {
    resultsDir: string;
    sessionId: string;
}): boolean;
/**
 * Terminal payloads for the runs a wait covered: the watcher's in-memory record
 * first, then the not-yet-consumed result file. Result files are written atomically,
 * so a direct read never observes a torn write; the read is deliberately read-only —
 * the watcher owns notification and cleanup.
 */
export declare function collectWaitCompletions(terminal: AsyncRunSummary[], state: SubagentState, resultsDir: string, onReference?: (text: string) => void): WaitCompletion[] | undefined;
//# sourceMappingURL=wait-completions.d.ts.map