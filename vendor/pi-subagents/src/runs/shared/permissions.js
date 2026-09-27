import * as fs from "node:fs";
import * as path from "node:path";
const INTERNAL_TOOLS = new Set(["contact_supervisor", "intercom", "bg_wait", "structured_output"]);
const DECISIONS = new Set(["allow", "ask", "deny"]);
const MAX_POLICY_BYTES = 16 * 1024;
const MAX_PREVIEW_BYTES = 2048;
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;
const SECRET_VALUE = /\b(?:Bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/gi;
export function redactSecretValues(value) {
    return value.replace(SECRET_VALUE, "[redacted]");
}
export function validatePermissionRules(value, label) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object mapping tool names to allow, ask, or deny.`);
    const result = {};
    for (const [tool, decision] of Object.entries(value)) {
        if (!tool.trim())
            throw new Error(`${label} contains an empty tool name.`);
        if (tool === "bash")
            throw new Error(`${label}.bash is unsupported; pi-subagents leaves bash policy to pi-guard.`);
        if (INTERNAL_TOOLS.has(tool))
            throw new Error(`${label}.${tool} is reserved for child coordination and cannot be gated.`);
        if (!DECISIONS.has(decision))
            throw new Error(`${label}.${tool} must be allow, ask, or deny.`);
        result[tool] = decision;
    }
    return Object.keys(result).length ? result : undefined;
}
export function validatePermissionConfig(value, label = "config.permissions") {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
    const object = value;
    const unknown = Object.keys(object).filter((key) => key !== "rules");
    if (unknown.length)
        throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
    return { rules: validatePermissionRules(object.rules, `${label}.rules`) };
}
export function resolvePermissionRules(globalConfig, agentRules) {
    const merged = { ...(globalConfig?.rules ?? {}), ...(agentRules ?? {}) };
    for (const [tool, decision] of Object.entries(merged))
        if (decision === "allow")
            delete merged[tool];
    return Object.keys(merged).length ? merged : undefined;
}
export function permissionDecision(rules, toolName) {
    if (toolName === "bash" || INTERNAL_TOOLS.has(toolName))
        return "allow";
    return rules?.[toolName] ?? "allow";
}
function redact(value, key = "", depth = 0) {
    if (SECRET_KEY.test(key))
        return "[redacted]";
    if (depth >= 3)
        return "[truncated]";
    if (Array.isArray(value))
        return value.slice(0, 10).map((item) => redact(item, "", depth + 1));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).slice(0, 20).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, depth + 1)]));
    if (typeof value === "string") {
        const redacted = redactSecretValues(value);
        return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
    }
    return value;
}
export function permissionArgsPreview(input) {
    const serialized = JSON.stringify(redact(input));
    if (!serialized)
        return "{}";
    if (Buffer.byteLength(serialized, "utf-8") <= MAX_PREVIEW_BYTES)
        return serialized;
    const maxContentBytes = MAX_PREVIEW_BYTES - Buffer.byteLength("…", "utf-8");
    let preview = "";
    let previewBytes = 0;
    for (const character of serialized) {
        const characterBytes = Buffer.byteLength(character, "utf-8");
        if (previewBytes + characterBytes > maxContentBytes)
            break;
        preview += character;
        previewBytes += characterBytes;
    }
    return `${preview}…`;
}
export function appendPermissionAudit(filePath, record) {
    if (!filePath)
        return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
}
//# sourceMappingURL=permissions.js.map