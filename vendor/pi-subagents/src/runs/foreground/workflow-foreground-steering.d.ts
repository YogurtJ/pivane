import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import { type SteerDeliveryMode } from "../background/control-channel.ts";
export interface WorkflowForegroundSteeringTarget {
    control: ForegroundRunControl;
    workflowRunId: string;
    sourceRunId: string;
}
export type WorkflowForegroundSteeringResolution = {
    ok: true;
    target: WorkflowForegroundSteeringTarget;
} | {
    ok: false;
    message: string;
};
export declare function resolveWorkflowForegroundSteeringTarget(input: {
    state: SubagentState;
    childRunId?: string;
    workflowRunId?: string;
    asyncDirRoot: string;
}): WorkflowForegroundSteeringResolution;
/** Local controllers remain authoritative; recorded foreign ownership permits enqueue, not takeover or proof of liveness. */
export declare function steerWorkflowRun(input: {
    state: SubagentState;
    runId: string;
    asyncDir: string;
    message: string;
    mode?: SteerDeliveryMode;
    index?: number;
    signal?: AbortSignal;
    ackTimeoutMs?: number;
}): Promise<AgentToolResult<Details>>;
/**
 * Steer a live workflow-owned foreground child through its in-process session.
 * `steer` (and `auto`) interrupt the child at its next safe point; `follow_up`
 * queues the message until the current run settles.
 */
export declare function steerWorkflowForegroundTarget(input: {
    target: WorkflowForegroundSteeringTarget;
    message: string;
    mode?: SteerDeliveryMode;
    index?: number;
}): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=workflow-foreground-steering.d.ts.map