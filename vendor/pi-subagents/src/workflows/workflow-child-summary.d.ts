import type { AgentProgress, AsyncStatus, WorkflowChildActivity, WorkflowChildSummary } from "../shared/types.ts";
import type { WorkflowScriptChildResult, WorkflowScriptTraceEntry } from "./scripted-workflow.ts";
type WorkflowChildLiveProgress = WorkflowChildActivity & Pick<AgentProgress, "agent" | "sessionName" | "model" | "thinking">;
export declare function workflowChildProgress(progress: AgentProgress): WorkflowChildLiveProgress;
/** Fixed field count and a 256 UTF-8 byte tool name keep JSON activity below 2 KiB, including escaping. */
export declare function workflowChildActivity(progress: WorkflowChildActivity): WorkflowChildActivity;
export declare function workflowChildSummary(input: {
    parentToolCallId: string;
    workflowRunId: string;
    workflowState: WorkflowChildSummary["workflowState"];
    inventoryComplete: boolean;
    trace?: WorkflowScriptTraceEntry[];
    children?: WorkflowScriptChildResult[];
    steps?: NonNullable<AsyncStatus["steps"]>;
    /** In-memory snapshots from synchronous child callbacks, keyed by workflow key. */
    progress?: ReadonlyMap<string, WorkflowChildLiveProgress>;
}): WorkflowChildSummary;
export declare function parseWorkflowChildSummary(value: unknown): WorkflowChildSummary | undefined;
export {};
//# sourceMappingURL=workflow-child-summary.d.ts.map