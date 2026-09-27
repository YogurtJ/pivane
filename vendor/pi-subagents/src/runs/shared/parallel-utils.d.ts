export type ResolvedRunnerConfig = import("../../shared/types.ts").AgentRunnerConfig;
export interface RunnerSubagentStep {
    /** Session id of the direct parent session for permission-system ask forwarding. */
    parentSessionId?: string;
    /** Resolved opt-in rules for native Pi child tool calls. */
    permissionRules?: import("./permissions.ts").PermissionRules;
    agent: string;
    /** Human-readable display name for the child session, derived internally at launch. */
    sessionName?: string;
    task: string;
    runner?: ResolvedRunnerConfig;
    /** Herdr saved machine this external-cli step runs on; `cwd` is then the directory on that machine. */
    machine?: import("../../shared/types.ts").HerdrMachineReference;
    remoteReads?: string[] | false;
    machineEnv?: Record<string, string>;
    externalJobFollowUp?: {
        sourceRunId: string;
        sourceStepIndex: number;
        parentProviderJobId: string;
        requestId: string;
        requestDigest: string;
    };
    /** Resolved launch context for this child. */
    context?: "fresh" | "fork";
    importAsyncRoot?: {
        runId: string;
        asyncDir: string;
        resultPath: string;
        index: number;
    };
    phase?: string;
    label?: string;
    outputName?: string;
    structured?: boolean;
    cwd?: string;
    /** Original cwd input retained for launch diagnostics. */
    requestedCwd?: string;
    model?: string;
    contextLimit?: number;
    fast?: boolean;
    thinking?: string;
    thinkingCeiling?: import("../../shared/model-info.ts").ThinkingLevel;
    requestedModel?: string;
    /** The primary model is inherited from the parent session and should not be verified against the child-reported active registry model. */
    skipPrimaryModelVerification?: boolean;
    modelVerificationRegistry?: Array<{
        provider: string;
        id: string;
        fullId: string;
        contextWindow?: number;
    }>;
    modelResponseAliases?: Record<string, string[]>;
    tools?: string[];
    excludeTools?: string[];
    allowNestedSubagents?: boolean;
    /** Resolved selected-agent policy for launches made by this child. */
    allowedAgents?: string[];
    extensions?: string[];
    subagentOnlyExtensions?: string[];
    /** Private immutable host policy snapshot serialized to the native runner. */
    requiredExtensions?: import("../../shared/required-child-extensions.ts").RequiredChildExtensionSnapshot;
    mcpDirectTools?: string[];
    mutationTools?: string[];
    systemPrompt?: string | null;
    systemPromptMode?: "append" | "replace";
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    skills?: string[];
    outputPath?: string;
    outputClaimPath?: string;
    /** Defer the authoritative output instruction until a dynamic fanout item is materialized. */
    namespaceOutputPath?: boolean;
    outputMode?: "inline" | "file-only";
    sessionFile?: string;
    maxSubagentDepth?: number;
    timeoutMs?: number;
    /** Resolved configured hard per-tool-call timeout (ms); fast tools still have a default when undefined. */
    toolTimeoutMs?: number;
    waitToolEnabled?: boolean;
    waitToolDefaultTimeoutMs?: number;
    structuredOutput?: import("./structured-output.ts").StructuredOutputRuntime;
    structuredOutputSchema?: import("../../shared/types.ts").JsonSchemaObject;
    agentContract?: import("../../shared/types.ts").AgentContract;
    definitionDigest?: string;
    launchBindingTask?: string;
    launchContractDigest?: string;
    extensionBindings?: import("./extension-bindings.ts").ExtensionBindings;
    launchResolvedExtensions?: import("../../shared/types.ts").LaunchResolvedChildExtensions;
    runtimeAcknowledgedExtensions?: import("../../shared/types.ts").RuntimeAcknowledgedChildExtensions;
    effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
    acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
    acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
    gateOn?: import("../../shared/types.ts").ChainGateLayer;
    toolBudget?: import("../../shared/types.ts").ResolvedToolBudget;
    capabilityCeiling?: import("./capability-ceiling.ts").ResolvedSubagentCapabilityCeiling;
    capabilityAudit?: import("./capability-ceiling.ts").SubagentCapabilityAudit;
    /** Private stable logical-child path for inherited run fan-out accounting. */
    runFanoutPath?: string;
    /** Run this single child in one managed worktree. */
    worktree?: boolean;
    /** Bounded launch-declared lane metadata; display/triage only. */
    lane?: import("../../shared/types.ts").WorkflowLaneMetadata;
}
export interface ParallelStepGroup {
    parallel: RunnerSubagentStep[];
    concurrency?: number;
    failFast?: boolean;
    worktree?: boolean;
}
export interface DynamicRunnerGroup {
    expand: import("../../shared/settings.ts").DynamicExpandSpec;
    parallel: RunnerSubagentStep;
    collect: import("../../shared/settings.ts").DynamicCollectSpec;
    concurrency?: number;
    failFast?: boolean;
    phase?: string;
    label?: string;
    sessionFiles?: (string | undefined)[];
    thinkingOverrides?: (string | undefined)[];
    effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
    acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
    acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
    agentContract?: import("../../shared/types.ts").AgentContract;
    gateOn?: import("../../shared/types.ts").ChainGateLayer;
    capabilityCeiling?: import("./capability-ceiling.ts").ResolvedSubagentCapabilityCeiling;
    capabilityAudit?: import("./capability-ceiling.ts").SubagentCapabilityAudit;
    thinkingCeiling?: import("../../shared/model-info.ts").ThinkingLevel;
}
export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | DynamicRunnerGroup;
export declare function isParallelGroup(step: RunnerStep): step is ParallelStepGroup;
export declare function isDynamicRunnerGroup(step: RunnerStep): step is DynamicRunnerGroup;
export declare function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[];
export declare const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20;
/**
 * A promise-based semaphore for limiting concurrent access across multiple
 * mapConcurrent calls within a single run. Enforces a global cap on the total
 * number of subagent tasks executing simultaneously, regardless of each step's
 * per-step concurrency limit.
 */
export declare class Semaphore {
    private available;
    private readonly queue;
    constructor(limit: number);
    acquire(): Promise<void>;
    release(): void;
}
export declare function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>, globalSemaphore?: Semaphore, 
/** Invoked after every worker has stopped, including workers outliving an early rejection. */
onSchedulingSettled?: () => void): Promise<R[]>;
export interface ParallelTaskResult {
    agent: string;
    taskIndex?: number;
    output: string;
    exitCode: number | null;
    error?: string;
    timedOut?: boolean;
    model?: string;
    outputTargetPath?: string;
    outputTargetExists?: boolean;
}
export declare function aggregateParallelOutputs(results: ParallelTaskResult[], headerFormat?: (index: number, agent: string) => string): string;
export declare const MAX_PARALLEL_CONCURRENCY = 4;
//# sourceMappingURL=parallel-utils.d.ts.map