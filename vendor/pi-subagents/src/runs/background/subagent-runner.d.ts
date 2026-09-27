import { type SteerRequest } from "./control-channel.ts";
import { type ArtifactConfig, type ExternalCliRunnerStatus, type ExternalJobRunnerStatus, type ExternalJobStatus, type ExternalProcessStatus, type ArtifactPaths, type ChainOutputMap, type CostSummary, type LaunchResolvedChildExtensions, type RuntimeAcknowledgedChildExtensions, type NestedRouteInfo, type ResolvedControlConfig, type ResolvedToolBudget, type RunFanoutBudgetDescriptor, type SubagentRunMode, type SubagentOutputState, type UsageBudgetConfig, type ToolBudgetState, type Usage, type WorkflowGraphSnapshot, type WorkflowLaneMetadata, type MaxOutputConfig } from "../../shared/types.ts";
import { type RunnerSubagentStep as SubagentStep, type RunnerStep } from "../shared/parallel-utils.ts";
import type { InheritedChildRuntime } from "../shared/child-launch.ts";
import type { ChildSessionFactory, DefaultChildSessionFactoryOptions } from "../shared/child-session.ts";
import { type ChildEvent, type SteerDelivery, type StepSteerHandler } from "./run-child-session.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";
import { createHerdrExternalAdapter, type HerdrExternalAdapterId, type HerdrExternalResult } from "../shared/herdr-external-adapters.ts";
import { type OrcaProgressTab } from "../shared/orca-progress-tabs.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
export interface SubagentRunConfig {
    id: string;
    steps: RunnerStep[];
    resultPath: string;
    cwd: string;
    placeholder: string;
    taskIndex?: number;
    totalTasks?: number;
    maxOutput?: MaxOutputConfig;
    artifactsDir?: string;
    artifactConfig?: Partial<ArtifactConfig>;
    share?: boolean;
    sessionDir?: string;
    asyncDir: string;
    sessionId?: string | null;
    completionOwnerId?: string;
    piPackageRoot?: string;
    /** Test seam: module the runner imports its `ChildSessionFactory` from. */
    childSessionFactoryModule?: string;
    /** The launching executor's own child runtime when it was itself an in-process child. */
    inheritedChildRuntime?: InheritedChildRuntime;
    worktreeSetupHook?: string;
    worktreeSetupHookTimeoutMs?: number;
    worktreeBaseDir?: string;
    baseRef?: string;
    worktreeProvider?: import("../../shared/types.ts").WorktreeProvider;
    worktreeBranchPrefix?: string;
    controlConfig?: ResolvedControlConfig;
    controlIntercomTarget?: string;
    childIntercomTargets?: Array<string | undefined>;
    resultMode?: SubagentRunMode;
    mode?: SubagentRunMode;
    dynamicFanoutMaxItems?: number;
    workflowGraph?: WorkflowGraphSnapshot;
    nestedRoute?: NestedRouteInfo;
    nestedSelf?: {
        parentRunId: string;
        parentStepIndex?: number;
        depth: number;
        path?: Array<{
            runId: string;
            stepIndex?: number;
            agent?: string;
        }>;
    };
    timeoutMs?: number;
    deadlineAt?: number;
    /** Resolved configured hard per-tool-call timeout (ms); fast tools still have a default when undefined. */
    toolTimeoutMs?: number;
    /** Steer the running steps to checkpoint and stop this many ms before `deadlineAt`; absent = no checkpoint steer. */
    checkpointBeforeDeadlineMs?: number;
    toolBudget?: ResolvedToolBudget;
    usageBudget?: UsageBudgetConfig;
    revivalLease?: SessionLeaseRequest;
    revivalLeaseToken?: string;
    /** Global cap on simultaneously-running subagent tasks within this run. */
    globalConcurrencyLimit?: number;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    /** Builtin tool names the host runtime provides; used to intersect agent-declared tools. */
    launchContractDigest?: string;
    launchResolvedExtensions?: LaunchResolvedChildExtensions;
    runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
    runnerProcessInstanceId?: string;
    launchBarrierToken?: string;
    parentWorkflowRunId?: string;
    workflowKey?: string;
    lane?: WorkflowLaneMetadata;
}
interface StepResult {
    agent: string;
    /** Human-readable display name for the child session, when derived at launch. */
    sessionName?: string;
    context?: "fresh" | "fork";
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    capabilityAudit?: import("../shared/capability-ceiling.ts").SubagentCapabilityAudit;
    launchResolvedExtensions?: LaunchResolvedChildExtensions;
    runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
    output: string;
    outputState?: SubagentOutputState;
    error?: string;
    success?: boolean;
    exitCode: number | null;
    usage?: Usage;
    savedOutputPath?: string;
    skipped?: boolean;
    interrupted?: boolean;
    detached?: boolean;
    timedOut?: boolean;
    stopped?: boolean;
    processSignal?: string | null;
    timeoutRecovery?: import("../../shared/types.ts").TimeoutRecoverySummary;
    toolBudget?: ToolBudgetState;
    toolBudgetBlocked?: boolean;
    sessionFile?: string;
    intercomTarget?: string;
    model?: string;
    nativeMachine?: import("../../shared/types.ts").SingleResult["nativeMachine"];
    thinking?: string;
    requestedModel?: string;
    /** True when the dispatch failed because the input exceeded the model's context window. */
    contextOverflow?: boolean;
    totalCost?: CostSummary;
    artifactPaths?: ArtifactPaths;
    outputSaveError?: string;
    artifactOutputSaveFailed?: true;
    metadataSaveError?: string;
    truncated?: boolean;
    transcriptPath?: string;
    transcriptError?: string;
    agentContract?: import("../../shared/types.ts").AgentContract;
    launchContractDigest?: string;
    execution?: import("../../shared/types.ts").ExecutionProjection;
    review?: import("../../shared/types.ts").ReviewProjection;
    effects?: import("../../shared/types.ts").EffectsProjection;
    structuredOutput?: unknown;
    structuredOutputFailed?: boolean;
    structuredOutputPath?: string;
    structuredOutputSchemaPath?: string;
    acceptance?: import("../../shared/types.ts").AcceptanceLedger;
    watchdog?: import("../../shared/types.ts").ChildWatchdogProgress;
    runner?: ExternalCliRunnerStatus | ExternalJobRunnerStatus;
    externalProcess?: ExternalProcessStatus;
    externalJob?: ExternalJobStatus;
}
/** Context for running a single step */
interface SingleStepContext {
    previousOutput: string;
    outputs?: ChainOutputMap;
    placeholder: string;
    cwd: string;
    sessionEnabled: boolean;
    sessionDir?: string;
    artifactsDir?: string;
    artifactConfig?: Partial<ArtifactConfig>;
    id: string;
    flatIndex: number;
    flatStepCount: number;
    outputFile: string;
    transcriptPath?: string;
    piPackageRoot?: string;
    /** Factory the runner creates this step's child session through. */
    childSessions: ChildSessionFactory;
    /** The launching executor's own child runtime; nested route, depth, and ceilings come from here. */
    inheritedChildRuntime?: InheritedChildRuntime;
    registerInterrupt?: (interrupt: (() => void) | undefined) => void;
    registerTimeout?: (interrupt: (() => void) | undefined) => void;
    registerStop?: (stop: (() => void) | undefined) => void;
    /** Receives the live child's steer handler while its session runs. */
    registerSteer?: (steer: StepSteerHandler | undefined) => void;
    /** Reports a live child's later steer consumption or unconsumed settlement. */
    onSteerOutcome?: (request: SteerRequest, delivery: SteerDelivery) => void;
    timeoutSignal?: AbortSignal;
    stopSignal?: AbortSignal;
    timeoutMessage?: string;
    stopMessage?: string;
    /** Resolved configured hard per-tool-call timeout (ms); fast tools still have a default when undefined. */
    toolTimeoutMs?: number;
    /** Effective step deadline (Date.now() + effective timeout) when a run budget exists. */
    deadlineAt?: number;
    childIntercomTarget?: string;
    orchestratorIntercomTarget?: string;
    nestedRoute?: NestedRouteInfo;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    onAttemptStart?: (attempt: {
        model?: string;
        thinking?: string;
        contextLimit?: number;
    }) => void;
    onChildEvent?: (event: ChildEvent) => void;
    onExternalProcess?: (process: ExternalProcessStatus) => void;
    prepareExternalActivity?: (cwd: string, signal: AbortSignal) => Promise<void>;
    onExternalStreamActivity?: () => void;
    onExternalJob?: (status: ExternalJobStatus) => void;
    skipAcceptance?: () => boolean;
    /** Authoritative owner decision after event delivery; undefined includes incomplete run-wide usage. */
    usageBudgetExhausted?: () => boolean | undefined;
    /** Existing run-owned budget configuration; cost allowance is not settled by the live token ledger. */
    usageBudget?: UsageBudgetConfig;
    orcaProgressTab?: OrcaProgressTab;
}
export declare function settleHerdrExternalRunnerError(error: unknown, adapter: HerdrExternalAdapterId, evidence: Parameters<ReturnType<typeof createHerdrExternalAdapter>["normalize"]>[0], retain: () => Promise<void>): Promise<HerdrExternalResult>;
export declare function runSingleStepInner(step: SubagentStep, ctx: SingleStepContext): Promise<StepResult>;
export declare function runSubagent(config: SubagentRunConfig, childSessions: ChildSessionFactory): Promise<void>;
/** Heavy execution entry loaded by the bootstrap only after startup commits. */
export declare function runConfiguredSubagentExecution(config: SubagentRunConfig, options?: DefaultChildSessionFactoryOptions): Promise<void>;
export {};
//# sourceMappingURL=subagent-runner.d.ts.map