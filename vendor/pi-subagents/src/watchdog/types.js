export const SUBAGENT_WATCHDOG_WARNING_TYPE = "subagent_watchdog_warning";
export const WATCHDOG_WARNING_SEVERITIES = ["concern", "blocker"];
export const WATCHDOG_WARNING_CATEGORIES = [
    "correctness",
    "missed-constraint",
    "test-gap",
    "unsafe-change",
    "scope-drift",
    "stale-fact",
    "loop-risk",
    "other",
];
export const WATCHDOG_WARNING_IMPORTANCES = ["low", "medium", "high"];
export const WATCHDOG_WARNING_SOURCES = ["main", "child", "lsp"];
export const WATCHDOG_LSP_DIAGNOSTIC_SEVERITIES = ["error", "warning", "info", "hint"];
export const WATCHDOG_LSP_STATUSES = ["disabled", "ok", "skipped", "unavailable", "timeout", "failed"];
export const WATCHDOG_RUNTIME_STATUSES = ["idle", "queued", "reviewing", "waiting-at-agent-end", "stale", "failed"];
export const WATCHDOG_WARNING_STATES = [
    "candidate",
    "confirmed",
    "displayed",
    "stale",
    "failed",
    "resolved",
    "stalemate",
    "suppressed",
];
//# sourceMappingURL=types.js.map