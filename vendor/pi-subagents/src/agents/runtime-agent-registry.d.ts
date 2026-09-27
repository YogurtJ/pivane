import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AcceptanceInput, AcceptanceRole, AgentRunnerConfig, OutputMode, ToolBudgetConfig } from "../shared/types.ts";
import { type PermissionRules } from "../runs/shared/permissions.ts";
import { type AgentConfig, type AgentDefaultContext, type AgentDiscoveryDiagnostic, type RuntimeAgentSettingsContext } from "./agents.ts";
export declare const RUNTIME_AGENT_REGISTRY_KEY = "pi-subagents.runtime-agents.v1";
export interface RuntimeAgentDefinition {
    description: string;
    systemPrompt: string;
    aliases?: readonly string[];
    tools?: readonly string[];
    excludeTools?: readonly string[];
    allowNestedSubagents?: boolean;
    mcpDirectTools?: readonly string[];
    model?: string;
    thinking?: string | false;
    systemPromptMode?: "append" | "replace";
    inheritProjectContext?: boolean;
    inheritGlobalContext?: boolean;
    inheritSkills?: boolean;
    defaultContext?: AgentDefaultContext;
    defaultAsync?: boolean;
    defaultTimeoutMs?: number;
    defaultToolTimeoutMs?: number;
    defaultAcceptance?: AcceptanceInput;
    acceptanceRole?: AcceptanceRole;
    runner?: AgentRunnerConfig;
    machine?: string;
    skills?: readonly string[];
    skillPath?: readonly string[];
    extensions?: readonly string[];
    subagentOnlyExtensions?: readonly string[];
    mutationTools?: readonly string[];
    output?: string;
    outputMode?: OutputMode;
    defaultReads?: readonly string[];
    defaultProgress?: boolean;
    interactive?: boolean;
    maxSubagentDepth?: number;
    toolBudget?: ToolBudgetConfig;
    permissions?: PermissionRules;
}
export interface RegisterRuntimeAgentInput {
    pi: ExtensionAPI;
    name: string;
    definition: RuntimeAgentDefinition;
}
export interface RuntimeAgentRegistration {
    dispose(): void;
}
export type RuntimeAgentOwner = ExtensionAPI;
export declare function registerRuntimeAgent(input: RegisterRuntimeAgentInput): RuntimeAgentRegistration;
export declare function clearRuntimeAgentsForPi(pi: RuntimeAgentOwner): void;
export declare function listRuntimeAgentConfigs(pi: RuntimeAgentOwner): AgentConfig[];
/**
 * Append registered runtime agents to a discovery result. With `settings`, the
 * runtime agents also receive the subagent model-tier settings that apply in
 * that discovery context (see `applyRuntimeAgentSettings`); without it they
 * carry only their registered definition.
 */
export declare function mergeRuntimeAgents<T extends {
    agents: AgentConfig[];
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
}>(pi: RuntimeAgentOwner, discovered: T, configuredAgents?: readonly AgentConfig[], settings?: RuntimeAgentSettingsContext): T;
//# sourceMappingURL=runtime-agent-registry.d.ts.map