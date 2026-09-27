export function isContextMode(value) {
    return value === "fresh" || value === "fork";
}
export function isContextSummary(value) {
    return isContextMode(value) || value === "mixed";
}
export function summarizeContextModes(modes) {
    const resolved = modes.filter(isContextMode);
    if (resolved.length === 0)
        return undefined;
    const first = resolved[0];
    return resolved.every((mode) => mode === first) ? first : "mixed";
}
export function contextModeLabel(mode) {
    if (mode === "fork")
        return "[fork]";
    if (mode === "fresh")
        return "[fresh]";
    if (mode === "mixed")
        return "[mixed]";
    return "";
}
export function contextModeBadge(theme, mode) {
    const label = contextModeLabel(mode);
    if (!label)
        return "";
    if (mode === "fork")
        return theme.fg("warning", ` ${label}`);
    return theme.fg("dim", ` ${label}`);
}
export function contextModePrefix(theme, mode) {
    const label = contextModeLabel(mode);
    if (!label)
        return "";
    if (mode === "fork")
        return `${theme.fg("warning", label)} `;
    return `${theme.fg("dim", label)} `;
}
//# sourceMappingURL=context-mode.js.map