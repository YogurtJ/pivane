import type { AgentConfig } from "../../agents/agents.ts";
import type { JsonSchemaObject, OutputMode } from "../../shared/types.ts";
export interface ResolvedStepBehavior {
    output: string | false;
    outputMode: OutputMode;
    reads: string[] | false;
    progress: boolean;
    skills: string[] | false;
    model?: string;
    fast?: boolean;
    outputSchema?: JsonSchemaObject;
}
export type OutputOverrideInput = string | boolean;
export interface StepOverrides {
    output?: OutputOverrideInput;
    outputMode?: OutputMode;
    reads?: string[] | false;
    progress?: boolean;
    skills?: string[] | false;
    model?: string;
    fast?: boolean;
    outputSchema?: JsonSchemaObject | false;
}
export interface ChildLaunchPlanInput {
    agentConfig: AgentConfig;
    stepOverrides: StepOverrides;
    task?: string;
    originalTask?: string;
    runnerCwd: string;
    runtimeCwd: string;
    stepCwdInput?: string;
    behaviorCwd?: string;
    machineCwd?: string;
    chainSkills?: string[];
    outputBaseDir?: string;
    parallelOutputNamespace?: {
        stepIndex: number;
        taskIndex?: number;
    };
    resolvedBehavior?: ResolvedStepBehavior;
}
export interface ChildLaunchPlan {
    stepCwd: string;
    instructionCwd: string;
    readExistenceCwd: string;
    behavior: ResolvedStepBehavior;
    inheritedRelativeParallelOutput: boolean;
    namespaceOutputPath: boolean;
    outputPath?: string;
    skillNames: string[];
}
export declare function normalizeOutputOverride(output: unknown): string | false | undefined;
export declare const resolveEffectiveOutputSchema: (agentConfig: AgentConfig, override?: JsonSchemaObject | false) => JsonSchemaObject | undefined;
type OutputSchemaStep = {
    agent: string;
    outputSchema?: JsonSchemaObject | false;
};
export declare function projectChainOutputSchemas<S extends OutputSchemaStep, R = S, G = {
    parallel: R[] | R;
}>(chain: readonly (S | {
    parallel: S[] | S;
})[], agents: AgentConfig[], projectStep?: (step: S, outputSchema: JsonSchemaObject | undefined) => R, projectGroup?: (step: {
    parallel: S[] | S;
}, parallel: R[] | R) => G): Array<R | G>;
export declare function resolveStepBehavior(agentConfig: AgentConfig, stepOverrides: StepOverrides, chainSkills?: string[]): ResolvedStepBehavior;
export declare function resolveTaskTextForFileUpdatePolicy(task: string | undefined, originalTask?: string): string | undefined;
export declare function taskDisallowsFileUpdates(task: string | undefined): boolean;
export declare function suppressProgressForReadOnlyTask(behavior: ResolvedStepBehavior, task: string | undefined, originalTask?: string): ResolvedStepBehavior;
export declare function planChildLaunch(input: ChildLaunchPlanInput): ChildLaunchPlan;
export {};
//# sourceMappingURL=child-launch-plan.d.ts.map