import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AsyncStatus, type Details, type SubagentState } from "../../shared/types.ts";
import { deliverStopRequest } from "../background/control-channel.ts";
/** After ownership/state checks, deliver stop and seal paused whole runs only with native terminal proof. */
export declare function deliverAsyncRunStop(input: Parameters<typeof deliverStopRequest>[0] & {
    status: AsyncStatus;
    resultsDir?: string;
}): string | undefined;
export declare function stopAsyncRun(state: SubagentState, runId: string | undefined, kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean, location?: {
    asyncDir: string | null;
    resolvedId?: string;
}, childId?: string): AgentToolResult<Details> | null;
//# sourceMappingURL=async-stop-action.d.ts.map