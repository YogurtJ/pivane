/**
 * Drives one in-process child session for the detached async runner: creates
 * the session through the runner's `ChildSessionFactory`, mirrors its events
 * into `events.jsonl`, the transcript, and the step output log, applies
 * interrupt, timeout, stop, and steer requests, and folds the run into the
 * step result the runner finalizes.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import type { EffectsProjection, RuntimeAcknowledgedChildExtensions, SubagentOutputState, ToolBudgetState, Usage } from "../../shared/types.ts";
import { type ChildWatchdogConfig, type ChildWatchdogStateSnapshot, type ChildWatchdogStatusEvent } from "../../watchdog/child-status.ts";
import { type InProcessChildLaunch } from "../shared/child-launch.ts";
import { type ChildSessionFactory } from "../shared/child-session.ts";
import type { SteerDeliveryStatus, SteerRequest } from "./control-channel.ts";
export interface ChildEventContext {
    runId: string;
    stepIndex: number;
    agent: string;
}
export interface ChildUsage {
    input?: number;
    inputTokens?: number;
    output?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheReadTokens?: number;
    cacheWrite?: number;
    cost?: {
        total?: number;
    };
}
export type ChildMessage = Message & {
    model?: string;
    errorMessage?: string;
    usage?: ChildUsage;
};
export interface ChildEvent {
    type?: string;
    message?: ChildMessage;
    toolName?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    willRetry?: unknown;
}
/** Outcome of handing a steer request to a live child session. */
export interface SteerDelivery {
    state: "delivered" | "queued" | "failed";
    deliveryStatus?: SteerDeliveryStatus;
    message: string;
}
export type StepSteerHandler = (request: SteerRequest) => Promise<SteerDelivery>;
export interface RunChildSessionInput {
    factory: ChildSessionFactory;
    launch: InProcessChildLaunch;
    /** Prompt text; the task with its `Task:` prefix. */
    prompt: string;
    childWatchdog?: ChildWatchdogConfig;
    childEventContext?: ChildEventContext;
    /** Persist one child event into `events.jsonl`; the runner owns the bounded log. */
    appendChildEvent: (event: Record<string, unknown>) => void;
    /** Append one line to the step output log and the progress tab. */
    writeOutputLine: (line: string) => void;
    registerInterrupt?: (interrupt: (() => void) | undefined) => void;
    registerTimeout?: (interrupt: (() => void) | undefined) => void;
    registerStop?: (stop: (() => void) | undefined) => void;
    registerSteer?: (steer: StepSteerHandler | undefined) => void;
    /** Consumption (or unconsumed settlement) after the child accepted a steer or follow-up. */
    onSteerOutcome?: (request: SteerRequest, delivery: SteerDelivery) => void;
    /** Receives the sink the child's watchdog hook reports status through; the launch's `watchdogStatus` must forward to it. */
    registerWatchdogStatus?: (sink: ((event: ChildWatchdogStatusEvent) => void) | undefined) => void;
    timeoutMessage?: string;
    stopMessage?: string;
    onChildEvent?: (event: ChildEvent) => void;
    onContextWindow?: (contextWindow: number) => void;
    transcriptWriter?: ChildTranscriptWriter;
    toolTimeoutMs?: number;
    runDeadlineAt?: number;
    expectedModelForVerification?: string;
    modelVerificationRegistry?: Array<{
        provider: string;
        id: string;
        fullId: string;
    }>;
    modelResponseAliases?: Record<string, string[]>;
    mutationTools?: readonly string[];
}
export interface RunChildSessionResult {
    exitCode: number;
    messages: Message[];
    usage: Usage;
    toolCount: number;
    durationMs: number;
    model?: string;
    nativeMachine?: {
        provider: "herdr";
        machineId: string;
        initialGit?: import("../../shared/types.ts").HerdrRemoteGitStatus;
        finalGit?: import("../../shared/types.ts").HerdrRemoteGitStatus;
    };
    error?: string;
    finalOutput: string;
    outputState: SubagentOutputState;
    interrupted?: boolean;
    timedOut?: boolean;
    stopped?: boolean;
    observedMutationAttempt?: boolean;
    structuredOutputToolInvoked?: boolean;
    structuredOutputMessageStartIndex?: number;
    structuredOutputFailed?: boolean;
    watchdog?: ChildWatchdogStateSnapshot;
    sessionFile?: string;
    currentTool?: string;
    currentToolArgs?: string;
    currentPath?: string;
    afterCompactionSettlement?: boolean;
    abortRecoveryDiagnostic?: string;
    /** Set by the runner while it finalizes the attempt. */
    toolBudget?: ToolBudgetState;
    toolBudgetBlocked?: boolean;
    structuredOutput?: unknown;
    runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
    effects?: EffectsProjection;
}
export declare function runChildSession(input: RunChildSessionInput): Promise<RunChildSessionResult>;
//# sourceMappingURL=run-child-session.d.ts.map