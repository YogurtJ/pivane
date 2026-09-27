import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Details, type SubagentState } from "../../shared/types.ts";
export declare function stopAsyncRun(state: SubagentState, runId: string | undefined, kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean, location?: {
    asyncDir: string | null;
    resolvedId?: string;
}, childId?: string): AgentToolResult<Details> | null;
//# sourceMappingURL=async-stop-action.d.ts.map