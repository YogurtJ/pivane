import type { ArtifactPaths, TimeoutRecoveryProjection, TimeoutRecoverySummary, TrackedMutationEvidence, TrackedMutationSnapshot } from "../../shared/types.ts";
export declare function snapshotTrackedMutations(cwd: string): TrackedMutationSnapshot;
export declare function collectTrackedMutationEvidence(snapshot: TrackedMutationSnapshot, cwd?: string): TrackedMutationEvidence;
/** Keep status and completion details to bounded routing evidence, not raw output or effects. */
export declare function projectTimeoutRecovery(value: unknown): TimeoutRecoveryProjection | undefined;
/** Render only the bounded recovery route needed by a parent/operator. */
export declare function formatTimeoutRecoveryLines(value: unknown, indent?: string): string[];
export declare function buildTimeoutRecoverySummary(input: {
    termination: "timed-out" | "stopped";
    evidence: TrackedMutationEvidence;
    requiredOutputMissing?: boolean;
    currentTool?: string;
    currentToolArgs?: string;
    currentPath?: string;
    sessionFile?: string;
    transcriptPath?: string;
    artifactPaths?: ArtifactPaths;
}): TimeoutRecoverySummary;
//# sourceMappingURL=mutation-evidence.d.ts.map