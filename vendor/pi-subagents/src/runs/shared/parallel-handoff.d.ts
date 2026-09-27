import type { ParallelHandoffGroup, ParallelHandoffManifest, ParallelHandoffReference, ParallelHandoffLaneBinding, SubagentResultStatus, WorkflowLaneMetadata } from "../../shared/types.ts";
import type { WorktreeCleanupReport, WorktreeDiff, WorktreeSetup, WorktreeSetupProgress, WorktreeCleanupIntent } from "./worktree.ts";
export interface ParallelHandoffResult {
    agent: string;
    status: SubagentResultStatus;
    summary: string;
    outputPath?: string;
    structuredOutput?: unknown;
    structuredOutputPath?: string;
    sessionPath?: string;
    workflowKey?: string;
    runId?: string;
    lane?: WorkflowLaneMetadata;
}
export declare function readParallelHandoffManifest(manifestPath: string): ParallelHandoffManifest | undefined;
export declare function resolveParallelHandoffChild(input: {
    manifestPath: string;
    runId: string;
    workflowKey?: string;
    childRunId?: string;
}): {
    group: ParallelHandoffGroup;
    child: ParallelHandoffGroup["children"][number];
} | undefined;
export declare function resolveRetainedWorktreeCwd(manifestPath: string, runId: string, childIndex: number): string | undefined;
export declare function isTerminalParallelHandoffChildStatus(status: unknown): boolean;
export declare function formatStoredParallelHandoffCleanup(manifestPath: string, manifest?: ParallelHandoffManifest): string;
export interface ParallelHandoffEvidenceResult {
    manifest: ParallelHandoffManifest;
    reference: ParallelHandoffReference;
    text: string;
}
export declare function recordParallelHandoffMerge(input: {
    manifestPath: string;
    laneId: string;
    merge: unknown;
    now?: number;
}): ParallelHandoffEvidenceResult;
export declare function recordParallelHandoffSupersession(input: {
    manifestPath: string;
    laneId: string;
    supersession: unknown;
    now?: number;
}): ParallelHandoffEvidenceResult;
export declare function writeParallelHandoffGroup(input: {
    manifestPath: string;
    runId: string;
    mode: "single" | "parallel" | "chain";
    source: "foreground" | "async";
    cwd: string;
    stepIndex: number;
    flatStartIndex: number;
    setup: WorktreeSetup;
    diffs: WorktreeDiff[];
    cleanup?: WorktreeCleanupReport;
    results: ParallelHandoffResult[];
    laneBindings?: ParallelHandoffLaneBinding[];
    now?: number;
}): ParallelHandoffReference;
export declare function parallelHandoffPath(baseDir: string, runId?: string): string;
/** Synchronous onProgress projection shared by setup owners; snapshots are cumulative. */
export declare function writeWorktreeSetupHandoff(input: Omit<Parameters<typeof writeParallelHandoffGroup>[0], "setup" | "diffs" | "results" | "cleanup" | "now"> & {
    progress: WorktreeSetupProgress;
}): ParallelHandoffReference | undefined;
export declare function formatParallelHandoffReference(reference: ParallelHandoffReference): string;
export declare function formatParallelHandoffError(error: unknown): string;
export declare function discardPreservedWorktrees(manifestPath: string, authorization: Extract<WorktreeCleanupIntent, {
    kind: "discard";
}>["authorization"]): {
    manifest: ParallelHandoffManifest;
    text: string;
};
//# sourceMappingURL=parallel-handoff.d.ts.map