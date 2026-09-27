import type { ChildWatchdogProgress, ChildWatchdogWarningSummary } from "../shared/types.ts";
import { type ResolvedWatchdogConfig, type WatchdogCadenceConfig, type WatchdogLspConfig } from "./types.ts";
export declare const CHILD_WATCHDOG_WARNING_LIMIT = 20;
export declare const CHILD_WATCHDOG_STATUS_EVENT = "subagent.watchdog.status";
export declare const CHILD_WATCHDOG_PHASES: readonly ["idle", "reviewing", "stale", "failed"];
export type ChildWatchdogPhase = typeof CHILD_WATCHDOG_PHASES[number];
export interface ChildWatchdogConfig {
    runId?: string;
    agent?: string;
    childIndex?: number;
    watchdogTailTimeoutMs: number;
    agentEndTimeoutMs: number;
    maxWarnings: number | null;
    model?: string;
    thinking?: string | false;
    lsp: WatchdogLspConfig;
    stalemateRepeats: number;
    /** Mid-run review cadence; everyNTools null means boundary reviews only. */
    cadence: WatchdogCadenceConfig;
}
export interface ChildWatchdogStatusEvent {
    type: typeof CHILD_WATCHDOG_STATUS_EVENT;
    runId?: string;
    agent?: string;
    childIndex?: number;
    stepIndex?: number;
    seq: number;
    phase: ChildWatchdogPhase;
    ts: number;
    reason?: string;
    warning?: ChildWatchdogWarningSummary;
}
export type ChildWatchdogStateSnapshot = ChildWatchdogProgress;
export declare function resolveChildWatchdogConfig(input: {
    config: ResolvedWatchdogConfig;
    agent?: string;
    runId?: string;
    childIndex?: number;
}): ChildWatchdogConfig | undefined;
export declare function decodeChildWatchdogConfig(raw: string | undefined): ChildWatchdogConfig | undefined;
export declare function isChildWatchdogStatusEvent(value: unknown): value is ChildWatchdogStatusEvent;
export declare function childWatchdogIsActive(snapshot: ChildWatchdogStateSnapshot | undefined): boolean;
export declare function acceptChildWatchdogEvent(input: {
    current: ChildWatchdogStateSnapshot | undefined;
    event: ChildWatchdogStatusEvent;
    runId?: string;
    agent?: string;
    childIndex?: number;
}): ChildWatchdogStateSnapshot | undefined;
/** An assistant turn marks earlier warnings addressed. Undefined when unchanged. */
export declare function applyChildWatchdogMessage(current: ChildWatchdogStateSnapshot | undefined, message: unknown): ChildWatchdogStateSnapshot | undefined;
export declare function unresolvedChildWatchdogBlockers(progress: Pick<ChildWatchdogProgress, "warnings"> | undefined): ChildWatchdogWarningSummary[];
export declare function childWatchdogProgressForModel(progress: ChildWatchdogProgress | undefined): ChildWatchdogProgress | undefined;
//# sourceMappingURL=child-status.d.ts.map