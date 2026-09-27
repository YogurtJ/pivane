import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Details, ExtensionConfig } from "../../shared/types.ts";
import type { SubagentParamsLike } from "../foreground/subagent-executor.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
export declare const SCHEDULED_RUN_ACTIONS: readonly ["schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"];
type ScheduledRunTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
export type ScheduledRunAction = typeof SCHEDULED_RUN_ACTIONS[number];
export type ScheduleRunState = "running" | "skipped" | "missed" | "completed" | "failed_launch" | "failed_run";
export type ScheduleTrigger = {
    kind: "once";
    at: string;
    nextRunAt?: string;
} | {
    kind: "interval";
    every: string;
    everyMs: number;
    anchorAt: string;
    nextRunAt: string;
};
export type ScheduleTarget = {
    workflowScript: string;
    args: Record<string, unknown>;
    baseRef?: string;
};
export interface ScheduleRecord {
    schemaVersion: 1;
    id: string;
    name: string;
    cwd: string;
    trigger: ScheduleTrigger;
    target: ScheduleTarget;
    overlap: "skip";
    catchUp: "none" | "latest";
    timeoutMs?: number;
    paused: boolean;
    sessionOnly?: boolean;
    quiet?: boolean;
    ownerSessionFile?: string;
    createdAt: string;
    updatedAt: string;
    activeRunId?: string;
    lastRunId?: string;
}
export interface ScheduleRunRecord {
    schemaVersion: 1;
    id: string;
    scheduleId: string;
    plannedAt: string;
    dueReason: "timer" | "run-due" | "manual";
    state: ScheduleRunState;
    startedAt?: string;
    completedAt?: string;
    asyncId?: string;
    asyncDir?: string;
    error?: string;
}
type ScheduledRunManagerDeps = {
    config: ExtensionConfig;
    launch(params: SubagentParamsLike, ctx: ExtensionContext, signal: AbortSignal): Promise<AgentToolResult<Details>>;
    storeRoot?: string;
    now?: () => number;
    randomId?: () => string;
    resolveCapabilityCeiling?: (sessionId: string) => ResolvedSubagentCapabilityCeiling | undefined;
    timers?: ScheduledRunTimers;
};
export declare function isScheduledRunAction(action: unknown): action is ScheduledRunAction;
export declare function scheduledRunsEnabled(config: ExtensionConfig): boolean;
export declare function scheduledRunStorePath(cwd: string, _sessionId?: string, root?: string): string;
export declare function parseScheduledRunTime(at: string, now?: number): number;
export declare function parseScheduleInterval(every: string): number;
export declare function listScheduledRunSummaries(cwd: string, root?: string): ScheduleRecord[];
export declare class ScheduledRunManager {
    private store?;
    private readonly stores;
    private readonly contexts;
    private readonly timers;
    private readonly observedAsyncIds;
    private readonly now;
    private readonly randomId;
    private readonly timersApi;
    private readonly deps;
    constructor(deps: ScheduledRunManagerDeps);
    bindSession(ctx: ExtensionContext): void;
    stop(): void;
    handleToolCall(params: SubagentParamsLike, ctx: ExtensionContext): Promise<AgentToolResult<Details>>;
    observedCompletionRunIds(): Set<string>;
    referencedAsyncRunIds(): Set<string>;
    handleAsyncCompletion(payload: unknown): void;
    private create;
    private list;
    private show;
    private history;
    private pause;
    private runManual;
    private runDue;
    private remove;
    private restore;
    private restoreOne;
    private arm;
    private restoreAfterFireError;
    private fire;
    private launch;
    private finishRun;
    private recordMissed;
    private selectProject;
    private resolve;
    private requireStore;
    private requireContext;
    private timerKey;
    private clearTimer;
    private stopTimers;
}
export declare function createScheduledRunManager(deps: ScheduledRunManagerDeps): ScheduledRunManager;
export {};
//# sourceMappingURL=scheduled-runs.d.ts.map