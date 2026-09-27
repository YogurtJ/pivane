import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AsyncStatus, Details, SubagentState, ToolBudgetConfig } from "../../shared/types.ts";
import { type SteerDeliveryMode } from "../background/control-channel.ts";
export declare function canQueueRetainedAsyncFollowUp(status: AsyncStatus, index?: number): boolean;
export declare function steerAsyncRun(input: {
    state: SubagentState;
    runId: string;
    message: string;
    mode?: SteerDeliveryMode;
    index?: number;
    findPendingAsks?: (target: {
        runId: string;
        agent: string;
        childIndex: number;
    }) => string[];
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    location: {
        asyncDir: string | null;
    };
    signal?: AbortSignal;
    ackTimeoutMs?: number;
    recoveryTimeoutMs?: number;
    onRequestQueued?: (requestPath: string) => void;
    onBeforeRecoveryClaim?: (requestId: string, committedAt: number) => void;
    onRecoveryCommitted?: (requestId: string, committedAt: number) => void;
    recover?: (limits: {
        timeoutMs?: number;
        absoluteDeadlineAt?: number;
        toolBudget?: ToolBudgetConfig;
    }) => Promise<AgentToolResult<Details>>;
}): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=async-steering-action.d.ts.map