import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgentsAll } from "./agents.ts";
import type { Details, ExtensionConfig } from "../shared/types.ts";
import { type RuntimeAgentOwner } from "./runtime-agent-registry.ts";
type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry"> & {
    model?: ExtensionContext["model"];
    config?: ExtensionConfig;
    currentSessionId?: string;
    runtimeAgentOwner?: RuntimeAgentOwner;
    onAgentsChanged?: () => void;
    discoverAgentsAll?: typeof discoverAgentsAll;
};
interface ManagementParams {
    action?: string;
    agent?: string;
    agentScope?: unknown;
    capabilities?: unknown;
    config?: unknown;
}
export declare function editableAgentConfig(agent: AgentConfig): AgentConfig;
export declare function preservedAgentFrontmatterFields(agent: AgentConfig, cfg: Record<string, unknown>): Set<string>;
export declare function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details>;
export declare function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details>;
export declare function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details>;
export declare function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details>;
export {};
//# sourceMappingURL=agent-management.d.ts.map