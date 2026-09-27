import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SubagentState } from "../../shared/types.ts";
import type { ReadonlyDrainObservation } from "../shared/readonly-drain-observation.ts";
import { type SubagentWaitDeps, type SubagentWaitParams, type WaitEventBus } from "./subagent-wait.ts";
export declare const DEFAULT_AUTO_DRAIN_TIMEOUT_MS: number;
export interface AutoDrainDeps extends Pick<SubagentWaitDeps, "asyncDirRoot" | "resultsDir" | "nestedRootRunId"> {
    state: SubagentState;
    events?: WaitEventBus;
    timeoutMs?: number;
    now?: () => number;
    wait?: (params: SubagentWaitParams, signal: AbortSignal | undefined, deps: SubagentWaitDeps) => Promise<AgentToolResult<Details>>;
    hasWork?: (sessionId: string, nowMs: number) => boolean;
    hasPendingSupervisorRequest?: () => boolean;
}
/** Drain all work owned by the current headless session, including work added while draining. */
export declare function drainOutstandingWork(deps: AutoDrainDeps, observation?: ReadonlyDrainObservation): Promise<void>;
//# sourceMappingURL=auto-drain.d.ts.map