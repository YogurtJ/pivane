import * as path from "node:path";
import { resolveChildCwd } from "../../shared/utils.js";
import { resolveSingleOutputPath } from "./single-output.js";
export function normalizeOutputOverride(output) {
    if (output === false || output === "false")
        return false;
    if (output === true || output === "true")
        return undefined;
    return typeof output === "string" && output.length > 0 ? output : undefined;
}
export const resolveEffectiveOutputSchema = (agentConfig, override) => override === false ? undefined : override !== undefined ? override : agentConfig.outputSchema;
export function projectChainOutputSchemas(chain, agents, projectStep, projectGroup) {
    const project = (step) => { const agent = agents.find((candidate) => candidate.name === step.agent); if (!agent && !projectStep)
        return step; const outputSchema = agent && resolveEffectiveOutputSchema(agent, step.outputSchema); return projectStep ? projectStep(step, outputSchema) : { ...step, outputSchema }; };
    return chain.map((step) => { if (!("parallel" in step))
        return project(step); const parallel = Array.isArray(step.parallel) ? step.parallel.map(project) : project(step.parallel); return projectGroup ? projectGroup(step, parallel) : { ...step, parallel }; });
}
export function resolveStepBehavior(agentConfig, stepOverrides, chainSkills) {
    const stepOutput = normalizeOutputOverride(stepOverrides.output);
    const output = stepOutput !== undefined
        ? stepOutput
        : normalizeOutputOverride(agentConfig.output) ?? false;
    const reads = stepOverrides.reads !== undefined
        ? stepOverrides.reads
        : agentConfig.defaultReads ?? false;
    const progress = stepOverrides.progress !== undefined
        ? stepOverrides.progress
        : agentConfig.defaultProgress ?? false;
    let skills;
    if (stepOverrides.skills === false) {
        skills = false;
    }
    else if (stepOverrides.skills !== undefined) {
        skills = [...stepOverrides.skills];
        if (chainSkills && chainSkills.length > 0) {
            skills = [...new Set([...skills, ...chainSkills])];
        }
    }
    else {
        skills = agentConfig.skills ? [...agentConfig.skills] : [];
        if (chainSkills && chainSkills.length > 0) {
            skills = [...new Set([...skills, ...chainSkills])];
        }
    }
    const outputMode = stepOverrides.outputMode ?? agentConfig.outputMode ?? "inline";
    const model = stepOverrides.model ?? agentConfig.model;
    const fast = stepOverrides.fast ?? agentConfig.fast;
    const outputSchema = resolveEffectiveOutputSchema(agentConfig, stepOverrides.outputSchema);
    return { output, outputMode, reads, progress, skills, model, fast, ...(outputSchema !== undefined ? { outputSchema } : {}) };
}
export function resolveTaskTextForFileUpdatePolicy(task, originalTask) {
    if (!task)
        return originalTask;
    return originalTask ? task.replaceAll("{task}", originalTask) : task;
}
export function taskDisallowsFileUpdates(task) {
    if (!task)
        return false;
    return /\breview[- ]only\b/i.test(task)
        || /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task)
        || /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task)
        || /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task)
        || /\bleave\s+files?\s+unchanged\b/i.test(task);
}
export function suppressProgressForReadOnlyTask(behavior, task, originalTask) {
    const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
    return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}
export function planChildLaunch(input) {
    const stepCwd = input.machineCwd ?? resolveChildCwd(input.runnerCwd, input.stepCwdInput);
    const instructionCwd = input.behaviorCwd ?? stepCwd;
    const readExistenceCwd = input.behaviorCwd ? stepCwd : instructionCwd;
    let behavior = suppressProgressForReadOnlyTask(input.resolvedBehavior ?? resolveStepBehavior(input.agentConfig, input.stepOverrides, input.chainSkills), input.task, input.originalTask);
    const inheritedRelativeParallelOutput = Boolean(input.parallelOutputNamespace
        && input.stepOverrides.output === undefined
        && typeof behavior.output === "string"
        && !path.isAbsolute(behavior.output));
    if (inheritedRelativeParallelOutput && input.parallelOutputNamespace?.taskIndex !== undefined) {
        behavior = {
            ...behavior,
            output: path.join(`parallel-${input.parallelOutputNamespace.stepIndex}`, `${input.parallelOutputNamespace.taskIndex}-${input.agentConfig.name}`, behavior.output),
        };
    }
    const namespaceOutputPath = inheritedRelativeParallelOutput && input.parallelOutputNamespace?.taskIndex === undefined;
    const skillNames = behavior.skills === false ? [] : behavior.skills;
    const outputPath = resolveSingleOutputPath(behavior.output, input.runtimeCwd, instructionCwd, input.outputBaseDir);
    return { stepCwd, instructionCwd, readExistenceCwd, behavior, inheritedRelativeParallelOutput, namespaceOutputPath, outputPath, skillNames };
}
//# sourceMappingURL=child-launch-plan.js.map