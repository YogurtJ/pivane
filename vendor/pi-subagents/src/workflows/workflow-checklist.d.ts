import type { AsyncJobStep, HostStepNode, WorkflowGraphSnapshot, WorkflowPreflightLane, WorkflowPreflight } from "../shared/types.ts";
import { type ThinkingLevel } from "../shared/model-info.ts";
export type WorkflowChecklistState = "complete" | "running" | "queued" | "blocked" | "failed" | "paused" | "stopped";
export interface WorkflowChecklistStep {
    key?: string;
    thinking?: string;
    workflowKey?: string;
    runId?: string;
    label?: string;
    description?: string;
    phase?: string;
    agent?: string;
    status: string;
    context?: "fresh" | "fork";
    activityState?: string;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    currentTool?: string;
    currentToolStartedAt?: number;
    currentPath?: string;
    turnCount?: number;
    toolCount?: number;
    outputName?: string;
    error?: string;
    toolBudgetBlocked?: boolean;
    turnBudgetExceeded?: boolean;
    timedOut?: boolean;
    stopped?: boolean;
    acceptance?: {
        status?: string;
        reviewResult?: {
            status?: string;
        };
    };
    review?: {
        status?: string;
    };
    watchdog?: {
        phase?: string;
    };
}
export interface WorkflowChecklistTraceEntry {
    operation?: string;
    key: string;
    state: string;
    agent?: string;
    runId?: string;
    phase?: string;
    label?: string;
    generatedLaneKey?: string;
    durationMs?: number;
    error?: string;
}
export interface WorkflowChecklistItem {
    key: string;
    label: string;
    phase: string;
    state: WorkflowChecklistState;
    agent?: string;
    /** Thinking level of the child this item stands for. */
    thinking?: ThinkingLevel;
    context?: "fresh" | "fork";
    startedAt?: number;
    durationMs?: number;
    currentTool?: string;
    currentToolStartedAt?: number;
    currentPath?: string;
    toolCount?: number;
    outputName?: string;
    error?: string;
    preflight?: WorkflowPreflightLane;
    kind?: "child" | "host";
    monitorKind?: HostStepNode["monitorKind"];
    provider?: string;
    role?: string;
    verdict?: HostStepNode["verdict"];
    target?: string;
    reasonCode?: string;
    stale?: boolean;
    reportPath?: string;
}
export interface WorkflowChecklistPhase {
    key: string;
    label: string;
    state: WorkflowChecklistState;
    items: WorkflowChecklistItem[];
    total: number;
    done: number;
    running: number;
    queued: number;
    blocked: number;
    failed: number;
    paused: number;
    stopped: number;
    parallel: boolean;
}
export interface WorkflowChecklistProjection {
    phases: WorkflowChecklistPhase[];
    total: number;
    done: number;
    running: number;
    queued: number;
    blocked: number;
    failed: number;
    paused: number;
    stopped: number;
    bottleneck?: WorkflowChecklistItem;
}
export interface WorkflowChecklistInput {
    graph?: WorkflowGraphSnapshot;
    steps?: readonly WorkflowChecklistStep[] | readonly AsyncJobStep[];
    hostSteps?: readonly HostStepNode[];
    preflight?: WorkflowPreflight;
    trace?: readonly WorkflowChecklistTraceEntry[];
    now?: number;
}
export declare function projectWorkflowChecklist(input: WorkflowChecklistInput): WorkflowChecklistProjection;
export declare function formatWorkflowChecklistSummary(projection: WorkflowChecklistProjection): string;
export declare function formatWorkflowChecklistPhase(phase: WorkflowChecklistPhase): string;
export declare function formatWorkflowChecklistBottleneck(item: WorkflowChecklistItem | undefined, options?: {
    includeOutput?: boolean;
    includeError?: boolean;
}): string | undefined;
export declare function formatWorkflowChecklistText(projection: WorkflowChecklistProjection, indent?: string, options?: {
    includeItems?: boolean;
}): string[];
//# sourceMappingURL=workflow-checklist.d.ts.map