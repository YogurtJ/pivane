export declare const EXTERNAL_RUN_REGISTRY_VERSION = 2;
export declare const EXTERNAL_RUN_REGISTRY_KEY = "pi-subagents.external-runs.v2";
export declare const EXTERNAL_RUN_LIMITS: {
    readonly maxCachedRuns: 100;
    readonly maxSnapshotRuns: 20;
    readonly maxIdentityLength: 160;
    /**
     * A Pi session id is the session file path, which routinely exceeds a short
     * identity budget in nested worktrees, so it is bounded like the other paths.
     */
    readonly maxSessionIdLength: 4096;
    readonly maxTextLength: 160;
    readonly maxPreviewLength: 4096;
    readonly maxPathLength: 4096;
    readonly maxSerializedBytes: number;
};
export type ExternalRunState = "queued" | "running" | "completed" | "failed" | "stopped";
/** A display-only record for work owned by another extension or runtime. */
export interface ExternalRun {
    id: string;
    sessionId: string;
    source: string;
    label: string;
    state: ExternalRunState;
    startedAt: number;
    updatedAt?: number;
    endedAt?: number;
    currentAction?: string;
    preview?: string;
    reportPath?: string;
    transcriptPath?: string;
}
export type ExternalRunUpdate = Partial<Omit<ExternalRun, "id" | "sessionId" | "source">>;
export interface ExternalRunSnapshotOptions {
    onMalformedRecord?: (message: string) => void;
    ignoreMalformed?: boolean;
}
/** Register one current-session external job. pi-subagents never controls the job. */
export declare function registerExternalRun(input: ExternalRun): ExternalRun;
/** Update display fields for a registered external job without changing its identity or owner. */
export declare function updateExternalRun(sessionId: string, id: string, update: ExternalRunUpdate): ExternalRun;
/** Remove a cached external job. The caller remains responsible for its process and artifacts. */
export declare function unregisterExternalRun(sessionId: string, id: string): boolean;
/** Read a bounded cached snapshot for one Pi session. This never invokes third-party code. */
export declare function snapshotExternalRuns(sessionId: string, options?: ExternalRunSnapshotOptions): readonly ExternalRun[];
/** Alias for callers that prefer list terminology. */
export declare const listExternalRuns: typeof snapshotExternalRuns;
//# sourceMappingURL=external-runs.d.ts.map