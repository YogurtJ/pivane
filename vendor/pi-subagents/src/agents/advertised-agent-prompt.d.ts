import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { AgentConfig } from "./agents.ts";
/**
 * The catalog body without its `<advertised_subagents>` wrapper, for Pi's structured
 * prompt sections, which add the tag from the section key. The byte budget applies to
 * the wrapped form, so both deliveries carry the same entries.
 */
export declare function buildAdvertisedAgentCatalog(agents: readonly AgentConfig[], capabilityCeiling?: ResolvedSubagentCapabilityCeiling): string | undefined;
export declare function buildAdvertisedAgentPrompt(agents: readonly AgentConfig[], capabilityCeiling?: ResolvedSubagentCapabilityCeiling): string | undefined;
//# sourceMappingURL=advertised-agent-prompt.d.ts.map