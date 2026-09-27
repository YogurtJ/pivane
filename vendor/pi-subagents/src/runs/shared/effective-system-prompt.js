import { buildAgentMemoryInjection } from "../../agents/agent-memory.js";
import { appendAgentRefinementOverlay } from "../../agents/agent-refinements.js";
import { buildSkillInjection } from "../../agents/skills.js";
import { injectOutputPathSystemPrompt } from "./single-output.js";
function appendSection(prompt, section) {
    return prompt ? `${prompt}\n\n${section}` : section;
}
/**
 * Child system prompt in the order preflight and every execution path hash:
 * base prompt, skills, memory, refinement overlay, output path. Runtime
 * acceptance prose is appended later and stays outside launch identity.
 */
export function buildEffectiveSystemPrompt(input) {
    let prompt = input.agent.systemPrompt?.trim() ?? "";
    if (input.resolvedSkills.length > 0)
        prompt = appendSection(prompt, buildSkillInjection(input.resolvedSkills));
    const memoryInjection = buildAgentMemoryInjection(input.agent, input.cwd);
    if (memoryInjection)
        prompt = appendSection(prompt, memoryInjection);
    prompt = appendAgentRefinementOverlay(prompt, { cwd: input.cwd, agentName: input.agent.name });
    return injectOutputPathSystemPrompt(prompt, input.outputPath, input.agent);
}
//# sourceMappingURL=effective-system-prompt.js.map