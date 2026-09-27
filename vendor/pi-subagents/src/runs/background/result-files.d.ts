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
export declare function resultPayloadMatchesSessionRun(data: unknown, sessionId: string, runId: string): boolean;
export declare function promotePendingResultFile(resultsDir: string, sessionId: string, runId: string, file?: string, options?: {
    logFailure?: boolean;
}): "none" | "promoted" | "pending";
export declare function fallbackResultPayloadPathForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined;
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