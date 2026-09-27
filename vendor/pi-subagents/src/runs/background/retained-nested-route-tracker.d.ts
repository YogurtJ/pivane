import * as fs from "node:fs";
import type { SubagentState } from "../../shared/types.ts";
interface RetainedNestedRouteTrackerOptions {
    pollIntervalMs?: number;
    platform?: NodeJS.Platform;
    watch?: typeof fs.watch;
}
export declare function createRetainedNestedRouteTracker(state: Pick<SubagentState, "retainedForegroundNestedRoutes">, options?: RetainedNestedRouteTrackerOptions): {
    track: (rootRunId: string) => void;
    clear: () => void;
};
export {};
//# sourceMappingURL=retained-nested-route-tracker.d.ts.map