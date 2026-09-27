import type { SubagentState } from "../../shared/types.ts";
export declare const MAX_REMEMBERED_FOREGROUND_RUNS = 50;
export declare function persistForegroundRunHistory(state: SubagentState, options?: {
    resultsDir?: string;
    limit?: number;
}): void;
export declare function restoreForegroundRunHistory(state: SubagentState, options?: {
    resultsDir?: string;
    sessionId?: string | null;
    limit?: number;
}): number;
//# sourceMappingURL=foreground-history.d.ts.map