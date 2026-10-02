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
    if (usesBuiltinMcp(runtimeSnapshotHost)) {
        return resolveBuiltinMcpSelections(selectors, runtimeSnapshotHost.getAllTools?.() ?? []);
    }
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
/**
 * pi-mcp-adapter keeps priority whenever it is loaded. 2.x registers /mcp, so Pi does not load its
 * built-in MCP. 3.x always registers /mcp-adapter and leaves /mcp to the built-in MCP.
 */
function usesBuiltinMcp(host) {
    const commands = host?.getCommands?.() ?? [];
    return commands.find((command) => command.name === "mcp")?.sourceInfo.path === "builtin:mcp"
        && !commands.some((command) => /^mcp-adapter(?::\d+)?$/.test(command.name));
}
/**
 * Pi names built-in MCP tools `mcp__<server>__<tool>` with invalid characters replaced by `_`,
 * in the namespace `mcp__<server>`. An overlong name, or one an earlier tool already took (`a_b`
 * before `a.b`), gets a suffix hashed from the raw server and tool (Pi's `createMcpToolName`), so
 * that suffixed name identifies the tool. The unsuffixed name may belong to another raw tool; the
 * child checks each granted tool's raw identity before it exposes the tool.
 */
function resolveBuiltinMcpSelections(selectors, tools) {
    const selections = [];
    const unresolvedSelectors = [];
    for (const selector of selectors) {
        const slash = selector.indexOf("/");
        const server = slash === -1 ? selector : selector.slice(0, slash);
        const inServer = tools.filter((tool) => tool.namespace?.name === `mcp__${server}`);
        const toolName = slash === -1 ? undefined : builtinMcpToolNames(server, selector.slice(slash + 1)).find((name) => inServer.some((tool) => tool.name === name));
        const matches = inServer.filter((tool) => tool.exposure !== "hidden" && (slash === -1 || tool.name === toolName));
        if (matches.length === 0)
            unresolvedSelectors.push(selector);
        for (const tool of matches) {
            if (!selections.some((selection) => selection.name === tool.name))
                selections.push({ name: tool.name, selector });
        }
    }
    return { selections, unresolvedSelectors, builtin: true };
}
/** The names Pi's `createMcpToolName` can give a raw tool, the hash-suffixed one first. */
function builtinMcpToolNames(server, tool) {
    const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
    const suffixed = `${name.slice(0, 64 - hash.length - 1)}_${hash}`;
    return name.length <= 64 ? [suffixed, name] : [suffixed];
}
export function formatUnresolvedBuiltinMcpSelectors(agentName, selectors) {
    const subject = agentName ? `Agent '${agentName}'` : "Subagent";
    return `${subject} selects MCP tools that Pi's built-in MCP does not offer: ${selectors.map((selector) => `mcp:${selector}`).join(", ")}. The server may be missing, disconnected, still connecting, or its tools hidden; check /mcp.`;
}
/**
 * Selected servers that only an extension registered, which a child without ambient extensions
 * never has. A server of the same name in an `mcp.json` the child reads takes precedence; like Pi,
 * the project file is read only when the project is trusted.
 */
export function extensionOnlyMcpServers(selections, host, cwd, projectTrusted) {
    const registered = new Set(host.getMcpServers?.().map(({ name }) => name));
    const servers = [...new Set(selections.map(({ selector }) => selector.split("/")[0]))].filter((server) => registered.has(server));
    if (servers.length === 0)
        return [];
    const files = [path.join(getAgentDir(), "mcp.json"), ...(projectTrusted ? [path.join(cwd, ".pi", "mcp.json")] : [])];
    const configured = new Set(files.flatMap((file) => {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        }
        catch {
            return [];
        }
        return isRecord(parsed) && isRecord(parsed.mcpServers) ? Object.keys(parsed.mcpServers) : [];
    }));
    return servers.filter((server) => !configured.has(server));
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
    const agentDir = getAgentDir();
    const projectDir = getProjectConfigDir(projectRoot);
    // pi-mcp-adapter 3.x reads mcp-adapter.json. Pi's own mcp.json files belong to
    // Pi's built-in MCP support, so servers there are never adapter-registered.
    const candidates = [
        GENERIC_GLOBAL_CONFIG_PATH,
        path.join(agentDir, "mcp-adapter.json"),
        path.resolve(projectRoot, ".mcp.json"),
        path.join(projectDir, "mcp-adapter.json"),
    ];
    return [...new Set(candidates)];
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
    // Aligned with pi-mcp-adapter's computeServerHash; since 3.1.0 stdio hashes include
    // inheritEnv/literalEnv. A mismatch leaves that server's cached direct-tool selectors unresolved.
    const isStdio = definition.command !== undefined;
    const literalEnv = isStdio && definition.literalEnv === true;
    const identity = {
        command: resolveConfigPath(definition.command),
        args: definition.args,
        socket: resolveConfigPath(definition.socket),
        env: literalEnv ? definition.env : interpolateEnvRecord(definition.env),
        ...(isStdio ? { inheritEnv: definition.inheritEnv !== false, literalEnv } : {}),
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