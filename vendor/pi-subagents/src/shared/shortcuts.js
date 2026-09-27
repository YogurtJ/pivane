export function formatShortcutLabel(shortcut) {
    return shortcut
        .split("+")
        .map((part) => {
        const normalized = part.trim().toLowerCase();
        if (normalized === "ctrl")
            return "Ctrl";
        if (normalized === "alt")
            return "Alt";
        if (normalized === "shift")
            return "Shift";
        if (normalized === "super")
            return "Super";
        return normalized.length === 1 ? normalized.toUpperCase() : part.trim();
    })
        .join("+");
}
//# sourceMappingURL=shortcuts.js.map