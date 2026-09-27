import { type AsyncStatus, type IntercomEventBus, type SingleResult, type SubagentState } from "../../shared/types.ts";
export declare function applyDetachedChildToPausedWorkflow(status: AsyncStatus, input: {
    childRunId: string;
    result: Pick<SingleResult, "exitCode" | "error" | "interrupted" | "sessionFile" | "sessionName" | "stopped">;
    workflowKey?: string;
}): AsyncStatus | undefined;
export declare function promotePausedWorkflowIfSettled(status: AsyncStatus): AsyncStatus | undefined;
export declare function reconcileDetachedWorkflowChildCompletion(input: {
    state: SubagentState;
    workflowRunId: string;
    childRunId: string;
    result: SingleResult;
    events?: IntercomEventBus;
    workflowKey?: string;
}): boolean;
//# sourceMappingURL=workflow-detach-reconcile.d.ts.map