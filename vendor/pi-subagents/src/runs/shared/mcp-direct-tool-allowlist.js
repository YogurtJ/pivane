import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findConfiguredProjectRoot } from "../../agents/agents.js";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.js";
import { isMcpServerDefinition, loadAgentPluginMcpServers, loadPackageMcpServers } from "./mcp-config-sources.js";
import { normalizeMcpDirectToolSelectors, parseMcpDirectToolSelectors, planMcpDirectToolGrant, } from "./mcp-direct-tool-grant.js";
export { formatUnresolvedMcpDirectToolSelectors } from "./mcp-direct-tool-grant.js";
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS = {
    cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
    "claude-code": [
        path.join(os.homedir(), ".claude", "mcp.json"),
        path.join(os.homedir(), ".claude.json"),
        path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
    ],
    "claude-desktop": [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
    codex: [path.join(os.homedir(), ".codex", "config.json")],
    windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
    vscode: [".vscode/mcp.json"],
};
export const MCP_RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1";
export const MCP_RUNTIME_SNAPSHOT_VERSION = 1;
export function resolveMcpDirectToolResolution(mcpDirectTools, cwd = process.cwd(), runtimeSnapshotHost, configOverride) {
    const selectors = normalizeMcpDirectToolSelectors(mcpDirectTools);
    if (selectors.length === 0)
        return { selections: [], unresolvedSelectors: [] };
    const config = configOverride ?? loadMcpConfig(cwd);
    const { servers: selectedServers, tools: selectedTools } = parseMcpDirectToolSelectors(selectors);
    const runtimeSelectionServers = new Set([...selectedServers, ...selectedTools.keys()]);
    const runtimeServers = resolveRuntimeMcpServers(config, runtimeSelectionServers, runtimeSnapshotHost);
    const resolvedConfig = Object.keys(runtimeServers).length > 0
        ? mergeConfigs(config, { mcpServers: runtimeServers })
        : config;
    validateSelectedServerDefinitions(resolvedConfig, selectors);
    const runtime = Object.keys(runtimeServers).length > 0
        ? { mcpConfig: resolvedConfig, runtimeServerNames: Object.keys(runtimeServers) }
        : {};
    const cache = loadMetadataCache();
    if (!cache)
        return { selections: [], unresolvedSelectors: selectors, ...runtime };
    const validMetadata = {};
    for (const [serverName, definition] of Object.entries(resolvedConfig.mcpServers)) {
        const serverCache = cache.servers[serverName];
        if (isServerCacheValid(serverCache, definition))
            validMetadata[serverName] = serverCache;
    }
    const grant = planMcpDirectToolGrant({
        selectors,
        servers: resolvedConfig.mcpServers,
        metadata: validMetadata,
        toolPrefix: resolvedConfig.settings?.toolPrefix,
    });
    return {
        selections: grant.selections,
        unresolvedSelectors: grant.unresolvedSelectors,
        ...runtime,
    };
}
export function resolveMcpDirectToolSelections(mcpDirectTools, cwd = process.cwd(), runtimeSnapshotHost) {
    return resolveMcpDirectToolResolution(mcpDirectTools, cwd, runtimeSnapshotHost).selections;
}
function loadMetadataCache() {
    const cachePath = path.join(getAgentDir(), "mcp-cache.json");
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    }
    catch {
        return null;
    }
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.servers))
        return null;
    const servers = {};
    for (const [name, value] of Object.entries(parsed.servers)) {
        const entry = parseServerCacheEntry(value);
        if (entry)
            servers[name] = entry;
    }
    return { version: CACHE_VERSION, servers };
}
function parseServerCacheEntry(value) {
    if (!isRecord(value))
        return undefined;
    if (value.configHash !== undefined && typeof value.configHash !== "string")
        return undefined;
    if (value.cachedAt !== undefined && (typeof value.cachedAt !== "number" || !Number.isFinite(value.cachedAt)))
        return undefined;
    if (value.tools !== undefined && !Array.isArray(value.tools))
        return undefined;
    if (value.resources !== undefined && !Array.isArray(value.resources))
        return undefined;
    const tools = value.tools?.map(parseCachedTool);
    const resources = value.resources?.map(parseCachedResource);
    if (tools && !tools.every((entry) => entry !== undefined))
        return undefined;
    if (resources && !resources.every((entry) => entry !== undefined))
        return undefined;
    return {
        ...(value.configHash !== undefined ? { configHash: value.configHash } : {}),
        ...(value.cachedAt !== undefined ? { cachedAt: value.cachedAt } : {}),
        ...(tools ? { tools } : {}),
        ...(resources ? { resources } : {}),
    };
}
function parseCachedTool(value) {
    if (!isRecord(value) || (value.name !== undefined && typeof value.name !== "string"))
        return undefined;
    return value.name === undefined ? {} : { name: value.name };
}
function parseCachedResource(value) {
    if (!isRecord(value))
        return undefined;
    if (value.uri !== undefined && typeof value.uri !== "string")
        return undefined;
    if (value.name !== undefined && typeof value.name !== "string")
        return undefined;
    return {
        ...(value.uri !== undefined ? { uri: value.uri } : {}),
        ...(value.name !== undefined ? { name: value.name } : {}),
    };
}
function resolveRuntimeMcpServers(config, selectedServers, runtimeSnapshotHost) {
    if (!runtimeSnapshotHost)
        return {};
    const runtimeServers = {};
    for (const serverName of selectedServers) {
        if (Object.hasOwn(config.mcpServers, serverName))
            continue;
        try {
            const snapshot = getRuntimeMcpServerSnapshot(runtimeSnapshotHost, serverName);
            runtimeServers[serverName] = snapshot.definition;
        }
        catch {
            // Missing, disposed, or shadowed runtime servers remain unresolved below.
        }
    }
    return runtimeServers;
}
function getRuntimeMcpServerSnapshot(host, name) {
    const request = {
        version: MCP_RUNTIME_SNAPSHOT_VERSION,
        name,
    };
    host.events.emit(MCP_RUNTIME_SNAPSHOT_EVENT, request);
    if (!request.result)
        throw new Error("pi-mcp-adapter is not installed for this Pi instance");
    if (!request.result.ok)
        throw request.result.error;
    const snapshot = request.result.snapshot;
    if (!snapshot ||
        snapshot.name !== name ||
        snapshot.runtime !== true ||
        snapshot.persisted !== false ||
        !isMcpServerDefinition(snapshot.definition)) {
        throw new Error(`Invalid MCP runtime snapshot for server "${name}"`);
    }
    return snapshot;
}
function loadMcpConfig(cwd) {
    const resolvedCwd = path.resolve(cwd);
    const projectRoot = findConfiguredProjectRoot(resolvedCwd) ?? resolvedCwd;
    let config = { mcpServers: {} };
    for (const sourcePath of getConfigPaths(projectRoot)) {
        const loaded = readConfig(sourcePath);
        if (!loaded)
            continue;
        config = mergeConfigs(config, expandImports(loaded, projectRoot));
    }
    const packageServers = loadPackageMcpServers(projectRoot);
    const pluginServers = loadAgentPluginMcpServers(config.settings?.agentPluginPaths, projectRoot);
    const packageOnlyServers = Object.fromEntries(Object.entries(packageServers).filter(([name]) => !Object.hasOwn(pluginServers, name)));
    return mergeConfigs({ mcpServers: packageOnlyServers }, mergeConfigs({ mcpServers: pluginServers }, config));
}
function getConfigPaths(projectRoot) {
    const piGlobalPath = path.join(getAgentDir(), "mcp.json");
    const projectPath = path.resolve(projectRoot, ".mcp.json");
    const projectPiPath = path.resolve(getProjectConfigDir(projectRoot), "mcp.json");
    const sources = [];
    if (GENERIC_GLOBAL_CONFIG_PATH !== piGlobalPath)
        sources.push(GENERIC_GLOBAL_CONFIG_PATH);
    sources.push(piGlobalPath);
    if (projectPath !== piGlobalPath)
        sources.push(projectPath);
    if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath)
        sources.push(projectPiPath);
    return sources;
}
function readConfig(configPath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
    catch {
        return null;
    }
    return validateConfig(parsed);
}
function validateConfig(raw) {
    if (!isRecord(raw))
        return { mcpServers: {} };
    const obj = raw;
    const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};
    return {
        mcpServers: parseServerEntries(servers),
        imports: Array.isArray(obj.imports) ? obj.imports.filter((value) => isImportKind(value)) : undefined,
        settings: parseSettings(obj.settings),
    };
}
function parseServerEntries(value) {
    if (!isRecord(value))
        return {};
    return Object.fromEntries(Object.entries(value).filter((entry) => isMcpServerDefinition(entry[1])));
}
function parseSettings(value) {
    if (!isRecord(value))
        return undefined;
    const toolPrefix = value.toolPrefix === "server" || value.toolPrefix === "short" || value.toolPrefix === "none" || value.toolPrefix === "mcp" ? value.toolPrefix : undefined;
    const directTools = typeof value.directTools === "boolean" ? value.directTools : undefined;
    const settings = {
        ...(toolPrefix ? { toolPrefix } : {}),
        ...(directTools !== undefined ? { directTools } : {}),
        ...(value.agentPluginPaths !== undefined ? { agentPluginPaths: value.agentPluginPaths } : {}),
    };
    return Object.keys(settings).length ? settings : undefined;
}
function mergeConfigs(base, next) {
    const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
    return {
        mcpServers: { ...base.mcpServers, ...next.mcpServers },
        imports: imports.length ? [...new Set(imports)] : undefined,
        settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
    };
}
function expandImports(config, cwd) {
    if (!config.imports?.length)
        return config;
    const importedServers = {};
    for (const importKind of config.imports) {
        const importPath = resolveImportPath(importKind, cwd);
        if (!importPath)
            continue;
        let imported;
        try {
            imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
        }
        catch {
            continue;
        }
        for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
            if (!importedServers[name])
                importedServers[name] = definition;
        }
    }
    return {
        imports: config.imports,
        settings: config.settings,
        mcpServers: { ...importedServers, ...config.mcpServers },
    };
}
function resolveImportPath(importKind, cwd) {
    for (const candidate of IMPORT_PATHS[importKind]) {
        const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
        if (fs.existsSync(fullPath))
            return fullPath;
    }
    return null;
}
function extractServers(config, kind) {
    if (!isRecord(config))
        return {};
    const obj = config;
    const servers = kind === "cursor" || kind === "windsurf" || kind === "vscode"
        ? obj.mcpServers ?? obj["mcp-servers"]
        : obj.mcpServers;
    return parseServerEntries(servers);
}
export function resolveMcpDirectToolNames(mcpDirectTools, cwd = process.cwd()) {
    return resolveMcpDirectToolSelections(mcpDirectTools, cwd).map((selection) => selection.name);
}
function validateSelectedServerDefinitions(config, selectors) {
    const { servers, tools } = parseMcpDirectToolSelectors(selectors);
    for (const serverName of new Set([...servers, ...tools.keys()])) {
        const definition = config.mcpServers[serverName];
        if (definition)
            computeMcpServerHash(definition);
    }
}
function isServerCacheValid(entry, definition) {
    if (!entry || entry.configHash !== computeMcpServerHash(definition))
        return false;
    if (!entry.cachedAt || typeof entry.cachedAt !== "number")
        return false;
    return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}
