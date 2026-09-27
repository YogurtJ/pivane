import type { WaitCompletion } from "../../shared/types.ts";
export interface CompletionArchiveEntry {
    agent?: string;
    resultIndex?: number;
    source: "output-artifact" | "session" | "result-tail";
    path?: string;
    text?: string;
    truncated?: boolean;
}
export interface CompletionArchive {
    version: 1;
    runId: string;
    createdAt: number;
    entries: CompletionArchiveEntry[];
}
export interface CompletionReplayRecord {
    version: 1;
    runId: string;
    sessionId: string;
    completedAt: number;
    expiresAt: number;
    completion: WaitCompletion;
    archivePath: string;
}
export declare function completionReplayPath(resultsDir: string, runId: string): string;
export declare function completionArchivePath(resultsDir: string, runId: string): string;
/** Create a small archive that references saved child artifacts and retains only bounded fallback output text. */
export declare function writeCompletionArchive(resultsDir: string, runId: string, data: Record<string, unknown>, createdAt: number): string;
/** Persist a terminal completion before its one-shot result file is removed. */
export declare function writeCompletionReplay(input: {
    resultsDir: string;
    runId: string;
    sessionId: string;
    completion: WaitCompletion;
    data: Record<string, unknown>;
    now: number;
    ttlMs: number;
}): CompletionReplayRecord;
/** Read a current replay record. Unknown fields are ignored and unknown versions are skipped. */
export declare function readCompletionReplay(resultsDir: string, runId: string, options?: {
    sessionId?: string;
    now?: number;
}): CompletionReplayRecord | undefined;
export declare function readCompletionArchive(archivePath: string): CompletionArchive | undefined;
export declare function cleanupCompletionReplayIfDue(resultsDir: string, now: number, maxAgeMs: number, intervalMs?: number): boolean;
/** Opportunistically remove expired replay and orphan archive files without affecting delivery. */
export declare function cleanupCompletionReplay(resultsDir: string, now: number, maxAgeMs: number): void;
//# sourceMappingURL=completion-replay.d.ts.map