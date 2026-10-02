import { type ThinkingLevel } from "../../shared/model-info.ts";
import type { AsyncJobState, AsyncJobStep, HostStepFreshness, HostStepMonitorKind, HostStepNode, HostStepState, HostStepVerdict, WorkflowGraphSnapshot, WorkflowPreflightLane, WorkflowPreflight } from "../../shared/types.ts";
export declare const ASYNC_STATUS_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
export declare const ASYNC_STATUS_SNAPSHOT_VERSION = 1;
export type AsyncStatusSnapshotState = "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
export type AsyncStatusSnapshotKind = "subagent" | "workflow" | "step";
export interface AsyncStatusSnapshotActivity {
    state?: string;
    currentTool?: string;
    lastActivityAt?: number;
    currentToolStartedAt?: number;
    turnCount?: number;
    toolCount?: number;
}
export interface AsyncStatusSnapshotHostStep {
    kind: HostStepMonitorKind;
    provider?: string;
    role?: string;
    state: HostStepState;
    verdict?: HostStepVerdict;
    reasonCode?: string;
    detail?: string;
    target?: string;
    stale?: boolean;
    report?: string;
}
export interface AsyncStatusSnapshotNode {
    id: string;
    kind: AsyncStatusSnapshotKind | "host-step";
    label: string;
    state: AsyncStatusSnapshotState;
    startedAt?: number;
    updatedAt?: number;
    endedAt?: number;
    activity?: AsyncStatusSnapshotActivity;
    hostStep?: AsyncStatusSnapshotHostStep;
    children?: AsyncStatusSnapshotNode[];
}
export interface AsyncStatusSnapshotCaps {
    maxRuns: number;
    maxChildrenPerNode: number;
    maxDepth: number;
    maxStringLength: number;
    maxSerializedBytes: number;
}
export interface AsyncStatusSnapshotOmitted {
    runs: number;
    children: number;
    byteLimitExceeded: boolean;
}
export interface AsyncStatusSnapshot {
    kind: typeof ASYNC_STATUS_SNAPSHOT_KIND;
    version: typeof ASYNC_STATUS_SNAPSHOT_VERSION;
    generatedAt: number;
    caps: AsyncStatusSnapshotCaps;
    omitted: AsyncStatusSnapshotOmitted;
    runs: AsyncStatusSnapshotNode[];
}
export interface AsyncStatusSnapshotOptions {
    generatedAt?: number;
    maxRuns?: number;
    maxChildrenPerNode?: number;
    maxDepth?: number;
    maxStringLength?: number;
    maxSerializedBytes?: number;
}
export interface AsyncStatusWorkflowRow {
    name: string;
    state: AsyncJobStep["status"] | HostStepState | "planned";
    /** Present only for typed host-owned monitor rows; legacy child rows omit it. */
    kind?: HostStepMonitorKind;
    context?: AsyncJobStep["context"];
    modelThinking?: string;
    /** Thinking level of the child a child row stands for. */
    thinking?: ThinkingLevel;
    activity?: string;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    tokens?: number;
    window?: number;
    overflow?: number;
    provider?: string;
    role?: string;
    verdict?: HostStepVerdict;
    reasonCode?: string;
    detail?: string;
    target?: string;
    freshness?: HostStepFreshness;
    reportPath?: string;
    preflight?: WorkflowPreflightLane;
}
/** Project authoritative workflow facts into compact rows, annotated by preflight hints. */
export declare function projectAsyncWorkflowRows(steps: readonly AsyncJobStep[] | undefined, hostStepsOrPreflight?: readonly HostStepNode[] | WorkflowGraphSnapshot | WorkflowPreflight, preflightOverride?: WorkflowPreflight): AsyncStatusWorkflowRow[];
/** Project already-loaded async status facts into the bounded public snapshot shape. */
export declare function projectAsyncStatusSnapshot(jobs: Iterable<AsyncJobState>, options?: AsyncStatusSnapshotOptions): AsyncStatusSnapshot;
//# sourceMappingURL=async-status-projection.d.ts.map