export function computeMcpServerHash(definition) {
    const identity = {
        command: definition.command,
        args: definition.args,
        socket: resolveConfigPath(definition.socket),
        env: interpolateEnvRecord(definition.env),
        cwd: resolveConfigPath(definition.cwd),
        url: resolveServerUrl(definition),
        headers: interpolateEnvRecord(definition.headers),
        requestHeadersCommand: definition.requestHeadersCommand
            ? {
                command: interpolateEnvVars(definition.requestHeadersCommand.command),
                args: definition.requestHeadersCommand.args?.map(interpolateEnvVars),
                env: interpolateEnvRecord(definition.requestHeadersCommand.env),
                timeoutMs: definition.requestHeadersCommand.timeoutMs,
            }
            : undefined,
        auth: definition.auth,
        bearerToken: resolveBearerToken(definition),
        bearerTokenEnv: definition.bearerTokenEnv,
        exposeResources: definition.exposeResources,
        includeTools: definition.includeTools,
        excludeTools: definition.excludeTools,
        protocolVersion: definition.protocolVersion,
    };
    return createHash("sha256").update(stableStringify(identity)).digest("hex");
}
function isImportKind(value) {
    return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function interpolateEnvRecord(values) {
    if (!values)
        return undefined;
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateSecretExpression(value)]));
}
function interpolateEnvVars(value) {
    return value
        .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
        .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "")
        .replace(/\{env:(\w+)\}/g, (_, name) => process.env[name] ?? "");
}
function interpolateSecretExpression(value) {
    if (value.startsWith("!!"))
        return interpolateEnvVars(value.slice(1));
    return value.startsWith("!") ? value : interpolateEnvVars(value);
}
function getMissingEnvVars(value) {
    const missing = new Set();
    for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
        const name = match[1] ?? match[2] ?? match[3];
        if (name && process.env[name] === undefined)
            missing.add(name);
    }
    return [...missing];
}
function resolveServerUrl(definition) {
    if (definition.url == null)
        return undefined;
    if (typeof definition.url !== "string")
        throw new Error("MCP server URL must be a string");
    const missing = getMissingEnvVars(definition.url);
    if (missing.length > 0) {
        throw new Error(`Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`);
    }
    const resolved = interpolateEnvVars(definition.url);
    try {
        new URL(resolved);
    }
    catch (error) {
        throw new Error(`Invalid MCP server URL after environment interpolation: ${resolved}`, { cause: error });
    }
    return resolved;
}
function resolveConfigPath(value) {
    if (value === undefined)
        return undefined;
    const resolved = interpolateEnvVars(value);
    if (resolved === "~")
        return os.homedir();
    if (resolved.startsWith("~/") || resolved.startsWith("~\\"))
        return path.join(os.homedir(), resolved.slice(2));
    return resolved;
}
function resolveBearerToken(definition) {
    if (definition.bearerToken !== undefined)
        return interpolateSecretExpression(definition.bearerToken);
    return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}
function stableStringify(value) {
    if (value === null || value === undefined || typeof value !== "object") {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? "undefined" : serialized;
    }
    if (Array.isArray(value))
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    const obj = value;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}
//# sourceMappingURL=mcp-direct-tool-allowlist.js.map