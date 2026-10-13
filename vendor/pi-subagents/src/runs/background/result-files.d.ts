export interface ResultIndexEntry {
    version: 1;
    runId: string;
    sessionId: string;
    file: string;
    writtenAt: number;
    asyncDir?: string;
}
export declare function resultFileName(runId: string): string;
export declare function resultFilePath(resultsDir: string, runId: string): string;
export declare function writeResultIndexForData(resultPath: string, data: Record<string, unknown>): void;
export declare function writePendingAsyncResultFile(resultPath: string, data: Record<string, unknown>): void;
export declare function writeAsyncResultFile(resultPath: string, data: Record<string, unknown>): {
    state: "public" | "pending";
};
export declare function removeResultIndex(resultsDir: string, sessionId: string | undefined, runId: string | undefined, toolCallId?: string): void;
export declare function removeMissionObserverIndex(resultsDir: string, runId: string | undefined): void;
/** Serializes one run's result publication and retirement across processes. Lookups never take it. */
export declare function withResultRunLease<T>(resultsDir: string, runId: string, action: () => T): T;
/**
 * The exact payload text a consumer read, with the identity its indexes are keyed by.
 * `stalePublic` is what the public path held, read just before `snapshot`, when it differed:
 * every writer goes through the pending path and promotion empties it, so a pending payload is
 * always newer than the public one beside it, and `stalePublic` is older than `snapshot`.
 */
export interface ResultSnapshot {
    runId: string;
    sessionId?: string;
    toolCallId?: string;
    snapshot: string;
    stalePublic?: string;
}
export declare function readResultPayload(filePath: string): string | undefined;
/** Call under the run's lease: whether a payload written after the consumer read now exists for the run. */
export declare function resultSnapshotReplaced(publicPath: string, read: ResultSnapshot): boolean;
/**
 * Removes the payload a consumer read, the older public payload it saw beside it, and the run's
 * indexes. When a newer payload replaced it, the shared payload paths and indexes stay and only
 * the consumer's own claimed copy goes. A payload that cannot be removed is reported after the
 * indexes are gone.
 */
export declare function retireResultSnapshot(publicPath: string, read: ResultSnapshot, payloadPath?: string): "retired" | "replaced";
/** Removes the mission observer index for the payload an observer handled, unless a newer payload replaced it. */
export declare function acknowledgeMissionObserverSnapshot(publicPath: string, read: ResultSnapshot): "acknowledged" | "replaced";
export declare function resultPayloadMatchesSessionRun(data: unknown, sessionId: string, runId: string): boolean;
export declare function promotePendingResultFile(resultsDir: string, sessionId: string, runId: string, file?: string, options?: {
    logFailure?: boolean;
}): "none" | "promoted" | "pending";
export declare function fallbackResultPayloadPathForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined;
/** Any pending or public result file for the run, without validating its contents. */
export declare function resultPayloadFileForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined;
export declare function resultPayloadPathForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined;
export declare function resultPayloadPathForMissionObserverRun(resultsDir: string, runId: string): string | undefined;
export declare function resultPayloadPathForIndexedRun(resultsDir: string, runId: string): string | undefined;
export declare function resultFilesForSession(resultsDir: string, sessionId: string): string[];
export declare function resultCandidateFilesForSession(resultsDir: string, sessionId: string): string[];
export declare function resultFilesForToolCall(resultsDir: string, toolCallId: string): string[];
export declare function resultCandidateFilesForToolCall(resultsDir: string, toolCallId: string): string[];
export declare function missionObserverResultFiles(resultsDir: string): string[];
export declare function missionObserverResultCandidateFiles(resultsDir: string): string[];
export declare function cleanupResultIndexes(resultsDir: string, now?: number, maxAgeMs?: number): number;
//# sourceMappingURL=result-files.d.ts.map