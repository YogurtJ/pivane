import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
export declare const WATCHDOG_DIFF_TOOL_NAME = "watchdog_diff";
export declare const WATCHDOG_DIFF_MAX_CHARS = 24000;
export declare const WATCHDOG_DIFF_UNAVAILABLE_BASELINE = "watchdog_diff unavailable: this cwd has no valid Git HEAD baseline. No diff can be shown; inspect files with independent read-only tools instead.";
export interface WatchdogDiffBaseline {
    root: string;
    ref: string;
}
declare const WatchdogDiffParams: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    stat: Type.TOptional<Type.TBoolean>;
}>;
type WatchdogDiffParams = Static<typeof WatchdogDiffParams>;
/** HEAD at session start, so later child commits still show in the diff. */
export declare function captureWatchdogDiffBaseline(cwd: string): WatchdogDiffBaseline | undefined;
/** In a shared cwd, changes already pending when the session started also appear. */
export declare function createWatchdogDiffTool(baseline: WatchdogDiffBaseline | undefined, options?: {
    workingTreeAtLaunch?: boolean;
}): AgentTool<typeof WatchdogDiffParams, {
    chars: number;
}>;
export {};
//# sourceMappingURL=diff-tool.d.ts.map