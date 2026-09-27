import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_NAMES } from "../agents/agents.ts";
export declare const DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS = 7;
type BuiltinAgentName = typeof BUILTIN_AGENT_NAMES[number];
export type ProfileKind = "quota" | "quality";
export type ProbeStatus = "ok" | "unavailable" | "auth" | "timeout" | "error" | "skipped";
export type CostTier = "cheap" | "medium" | "expensive";
export type QualityTier = "weak" | "medium" | "strong";
export type LatencyTier = "fast" | "medium" | "slow";
export type RecommendedRoleTier = "cheap" | "medium" | "strong";
interface ProfileAgentOverride {
    model?: string;
    thinking?: string | false;
    machine?: string;
}
export interface SubagentProfileFile {
    subagents: {
        agentOverrides: Record<string, ProfileAgentOverride>;
        disableBuiltins?: boolean;
        [key: string]: unknown;
    };
}
export type ClassificationSource = "official-metadata" | "heuristic-name";
export interface ProviderModelCatalogModel {
    id: string;
    fullId: string;
    observed: {
        availableInRegistry: boolean;
        name?: string;
        reasoning?: boolean;
        thinkingLevels: string[];
        contextWindow?: number;
        maxTokens?: number;
        cost?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
        };
        probe: {
            status: ProbeStatus;
            checkedAt: string;
            message?: string;
        };
    };
    derived: {
        profileRank: number;
        costTier: CostTier;
        qualityTier: QualityTier;
        latencyTier: LatencyTier;
        recommendedRoleTier: RecommendedRoleTier;
        recommendedAgents: BuiltinAgentName[];
        classificationSources: ClassificationSource[];
    };
    warnings: string[];
    notes: string[];
}
export interface ProviderModelCatalogFile {
    provider: string;
    refreshedAt: string;
    maxAgeDays: number;
    sources: string[];
    models: ProviderModelCatalogModel[];
}
export interface ProfileCheckResult {
    profileName: string;
    filePath: string;
    results: Array<{
        agent: string;
        model: string;
        inRegistry: boolean;
        probe: {
            status: ProbeStatus;
            message?: string;
        };
    }>;
}
export declare function countHeuristicFallbackModels(catalog: ProviderModelCatalogFile): number;
export declare function getSubagentProfilesRootDir(): string;
export declare function getSubagentProfilesDir(): string;
export declare function ensureSubagentProfilesDir(): string;
export declare function getProviderModelsDir(): string;
export declare function ensureProviderModelsDir(): string;
export declare function getProviderModelsPath(provider: string): string;
export declare function listSubagentProfiles(): string[];
export declare function readSubagentProfile(name: string): {
    filePath: string;
    profile: SubagentProfileFile;
};
export declare function applySubagentProfile(name: string): {
    filePath: string;
    settingsPath: string;
};
export declare function readProviderModelCatalog(provider: string): ProviderModelCatalogFile | null;
export declare function isProviderModelCatalogStale(catalog: ProviderModelCatalogFile, maxAgeDays?: number): boolean;
export declare function refreshProviderModelCatalog(pi: Pick<ExtensionAPI, "exec"> | {
    exec?: ExtensionAPI["exec"];
}, ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">, provider: string, options?: {
    force?: boolean;
    maxAgeDays?: number;
    probe?: boolean;
}): Promise<{
    filePath: string;
    catalog: ProviderModelCatalogFile;
    reused: boolean;
    heuristicFallbackCount: number;
}>;
export declare function generateProfilesForProvider(pi: Pick<ExtensionAPI, "exec"> | {
    exec?: ExtensionAPI["exec"];
}, ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">, provider: string, options?: {
    maxAgeDays?: number;
    forceRefresh?: boolean;
    probe?: boolean;
}): Promise<{
    quotaPath: string;
    qualityPath: string;
    catalogPath: string;
    quotaModels: {
        cheap: string;
        medium: string;
        strong: string;
    };
    qualityModels: {
        cheap: string;
        medium: string;
        strong: string;
    };
    heuristicFallbackCount: number;
    selectedHeuristicFallbackCount: number;
}>;
export declare function checkSubagentProfile(pi: Pick<ExtensionAPI, "exec"> | {
    exec?: ExtensionAPI["exec"];
}, ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">, name: string): Promise<ProfileCheckResult>;
export {};
//# sourceMappingURL=profiles.d.ts.map