import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Details, type SubagentState } from "../../shared/types.ts";
import { type NestedRunResolutionScope } from "../shared/nested-events.ts";
interface RunStatusParams {
    action?: string;
    id?: string;
    runId?: string;
    dir?: string;
    index?: number;
    view?: "fleet" | "transcript";
    lines?: number;
}
interface RunStatusDeps {
    asyncDirRoot?: string;
    resultsDir?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
    state?: SubagentState;
    nested?: NestedRunResolutionScope;
    sessionRoots?: string[];
    activeCapacityRoot?: string;
    abandonedSlotReleaseAfterMs?: number | false;
}
export declare function inspectSubagentStatus(params: RunStatusParams, deps?: RunStatusDeps): AgentToolResult<Details>;
export {};
//# sourceMappingURL=run-status.d.ts.map