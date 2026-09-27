import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentDiscoveryDiagnostic, type AgentScope, type UnknownAgentDiagnosticContext } from "../../agents/agents.ts";
import type { MainWatchdogRuntime } from "../../watchdog/runtime.ts";
import { type ModelOrigin } from "../shared/model-resolution.ts";
import { type ModelScopeConfig } from "../shared/model-scope.ts";
import { type ChainStep } from "../../shared/settings.ts";
import { DEFAULT_ASYNC_TIMEOUT_MS } from "../background/async-execution.ts";
import { type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { type ExtensionBindings } from "../shared/extension-bindings.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { type SteerDeliveryMode } from "../background/control-channel.ts";
import { steerAsyncRun } from "./async-steering-action.ts";
import type { ChildRuntimeConfig } from "../shared/child-runtime-config.ts";
import { type MissionLaunchBinding } from "../../missions/lifecycle.ts";
import { type WorkflowSteerOptions, type WorkflowSteerResult } from "../../workflows/scripted-workflow.ts";
import { type AcceptanceInput, type AgentContract, type ControlConfig, type Details, type ExtensionConfig, type IntercomBridgeConfig, type JsonSchemaObject, type MaxOutputConfig, type ResolvedControlConfig, type RunFanoutBudgetDescriptor, type SteeringRecoveryDescriptor, type SingleResult, type ToolBudgetConfig, type UsageBudgetConfig, type SubagentState, type ScheduleOrigin } from "../../shared/types.ts";
export declare function unknownSubagentActionMessage(action: string): string;
interface TaskParam {
    agent: string;
    task: string;
    cwd?: string;
    machine?: string;
    count?: number;
    output?: string | boolean;
    outputMode?: "inline" | "file-only";
    reads?: string[] | boolean;
    progress?: boolean;
    model?: string;
    fast?: boolean;
    skill?: string | string[] | boolean;
    outputSchema?: JsonSchemaObject | false;
    acceptance?: AcceptanceInput;
    agentContract?: AgentContract;
    toolBudget?: ToolBudgetConfig;
}
export interface SubagentParamsLike {
    action?: string;
    id?: string;
    runId?: string;
    dir?: string;
    handoffPath?: string;
    laneId?: string;
    merge?: unknown;
    supersession?: unknown;
    index?: number;
    childId?: string;
    view?: "fleet" | "transcript";
    lines?: number;
    topic?: string;
    chainName?: string;
    config?: unknown;
    name?: string;
    type?: string;
    agent?: string;
    task?: string;
    capabilities?: boolean;
    extensionBindings?: ExtensionBindings;
    /** Retained async child run id. Valid only on workflow runs.run items. */
    resume?: string;
    message?: string;
    steeringRecovery?: boolean;
    mode?: SteerDeliveryMode | "plan" | "apply";
    repo?: string;
    planId?: string;
    workflowScript?: string;
    workflowScriptPath?: string;
    globalConcurrencyLimit?: number;
    maxSubagentSpawnsPerRun?: number;
    preflight?: import("../../shared/types.ts").WorkflowPreflight;
    chatProgress?: "auto" | "off" | "live-card";
    isolation?: "none" | "worktree";
    step?: ChainStep;
    /** Internal workflow ownership metadata; not part of the public schema. */
    workflowParentRunId?: string;
    workflowKey?: string;
    lane?: import("../../shared/types.ts").WorkflowLaneMetadata;
    /** Set by the scheduler so this run's completion can name the schedule that produced it. */
    scheduleOrigin?: ScheduleOrigin;
    workflowChildAsyncId?: string;
    workflowAwaitAsync?: boolean;
    /** Internal async-workflow bridge: keep the live VM await pending across supervisor detachment. */
    workflowAwaitDetached?: boolean;
    workflowParentDeadlineAt?: number;
    workflowOutputClaimPath?: string;
    suppressRoutineResultIntercom?: boolean;
    /** Internal inherited cumulative run-tree budget. */
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    /** Internal workflow host admission proof. */
    runFanoutAdmitted?: boolean;
    /** Internal inherited tool/agent ceiling for delegated child launches. */
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    /** Internal durable-run compatibility fields. Public callers must use workflowScript. */
    chain?: ChainStep[];
    tasks?: TaskParam[];
    concurrency?: number;
    worktree?: boolean;
    /** Git ref used as the managed worktree base. */
    baseRef?: string;
    context?: "fresh" | "fork" | "profile";
    /** Per-run intercom bridge config. It replaces the global config for this launch only. */
    intercomBridge?: IntercomBridgeConfig;
    async?: boolean;
    foregroundOnly?: boolean;
    timeoutMs?: number;
    maxRuntimeMs?: number;
    /** Async runs only: steer the child to checkpoint and stop this many ms before the run deadline. */
    checkpointBeforeDeadlineMs?: number;
    /** Optional hard per-tool-call timeout (ms). Known-fast tools also have a default. */
    toolTimeoutMs?: number;
    toolBudget?: ToolBudgetConfig;
    usageBudget?: UsageBudgetConfig;
    clarify?: boolean;
    share?: boolean;
    control?: ControlConfig;
    sessionDir?: string;
    cwd?: string;
    machine?: string;
    /** Internal: the typed cwd when a machine is set, kept as a remote path and never resolved locally. */
    machineCwd?: string;
    maxOutput?: MaxOutputConfig;
    artifacts?: boolean;
    includeProgress?: boolean;
    model?: string;
    /** Internal recovery provenance for a resolved model override. */
    modelOrigin?: ModelOrigin;
    fast?: boolean;
    thinking?: string | false;
    /** Public named workflow resource. Resolved before entering the workflow sandbox. */
    workflow?: string;
    args?: Record<string, unknown>;
    scope?: string;
    target?: string;
    focus?: boolean;
    skill?: string | string[] | boolean;
    output?: string | boolean;
    /** Internal-only; not part of the public tool schema. Wired for single-run reads (chain steps use their own field). */
    reads?: string[] | false;
    outputMode?: "inline" | "file-only";
    outputSchema?: JsonSchemaObject | false;
    agentScope?: unknown;
    chainDir?: string;
    acceptance?: AcceptanceInput;
    gate?: string;
    agentContract?: AgentContract;
    at?: string;
    every?: string;
    sessionOnly?: boolean;
    quiet?: boolean;
    on?: string | number;
    timezone?: string;
    overlap?: "skip";
    catchUp?: "none" | "latest";
    additional?: number;
    missionId?: string;
    mission?: unknown;
    missionUpdate?: unknown;
    missionStatus?: string;
    missionScope?: string;
    runMode?: string;
    runStatus?: string;
    summary?: string;
}
interface ExecutorDeps {
    pi: ExtensionAPI;
    state: SubagentState;
    config: ExtensionConfig;
    asyncByDefault: boolean;
    waitToolEnabled?: boolean;
    waitToolDefaultTimeoutMs?: number;
    handleScheduledRunAction?: (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
    watchdog?: MainWatchdogRuntime;
    tempArtifactsDir: string;
    getSubagentSessionRoot: (parentSessionFile: string | null) => string;
    expandTilde: (p: string) => string;
    discoverAgents: (cwd: string, scope: AgentScope, preferredModelProvider?: string) => {
        agents: AgentConfig[];
        agentDiagnostics?: AgentDiscoveryDiagnostic[];
        modelScope?: ModelScopeConfig;
        maxThinking?: AgentConfig["maxThinking"];
        cwd?: string;
        scope?: AgentScope;
        directories?: UnknownAgentDiagnosticContext["directories"];
    };
    onAgentsChanged?: () => void;
    allowMutatingManagementActions?: boolean;
    activateSupervisorTransport?: () => void;
    findPendingAsks?: Parameters<typeof steerAsyncRun>[0]["findPendingAsks"];
    refreshResultDelivery?: () => void;
    trackRetainedNestedRoute?: (rootRunId: string) => void;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    /** Set when this executor runs inside a child session; carries the runtime settings the host passes instead of environment variables. */
    childRuntime?: ChildRuntimeConfig;
}
export declare function removeForegroundControlIfIdle(state: SubagentState, runId: string, trackRetainedNestedRoute?: (rootRunId: string) => void): boolean;
export declare function promptAuditRedoParams(value: unknown, rewrittenTask: string): SubagentParamsLike;
export declare function readNestedRecoveryDescriptor(asyncDir: string | undefined, runId: string, agent: string): SteeringRecoveryDescriptor | undefined;
export declare function foregroundResultIntercomStatus(result: SingleResult): ReturnType<typeof resolveSubagentResultStatus>;
export declare function shouldSuppressRoutineResultIntercom(input: {
    suppressRoutineResultIntercom?: boolean;
    results: SingleResult[];
}): boolean;
export declare const DEFAULT_FOREGROUND_TIMEOUT_MS: number;
export { DEFAULT_ASYNC_TIMEOUT_MS };
/**
 * Resolve the optional global default runtime deadline from extension config
 * (`config.timeoutMs`). Returns undefined for unset or invalid values so callers
 * fall back to the built-in defaults. "Invalid" covers non-positive-integer
 * values and values above `MAX_TIMER_DELAY_MS`; the latter would overflow the
 * Node.js timer and expire the run almost immediately instead of running long.
 */
export declare function resolveConfigDefaultTimeoutMs(raw: unknown): number | undefined;
export declare function resolveForegroundTimeout(params: SubagentParamsLike, defaultTimeoutMs?: number): {
    timeoutMs?: number;
    error?: string;
};
/**
 * Resolve the effective launch timeout for a single-agent run, applying the
 * async/foreground default when neither the caller nor the agent set one.
 *
 * A global config default (`config.timeoutMs`, passed as `configDefaultTimeoutMs`)
 * replaces the built-in 30-minute backstop wherever a concrete default is applied.
 * The async default is deliberately applied only to plain single-agent launches.
 * Composite launches keep their top-level execution unbounded when no timeout is
 * set — even with a config default — while their runner children resolve separate
 * deadlines. Exported so the executor wiring is directly testable.
 */
export declare function resolveSingleAgentLaunchTimeout(params: SubagentParamsLike, async: boolean, configDefaultTimeoutMs?: number): {
    timeoutMs?: number;
    error?: string;
};
export declare function sanitizeRunPathSegment(value: string, maxBytes?: number): string;
export declare function resolveWorkflowChildLocalCwd(input: {
    workflowCwd: string;
    discoverAgents: (cwd: string, scope: AgentScope) => {
        agents: AgentConfig[];
    };
    agents: AgentConfig[];
    workflowAgentScope?: unknown;
    params: Record<string, unknown>;
}): string;
export declare function missionWorkflowChildStatus(result: AgentToolResult<Details>): string;
export declare function runMissionWorkflowChild(binding: MissionLaunchBinding | undefined, workflowRunId: string, key: string, phase: string | undefined, run: () => Promise<AgentToolResult<Details>>): Promise<AgentToolResult<Details>>;
export declare function bindMissionWorkflowChildAsyncLaunch(params: SubagentParamsLike, binding: MissionLaunchBinding | undefined, asyncByDefault: boolean, asyncId?: string, nestedRootRunId?: string): SubagentParamsLike;
export declare function steerWorkflowChildByKey(input: {
    state: SubagentState;
    workflowRunId: string;
    key: string;
    message: string;
    options: WorkflowSteerOptions;
    signal?: AbortSignal;
    asyncDirRoot?: string;
    resolveRunId?: () => string | undefined;
}): Promise<WorkflowSteerResult>;
export declare function preflightWorkflowWorktrees(input: {
    workflowDefaults: SubagentParamsLike;
    defaultWorktree?: boolean;
    calls: Array<{
        key: string;
        params: Record<string, unknown>;
    }>;
    ctxCwd: string;
    signal: AbortSignal;
    deadlineAt?: number;
}): Promise<void>;
export declare function prepareWorkflowLaunchParams(workflowDefaults: SubagentParamsLike, childParams: Record<string, unknown>, parentWorkflowRunId: string, workflowKey: string, options?: {
    missionDetached?: boolean;
    suppressRoutineResultIntercom?: boolean;
    awaitDetachedChild?: boolean;
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    parentDeadlineAt?: number;
    externalAsyncRequired?: boolean;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    outputClaimPath?: string;
}): SubagentParamsLike;
export declare function resolveRevivalControlConfig(input: {
    globalConfig?: ControlConfig;
    requestedControl?: ControlConfig;
    recoveryControlConfig?: ResolvedControlConfig;
}): ResolvedControlConfig;
export declare function createSubagentExecutor(deps: ExecutorDeps): {
    execute: (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((r: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
    /** Public/model-facing execution boundary. Internal direct launch primitives use execute or executeDelegated. */
    executePublic: (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((r: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
    /**
     * Correlated extension-to-extension delegation owns its request IDs and
     * cancellation controllers, so independent requests may execute concurrently.
     * The ordinary model-facing tool keeps the one-foreground-call-per-turn guard.
     */
    executeDelegated: (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((r: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
    /** Scheduled launches retain their owning context without replacing the live active session. */
    executeScheduled: (id: string, params: SubagentParamsLike, signal: AbortSignal, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
    /** Scheduled state visible to the current runtime supervisor owner only. */
    getCurrentSupervisorOwnerStates: () => Iterable<SubagentState>;
};
//# sourceMappingURL=subagent-executor.d.ts.map