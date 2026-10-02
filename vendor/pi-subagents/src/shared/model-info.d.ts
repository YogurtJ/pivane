import type { ModelCost } from "@earendil-works/pi-ai";
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
export interface ModelInfo {
    provider: string;
    id: string;
    fullId: string;
    api?: string;
    reasoning?: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    /** Context window in tokens, when the host model registry reports one. */
    contextWindow?: number;
    /** Maximum output tokens, when the host model registry reports one. */
    maxTokens?: number;
    /** Input modalities reported by the registry, e.g. ["text", "image"]. */
    input?: string[];
    /** Per-token pricing from the registry (USD per 1M tokens). */
    cost?: ModelCost;
}
interface RegistryModelLike {
    provider: string;
    id: string;
    api?: string;
    reasoning?: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    contextWindow?: number;
    maxTokens?: number;
    input?: string[];
    cost?: ModelCost;
}
export declare function toModelInfo(model: RegistryModelLike): ModelInfo;
/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. no model was specified, or the model has no suffix and no config was provided). */
export declare function resolveEffectiveThinking(model: string | undefined, configThinking: string | false | undefined): string | undefined;
/** The recorded thinking level of one child: the first known level among the places it is recorded. */
export declare function childThinkingLevel(...sources: Array<{
    thinking?: string;
} | undefined>): ThinkingLevel | undefined;
export declare function splitKnownThinkingSuffix(model: string): {
    baseModel: string;
    thinkingSuffix: string;
};
export declare function findModelInfo(model: string | undefined, availableModels: ModelInfo[] | undefined, preferredProvider?: string): ModelInfo | undefined;
export declare function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[];
export {};
//# sourceMappingURL=model-info.d.ts.map