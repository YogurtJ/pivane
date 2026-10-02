import { isStaleExtensionContextError, isUnboundExtensionRuntimeError } from "../shared/extension-context.js";
let mainThinkingLevelSource = () => undefined;
/** Registers where the main session's current thinking level is read; glyphs that stand for several children take its color. */
export function setMainThinkingLevelSource(source) {
    mainThinkingLevelSource = source;
}
/** Reads the main session's level through `read`; a stale or not-yet-bound Pi runtime has no level to show. */
export function readMainThinkingLevel(read) {
    try {
        return read();
    }
    catch (error) {
        if (isStaleExtensionContextError(error) || isUnboundExtensionRuntimeError(error))
            return undefined;
        throw error;
    }
}
/** The running tone of a glyph: Pi's prompt-box color for the recorded level of the one child it stands for, else for the main session's current level, else accent. */
export function runningTone(theme, childLevel) {
    const level = childLevel ?? mainThinkingLevelSource();
    return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
//# sourceMappingURL=running-tone.js.map