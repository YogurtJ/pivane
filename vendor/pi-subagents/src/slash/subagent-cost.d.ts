import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SubagentState, type Usage } from "../shared/types.ts";
/** Structured parent-plus-child accounting for one session; the source of `/subagent-cost` and the RPC `cost` method. */
export interface SubagentCostReport {
    version: 1;
    parent: Usage;
    children: SubagentCostChild[];
    childTotal: Usage;
    total: Usage;
    /** Async children whose usage metadata could not be resolved; the child total is a lower bound when this is non-zero. */
    unresolvedAsyncChildren: number;
}
export interface SubagentCostChild {
    label: string;
    agent?: string;
    runId?: string;
    usage: Usage;
    sessionFile?: string;
}
export declare const SUBAGENT_COST_REPORT_VERSION: 1;
/**
 * Collect parent and child usage for the current session branch. Foreground
 * children come from persisted `subagent`/`bg_wait` tool-result details; async
 * workflow children are resolved through receipts, and other async runs through
 * their status steps, then artifact metadata.
 */
export declare function collectSubagentCost(ctx: ExtensionContext, state: Pick<SubagentState, "baseCwd" | "artifactDirPreference">): SubagentCostReport;
/** The `/subagent-cost` text rendering of a collected report. */
export declare function formatSubagentCostReport(report: SubagentCostReport): string;
//# sourceMappingURL=subagent-cost.d.ts.map