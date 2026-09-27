import { WATCHDOG_WARNING_CATEGORIES, WATCHDOG_WARNING_IMPORTANCES } from "./types.js";
export const CHILD_WATCHDOG_WARNING_LIMIT = 20;
export const CHILD_WATCHDOG_STATUS_EVENT = "subagent.watchdog.status";
export const CHILD_WATCHDOG_PHASES = ["idle", "reviewing", "stale", "failed"];
export function resolveChildWatchdogConfig(input) {
    const override = input.agent ? input.config.children.overrides[input.agent] : undefined;
    const enabled = input.config.enabled && (override?.enabled ?? input.config.children.enabled);
    if (!enabled)
        return undefined;
    const model = override?.model ?? input.config.children.model;
    const thinking = override?.thinking ?? input.config.children.thinking;
    const cadence = override?.cadence ?? input.config.children.cadence ?? input.config.cadence;
    return {
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
        watchdogTailTimeoutMs: input.config.children.watchdogTailTimeoutMs,
        agentEndTimeoutMs: input.config.agentEndTimeoutMs,
        maxWarnings: input.config.maxWarnings,
        ...(model ? { model } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        lsp: { ...input.config.lsp },
        stalemateRepeats: input.config.stalemateRepeats,
        cadence: { everyNTools: cadence.everyNTools ?? null },
    };
}
function childConfigObject(value, field) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    throw new Error(`Invalid child watchdog config: ${field} must be an object.`);
}
function childConfigOptionalString(input, field) {
    if (!(field in input))
        return undefined;
    const value = input[field];
    if (typeof value === "string" && value.trim())
        return value;
    throw new Error(`Invalid child watchdog config: ${field} must be a non-empty string.`);
}
function childConfigOptionalIndex(input, field) {
    if (!(field in input))
        return undefined;
    const value = input[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0)
        return value;
    throw new Error(`Invalid child watchdog config: ${field} must be a non-negative integer.`);
}
function childConfigPositiveInteger(input, field) {
    const value = input[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1)
        return value;
    throw new Error(`Invalid child watchdog config: ${field} must be a positive integer.`);
}
function childConfigNullableNonNegativeInteger(input, field) {
    const value = input[field];
    if (value === null)
        return null;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0)
        return value;
    throw new Error(`Invalid child watchdog config: ${field} must be null or a non-negative integer.`);
}
function childConfigCadence(value) {
    const input = childConfigObject(value, "cadence");
    const everyNTools = input.everyNTools;
    if (everyNTools === null)
        return { everyNTools: null };
    if (typeof everyNTools === "number" && Number.isInteger(everyNTools) && everyNTools >= 5)
        return { everyNTools };
    throw new Error("Invalid child watchdog config: cadence.everyNTools must be null or an integer >= 5.");
}
function childConfigLsp(value) {
    const input = childConfigObject(value, "lsp");
    if (typeof input.enabled !== "boolean")
        throw new Error("Invalid child watchdog config: lsp.enabled must be a boolean.");
    if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
        throw new Error("Invalid child watchdog config: lsp.timeoutMs must be a positive integer.");
    }
    if (typeof input.maxFiles !== "number" || !Number.isInteger(input.maxFiles) || input.maxFiles < 1) {
        throw new Error("Invalid child watchdog config: lsp.maxFiles must be a positive integer.");
    }
    if (typeof input.maxDiagnostics !== "number" || !Number.isInteger(input.maxDiagnostics) || input.maxDiagnostics < 0) {
        throw new Error("Invalid child watchdog config: lsp.maxDiagnostics must be a non-negative integer.");
    }
    return {
        enabled: input.enabled,
        timeoutMs: input.timeoutMs,
        maxFiles: input.maxFiles,
        maxDiagnostics: input.maxDiagnostics,
    };
}
export function decodeChildWatchdogConfig(raw) {
    if (!raw)
        return undefined;
    const parsed = childConfigObject(JSON.parse(raw), "root");
    if (Object.hasOwn(parsed, "fallbackModels")) {
        throw new Error("Invalid child watchdog config: fallbackModels was removed; configure one model instead.");
    }
    if (parsed.enabled === false)
        return undefined;
    if ("enabled" in parsed && parsed.enabled !== true)
        throw new Error("Invalid child watchdog config: enabled must be true or false.");
    const thinking = parsed.thinking;
    if (thinking !== undefined && typeof thinking !== "string" && thinking !== false) {
        throw new Error("Invalid child watchdog config: thinking must be a string or false.");
    }
    const runId = childConfigOptionalString(parsed, "runId");
    const agent = childConfigOptionalString(parsed, "agent");
    const childIndex = childConfigOptionalIndex(parsed, "childIndex");
    const model = childConfigOptionalString(parsed, "model");
    return {
        ...(runId ? { runId } : {}),
        ...(agent ? { agent } : {}),
        ...(childIndex !== undefined ? { childIndex } : {}),
        watchdogTailTimeoutMs: childConfigPositiveInteger(parsed, "watchdogTailTimeoutMs"),
        agentEndTimeoutMs: childConfigPositiveInteger(parsed, "agentEndTimeoutMs"),
        maxWarnings: childConfigNullableNonNegativeInteger(parsed, "maxWarnings"),
        ...(model ? { model } : {}),
        ...(thinking !== undefined ? { thinking: thinking } : {}),
        lsp: childConfigLsp(parsed.lsp),
        stalemateRepeats: childConfigPositiveInteger(parsed, "stalemateRepeats"),
        cadence: childConfigCadence(parsed.cadence),
    };
}
export function isChildWatchdogStatusEvent(value) {
    if (!value || typeof value !== "object")
        return false;
    const event = value;
    const warningValue = event.warning;
    const warning = warningValue;
    const validWarning = warningValue === undefined || (warningValue !== null && typeof warningValue === "object" && !Array.isArray(warningValue)
        && (warning.severity === "concern" || warning.severity === "blocker")
        && typeof warning.importance === "string" && WATCHDOG_WARNING_IMPORTANCES.includes(warning.importance)
        && typeof warning.category === "string" && WATCHDOG_WARNING_CATEGORIES.includes(warning.category)
        && typeof warning.summary === "string" && typeof warning.evidence === "string" && typeof warning.recommendedAction === "string"
        && typeof warning.addressed === "boolean" && typeof warning.stalemate === "boolean"
        && (warning.displayedAt === undefined || typeof warning.displayedAt === "string"));
    return event.type === CHILD_WATCHDOG_STATUS_EVENT
        && typeof event.seq === "number"
        && Number.isInteger(event.seq)
        && event.seq >= 0
        && typeof event.ts === "number"
        && Number.isFinite(event.ts)
        && typeof event.phase === "string"
        && CHILD_WATCHDOG_PHASES.includes(event.phase)
        && validWarning;
}
export function childWatchdogIsActive(snapshot) {
    if (!snapshot)
        return false;
    return snapshot.phase === "reviewing";
}
export function acceptChildWatchdogEvent(input) {
    if (input.runId !== undefined && input.event.runId !== input.runId)
        return undefined;
    if (input.agent !== undefined && input.event.agent !== input.agent)
        return undefined;
    const eventIndex = input.event.childIndex ?? input.event.stepIndex;
    if (input.childIndex !== undefined && eventIndex !== input.childIndex)
        return undefined;
    if (input.current && input.event.seq <= input.current.seq)
        return undefined;
    const warnings = input.event.warning
        ? [...(input.current?.warnings ?? []), input.event.warning].slice(-CHILD_WATCHDOG_WARNING_LIMIT)
        : input.current?.warnings;
    return {
        phase: input.event.phase,
        seq: input.event.seq,
        lastUpdate: input.event.ts,
        ...(input.event.reason ? { reason: input.event.reason } : {}),
        ...(warnings?.length ? { warnings } : {}),
    };
}
/** An assistant turn marks earlier warnings addressed. Undefined when unchanged. */
export function applyChildWatchdogMessage(current, message) {
    if (message?.role !== "assistant" || !current?.warnings?.some((entry) => !entry.addressed))
        return undefined;
    return { ...current, warnings: current.warnings.map((entry) => entry.addressed ? entry : { ...entry, addressed: true }) };
}
export function unresolvedChildWatchdogBlockers(progress) {
    return (progress?.warnings ?? []).filter((warning) => warning.severity === "blocker" && (!warning.addressed || warning.stalemate));
}
export function childWatchdogProgressForModel(progress) {
    if (!progress)
        return undefined;
    const warnings = (progress.warnings ?? []).filter((warning) => warning.importance === "high");
    return { ...progress, warnings: warnings.length ? warnings : undefined };
}
//# sourceMappingURL=child-status.js.map