/**
 * Chain behavior, template resolution, and directory management
 */
import { type AgentConfig, type AgentScope, type UnknownAgentDiagnosticContext } from "../agents/agents.ts";
import { type OutputOverrideInput, type ResolvedStepBehavior } from "../runs/shared/child-launch-plan.ts";
import { type AcceptanceInput, type AgentContract, type ChainGateLayer, type JsonSchemaObject, type OutputMode, type ToolBudgetConfig } from "./types.ts";
export { planChildLaunch, resolveStepBehavior, resolveTaskTextForFileUpdatePolicy, suppressProgressForReadOnlyTask, taskDisallowsFileUpdates, } from "../runs/shared/child-launch-plan.ts";
export type { ChildLaunchPlan, ChildLaunchPlanInput, OutputOverrideInput, ResolvedStepBehavior, StepOverrides } from "../runs/shared/child-launch-plan.ts";
/** Sequential step: single agent execution */
export interface SequentialStep {
    agent: string;
    task?: string;
    phase?: string;
    label?: string;
    as?: string;
    outputSchema?: JsonSchemaObject | false;
    cwd?: string;
    machine?: string;
    output?: OutputOverrideInput;
    outputMode?: OutputMode;
    reads?: string[] | false;
    progress?: boolean;
    skill?: string | string[] | false;
    model?: string;
    fast?: boolean;
    toolBudget?: ToolBudgetConfig;
    acceptance?: AcceptanceInput;
    agentContract?: AgentContract;
    gateOn?: ChainGateLayer;
    /** Internal workflow child isolation; public workflowScript supplies this on runs.run. */
    worktree?: boolean;
}
/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
    agent: string;
    task?: string;
    phase?: string;
    label?: string;
    as?: string;
    outputSchema?: JsonSchemaObject | false;
    cwd?: string;
    machine?: string;
    count?: number;
    output?: OutputOverrideInput;
    outputMode?: OutputMode;
    reads?: string[] | false;
    progress?: boolean;
    skill?: string | string[] | false;
    model?: string;
    fast?: boolean;
    toolBudget?: ToolBudgetConfig;
    acceptance?: AcceptanceInput;
    agentContract?: AgentContract;
    gateOn?: ChainGateLayer;
}
export interface DynamicExpandSpec {
    from: {
        output: string;
        path: string;
    };
    item?: string;
    key?: string;
    maxItems?: number;
    onEmpty?: "skip" | "fail";
}
export type DynamicParallelTemplate = Omit<ParallelTaskItem, "as" | "count">;
export interface DynamicCollectSpec {
    as: string;
    outputSchema?: JsonSchemaObject;
}
export interface DynamicParallelStep {
    expand: DynamicExpandSpec;
    parallel: DynamicParallelTemplate;
    collect: DynamicCollectSpec;
    concurrency?: number;
    failFast?: boolean;
    phase?: string;
    label?: string;
    acceptance?: AcceptanceInput;
    agentContract?: AgentContract;
    gateOn?: ChainGateLayer;
}
/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
    parallel: ParallelTaskItem[];
    concurrency?: number;
    failFast?: boolean;
    worktree?: boolean;
    cwd?: string;
    machine?: string;
    agentContract?: AgentContract;
    gateOn?: ChainGateLayer;
}
/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;
export declare function isParallelStep(step: ChainStep): step is ParallelStep;
export declare function isDynamicParallelStep(step: ChainStep): step is DynamicParallelStep;
/** Get all agent names in a step (single for sequential, multiple for parallel) */
export declare function getStepAgents(step: ChainStep): string[];
export declare function createChainDir(runId: string, baseDir?: string): string;
export declare function removeChainDir(chainDir: string): void;
export declare function cleanupOldChainDirs(): void;
/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];
/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export declare function resolveChainTemplates(steps: ChainStep[]): ResolvedTemplates;
/**
 * Expand a leading `~`/`~/` to the user's home directory. Other forms (relative,
 * absolute, `~user/`) pass through unchanged.
 */
export declare function expandHomePath(filePath: string): string;
/**
 * Resolve a file path: `~`/`~/` expand to home first, then absolute paths pass
 * through and relative paths get chainDir prepended.
 */
export declare function resolveChainPath(filePath: string, chainDir: string): string;
export declare function resolveExistingReadInstructionPaths(reads: readonly string[], instructionCwd: string, existenceCwd?: string): string[];
export declare function resolveExistingReadPaths(reads: readonly string[], cwd: string): string[];
/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export declare function writeInitialProgressFile(progressDir: string): void;
export declare function buildChainInstructions(behavior: ResolvedStepBehavior, chainDir: string, isFirstProgressAgent: boolean, previousSummary?: string, readExistenceDir?: string): {
    prefix: string;
    suffix: string;
};
/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
/** Exact discovery context, or explicit input for defensive fallback discovery. */
export type ParallelBehaviorDiagnostics = UnknownAgentDiagnosticContext | {
    cwd: string;
    scope?: AgentScope;
};
export declare function resolveParallelBehaviors(tasks: ParallelTaskItem[], agentConfigs: AgentConfig[], stepIndex: number, chainSkills?: string[], diagnostics?: ParallelBehaviorDiagnostics): ResolvedStepBehavior[];
/**
 * Create subdirectories for parallel step outputs
 */
export declare function createParallelDirs(chainDir: string, stepIndex: number, taskCount: number, agentNames: string[]): void;
export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
//# sourceMappingURL=settings.d.ts.map