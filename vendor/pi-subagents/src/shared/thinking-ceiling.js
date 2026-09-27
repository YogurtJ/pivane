import { resolveEffectiveThinking, THINKING_LEVELS } from "./model-info.js";
const thinkingLevelRanks = new Map(THINKING_LEVELS.map((level, index) => [level, index]));
export function parseThinkingLevel(value, field = "thinking level") {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (thinkingLevelRanks.has(trimmed))
            return trimmed;
    }
    throw new Error(`Invalid ${field}; expected one of ${THINKING_LEVELS.join(", ")}.`);
}
export function compareThinkingLevels(left, right) {
    const leftRank = thinkingLevelRanks.get(left);
    const rightRank = thinkingLevelRanks.get(right);
    if (leftRank === undefined || rightRank === undefined)
        throw new Error(`Invalid thinking level comparison; expected one of ${THINKING_LEVELS.join(", ")}.`);
    return leftRank - rightRank;
}
export function intersectThinkingCeilings(...ceilings) {
    const active = ceilings.filter((ceiling) => ceiling !== undefined);
    if (active.length === 0)
        return undefined;
    return active.reduce((lowest, ceiling) => compareThinkingLevels(ceiling, lowest) < 0 ? ceiling : lowest);
}
export function assertThinkingWithinCeiling(input) {
    if (!input.ceiling)
        return;
    const requested = resolveEffectiveThinking(input.model, input.configThinking);
    if (!requested)
        return;
    const requestedLevel = parseThinkingLevel(requested, "requested thinking level");
    if (compareThinkingLevels(requestedLevel, input.ceiling) <= 0)
        return;
    const subject = [input.agent ? `agent '${input.agent}'` : undefined, input.runId ? `run '${input.runId}'` : undefined]
        .filter((value) => Boolean(value))
        .join(" ");
    throw new Error(`Thinking level '${requestedLevel}' exceeds configured maximum '${input.ceiling}'${subject ? ` for ${subject}` : ""}.`);
}
//# sourceMappingURL=thinking-ceiling.js.map