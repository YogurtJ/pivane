import * as fs from "node:fs";
import * as path from "node:path";
import { THINKING_LEVELS } from "../shared/model-info.js";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.js";
import { WATCHDOG_WARNING_SEVERITIES, } from "./types.js";
export const DEFAULT_WATCHDOG_CONFIG = {
    enabled: false,
    clarification: false,
    agentEndTimeoutMs: 30_000,
    severityThreshold: "concern",
    maxWarnings: null,
    guidance: {
        watchdogMd: true,
    },
    stalemateRepeats: 3,
    scope: {
        enabled: true,
    },
    cadence: {
        everyNTools: null,
    },
    main: {
        enabled: false,
    },
    children: {
        enabled: false,
        watchdogTailTimeoutMs: 120_000,
        overrides: {},
    },
    lsp: {
        enabled: true,
        timeoutMs: 3_000,
        maxFiles: 20,
        maxDiagnostics: 50,
    },
};
const WATCHDOG_FIELDS = new Set([
    "enabled",
    "clarification",
    "agentEndTimeoutMs",
    "severityThreshold",
    "maxWarnings",
    "guidance",
    "stalemateRepeats",
    "scope",
    "cadence",
    "main",
    "children",
    "lsp",
    "rules",
]);
const RULES_FIELDS = new Set(["action", "roleModels"]);
const ROLE_MODEL_RULE_FIELDS = new Set(["allow", "deny", "note"]);
const GUIDANCE_FIELDS = new Set(["watchdogMd"]);
const SCOPE_FIELDS = new Set(["enabled"]);
const CADENCE_FIELDS = new Set(["everyNTools"]);
const ENDPOINT_FIELDS = new Set(["enabled", "model", "thinking"]);
const CHILDREN_FIELDS = new Set(["enabled", "model", "thinking", "watchdogTailTimeoutMs", "cadence", "overrides"]);
const CHILD_OVERRIDE_FIELDS = new Set(["enabled", "model", "thinking", "cadence"]);
const LSP_FIELDS = new Set(["enabled", "timeoutMs", "maxFiles", "maxDiagnostics"]);
function cloneDefaultConfig() {
    return {
        ...DEFAULT_WATCHDOG_CONFIG,
        guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
        scope: { ...DEFAULT_WATCHDOG_CONFIG.scope },
        cadence: { ...DEFAULT_WATCHDOG_CONFIG.cadence },
        main: { ...DEFAULT_WATCHDOG_CONFIG.main },
        children: {
            ...DEFAULT_WATCHDOG_CONFIG.children,
            overrides: {},
        },
        lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp },
    };
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sourceName(meta) {
    return meta.path ? `'${meta.path}'` : "session override";
}
function invalid(meta, field, expected) {
    return new Error(`Watchdog settings in ${sourceName(meta)} have invalid '${field}'; expected ${expected}.`);
}
function unknown(meta, field) {
    return new Error(`Watchdog settings in ${sourceName(meta)} have unknown field '${field}'.`);
}
function assertKnownFields(input, allowed, fieldPrefix, meta) {
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            throw unknown(meta, `${fieldPrefix}.${key}`);
    }
}
function parseObject(value, field, meta) {
    if (isPlainObject(value))
        return value;
    throw invalid(meta, field, "an object");
}
function parseBoolean(value, field, meta) {
    if (typeof value === "boolean")
        return value;
    throw invalid(meta, field, "a boolean");
}
function parseNonEmptyString(value, field, meta) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    throw invalid(meta, field, "a non-empty string");
}
function parseThinking(value, field, meta) {
    if (value === false)
        return false;
    if (typeof value === "string" && THINKING_LEVELS.includes(value))
        return value;
    throw invalid(meta, field, `${THINKING_LEVELS.map((level) => `'${level}'`).join(" or ")} or false`);
}
function parseInteger(value, field, meta, expected, check) {
    if (typeof value === "number" && Number.isInteger(value) && check(value))
        return value;
    throw invalid(meta, field, expected);
}
function parseNullableInteger(value, field, meta, expected, check) {
    if (value === null)
        return null;
    return parseInteger(value, field, meta, expected, check);
}
function parseEnum(value, field, meta, values) {
    if (typeof value === "string" && values.includes(value))
        return value;
    throw invalid(meta, field, values.map((item) => `'${item}'`).join(" or "));
}
function parseGuidancePatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, GUIDANCE_FIELDS, field, meta);
    const patch = {};
    if ("watchdogMd" in input)
        patch.watchdogMd = parseBoolean(input.watchdogMd, `${field}.watchdogMd`, meta);
    return patch;
}
function parseScopePatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, SCOPE_FIELDS, field, meta);
    const patch = {};
    if ("enabled" in input)
        patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
    return patch;
}
function parseCadencePatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, CADENCE_FIELDS, field, meta);
    const patch = {};
    if ("everyNTools" in input) {
        patch.everyNTools = input.everyNTools === null
            ? null
            : parseInteger(input.everyNTools, `${field}.everyNTools`, meta, "null or an integer >= 5", (candidate) => candidate >= 5);
    }
    return patch;
}
function parseEndpointPatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, ENDPOINT_FIELDS, field, meta);
    const patch = {};
    if ("enabled" in input)
        patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
    if ("model" in input)
        patch.model = parseNonEmptyString(input.model, `${field}.model`, meta);
    if ("thinking" in input)
        patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta);
    return patch;
}
function parseChildOverridePatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, CHILD_OVERRIDE_FIELDS, field, meta);
    const patch = {};
    if ("enabled" in input)
        patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
    if ("model" in input)
        patch.model = parseNonEmptyString(input.model, `${field}.model`, meta);
    if ("thinking" in input)
        patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta);
    if ("cadence" in input)
        patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta);
    return patch;
}
function parseChildrenPatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, CHILDREN_FIELDS, field, meta);
    const patch = {};
    if ("enabled" in input)
        patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
    if ("model" in input)
        patch.model = parseNonEmptyString(input.model, `${field}.model`, meta);
    if ("thinking" in input)
        patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta);
    if ("watchdogTailTimeoutMs" in input) {
        patch.watchdogTailTimeoutMs = parseInteger(input.watchdogTailTimeoutMs, `${field}.watchdogTailTimeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
    }
    if ("cadence" in input)
        patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta);
    if ("overrides" in input) {
        const overrides = parseObject(input.overrides, `${field}.overrides`, meta);
        patch.overrides = {};
        for (const [agent, override] of Object.entries(overrides)) {
            if (!agent.trim())
                throw invalid(meta, `${field}.overrides`, "agent names to be non-empty");
            patch.overrides[agent] = parseChildOverridePatch(override, `${field}.overrides.${agent}`, meta);
        }
    }
    return patch;
}
function parseLspPatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, LSP_FIELDS, field, meta);
    const patch = {};
    if ("enabled" in input)
        patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
    if ("timeoutMs" in input)
        patch.timeoutMs = parseInteger(input.timeoutMs, `${field}.timeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
    if ("maxFiles" in input)
        patch.maxFiles = parseInteger(input.maxFiles, `${field}.maxFiles`, meta, "a positive integer", (candidate) => candidate >= 1);
    if ("maxDiagnostics" in input)
        patch.maxDiagnostics = parseInteger(input.maxDiagnostics, `${field}.maxDiagnostics`, meta, "a non-negative integer", (candidate) => candidate >= 0);
    return patch;
}
function parseStringList(value, field, meta) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim()))
        throw invalid(meta, field, "an array of non-empty strings");
    return value.map((entry) => entry.trim());
}
function parseRoleModelRule(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, ROLE_MODEL_RULE_FIELDS, field, meta);
    const rule = {};
    if ("allow" in input)
        rule.allow = parseStringList(input.allow, `${field}.allow`, meta);
    if ("deny" in input)
        rule.deny = parseStringList(input.deny, `${field}.deny`, meta);
    if ("note" in input)
        rule.note = parseNonEmptyString(input.note, `${field}.note`, meta);
    return rule;
}
function parseRules(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, RULES_FIELDS, field, meta);
    const rules = { action: "warn", roleModels: {} };
    if ("action" in input)
        rules.action = parseEnum(input.action, `${field}.action`, meta, ["warn", "block"]);
    if ("roleModels" in input) {
        for (const [agent, rule] of Object.entries(parseObject(input.roleModels, `${field}.roleModels`, meta))) {
            if (!agent.trim())
                throw invalid(meta, `${field}.roleModels`, "agent names to be non-empty");
            rules.roleModels[agent] = parseRoleModelRule(rule, `${field}.roleModels.${agent}`, meta);
        }
    }
    return rules;
}
function parseWatchdogPatch(value, field, meta) {
    const input = parseObject(value, field, meta);
    assertKnownFields(input, WATCHDOG_FIELDS, field, meta);
    const patch = {};
    if ("enabled" in input)
        patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
    if ("clarification" in input)
        patch.clarification = parseBoolean(input.clarification, `${field}.clarification`, meta);
    if ("agentEndTimeoutMs" in input) {
        patch.agentEndTimeoutMs = parseInteger(input.agentEndTimeoutMs, `${field}.agentEndTimeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
    }
    if ("severityThreshold" in input) {
        patch.severityThreshold = parseEnum(input.severityThreshold, `${field}.severityThreshold`, meta, WATCHDOG_WARNING_SEVERITIES);
    }
    if ("maxWarnings" in input) {
        patch.maxWarnings = parseNullableInteger(input.maxWarnings, `${field}.maxWarnings`, meta, "null or a non-negative integer", (candidate) => candidate >= 0);
    }
    if ("guidance" in input)
        patch.guidance = parseGuidancePatch(input.guidance, `${field}.guidance`, meta);
    if ("stalemateRepeats" in input) {
        patch.stalemateRepeats = parseInteger(input.stalemateRepeats, `${field}.stalemateRepeats`, meta, "a positive integer", (candidate) => candidate >= 1);
    }
    if ("scope" in input)
        patch.scope = parseScopePatch(input.scope, `${field}.scope`, meta);
    if ("cadence" in input)
        patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta);
    if ("main" in input)
        patch.main = parseEndpointPatch(input.main, `${field}.main`, meta);
    if ("children" in input)
        patch.children = parseChildrenPatch(input.children, `${field}.children`, meta);
    if ("lsp" in input)
        patch.lsp = parseLspPatch(input.lsp, `${field}.lsp`, meta);
    if ("rules" in input)
        patch.rules = parseRules(input.rules, `${field}.rules`, meta);
    return patch;
}
function parseSettingsObject(settings, meta) {
    if (!("subagents" in settings))
        return {};
    const subagents = parseObject(settings.subagents, "subagents", meta);
    if (!("watchdog" in subagents))
        return {};
    return parseWatchdogPatch(subagents.watchdog, "subagents.watchdog", meta);
}
function readSettingsFileStrict(filePath) {
    if (!fs.existsSync(filePath))
        return {};
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
    }
    if (!isPlainObject(parsed)) {
        throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
    }
    return parsed;
}
function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
function getUserSettingsPath() {
    return path.join(getAgentDir(), "settings.json");
}
export function getWatchdogUserSettingsPath() {
    return getUserSettingsPath();
}
function getProjectSettingsPath(cwd) {
    let currentDir = cwd;
    while (true) {
        if (isDirectory(getProjectConfigDir(currentDir)) || isDirectory(path.join(currentDir, ".agents"))) {
            return path.join(getProjectConfigDir(currentDir), "settings.json");
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            return undefined;
        currentDir = parentDir;
    }
}
export function getWatchdogProjectSettingsPath(cwd) {
    return path.join(getProjectConfigDir(cwd), "settings.json");
}
function deepMerge(base, patch) {
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const current = next[key];
        next[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
    }
    return next;
}
function resolvePatch(patch) {
    const config = deepMerge(cloneDefaultConfig(), patch);
    config.enabled = patch.enabled ?? DEFAULT_WATCHDOG_CONFIG.enabled;
    config.main.enabled = patch.main?.enabled ?? config.enabled;
    return config;
}
function parseSourceFile(filePath, scope) {
    return parseSettingsObject(readSettingsFileStrict(filePath), { scope, path: filePath });
}
function parseSessionOverride(value) {
    if ("subagents" in value)
        return parseSettingsObject(value, { scope: "session" });
    return parseWatchdogPatch(value, "subagents.watchdog", { scope: "session" });
}
export function resolveWatchdogConfigStrict(cwd, options = {}) {
    let patch = {};
    patch = deepMerge(patch, parseSourceFile(getUserSettingsPath(), "user"));
    const projectSettingsPath = getProjectSettingsPath(cwd);
    if (projectSettingsPath) {
        patch = deepMerge(patch, parseSourceFile(projectSettingsPath, "project"));
    }
    if (options.session) {
        patch = deepMerge(patch, parseSessionOverride(options.session));
    }
    return resolvePatch(patch);
}
function ensureObjectField(parent, key, field, meta) {
    if (!(key in parent))
        parent[key] = {};
    if (!isPlainObject(parent[key]))
        throw invalid(meta, field, "an object");
    return parent[key];
}
function ensureWatchdogSettings(settings, meta) {
    const subagents = ensureObjectField(settings, "subagents", "subagents", meta);
    return ensureObjectField(subagents, "watchdog", "subagents.watchdog", meta);
}
function settingsPathForWrite(scope, cwd) {
    return scope === "user" ? getUserSettingsPath() : getWatchdogProjectSettingsPath(cwd ?? process.cwd());
}
function targetSettingsObject(watchdog, target, meta) {
    if (target.kind === "main")
        return ensureObjectField(watchdog, "main", "subagents.watchdog.main", meta);
    const children = ensureObjectField(watchdog, "children", "subagents.watchdog.children", meta);
    if (target.kind === "children")
        return children;
    if (!target.agent.trim())
        throw invalid(meta, "subagents.watchdog.children.overrides.<agent>", "a non-empty agent name");
    const overrides = ensureObjectField(children, "overrides", "subagents.watchdog.children.overrides", meta);
    return ensureObjectField(overrides, target.agent.trim(), `subagents.watchdog.children.overrides.${target.agent.trim()}`, meta);
}
function writeSettingsFile(settingsPath, settings) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    return settingsPath;
}
export function writeUserWatchdogEnabled(enabled) {
    const settingsPath = getUserSettingsPath();
    const meta = { scope: "user", path: settingsPath };
    const settings = readSettingsFileStrict(settingsPath);
    const watchdog = ensureWatchdogSettings(settings, meta);
    watchdog.enabled = enabled;
    targetSettingsObject(watchdog, { kind: "main" }, meta).enabled = enabled;
    return writeSettingsFile(settingsPath, settings);
}
export function writeWatchdogModelSettings(input) {
    const settingsPath = settingsPathForWrite(input.scope, input.cwd);
    const meta = { scope: input.scope, path: settingsPath };
    const settings = readSettingsFileStrict(settingsPath);
    const watchdog = ensureWatchdogSettings(settings, meta);
    const target = targetSettingsObject(watchdog, input.target, meta);
    if (input.model === null)
        delete target.model;
    else if (input.model !== undefined)
        target.model = input.model;
    if (input.thinking === null)
        delete target.thinking;
    else if (input.thinking !== undefined)
        target.thinking = input.thinking;
    return writeSettingsFile(settingsPath, settings);
}
export function resolveWatchdogConfig(cwd, options = {}) {
    const sources = [];
    const errors = [];
    let patch = {};
    const sourceSpecs = [
        { scope: "user", path: getUserSettingsPath() },
        { scope: "project", path: getProjectSettingsPath(cwd) },
    ];
    for (const source of sourceSpecs) {
        if (!source.path)
            continue;
        sources.push({ scope: source.scope, path: source.path, exists: fs.existsSync(source.path) });
        try {
            patch = deepMerge(patch, parseSourceFile(source.path, source.scope));
        }
        catch (error) {
            errors.push({ scope: source.scope, path: source.path, message: error instanceof Error ? error.message : String(error) });
        }
    }
    if (options.session) {
        sources.push({ scope: "session", exists: true });
        try {
            patch = deepMerge(patch, parseSessionOverride(options.session));
        }
        catch (error) {
            errors.push({ scope: "session", message: error instanceof Error ? error.message : String(error) });
        }
    }
    return {
        ok: errors.length === 0,
        config: errors.length === 0 ? resolvePatch(patch) : cloneDefaultConfig(),
        errors,
        sources,
    };
}
//# sourceMappingURL=settings.js.map