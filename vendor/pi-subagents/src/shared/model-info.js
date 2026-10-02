export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function toModelInfo(model) {
    return {
        provider: model.provider,
        id: model.id,
        fullId: `${model.provider}/${model.id}`,
        api: model.api,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
        ...(typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
        ...(Array.isArray(model.input) && model.input.length > 0 ? { input: [...model.input] } : {}),
        ...(model.cost && Number.isFinite(model.cost.input) && Number.isFinite(model.cost.output)
            ? { cost: { ...model.cost, ...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) } : {}) } }
            : {}),
    };
}
/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. no model was specified, or the model has no suffix and no config was provided). */
export function resolveEffectiveThinking(model, configThinking) {
    if (!model)
        return undefined;
    const { thinkingSuffix } = splitKnownThinkingSuffix(model);
    if (thinkingSuffix)
        return thinkingSuffix.slice(1);
    return THINKING_LEVELS.find((level) => level === configThinking);
}
/** The recorded thinking level of one child: the first known level among the places it is recorded. */
export function childThinkingLevel(...sources) {
    for (const source of sources) {
        const level = THINKING_LEVELS.find((candidate) => candidate === source?.thinking);
        if (level)
            return level;
    }
    return undefined;
}
export function splitKnownThinkingSuffix(model) {
    const colonIdx = model.lastIndexOf(":");
    if (colonIdx === -1)
        return { baseModel: model, thinkingSuffix: "" };
    const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
    if (!suffix)
        return { baseModel: model, thinkingSuffix: "" };
    return {
        baseModel: model.substring(0, colonIdx),
        thinkingSuffix: `:${suffix}`,
    };
}
export function findModelInfo(model, availableModels, preferredProvider) {
    if (!model || !availableModels || availableModels.length === 0)
        return undefined;
    const { baseModel } = splitKnownThinkingSuffix(model);
    const exact = availableModels.find((entry) => entry.fullId === baseModel);
    if (exact)
        return exact;
    const matches = availableModels.filter((entry) => entry.id === baseModel);
    if (preferredProvider) {
        const preferred = matches.find((entry) => entry.provider === preferredProvider);
        if (preferred)
            return preferred;
    }
    return matches.length === 1 ? matches[0] : undefined;
}
export function getSupportedThinkingLevels(model) {
    if (!model)
        return THINKING_LEVELS.filter((level) => level !== "max");
    if (model.reasoning === false)
        return ["off"];
    if (!model.thinkingLevelMap)
        return THINKING_LEVELS.filter((level) => level !== "max");
    const levels = THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === "xhigh" || level === "max")
            return mapped !== undefined;
        return true;
    });
    return levels;
}
//# sourceMappingURL=model-info.js.map