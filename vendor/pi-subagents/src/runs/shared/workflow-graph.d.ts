import { type ChainStep } from "../../shared/settings.ts";
import type { SingleResult, SubagentRunMode, WorkflowGraphNode, WorkflowGraphSnapshot, WorkflowNodeStatus } from "../../shared/types.ts";
export interface WorkflowGraphBuildInput {
    runId: string;
    mode?: SubagentRunMode;
    steps: ChainStep[];
    results?: Array<Pick<SingleResult, "exitCode" | "detached" | "interrupted" | "error" | "acceptance">>;
    currentFlatIndex?: number;
    currentStepIndex?: number;
    stepStatuses?: Array<{
        status?: string;
        error?: string;
    }>;
    dynamicChildren?: Record<number, Array<{
        agent: string;
        label?: string;
        flatIndex: number;
        itemKey: string;
        outputName?: string;
        structured?: boolean;
        error?: string;
    }>>;
    dynamicGroupStatuses?: Record<number, {
        status: WorkflowNodeStatus;
        error?: string;
        acceptance?: SingleResult["acceptance"];
    }>;
}
/** Return displayable workflow stages while hiding structural parallel groups and host monitors. */
export declare function workflowGraphStageNodes(graph: WorkflowGraphSnapshot | undefined): WorkflowGraphNode[];
export declare function buildWorkflowGraphSnapshot(input: WorkflowGraphBuildInput): WorkflowGraphSnapshot;
//# sourceMappingURL=workflow-graph.d.ts.map