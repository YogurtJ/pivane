import type { AcceptanceRecoveryMetadata, HostStepNode, SingleResult, WorkflowScriptFailureKind } from "../shared/types.ts";
import { type WorkflowHostCommandParams, type WorkflowHostCommandResult } from "./host-command.ts";
export interface WorkflowScriptValidationError {
    message: string;
    line?: number;
    column?: number;
    kind?: "spawn-budget" | "agent";
}
export interface WorkflowScriptValidationWarning {
    message: string;
    kind: "dynamic-spawn-count";
}
export interface WorkflowScriptValidationResult {
    ok: boolean;
    errors: WorkflowScriptValidationError[];
    warnings?: WorkflowScriptValidationWarning[];
}
export interface WorkflowScriptValidationOptions {
    maxSubagentSpawnsPerRun?: number;
    /** Returns why launch-time resolution would reject this literal child agent name. */
    agentNameError?: (name: string) => string | undefined;
}
export interface WorkflowScriptChildResult {
    key: string;
    /** True only for successfully completed child work, never for a launch receipt. */
    ok: boolean;
    /** An explicit async launch returned before a final child result was available. */
    state?: "running";
    asyncDir?: string;
    lane?: import("../shared/types.ts").WorkflowLaneMetadata;
    terminalOutcome?: import("../shared/types.ts").WorkflowTerminalOutcome;
    stopped?: boolean;
    /** Canonical child agent name when launch resolution produced one. */
    agent?: string;
    runId?: string;
    output: string;
    error?: string;
    detached?: boolean;
    interrupted?: boolean;
    structuredOutput?: unknown;
    requestedContext?: "fresh" | "fork";
    resolvedContext?: "fresh" | "fork" | "mixed";
    outputReference?: string;
    /** A file produced by the child runtime (output or worktree handoff), not its job directory. */
    outputArtifactPath?: string;
    recovery?: AcceptanceRecoveryMetadata;
    outputPathMapping?: {
        requestedPath: string;
        savedPath: string;
    };
    externalAdapter?: import("../shared/types.ts").ExternalCliReceiptMetadata;
    resumability?: {
        state: "resumable";
    } | {
        state: "not-resumable";
        reason: string;
    };
    continuation?: {
        runIds: string[];
    };
    artifactPaths: string[];
    results?: SingleResult[];
    /** Came from a runtime-replaced run of the same script and args (its saved result, or its still-running child re-attached); this run launched nothing. */
    reused?: boolean;
}
export interface WorkflowScriptTraceEntry {
    operation: "run" | "status" | "steer" | "host";
    key: string;
    state: "started" | "completed" | "failed" | "detached" | "stopped" | "reused" | "queued" | "delivered" | "missed";
    /** Canonical child agent name when resolved launch or result data is available. */
    agent?: string;
    runId?: string;
    durationMs?: number;
    phase?: string;
    label?: string;
    error?: string;
    /** Internal provenance for a generated runs.lanes child key. */
    generatedLaneKey?: string;
    lane?: import("../shared/types.ts").WorkflowLaneMetadata;
    warning?: string;
    /** The settled result came from a previous run of the same script and args; no child was launched. */
    reused?: boolean;
}
/** Bounded plan metadata emitted when a workflow materializes a runs.lanes graph. */
export interface WorkflowLanePlanStage {
    key: string;
    generatedKey: string;
    agent?: string;
    phase?: string;
    label?: string;
    outputName?: string;
    structured?: boolean;
}
export interface WorkflowLanePlan {
    key: string;
    stages: WorkflowLanePlanStage[];
}
export interface WorkflowSteerOptions {
    mode?: "steer" | "follow_up" | "auto";
    index?: number;
    ackTimeoutMs?: number;
}
export interface WorkflowSteerResult {
    key: string;
    state: "queued" | "delivered" | "missed" | "failed";
    requestId?: string;
    deliveryStatus?: "queued" | "delivered";
    targets?: Array<{
        index: number;
        state: string;
        reason?: string;
    }>;
    error?: string;
}
export interface WorkflowReceiptResumeReference {
    workflowRunId: string;
    key: string;
    latest: true;
}
export interface WorkflowResolvedResumeReference {
    runId: string;
    runIds?: string[];
}
export interface WorkflowScriptResult {
    value: unknown;
    emits: unknown[];
    console: Array<{
        level: "log" | "info" | "warn" | "error";
        text: string;
    }>;
    trace: WorkflowScriptTraceEntry[];
    children: WorkflowScriptChildResult[];
}
export declare class WorkflowScriptError extends Error {
    readonly partial: Omit<WorkflowScriptResult, "value">;
    readonly errorKind?: WorkflowScriptFailureKind;
    constructor(message: string, partial: Omit<WorkflowScriptResult, "value">, errorKind?: WorkflowScriptFailureKind, options?: ErrorOptions);
}
export type WorkflowChildSettledOutcome = "completed" | "failed" | "paused" | "stopped";
export interface WorkflowChildSettledNotification {
    workflowRunId: string;
    childKey: string;
    childRunId?: string;
    outcome: WorkflowChildSettledOutcome;
    outputReference?: string;
    error?: string;
    workflowRunning: boolean;
    /** The script-visible result, exactly as returned to the script. */
    result: WorkflowScriptChildResult;
}
export interface RunWorkflowScriptOptions {
    script: string;
    /** Normalized raw-script input exposed as the deeply frozen sandbox global `args`. */
    args?: Readonly<Record<string, unknown>>;
    /** Parent-session cwd used to recover a stale process cwd. */
    processCwd?: string;
    /** Workflow run ID for notifications. Required when onChildSettled is provided. */
    workflowRunId?: string;
    /** Host-only first-slice admission context. It is never sent to the workflow worker. */
    oneUsePermit?: {
        claim: (key: string) => string | undefined;
    };
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Let an async workflow flush pure result assembly after reload once every child is terminal. */
    continueAfterAbortWhenChildrenSettled?: (abortError: Error) => boolean;
    /** Maximum children executing concurrently within this workflow. Defaults to 20. */
    globalConcurrencyLimit?: number;
    admit?: (calls: Array<{
        key: string;
        params: Record<string, unknown>;
    }>, signal: AbortSignal) => void | Promise<void>;
    launch: (key: string, params: Record<string, unknown>, signal: AbortSignal, admission: {
        admitted: boolean;
        batch: boolean;
    }) => Promise<WorkflowScriptChildResult>;
    resolveResume?: (reference: WorkflowReceiptResumeReference | string, signal: AbortSignal, index?: number) => string | WorkflowResolvedResumeReference | Promise<string | WorkflowResolvedResumeReference>;
    status: (keyOrRunId: string, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
    steer?: (key: string, message: string, options: WorkflowSteerOptions, signal: AbortSignal) => Promise<WorkflowSteerResult>;
    host?: (key: string, params: WorkflowHostCommandParams, signal: AbortSignal) => Promise<WorkflowHostCommandResult>;
    onHostStep?: (hostStep: HostStepNode) => void;
    state?: {
        get: (key: string) => unknown | Promise<unknown>;
        set: (key: string, value: unknown) => void | Promise<void>;
    };
    registerStopChild?: (stop: ((key: string, message?: string) => boolean) | undefined) => void;
    onTrace?: (trace: WorkflowScriptTraceEntry[]) => void;
    onLanePlan?: (lanes: WorkflowLanePlan[]) => void;
    onEmit?: (emits: unknown[]) => void;
    onChildSettled?: (notification: WorkflowChildSettledNotification) => void;
}
export declare function assertWorkflowJsonValue(value: unknown, path?: string, seen?: Set<object>): void;
export declare function formatWorkflowJsonPreview(value: unknown, maxLength: number): string | undefined;
export interface SimpleWorkflowRunPreview {
    agent?: string;
    task?: string;
}
/** Display-only preview for the exact simple `return runs.run(key, {...})` form. */
export declare function previewSimpleWorkflowRun(script: string | undefined): SimpleWorkflowRunPreview | undefined;
/** Canonical launch-params identity; matches the worker's stableRunJson(canonicalRunParams(params)). */
export declare function workflowRunParamsFingerprint(params: Record<string, unknown>): string;
/** Parse a workflowScript and apply only rules that are decidable from its local syntax. */
export declare function validateWorkflowScript(script: string, options?: WorkflowScriptValidationOptions): WorkflowScriptValidationResult;
export declare function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult>;
//# sourceMappingURL=scripted-workflow.d.ts.map