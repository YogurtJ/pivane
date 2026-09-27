import type { AgentConfig } from "../../agents/agents.ts";
import { buildSkillInjection } from "../../agents/skills.ts";
export interface EffectiveSystemPromptInput {
    /** Agent as handed to the child, including runtime-declared overlays such as the Intercom bridge. */
    agent: AgentConfig;
    resolvedSkills: Parameters<typeof buildSkillInjection>[0];
    /** Directory that scopes memory and refinement lookups. */
    cwd: string;
    /** Omit when the caller injects the output path through another channel. */
    outputPath?: string;
}
/**
 * Child system prompt in the order preflight and every execution path hash:
 * base prompt, skills, memory, refinement overlay, output path. Runtime
 * acceptance prose is appended later and stays outside launch identity.
 */
export declare function buildEffectiveSystemPrompt(input: EffectiveSystemPromptInput): string;
//# sourceMappingURL=effective-system-prompt.d.ts.map