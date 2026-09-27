export const TOOL_TIMEOUT_ENV = "PI_SUBAGENT_TOOL_TIMEOUT_MS";
/** Maximum delay a Node.js timer accepts without overflow. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_FAST_TOOL_TIMEOUT_MS = 300_000;
export const DEFAULT_FAST_TOOL_TIMEOUT_TOOLS = new Set([
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
    "structured_output",
]);
/** Tools whose normal job can be to wait for a person or another run. */
export const TOOL_TIMEOUT_EXEMPT_TOOLS = new Set(["contact_supervisor", "intercom", "bg_wait"]);
// Backward-compatible export name for existing callers/tests.
export const TOOL_TIMEOUT_ALLOWLIST = TOOL_TIMEOUT_EXEMPT_TOOLS;
export function isToolTimeoutExempt(toolName) {
    return toolName !== undefined && TOOL_TIMEOUT_EXEMPT_TOOLS.has(toolName);
}
export function defaultToolTimeoutMs(toolName) {
    return toolName !== undefined && DEFAULT_FAST_TOOL_TIMEOUT_TOOLS.has(toolName)
        ? DEFAULT_FAST_TOOL_TIMEOUT_MS
        : undefined;
}
export function effectiveToolTimeoutMs(toolName, configuredToolTimeoutMs) {
    if (isToolTimeoutExempt(toolName))
        return undefined;
    return configuredToolTimeoutMs ?? defaultToolTimeoutMs(toolName);
}
export function formatToolTimeoutMessage(toolName, timeoutMs) {
    return `Tool '${toolName}' exceeded its timeout of ${timeoutMs}ms.`;
}
export function toolTimeoutCallKey(event, fallbackId) {
    return typeof event.toolCallId === "string" && event.toolCallId.length > 0
        ? `id:${event.toolCallId}`
        : `anon:${String(event.toolName ?? "tool")}:${fallbackId}`;
}
/** Resolve the configured hard timeout. Default fast-tool timeouts apply later per tool name. */
export function resolveToolTimeoutMs(input) {
    const candidates = [
        { label: "toolTimeoutMs", value: input.callValue },
        { label: "agent.toolTimeoutMs", value: input.agentValue },
        { label: "config.toolTimeoutMs", value: input.configValue },
    ];
    let winner;
    for (const candidate of candidates) {
        if (candidate.value === undefined)
            continue;
        winner = candidate;
        break;
    }
    if (winner === undefined && input.envValue !== undefined && input.envValue.trim() !== "") {
        winner = { label: TOOL_TIMEOUT_ENV, value: input.envValue };
    }
    if (winner === undefined)
        return {};
    let raw = winner.value;
    let parsed;
    if (winner.label === TOOL_TIMEOUT_ENV && typeof raw === "string") {
        parsed = Number(raw);
        if (raw.trim() !== "" && !Number.isNaN(parsed))
            raw = parsed;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TIMER_DELAY_MS) {
        return { error: `${winner.label} must be a positive integer no larger than ${MAX_TIMER_DELAY_MS}.` };
    }
    return { toolTimeoutMs: raw };
}
/** Read the environment override without requiring callers to know the name. */
export function toolTimeoutFromEnv(env = process.env) {
    return env[TOOL_TIMEOUT_ENV];
}
//# sourceMappingURL=tool-timeout.js.map