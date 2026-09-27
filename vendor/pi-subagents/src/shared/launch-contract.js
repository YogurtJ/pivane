import { createHash } from "node:crypto";
import * as fs from "node:fs";
export const AGENT_DEFINITION_PROJECTION_VERSION = 2;
// v2: the Intercom bridge prompt and tools are part of the binding on every
// path, and the bridge text no longer names the parent session.
export const LAUNCH_BINDING_PROJECTION_VERSION = 2;
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
export function stableJsonDigest(value) {
    return createHash("sha256").update(stableJson(value)).digest("hex");
}
function fileDigest(filePath) {
    try {
        return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    }
    catch {
        return undefined;
    }
}
/** Public-safe, deterministic evidence for the parsed launch-affecting agent definition. */
export function projectAgentDefinition(agent) {
    return {
        version: AGENT_DEFINITION_PROJECTION_VERSION,
        name: agent.name,
        localName: agent.localName,
        packageName: agent.packageName,
        filePath: agent.filePath,
        fileContentDigest: fileDigest(agent.filePath),
        runner: agent.runner,
        systemPrompt: agent.systemPrompt,
        systemPromptMode: agent.systemPromptMode,
        inheritProjectContext: agent.inheritProjectContext,
        inheritGlobalContext: agent.inheritGlobalContext,
        inheritSkills: agent.inheritSkills,
        model: agent.model,
        modelProvider: agent.modelProvider,
        fast: agent.fast,
        thinking: agent.thinking,
        tools: agent.tools,
        excludeTools: agent.excludeTools,
        allowNestedSubagents: agent.allowNestedSubagents,
        allowedAgents: agent.allowedAgents,
        mcpDirectTools: agent.mcpDirectTools,
        extensions: agent.extensions,
        subagentOnlyExtensions: agent.subagentOnlyExtensions,
        mutationTools: agent.mutationTools,
        skills: agent.skills,
        skillPath: agent.skillPath,
        output: agent.output,
        outputSchema: agent.outputSchema,
        defaultReads: agent.defaultReads,
        defaultProgress: agent.defaultProgress,
        defaultContext: agent.defaultContext,
        defaultAsync: agent.defaultAsync,
        defaultTimeoutMs: agent.defaultTimeoutMs,
        defaultAcceptance: agent.defaultAcceptance,
        acceptanceRole: agent.acceptanceRole,
        interactive: agent.interactive,
        maxSubagentDepth: agent.maxSubagentDepth,
        toolBudget: agent.toolBudget,
        memory: agent.memory,
    };
}
/** Digest of the parsed definition; a runtime overlay that already captured it wins over re-hashing the overlaid copy. */
export function agentDefinitionDigest(agent) {
    return agent.definitionDigest ?? stableJsonDigest(projectAgentDefinition(agent));
}
/** Canonical projection of the resolved inputs handed to the child. */
export function projectLaunchBinding(input) {
    return {
        version: LAUNCH_BINDING_PROJECTION_VERSION,
        definitionDigest: input.definitionDigest,
        taskDigest: input.task === undefined ? undefined : stableJsonDigest(input.task),
        model: input.model,
        fast: input.fast,
        thinking: input.thinking,
        systemPromptDigest: input.systemPrompt === undefined || input.systemPrompt === null ? undefined : stableJsonDigest(input.systemPrompt),
        systemPromptMode: input.systemPromptMode,
        inheritProjectContext: input.inheritProjectContext,
        inheritGlobalContext: input.inheritGlobalContext,
        inheritSkills: input.inheritSkills,
        skills: input.skills,
        tools: input.tools,
        excludeTools: input.excludeTools,
        extensions: input.extensions,
        subagentOnlyExtensions: input.subagentOnlyExtensions,
        mcpDirectTools: input.mcpDirectTools,
        outputPath: input.outputPath,
        outputMode: input.outputMode,
        structuredOutputSchema: input.structuredOutputSchema,
        extensionBindings: input.extensionBindings,
    };
}
export function launchBindingDigest(input) {
    return stableJsonDigest(projectLaunchBinding(input));
}
/**
 * Assemble launch identity from resolved preflight or execution inputs.
 * The stable projection omits undefined optional fields.
 */
export function resolveLaunchBinding(source) {
    const identity = "agent" in source ? {
        definitionDigest: agentDefinitionDigest(source.agent),
        systemPromptMode: source.agent.systemPromptMode,
        inheritProjectContext: source.agent.inheritProjectContext,
        inheritGlobalContext: source.agent.inheritGlobalContext,
        inheritSkills: source.agent.inheritSkills,
    } : source;
    return {
        definitionDigest: identity.definitionDigest,
        launchContractDigest: launchBindingDigest({
            ...identity,
            task: source.task,
            model: source.model,
            fast: source.fast,
            thinking: source.thinking || undefined,
            systemPrompt: source.systemPrompt,
            skills: source.skills,
            tools: source.toolPlan.effectiveToolAllowlist,
            excludeTools: source.toolPlan.excludeTools.length > 0 ? source.toolPlan.excludeTools : undefined,
            extensions: source.toolPlan.extensionArgs,
            mcpDirectTools: source.toolPlan.effectiveMcpTools,
            outputPath: source.outputPath || undefined,
            outputMode: source.outputMode,
            structuredOutputSchema: source.structuredOutputSchema,
            extensionBindings: source.extensionBindings || undefined,
        }),
    };
}
//# sourceMappingURL=launch-contract.js.map