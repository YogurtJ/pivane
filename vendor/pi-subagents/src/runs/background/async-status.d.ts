import { type ActivityState, type AsyncJobStep, type AsyncParallelGroupStatus, type AsyncStatus, type CostSummary, type Details, type HostStepNode, type LaunchResolvedChildExtensions, type RuntimeAcknowledgedChildExtensions, type NestedRunSummary, type SteeringStatus, type SubagentRunMode, type TimeoutRecoveryProjection, type TokenUsage, type TurnBudgetState, type UsageBudgetState, type WorktreeNaming, type WorkflowPreflight, type WorkflowGraphSnapshot } from "../../shared/types.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../shared/capability-ceiling.ts";
import { type ContextMode, type ContextSummary } from "../shared/context-mode.ts";
import type { RawDrainStatusObserver } from "../shared/readonly-drain-observation.ts";
interface AsyncRunStepSummary {
    index: number;
    childId?: string;
    agent: string;
    /** Human-readable display name for the child session, when derived at launch. */
    sessionName?: string;
    context?: ContextMode;
    label?: string;
    description?: string;
    phase?: string;
    workflowKey?: string;
    lane?: AsyncJobStep["lane"];
    worktreePath?: string;
    branch?: string;
    provider?: "native" | "worktrunk";
    naming?: WorktreeNaming;
    runId?: string;
    outputName?: string;
    structured?: boolean;
    status: AsyncJobStep["status"];
    runner?: AsyncJobStep["runner"];
    externalProcess?: AsyncJobStep["externalProcess"];
    activityState?: ActivityState;
    lastActivityAt?: number;
    currentTool?: string;
    currentToolArgs?: string;
    currentToolStartedAt?: number;
    currentPath?: string;
    recentTools?: Array<{
        tool: string;
        args: string;
        endMs: number;
    }>;
    recentOutput?: string[];
    turnCount?: number;
    toolCount?: number;
    steering?: SteeringStatus;
    durationMs?: number;
    tokens?: TokenUsage;
    totalCost?: CostSummary;
    skills?: string[];
    model?: string;
    contextLimit?: number;
    thinking?: string;
    requestedModel?: string;
    sessionFile?: string;
    transcriptPath?: string;
    error?: string;
    timedOut?: boolean;
    stopped?: boolean;
    turnBudget?: TurnBudgetState;
    turnBudgetExceeded?: boolean;
    toolBudgetBlocked?: boolean;
    wrapUpRequested?: boolean;
    acceptance?: AsyncJobStep["acceptance"];
    agentContract?: AsyncJobStep["agentContract"];
    execution?: AsyncJobStep["execution"];
    review?: AsyncJobStep["review"];
    effects?: AsyncJobStep["effects"];
    processTerminal?: AsyncJobStep["processTerminal"];
    timeoutRecovery?: TimeoutRecoveryProjection;
    launchResolvedExtensions?: LaunchResolvedChildExtensions;
    runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    capabilityAudit?: SubagentCapabilityAudit;
    children?: NestedRunSummary[];
}
export interface AsyncRunSummary {
    id: string;
    asyncDir: string;
    toolCallId?: string;
    sessionId?: string;
    state: "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
    error?: string;
    activityState?: ActivityState;
    lastActivityAt?: number;
    currentTool?: string;
    currentToolStartedAt?: number;
    currentPath?: string;
    turnCount?: number;
    toolCount?: number;
    steering?: SteeringStatus;
    mode: SubagentRunMode;
    context?: ContextSummary;
    cwd?: string;
    sessionRoot?: string;
    startedAt: number;
    lastUpdate?: number;
    endedAt?: number;
    timeoutMs?: number;
    deadlineAt?: number;
    timedOut?: boolean;
    stopped?: boolean;
    turnBudget?: TurnBudgetState;
    turnBudgetExceeded?: boolean;
    wrapUpRequested?: boolean;
    currentStep?: number;
    chainStepCount?: number;
    pendingAppends?: number;
    parallelGroups?: AsyncParallelGroupStatus[];
    hostSteps?: HostStepNode[];
    workflowGraph?: AsyncStatus["workflowGraph"];
    steps: AsyncRunStepSummary[];
    sessionDir?: string;
    outputFile?: string;
    totalTokens?: TokenUsage;
    totalCost?: CostSummary;
    usageBudget?: UsageBudgetState;
    sessionFile?: string;
    nestedChildren?: NestedRunSummary[];
    nestedWarnings?: string[];
    processTerminal?: AsyncStatus["processTerminal"];
    runFanoutBudget?: AsyncStatus["runFanoutBudget"];
    launchResolvedExtensions?: LaunchResolvedChildExtensions;
    runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    capabilityAudit?: SubagentCapabilityAudit;
    parentWorkflowRunId?: string;
    workflowKey?: string;
    lane?: AsyncStatus["lane"];
    workflow?: Details["workflow"];
    workflowChildren?: Details["workflowChildren"];
    preflight?: WorkflowPreflight;
}
interface AsyncRunListOptions {
    states?: Array<AsyncRunSummary["state"]>;
    sessionId?: string;
    limit?: number;
    /** Limits terminal candidates using the timestamp embedded in index marker names. */
    entryLimit?: number;
    resultsDir?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
    reconcile?: boolean;
    runId?: string;
    /** The caller already holds a canonical run id; never interpret a miss as a prefix. */
    exactRunId?: boolean;
    includeNested?: boolean;
    /** Explicit repair/debug escape hatch. Normal runtime paths must not set this. */
    repairScan?: boolean;
}
type TargetedAsyncRunResolution = {
    kind: "exact";
    id: string;
} | {
    kind: "prefix";
} | {
    kind: "reject";
};
/**
 * Resolve an exact targeted run without following a run-directory symlink or
 * accepting a path whose canonical location escaped the async root.
 */
export declare function resolveTargetedAsyncRun(asyncDirRoot: string, id: string, sessionId?: string): TargetedAsyncRunResolution;
export declare function summarizeAsyncStatus(asyncDir: string, status: AsyncStatus & {
    cwd?: string;
}): AsyncRunSummary;
export declare function listAsyncRuns(asyncDirRoot: string, options?: AsyncRunListOptions, observeStatus?: RawDrainStatusObserver): AsyncRunSummary[];
export declare function formatWorkflowStageLine(node: WorkflowGraphSnapshot["nodes"][number], index: number, total: number): string;
export declare function formatAsyncRunOutputPath(run: Pick<AsyncRunSummary, "asyncDir" | "outputFile">): string | undefined;
export declare function formatAsyncRunProgressLabel(run: Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups" | "steps"> & {
    workflowGraph?: WorkflowGraphSnapshot;
}): string;
export declare function formatAsyncRunList(runs: AsyncRunSummary[], heading?: string): string;
export {};
//# sourceMappingURL=async-status.d.ts.map