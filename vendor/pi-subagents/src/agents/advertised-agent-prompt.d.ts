import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { AgentConfig } from "./agents.ts";
export declare function buildAdvertisedAgentPrompt(agents: readonly AgentConfig[], capabilityCeiling?: ResolvedSubagentCapabilityCeiling): string | undefined;
export declare function appendAdvertisedAgentPrompt(systemPrompt: string, advertisedPrompt: string | undefined): string;
export declare function appendAdvertisedAgentPrompt(systemPrompt: string[], advertisedPrompt: string | undefined): string[];
export declare function appendAdvertisedAgentPrompt(systemPrompt: undefined, advertisedPrompt: string | undefined): string | undefined;
export declare function appendAdvertisedAgentPrompt(systemPrompt: string | string[] | undefined, advertisedPrompt: string | undefined): string | string[] | undefined;
//# sourceMappingURL=advertised-agent-prompt.d.ts.map