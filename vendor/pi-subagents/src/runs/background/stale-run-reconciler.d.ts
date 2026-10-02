import { type AsyncParallelGroupStatus, type AsyncStatus, type SubagentRunMode } from "../../shared/types.ts";
import { type NestedRoute } from "../shared/nested-events.ts";
import type { RawDrainStatusObserver } from "../shared/readonly-drain-observation.ts";
export type PidLiveness = "alive" | "dead" | "unknown";
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;
interface StartedRunMetadata {
    runId: string;
    pid?: number;
    sessionId?: string;
    completionOwnerId?: string;
    mode?: SubagentRunMode;
    agents?: string[];
    chainStepCount?: number;
    parallelGroups?: AsyncParallelGroupStatus[];
    startedAt?: number;
    sessionFile?: string;
    sessionName?: string;
}
interface ReconcileAsyncRunOptions {
    resultsDir?: string;
    kill?: KillFn;
    now?: () => number;
    startedRun?: StartedRunMetadata;
    missingStatusGraceMs?: number;
    staleAlivePidMs?: number;
    pidNamespaceScope?: () => string | undefined;
}
interface ReconcileAsyncRunResult {
    status: AsyncStatus | null;
    repaired: boolean;
    resultPath?: string;
    message?: string;
}
export declare function reconcileNestedAsyncDescendants(route: NestedRoute, options?: ReconcileAsyncRunOptions): void;
export declare function checkPidLiveness(pid: number, kill?: KillFn): PidLiveness;
export declare function reconcileAsyncRun(asyncDir: string, options?: ReconcileAsyncRunOptions, observeStatus?: RawDrainStatusObserver): ReconcileAsyncRunResult;
export {};
//# sourceMappingURL=stale-run-reconciler.d.ts.map