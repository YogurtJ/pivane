import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SubagentState } from "../../shared/types.ts";
import type { ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { type CommandOperation } from "../shared/child-commands.ts";
export declare function commandAction(input: {
    state: SubagentState;
    target: ResolvedSubagentRunId;
    operation: CommandOperation;
    index?: number;
    toolCallId?: string;
    signal?: AbortSignal;
}): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=command-action.d.ts.map