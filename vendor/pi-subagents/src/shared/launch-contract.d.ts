import type { AgentConfig } from "../agents/agents.ts";
import type { PiLaunchToolPlan } from "../runs/shared/child-tool-plan.ts";
import type { ExtensionBindings } from "../runs/shared/extension-bindings.ts";
export declare const AGENT_DEFINITION_PROJECTION_VERSION: 2;
export declare const LAUNCH_BINDING_PROJECTION_VERSION: 2;
export declare function stableJsonDigest(value: unknown): string;
/** Public-safe, deterministic evidence for the parsed launch-affecting agent definition. */
export declare function projectAgentDefinition(agent: AgentConfig): Record<string, unknown>;
/** Digest of the parsed definition; a runtime overlay that already captured it wins over re-hashing the overlaid copy. */
export declare function agentDefinitionDigest(agent: AgentConfig): string;
export interface LaunchBindingInput {
    definitionDigest: string;
    /** Caller task; runtime acceptance/output task annotations are explicitly outside the preflight-known subset. */
    task?: string;
    model?: string;
    fast?: boolean;
    thinking?: string;
    systemPrompt?: string | null;
    systemPromptMode?: AgentConfig["systemPromptMode"];
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    skills?: string[];
    tools?: string[];
    excludeTools?: string[];
    extensions?: string[];
    subagentOnlyExtensions?: string[];
    mcpDirectTools?: string[];
    outputPath?: string;
    outputMode?: string;
    structuredOutputSchema?: unknown;
    extensionBindings?: ExtensionBindings;
}
/** Canonical projection of the resolved inputs handed to the child. */
export declare function projectLaunchBinding(input: LaunchBindingInput): Record<string, unknown>;
export declare function launchBindingDigest(input: LaunchBindingInput): string;
type LaunchBindingPromptMode = Pick<LaunchBindingInput, "systemPromptMode" | "inheritProjectContext" | "inheritGlobalContext" | "inheritSkills">;
/**
 * Who the child is: the launched agent, or the identity a persisted step
 * already captured when a runner recomputes the binding per model attempt.
 */
export type LaunchBindingIdentity = {
    agent: AgentConfig;
} | ({
    definitionDigest: string;
} & LaunchBindingPromptMode);
export type LaunchBindingSource = LaunchBindingIdentity & Pick<LaunchBindingInput, "fast" | "thinking" | "skills" | "outputPath" | "outputMode" | "structuredOutputSchema" | "extensionBindings"> & {
    task: string;
    model?: string;
    /** Effective child system prompt before runtime acceptance prose. */
    systemPrompt: string;
    toolPlan: Pick<PiLaunchToolPlan, "effectiveToolAllowlist" | "excludeTools" | "extensionArgs" | "effectiveMcpTools">;
};
export interface LaunchBinding {
    definitionDigest: string;
    launchContractDigest: string;
}
/**
 * Assemble launch identity from resolved preflight or execution inputs.
 * The stable projection omits undefined optional fields.
 */
export declare function resolveLaunchBinding(source: LaunchBindingSource): LaunchBinding;
export {};
//# sourceMappingURL=launch-contract.d.ts.map