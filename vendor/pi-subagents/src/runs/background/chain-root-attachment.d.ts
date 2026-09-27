import type { AcceptanceLedger, ArtifactPaths, CostSummary, EffectsProjection, ExecutionProjection, Usage } from "../../shared/types.ts";
export interface ImportedAsyncRoot {
    runId: string;
    asyncDir: string;
    resultPath: string;
    index: number;
}
export interface ImportedAsyncRootResult {
    agent: string;
    importedPublication?: {
        sessionId?: string;
        toolCallId?: string;
    };
    /** Human-readable display name for the child session, when derived at launch. */
    sessionName?: string;
    output: string;
    success: boolean;
    exitCode: number;
    error?: string;
    sessionFile?: string;
    intercomTarget?: string;
    model?: string;
    requestedModel?: string;
    contextOverflow?: boolean;
    totalCost?: CostSummary;
    usage?: Usage;
    structuredOutput?: unknown;
    structuredOutputPath?: string;
    structuredOutputSchemaPath?: string;
    acceptance?: AcceptanceLedger;
    artifactPaths?: ArtifactPaths;
    savedOutputPath?: string;
    outputSaveError?: string;
    transcriptPath?: string;
    transcriptError?: string;
    timedOut?: boolean;
    stopped?: boolean;
    execution?: ExecutionProjection;
    effects?: EffectsProjection;
}
export declare function waitForImportedAsyncRoot(root: ImportedAsyncRoot, options?: {
    pollIntervalMs?: number;
    terminalResultGraceMs?: number;
    now?: () => number;
    shouldAbort?: () => boolean;
    timeoutMessage?: string;
}): Promise<ImportedAsyncRootResult>;
export declare function resolveAsyncRootResultPath(resultsDir: string, runId: string): string;
//# sourceMappingURL=chain-root-attachment.d.ts.map