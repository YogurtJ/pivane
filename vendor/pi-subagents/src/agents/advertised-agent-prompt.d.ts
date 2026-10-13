import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { AgentConfig } from "./agents.ts";
/**
 * The catalog body without its `<advertised_subagents>` wrapper, for Pi's structured
 * prompt sections, which add the tag from the section key. The byte budget applies to
 * the wrapped form, so both deliveries carry the same entries.
 *
 * `recordedCatalog` is the body a session already sent. Its first line, the introduction,
 * is kept so a release that rewords the introduction does not change the section of a
 * resumed session and cost it the provider's prompt cache. The entries are always current.
 */
export declare function buildAdvertisedAgentCatalog(agents: readonly AgentConfig[], capabilityCeiling?: ResolvedSubagentCapabilityCeiling, recordedCatalog?: string): string | undefined;
export declare function buildAdvertisedAgentPrompt(agents: readonly AgentConfig[], capabilityCeiling?: ResolvedSubagentCapabilityCeiling): string | undefined;
//# sourceMappingURL=advertised-agent-prompt.d.ts.map