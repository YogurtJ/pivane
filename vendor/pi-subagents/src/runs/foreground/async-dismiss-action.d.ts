import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Details, type SubagentState } from "../../shared/types.ts";
export declare function dismissRecoveredWorkflow(state: SubagentState, location: {
    asyncDir: string | null;
    resolvedId?: string;
}): AgentToolResult<Details>;
//# sourceMappingURL=async-dismiss-action.d.ts.map