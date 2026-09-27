/**
 * Async execution logic for subagent tool
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type UnknownAgentDiagnosticContext } from "../../agents/agents.ts";
import { type ChainStep } from "../../shared/settings.ts";
import { type RunnerStep } from "../shared/parallel-utils.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { type AvailableModelInfo, type ModelOrigin, type ParentModel } from "../shared/model-resolution.ts";
import { type ModelScopeConfig } from "../shared/model-scope.ts";
import { type ThinkingLevel } from "../../shared/thinking-ceiling.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { type AcceptanceInput, type AgentContract, type ArtifactConfig, type Details, type IntercomBridgeConfig, type JsonSchemaObject, type MaxOutputConfig, type NestedRouteInfo, type ResolvedControlConfig, type ResolvedToolBudget, type RunFanoutBudgetDescriptor, type ToolBudgetConfig, type SubagentRunMode, type WorkflowLaneMetadata, type UsageBudgetConfig } from "../../shared/types.ts";
import { type ChildRuntimeConfig } from "../shared/child-runtime-config.ts";
import type { ImportedAsyncRoot } from "./chain-root-attachment.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";
import type { ActiveAsyncCapacityHandle } from "./active-async-capacity.ts";
import { type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { type PermissionConfig } from "../shared/permissions.ts";
import { type ExtensionBindings } from "../shared/extension-bindings.ts";
import { type RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
interface AsyncExecutionContext {
    pi: ExtensionAPI;
    cwd: string;
    currentSessionId: string;
    completionOwnerId?: string;
    /** Parent session id used by permission-system ask forwarding. */
    parentSessionId?: string;
    permissions?: PermissionConfig;
    currentModelProvider?: string;
    currentModel?: ParentModel;
    /** Optional model-scope enforcement resolved from subagent settings. */
    modelScope?: ModelScopeConfig;
    modelResponseAliases?: Record<string, string[]>;
    /** Whether the parent session has an interactive UI. */
    interactive?: boolean;
    /** The executor's own child runtime when the launch comes from an in-process child. */
    childRuntime?: ChildRuntimeConfig;
}
export declare const DEFAULT_ASYNC_TIMEOUT_MS: number;
interface AsyncChainParams {
    chain: ChainStep[];
    task?: string;
    /** Raw caller-facing goal used only by the started event. */
    goal?: string;
    attachRoot?: ImportedAsyncRoot & {
        agent: string;
        outputName?: string;
        label?: string;
    };
    resultMode?: SubagentRunMode;
    agents: AgentConfig[];
    /** Original discovery provenance, retained by normal callers for unknown-agent diagnostics. */
    unknownAgentDiagnosticContext?: UnknownAgentDiagnosticContext;
    ctx: AsyncExecutionContext;
    availableModels?: AvailableModelInfo[];
    cwd?: string;
    maxOutput?: MaxOutputConfig;
    machine?: string;
    /** Launch cwd as typed when a machine is set: a path on that machine, never resolved locally. */
    machineCwd?: string;
    artifactsDir?: string;
    artifactConfig: ArtifactConfig;
    shareEnabled: boolean;
    sessionRoot?: string;
    agentContract?: AgentContract;
    chainSkills?: string[];
    sessionFilesByFlatIndex?: (string | undefined)[];
    thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
    contextForAgent?: (agentName: string) => ContextMode;
    progressDir?: string;
    dynamicFanoutMaxItems?: number;
    maxSubagentDepth: number;
    waitToolEnabled?: boolean;
    waitToolDefaultTimeoutMs?: number;
    worktreeSetupHook?: string;
    worktreeSetupHookTimeoutMs?: number;
    worktreeBaseDir?: string;
    baseRef?: string;
    worktreeProvider?: import("../../shared/types.ts").WorktreeProvider;
    worktreeBranchPrefix?: string;
    controlConfig?: ResolvedControlConfig;
    controlIntercomTarget?: string;
    childIntercomTarget?: (agent: string, index: number) => string | undefined;
    nestedRoute?: NestedRouteInfo;
    acceptance?: AcceptanceInput;
    fast?: boolean;
    timeoutMs?: number;
    toolBudget?: ResolvedToolBudget;
    usageBudget?: UsageBudgetConfig;
    configToolBudget?: ResolvedToolBudget;
    /** Optional per-call hard toolTimeoutMs override (highest precedence). */
    callToolTimeoutMs?: number;
    /** Global config.toolTimeoutMs (third precedence, after agent frontmatter). */
    configToolTimeoutMs?: number;
    /** PI_SUBAGENT_TOOL_TIMEOUT_MS override (lowest precedence). */
    toolTimeoutMsEnv?: string | undefined;
    /** Global cap on simultaneously-running subagent tasks within the async run. */
    globalConcurrencyLimit?: number;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    thinkingCeiling?: ThinkingLevel;
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    parentWorkflowRunId?: string;
    workflowKey?: string;
    lane?: WorkflowLaneMetadata;
    activeAsyncCapacity?: ActiveAsyncCapacityHandle;
}
interface AsyncSingleParams {
    agent: string;
    task?: string;
    /** Raw caller-facing goal used only by the started event. */
    goal?: string;
    agentConfig: AgentConfig;
    /** Agent contract before per-run bridge injection, used only for recovery persistence. */
    recoveryAgentConfig?: AgentConfig;
    requiredExtensions?: RequiredChildExtensionSnapshot;
    ctx: AsyncExecutionContext;
    cwd?: string;
    requestedCwd?: string;
    machine?: string;
    /** Launch cwd as typed when a machine is set: a path on that machine, never resolved locally. */
    machineCwd?: string;
    maxOutput?: MaxOutputConfig;
    artifactsDir?: string;
    artifactConfig: ArtifactConfig;
    shareEnabled: boolean;
    sessionRoot?: string;
    sessionDir?: string;
    sessionFile?: string;
    revivalLease?: SessionLeaseRequest;
    context?: ContextMode;
    skills?: string[];
    output?: string | boolean;
    reads?: string[] | false;
    outputMode?: "inline" | "file-only";
    outputBaseDir?: string;
    outputClaimPath?: string;
    agentContract?: AgentContract;
    structuredOutputSchema?: JsonSchemaObject;
    modelOverride?: string;
    modelOverrideFromParent?: boolean;
    modelOrigin?: ModelOrigin;
    fast?: boolean;
    thinkingOverride?: AgentConfig["thinking"];
    availableModels?: AvailableModelInfo[];
    maxSubagentDepth: number;
    waitToolEnabled?: boolean;
    waitToolDefaultTimeoutMs?: number;
    worktreeSetupHook?: string;
    worktreeSetupHookTimeoutMs?: number;
    worktreeBaseDir?: string;
    baseRef?: string;
    worktreeProvider?: import("../../shared/types.ts").WorktreeProvider;
    worktreeBranchPrefix?: string;
    worktree?: boolean;
    controlConfig?: ResolvedControlConfig;
    intercomBridge?: IntercomBridgeConfig;
    controlIntercomTarget?: string;
    childIntercomTarget?: (agent: string, index: number) => string | undefined;
    nestedRoute?: NestedRouteInfo;
    acceptance?: AcceptanceInput;
    timeoutMs?: number;
    absoluteDeadlineAt?: number;
    /** Optional per-call hard toolTimeoutMs override (highest precedence). */
    toolTimeoutMs?: number;
    /** Steer the child to checkpoint and stop this many ms before the run deadline (resolved call param ?? config). */
    checkpointBeforeDeadlineMs?: number;
    toolBudget?: ResolvedToolBudget | ToolBudgetConfig;
    usageBudget?: UsageBudgetConfig;
    configToolBudget?: ResolvedToolBudget;
    /** Global config.toolTimeoutMs (third precedence, after agent frontmatter). */
    configToolTimeoutMs?: number;
    /** PI_SUBAGENT_TOOL_TIMEOUT_MS override (lowest precedence). */
    toolTimeoutMsEnv?: string | undefined;
    allowZeroToolBudget?: boolean;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    thinkingCeiling?: ThinkingLevel;
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    parentWorkflowRunId?: string;
    workflowKey?: string;
    lane?: WorkflowLaneMetadata;
    workflowAwaitAsync?: boolean;
    activeAsyncCapacity?: ActiveAsyncCapacityHandle;
    externalJobFollowUp?: {
        sourceRunId: string;
        sourceStepIndex: number;
        parentProviderJobId: string;
        requestId: string;
        requestDigest: string;
    };
    extensionBindings?: ExtensionBindings;
}
interface AsyncExecutionResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Details;
    isError?: boolean;
}
export interface AsyncRunnerStepBuildParams {
    chain: ChainStep[];
    task?: string;
    attachRoot?: ImportedAsyncRoot & {
        agent: string;
        outputName?: string;
        label?: string;
    };
    resultMode?: SubagentRunMode;
    agents: AgentConfig[];
    /** Exact discovery provenance for failed resolution; omission triggers defensive fallback discovery. */
    unknownAgentDiagnosticContext?: UnknownAgentDiagnosticContext;
    ctx: AsyncExecutionContext;
    availableModels?: AvailableModelInfo[];
    cwd?: string;
    machine?: string;
    machineCwd?: string;
    chainSkills?: string[];
    sessionFilesByFlatIndex?: (string | undefined)[];
    thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
    contextForAgent?: (agentName: string) => ContextMode;
    progressDir?: string;
    agentContract?: AgentContract;
    dynamicFanoutMaxItems?: number;
    maxSubagentDepth: number;
    waitToolEnabled?: boolean;
    waitToolDefaultTimeoutMs?: number;
    worktreeBaseDir?: string;
    worktreeProvider?: import("../../shared/types.ts").WorktreeProvider;
    worktreeBranchPrefix?: string;
    asyncDir: string;
    outputBaseDir?: string;
    validateOutputBindings?: boolean;
    fast?: boolean;
    toolBudget?: ResolvedToolBudget;
    configToolBudget?: ResolvedToolBudget;
    /** Optional per-call hard toolTimeoutMs override from the subagent invocation. */
    callToolTimeoutMs?: number;
    /** Global config.toolTimeoutMs (third precedence, after agent frontmatter). */
    configToolTimeoutMs?: number;
    /** PI_SUBAGENT_TOOL_TIMEOUT_MS override (lowest precedence). */
    toolTimeoutMsEnv?: string | undefined;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    thinkingCeiling?: ThinkingLevel;
}
export type AsyncRunnerStepBuildResult = {
    steps: RunnerStep[];
    runnerCwd: string;
    workflowGraph: ReturnType<typeof buildWorkflowGraphSnapshot>;
    eventChain: ChainStep[];
    originalTask?: string;
} | {
    error: string;
};
export declare function formatAsyncStartedMessage(headline: string, interactive: boolean): string;
/** Check whether detached async execution has a supported runtime. */
export declare function isAsyncAvailable(): boolean;
export declare function resolveAsyncRunnerLogPaths(cfg: object): {
    stdoutPath: string;
    stderrPath: string;
} | undefined;
export declare function emitProcessTerminalEvent(ctx: AsyncExecutionContext, proof: unknown): void;
export declare function buildAsyncRunnerSteps(id: string, params: AsyncRunnerStepBuildParams): AsyncRunnerStepBuildResult;
/**
 * Execute a chain asynchronously
 */
export declare function executeAsyncChain(id: string, params: AsyncChainParams): AsyncExecutionResult;
/**
 * Execute a single agent asynchronously
 */
export declare function workflowAwaitedAsyncResultPath(asyncDir: string): string;
export declare function executeAsyncSingle(id: string, params: AsyncSingleParams): AsyncExecutionResult | Promise<AsyncExecutionResult>;
export {};
//# sourceMappingURL=async-execution.d.ts.map