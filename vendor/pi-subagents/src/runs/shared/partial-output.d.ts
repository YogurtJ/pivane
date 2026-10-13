/**
 * Unfinished assistant text recovered when a child ends abnormally.
 *
 * Final output is built from completed `message_end` messages, so text that was
 * still streaming when a child timed out or its session threw is otherwise lost.
 * The tracker keeps one in-memory reference to the latest unfinished assistant
 * message. Nothing is persisted.
 */
import type { ChildSessionEvent } from "./child-session.ts";
export type PartialOutputCause = "timeout" | "child error";
export interface PartialOutputTracker {
    observe(event: ChildSessionEvent): void;
    /** Latest unfinished assistant text that is newer than the last completed reply. */
    text(): string | undefined;
}
export declare function createPartialOutputTracker(): PartialOutputTracker;
export declare function formatPartialOutput(text: string, cause: PartialOutputCause): string;
/**
 * Summary of a timed-out background run. The timeout message comes first; when a child kept text streamed before
 * the kill, the per-child summary follows, so the completion notice and status show it (capped, with its file path).
 */
export declare function timedOutRunSummary(message: string, summary: string, results: ReadonlyArray<{
    outputPartial?: boolean;
}>): string;
//# sourceMappingURL=partial-output.d.ts.map