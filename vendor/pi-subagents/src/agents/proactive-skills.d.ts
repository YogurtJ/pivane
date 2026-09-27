import type { AgentConfig, ChainConfig } from "./agents.ts";
import type { ProactiveSkillSubagentsConfig } from "../shared/types.ts";
export interface ResolvedProactiveSkillSubagentsConfig {
    enabled: boolean;
    minReferences: number;
    maxRecommendations: number;
    preferredAgent: string;
}
export interface ProactiveSkillSubagentRecommendation {
    skill: string;
    agent: string;
    references: number;
    sources: string[];
    description?: string;
    reason: string;
}
export interface AvailableSkill {
    name: string;
    description?: string;
    disableModelInvocation?: boolean;
}
export declare function resolveProactiveSkillSubagentsConfig(config?: ProactiveSkillSubagentsConfig | false): ResolvedProactiveSkillSubagentsConfig;
export declare function recommendProactiveSkillSubagents(input: {
    agents: AgentConfig[];
    chains?: ChainConfig[];
    availableSkills?: AvailableSkill[];
    config?: ProactiveSkillSubagentsConfig | false;
}): ProactiveSkillSubagentRecommendation[];
export declare function formatProactiveSkillSubagentRecommendations(recommendations: ProactiveSkillSubagentRecommendation[]): string[];
export declare function buildProactiveSkillSubagentRecommendationLines(input: {
    agents: AgentConfig[];
    chains?: ChainConfig[];
    config?: ProactiveSkillSubagentsConfig | false;
    discoverAvailableSkills: () => AvailableSkill[];
}): string[];
//# sourceMappingURL=proactive-skills.d.ts.map