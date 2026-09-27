/**
 * Completion notification delivery.
 *
 * Async result files call this notifier directly and are deleted only after
 * `sendMessage()` accepts the notification. The event bus remains an
 * observation channel, not a delivery acknowledgement.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CompletionBatchConfig } from "./completion-batcher.ts";
import { type ChildWatchdogProgress, type ChildWatchdogWarningSummary, type ParallelHandoffReference, type ScheduleOrigin, type SubagentState } from "../../shared/types.ts";
import type { ResultDeliveryOwnership } from "./result-delivery-ownership.ts";
export interface SubagentNotifyChildOutput {
    workflowKey?: string;
    runId?: string;
    agent?: string;
    status: string;
    savedOutputPath?: string;
    outputArtifactPath?: string;
    structuredOutputPath?: string;
    outputArtifactError?: RetainedPathError;
    structuredOutputError?: RetainedPathError;
    preview: string;
    previewTruncated?: boolean;
    previewUnavailableReason?: string;
}
export type SubagentNotifyWatchdogBlocker = Pick<ChildWatchdogWarningSummary, "summary" | "addressed" | "stalemate"> & {
    agent: string;
};
export interface SubagentNotifyDetails {
    workflowReceiptPath?: string;
    asyncDir?: string;
    agent: string;
    status: "completed" | "failed" | "paused" | "stopped";
    source?: "async" | "foreground";
    taskInfo?: string;
    resultPreview: string;
    durationMs?: number;
    workflowRunId?: string;
    childRuns?: Array<{
        runId: string;
        workflowKey?: string;
        agent?: string;
        status?: string;
    }>;
    childOutputs?: SubagentNotifyChildOutput[];
    reconciledFromDetachedChild?: string;
    sessionLabel?: string;
    sessionValue?: string;
    handoffPath?: string;
    /** Present when a durable schedule launched the run. */
    scheduleOrigin?: ScheduleOrigin;
    watchdogBlockers?: SubagentNotifyWatchdogBlocker[];
}
export interface IncrementalChildCompletion {
    workflowRunId: string;
    childKey: string;
    childRunId?: string;
    outcome: "completed" | "failed" | "paused" | "stopped";
    outputReference?: string;
    error?: string;
    workflowRunning: boolean;
}
export interface CompletionNotification {
    [key: string]: unknown;
    id?: string | null;
    source?: "async" | "foreground";
    agent?: string | null;
    success?: boolean;
    summary?: string;
    exitCode?: number;
    state?: string;
    mode?: string;
    runId?: string | null;
    reconciledFromDetachedChild?: string;
    processSignal?: string | null;
    interrupted?: boolean;
    timedOut?: boolean;
    stopped?: boolean;
    turnBudgetExceeded?: boolean;
    results?: Array<{
        runId?: string;
        workflowKey?: string;
        agent?: string;
        status?: string;
        state?: string;
        success?: boolean;
        output?: string;
        structuredOutput?: unknown;
        structuredOutputPath?: string;
        outputState?: "present" | "absent" | "unknown";
        outputReference?: string | {
            path?: string;
        };
        artifactPaths?: {
            outputPath?: string;
        };
        outputSaveError?: string;
        artifactOutputSaveFailed?: true;
        detached?: boolean;
        exitCode?: number | null;
        processSignal?: string | null;
        interrupted?: boolean;
        timedOut?: boolean;
        stopped?: boolean;
        turnBudgetExceeded?: boolean;
        watchdog?: ChildWatchdogProgress;
    }>;
    watchdog?: ChildWatchdogProgress;
    timestamp?: number;
    durationMs?: number;
    cwd?: string;
    sessionFile?: string;
    shareUrl?: string;
    gistUrl?: string;
    shareError?: string;
    taskIndex?: number;
    totalTasks?: number;
    sessionId?: string | null;
    completionOwnerId?: string | null;
    triggerTurn?: boolean;
    /** True when an acknowledged grouped intercom relay already delivered this run. */
    intercomDelivered?: boolean;
    parallelHandoff?: ParallelHandoffReference;
    scheduleOrigin?: ScheduleOrigin;
    asyncDir?: string;
}
interface NotifyTimerApi {
    setTimeout(handler: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface RegisterSubagentNotifyOptions {
    batchConfig?: CompletionBatchConfig;
    timers?: NotifyTimerApi;
    now?: () => number;
    ownership?: Pick<ResultDeliveryOwnership, "owns">;
    sendRegistry?: CompletionSendRegistry;
}
export interface CompletionNotifier {
    deliver(result: CompletionNotification): Promise<boolean>;
    hasPendingDelivery(): boolean;
    dispose(): void;
}
interface RetainedPathError {
    path: string;
    code?: string;
    message: string;
}
export declare function formatSingleCompletion(details: SubagentNotifyDetails): string;
export declare function scheduledCompletionTriggersTurn(origin: ScheduleOrigin | undefined, outcome: string): boolean;
/**
 * Child settlement is useful context, but an ordinary successful child does not
 * establish the workflow's dependency barrier while its workflow is running.
 * Keep actionable outcomes waking the parent, and preserve a terminal child as
 * the barrier for hosts that do not emit a separate workflow completion wake.
 */
export declare function incrementalChildCompletionTriggersTurn(child: Pick<IncrementalChildCompletion, "outcome" | "workflowRunning">, origin: ScheduleOrigin | undefined): boolean;
export declare function formatIncrementalChildCompletion(child: IncrementalChildCompletion): string;
export declare function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined;
export declare function formatGroupedCompletion(details: SubagentNotifyDetails[]): string;
export interface CompletionSendClaim {
    owned: boolean;
    outcome: Promise<boolean>;
    settle?(accepted: boolean): void;
}
export interface CompletionSendRegistry {
    claim(key: string, now: number): CompletionSendClaim;
}
/** A fresh registry is injectable so tests and separately scoped runtimes stay isolated. */
export declare function createCompletionSendRegistry(ttlMs?: number, cap?: number): CompletionSendRegistry;
export declare function buildCompletionDetails(result: CompletionNotification): SubagentNotifyDetails;
export default function registerSubagentNotify(pi: ExtensionAPI, state: Pick<SubagentState, "currentSessionId" | "completionOwnerId">, options?: RegisterSubagentNotifyOptions): CompletionNotifier;
export {};
//# sourceMappingURL=notify.d.ts.map