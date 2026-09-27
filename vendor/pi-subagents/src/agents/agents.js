/**
 * Agent discovery and configuration
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL, isCodeOwnedExternalCliAdapterId, parseExternalCliCapabilityNarrowing, validateCodeOwnedProfileRunner } from "../runs/shared/external-cli-contract.js";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.js";
import { expandHomePath } from "../shared/settings.js";
import { KNOWN_FIELDS } from "./agent-serializer.js";
import { parseChain, parseJsonChain } from "./chain-serializer.js";
import { mergeAgentsForScope } from "./agent-selection.js";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.js";
import { buildRuntimeName, parsePackageName } from "./identity.js";
import { parseModelScopeConfig } from "../runs/shared/model-scope.js";
export { BUILTIN_AGENT_NAMES } from "./builtin-names.js";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.js";
import { parseMemoryFrontmatter } from "./agent-memory.js";
import { validateAcceptanceInput } from "../runs/shared/acceptance.js";
import { validatePermissionRules } from "../runs/shared/permissions.js";
import { parseThinkingLevel } from "../shared/thinking-ceiling.js";
import { assertJsonSchemaObject } from "../runs/shared/structured-output.js";
import { normalizeCapabilityCeilingAllowedAgents } from "../runs/shared/capability-ceiling.js";
export function defaultSystemPromptMode(name) {
    return name === "delegate" ? "append" : "replace";
}
export function defaultInheritProjectContext(name) {
    return name === "delegate";
}
export function defaultInheritSkills() {
    return false;
}
const EMPTY_SUBAGENT_SETTINGS = { overrides: {}, providerOverrides: {} };
const agentFrontmatterFields = new WeakMap();
const AGENT_SOURCE_PRIORITY = {
    builtin: 0,
    package: 1,
    user: 2,
    project: 3,
    runtime: 4,
};
function agentDefinitionPriority(definition) {
    return AGENT_SOURCE_PRIORITY[definition.source] * 1_000_000
        + (definition.discoveryPriority ?? 0);
}
export function findBlockingAgentDiagnostic(name, agent, diagnostics) {
    const normalizedName = name.trim();
    const agents = Array.isArray(agent) ? agent : agent ? [agent] : [];
    let match;
    for (const diagnostic of diagnostics ?? []) {
        if ((diagnostic.runtimeName === normalizedName
            || (diagnostic.name === normalizedName && (!diagnostic.packageSpecified
                || diagnostic.runtimeName === undefined
                || agents.some((agent) => agent.name === diagnostic.runtimeName && agent.localName === diagnostic.name))))
            && (!match || agentDefinitionPriority(diagnostic) > agentDefinitionPriority(match))) {
            match = diagnostic;
        }
    }
    const highestPriority = Math.max(...agents.map(agentDefinitionPriority), -Infinity);
    return !agents.length || (match && agentDefinitionPriority(match) > highestPriority) ? match : undefined;
}
/** Create formatter input from the exact discovery operation used for resolution. */
export function unknownAgentDiagnosticContext(discovered) {
    return {
        cwd: discovered.cwd,
        scope: discovered.scope,
        directories: discovered.directories,
        agents: discovered.agents,
    };
}
/** Render local discovery evidence without exposing filesystem error details. */
export function formatUnknownAgentError(name, context, prefix = "Unknown agent") {
    const directories = context.directories.map((directory) => {
        const state = directory.state === "candidates"
            ? `${directory.candidateCount ?? 0} candidate${directory.candidateCount === 1 ? "" : "s"}`
            : directory.state === "empty" ? "present but empty"
                : directory.state === "not-directory" ? "not a directory"
                    : directory.state;
        return `- ${directory.source}: ${directory.path} (${state})`;
    });
    const agents = [...context.agents]
        .sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
        .map((agent) => `- ${agent.name} (${agent.source})`);
    return [
        `${prefix}: ${name}`,
        `Effective cwd: ${path.resolve(context.cwd)}`,
        "Consulted agent-definition directories:",
        ...(directories.length ? directories : ["- (none)"]),
        "Discovered agents:",
        ...(agents.length ? agents : ["- (none)"]),
    ].join("\n");
}
function getUserChainDir() {
    return path.join(getAgentDir(), "chains");
}
let cachedGlobalNpmRoot = null;
function readJsonFileBestEffort(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        // Installed package scans are opportunistic; bad third-party manifests
        // should not break local agent discovery.
        return null;
    }
}
function isSafePackagePath(value) {
    return value.length > 0
        && !path.isAbsolute(value)
        && value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}
function parseNpmPackageName(source) {
    const spec = source.slice(4).trim();
    if (!spec)
        return undefined;
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    const packageName = match?.[1] ?? spec;
    return isSafePackagePath(packageName) ? packageName : undefined;
}
function stripGitRef(repoPath) {
    const atIndex = repoPath.indexOf("@");
    const hashIndex = repoPath.indexOf("#");
    const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}
function parseGitPackagePath(source) {
    const spec = source.slice(4).trim();
    if (!spec)
        return undefined;
    let host = "";
    let repoPath = "";
    const scpLike = spec.match(/^git@([^:]+):(.+)$/);
    if (scpLike) {
        host = scpLike[1] ?? "";
        repoPath = scpLike[2] ?? "";
    }
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
        try {
            const url = new URL(spec);
            host = url.hostname;
            repoPath = url.pathname.replace(/^\/+/, "");
        }
        catch {
            return undefined;
        }
    }
    else {
        const slashIndex = spec.indexOf("/");
        if (slashIndex < 0)
            return undefined;
        host = spec.slice(0, slashIndex);
        repoPath = spec.slice(slashIndex + 1);
    }
    const normalizedPath = stripGitRef(repoPath).replace(/\.git$/, "").replace(/^\/+/, "");
    if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalizedPath) || normalizedPath.split(/[\\/]/).length < 2) {
        return undefined;
    }
    return { host, repoPath: normalizedPath };
}
function resolveSettingsPackageRoot(source, baseDir) {
    const trimmed = source.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.startsWith("git:")) {
        const parsed = parseGitPackagePath(trimmed);
        return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
    }
    if (trimmed.startsWith("npm:")) {
        const packageName = parseNpmPackageName(trimmed);
        return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
    }
    const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
    if (normalized === "~")
        return os.homedir();
    if (normalized.startsWith("~/"))
        return path.join(os.homedir(), normalized.slice(2));
    if (path.isAbsolute(normalized))
        return normalized;
    if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
        return path.resolve(baseDir, normalized);
    }
    if (/^https?:\/\//i.test(trimmed)) {
        const parsed = parseGitPackagePath(`git:${trimmed}`);
        return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
    }
    return undefined;
}
function getGlobalNpmRoot() {
    const offline = process.env.PI_OFFLINE?.toLowerCase();
    if (offline === "1" || offline === "true" || offline === "yes")
        return null;
    if (cachedGlobalNpmRoot !== null)
        return cachedGlobalNpmRoot;
    const windowsGlobalRoot = process.platform === "win32" && process.env.APPDATA
        ? path.join(process.env.APPDATA, "npm", "node_modules")
        : undefined;
    if (windowsGlobalRoot) {
        try {
            if (fs.statSync(windowsGlobalRoot).isDirectory()) {
                cachedGlobalNpmRoot = fs.realpathSync(windowsGlobalRoot);
                return cachedGlobalNpmRoot;
            }
        }
        catch {
            // Fall through if the directory disappears while resolving it.
        }
    }
    try {
        cachedGlobalNpmRoot = fs.realpathSync(execSync("npm root -g", { encoding: "utf-8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim());
        return cachedGlobalNpmRoot;
    }
    catch {
        cachedGlobalNpmRoot = "";
        return null;
    }
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}
function packageMetadata(pkg, packageRoot) {
    const name = typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : undefined;
    const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
    return {
        packageRoot,
        ...(name ? { packageName: name } : {}),
        ...(version ? { packageVersion: version } : {}),
    };
}
function extractSubagentPathsFromPackageRoot(packageRoot, scope) {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const pkg = readJsonFileBestEffort(packageJsonPath);
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
        return { agents: [], chains: [], watchPaths: [packageJsonPath], settingsErrors: {} };
    const pkgRecord = pkg;
    const metadata = packageMetadata(pkgRecord, packageRoot);
    const roots = [];
    const piSubagents = pkgRecord["pi-subagents"];
    if (piSubagents && typeof piSubagents === "object" && !Array.isArray(piSubagents)) {
        roots.push(piSubagents);
    }
    const pi = pkgRecord.pi;
    if (pi && typeof pi === "object" && !Array.isArray(pi)) {
        const subagents = pi.subagents;
        if (subagents && typeof subagents === "object" && !Array.isArray(subagents)) {
            roots.push(subagents);
        }
    }
    const agents = [];
    const chains = [];
    for (const root of roots) {
        for (const entry of stringArray(root.agents))
            agents.push({ dir: path.resolve(packageRoot, entry), scope, ...metadata });
        for (const entry of stringArray(root.chains))
            chains.push({ dir: path.resolve(packageRoot, entry), scope, packageRoot });
    }
    return { agents, chains, watchPaths: [packageJsonPath], settingsErrors: {} };
}
function collectPackageRootsFromNodeModules(nodeModulesDir, watchPaths) {
    const roots = [];
    watchPaths?.push(nodeModulesDir);
    if (!fs.existsSync(nodeModulesDir))
        return roots;
    let entries;
    try {
        entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
    }
    catch {
        return roots;
    }
    for (const entry of entries) {
        if (entry.name.startsWith("."))
            continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink())
            continue;
        if (entry.name.startsWith("@")) {
            const scopeDir = path.join(nodeModulesDir, entry.name);
            watchPaths?.push(scopeDir);
            let scopeEntries;
            try {
                scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const scopeEntry of scopeEntries) {
                if (scopeEntry.name.startsWith("."))
                    continue;
                if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink())
                    continue;
                roots.push(path.join(scopeDir, scopeEntry.name));
            }
            continue;
        }
        roots.push(path.join(nodeModulesDir, entry.name));
    }
    return roots;
}
function collectSettingsPackageRoots(settingsFile, baseDir) {
    const settings = readSettingsFileStrict(settingsFile);
    const packages = settings.packages;
    if (!Array.isArray(packages))
        return [];
    const roots = [];
    for (const entry of packages) {
        const packageSource = typeof entry === "string"
            ? entry
            : typeof entry === "object" && entry !== null && "source" in entry && typeof entry.source === "string"
                ? entry.source
                : undefined;
        if (!packageSource)
            continue;
        const packageRoot = resolveSettingsPackageRoot(packageSource, baseDir);
        if (packageRoot)
            roots.push(packageRoot);
    }
    return roots;
}
function collectPackageSubagentPaths(cwd, options = { includeUser: true, includeProject: true }) {
    const agentDir = getAgentDir();
    const projectRoot = findConfiguredProjectRoot(cwd) ?? cwd;
    const packageRoots = [
        { root: projectRoot, scope: "root" },
    ];
    const watchPaths = [path.join(projectRoot, "package.json")];
    const settingsErrors = {};
    const collectScopedSettingsRoots = (scope, settingsFile, baseDir) => {
        try {
            return collectSettingsPackageRoots(settingsFile, baseDir);
        }
        catch (error) {
            // The raw source snapshot includes both settings scopes. Defer a
            // strict failure until a projection actually selects this scope so an
            // unrelated malformed settings file stays out of scoped discovery.
            settingsErrors[scope] = error instanceof Error
                ? error
                : new Error(`Failed to read settings file '${settingsFile}': ${String(error)}`, { cause: error });
            return [];
        }
    };
    if (options.includeProject) {
        const projectConfigDir = getProjectConfigDir(projectRoot);
        const nodeModulesDir = path.join(projectConfigDir, "npm", "node_modules");
        packageRoots.push(...collectPackageRootsFromNodeModules(nodeModulesDir, watchPaths).map((root) => ({ root, scope: "project" })));
        packageRoots.push(...collectScopedSettingsRoots("project", path.join(projectConfigDir, "settings.json"), projectConfigDir).map((root) => ({ root, scope: "project" })));
    }
    if (options.includeUser) {
        const nodeModulesDir = path.join(agentDir, "npm", "node_modules");
        packageRoots.push(...collectPackageRootsFromNodeModules(nodeModulesDir, watchPaths).map((root) => ({ root, scope: "user" })));
        packageRoots.push(...collectScopedSettingsRoots("user", path.join(agentDir, "settings.json"), agentDir).map((root) => ({ root, scope: "user" })));
    }
    if (options.includeUser) {
        const globalRoot = getGlobalNpmRoot();
        if (globalRoot) {
            packageRoots.push(...collectPackageRootsFromNodeModules(globalRoot, watchPaths).map((root) => ({ root, scope: "user" })));
        }
    }
    const seenRoots = new Map();
    const seenAgents = new Map();
    const seenChains = new Map();
    const agents = [];
    const chains = [];
    for (const { root: packageRoot, scope } of packageRoots) {
        const resolvedRoot = path.resolve(packageRoot);
        const scopes = seenRoots.get(resolvedRoot);
        if (scopes !== undefined) {
            scopes.add(scope);
            continue;
        }
        const packageScopes = new Set([scope]);
        seenRoots.set(resolvedRoot, packageScopes);
        const paths = extractSubagentPathsFromPackageRoot(resolvedRoot, packageScopes);
        watchPaths.push(...paths.watchPaths);
        for (const agentPath of paths.agents) {
            const agentKey = `${agentPath.dir}\u0000${agentPath.packageRoot}`;
            const existing = seenAgents.get(agentKey);
            if (existing) {
                for (const packageScope of agentPath.scope)
                    existing.scope.add(packageScope);
                continue;
            }
            seenAgents.set(agentKey, agentPath);
            agents.push(agentPath);
        }
        for (const chainDir of paths.chains) {
            const chainKey = `${chainDir.dir}\u0000${chainDir.packageRoot}`;
            const existing = seenChains.get(chainKey);
            if (existing) {
                for (const packageScope of chainDir.scope)
                    existing.scope.add(packageScope);
                continue;
            }
            seenChains.set(chainKey, chainDir);
            chains.push(chainDir);
        }
    }
    return { agents, chains, watchPaths, settingsErrors };
}
function normalizeAgentAliases(rawAliases, agentName) {
    const aliases = [...new Set((rawAliases ?? []).map((alias) => alias.trim()).filter(Boolean))]
        .filter((alias) => alias !== agentName);
    return aliases.length > 0 ? aliases : undefined;
}
function effectiveAgentMatch(matches) {
    const distinctNames = [...new Set(matches.map((agent) => agent.name))];
    if (distinctNames.length === 1) {
        const sourceRank = new Map([["builtin", 0], ["package", 1], ["user", 2], ["project", 3], ["runtime", 4]]);
        const agent = [...matches].sort((a, b) => (sourceRank.get(b.source) ?? 0) - (sourceRank.get(a.source) ?? 0))[0];
        return agent ? { agent } : {};
    }
    return {};
}
export function resolveAgentName(name, agents) {
    const raw = name.trim();
    const canonical = agents.filter((agent) => agent.name === raw);
    if (canonical.length === 1)
        return canonical[0] ? { agent: canonical[0] } : {};
    if (canonical.length > 1) {
        const effective = effectiveAgentMatch(canonical);
        if (effective.agent)
            return effective;
        return { error: `Ambiguous agent name '${name}': ${canonical.map((agent) => agent.name).join(", ")}` };
    }
    const local = agents.filter((agent) => agent.localName === raw);
    if (local.length === 1)
        return local[0] ? { agent: local[0] } : {};
    if (local.length > 1) {
        const effective = effectiveAgentMatch(local);
        if (effective.agent)
            return effective;
        return { error: `Ambiguous local agent name '${name}': ${local.map((agent) => agent.name).join(", ")}` };
    }
    const aliases = agents.filter((agent) => agent.aliases?.includes(raw));
    if (aliases.length === 1)
        return aliases[0] ? { agent: aliases[0] } : {};
    if (aliases.length > 1) {
        const effective = effectiveAgentMatch(aliases);
        if (effective.agent)
            return effective;
        return { error: `Ambiguous agent alias '${name}': ${aliases.map((agent) => agent.name).join(", ")}` };
    }
    return {};
}
function splitToolList(rawTools) {
    const mcpDirectTools = [];
    const tools = [];
    for (const tool of rawTools ?? []) {
        if (tool.startsWith("mcp:")) {
            mcpDirectTools.push(tool.slice(4));
        }
        else {
            tools.push(tool);
        }
    }
    return {
        ...(rawTools !== undefined ? { tools } : {}),
        ...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
    };
}
function joinToolList(config) {
    const joined = [
        ...(config.tools ?? []),
        ...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
    ];
    return joined.length > 0 ? joined : undefined;
}
function arraysEqual(a, b) {
    if (!a && !b)
        return true;
    if (!a || !b)
        return false;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
function cloneOverrideBase(agent) {
    return {
        description: agent.description,
        ...(agent.machine !== undefined ? { machine: agent.machine } : {}),
        ...(agent.output !== undefined ? { output: agent.output } : {}),
        ...(agent.outputMode !== undefined ? { outputMode: agent.outputMode } : {}),
        ...(agent.defaultReads !== undefined ? { defaultReads: [...agent.defaultReads] } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        ...(agent.modelProvider !== undefined ? { modelProvider: agent.modelProvider } : {}),
        ...(agent.fast !== undefined ? { fast: agent.fast } : {}),
        ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
        systemPromptMode: agent.systemPromptMode,
        inheritProjectContext: agent.inheritProjectContext,
        inheritGlobalContext: agent.inheritGlobalContext,
        inheritSkills: agent.inheritSkills,
        ...(agent.defaultContext !== undefined ? { defaultContext: agent.defaultContext } : {}),
        ...(agent.acceptanceRole !== undefined ? { acceptanceRole: agent.acceptanceRole } : {}),
        ...(agent.disabled !== undefined ? { disabled: agent.disabled } : {}),
        systemPrompt: agent.systemPrompt,
        ...(agent.skills ? { skills: [...agent.skills] } : {}),
        ...(agent.skillPath ? { skillPath: [...agent.skillPath] } : {}),
        ...(agent.tools ? { tools: [...agent.tools] } : {}),
        ...(agent.excludeTools ? { excludeTools: [...agent.excludeTools] } : {}),
        ...(agent.allowNestedSubagents !== undefined ? { allowNestedSubagents: agent.allowNestedSubagents } : {}),
        ...(agent.allowedAgents !== undefined ? { allowedAgents: [...agent.allowedAgents] } : {}),
        ...(agent.mcpDirectTools ? { mcpDirectTools: [...agent.mcpDirectTools] } : {}),
        ...(!agent.extensionsFromDefault && agent.extensions ? { extensions: [...agent.extensions] } : {}),
        ...(agent.subagentOnlyExtensions ? { subagentOnlyExtensions: [...agent.subagentOnlyExtensions] } : {}),
        ...(agent.mutationTools ? { mutationTools: [...agent.mutationTools] } : {}),
        ...(agent.toolBudget !== undefined ? { toolBudget: agent.toolBudget } : {}),
    };
}
function cloneOverrideValue(override) {
    return {
        ...(override.description !== undefined ? { description: override.description } : {}),
        ...(override.machine !== undefined ? { machine: override.machine } : {}),
        ...(override.output !== undefined ? { output: override.output } : {}),
        ...(override.outputMode !== undefined ? { outputMode: override.outputMode } : {}),
        ...(override.defaultReads !== undefined ? { defaultReads: override.defaultReads === false ? false : [...override.defaultReads] } : {}),
        ...(override.model !== undefined ? { model: override.model } : {}),
        ...(override.defaultProvider !== undefined ? { defaultProvider: override.defaultProvider } : {}),
        ...(override.fast !== undefined ? { fast: override.fast } : {}),
        ...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
        ...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
        ...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
        ...(override.inheritGlobalContext !== undefined ? { inheritGlobalContext: override.inheritGlobalContext } : {}),
        ...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
        ...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
        ...(override.acceptanceRole !== undefined ? { acceptanceRole: override.acceptanceRole } : {}),
        ...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
        ...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
        ...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
        ...(override.tools !== undefined ? { tools: Array.isArray(override.tools) ? [...override.tools] : override.tools } : {}),
        ...(override.excludeTools !== undefined ? { excludeTools: override.excludeTools === false ? false : [...override.excludeTools] } : {}),
        ...(override.allowNestedSubagents !== undefined ? { allowNestedSubagents: override.allowNestedSubagents } : {}),
        ...(override.allowedAgents !== undefined ? { allowedAgents: override.allowedAgents === false ? false : [...override.allowedAgents] } : {}),
        ...(override.extensions !== undefined ? { extensions: override.extensions === false ? false : [...override.extensions] } : {}),
        ...(override.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: override.subagentOnlyExtensions === false ? false : [...override.subagentOnlyExtensions] } : {}),
        ...(override.mutationTools !== undefined ? { mutationTools: override.mutationTools === false ? false : [...override.mutationTools] } : {}),
        ...(override.toolBudget !== undefined ? { toolBudget: override.toolBudget === false ? false : { ...override.toolBudget, ...(Array.isArray(override.toolBudget.block) ? { block: [...override.toolBudget.block] } : {}) } } : {}),
    };
}
function isProjectRootCandidate(dir) {
    return isDirectory(getProjectConfigDir(dir)) || isDirectory(path.join(dir, ".agents"));
}
function findProjectRootCandidates(cwd) {
    const roots = [];
    const windowsProfile = process.env.HOMEDRIVE && process.env.HOMEPATH
        ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
        : undefined;
    const homeDirs = new Set([os.homedir(), process.env.HOME, process.env.USERPROFILE, windowsProfile]
        .filter((value) => Boolean(value?.trim()))
        .filter(isDirectory)
        .map((value) => fs.realpathSync.native(value)));
    let currentDir = cwd;
    while (true) {
        // ~/.pi and ~/.agents are user configuration, never an implicit project.
        if (isDirectory(currentDir) && homeDirs.has(fs.realpathSync.native(currentDir)))
            return roots;
        if (isProjectRootCandidate(currentDir))
            roots.push(currentDir);
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            return roots;
        currentDir = parentDir;
    }
}
export function findNearestGitRoot(cwd) {
    let currentDir = cwd;
    while (true) {
        if (fs.existsSync(path.join(currentDir, ".git")))
            return currentDir;
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            return null;
        currentDir = parentDir;
    }
}
function readProjectRootResolution(projectRoot) {
    const settingsPath = path.join(getProjectConfigDir(projectRoot), "settings.json");
    if (!fs.existsSync(settingsPath))
        return undefined;
    const settings = readSettingsFileStrict(settingsPath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return undefined;
    const value = subagents.projectRootResolution;
    if (value === undefined)
        return undefined;
    if (value === "nearest" || value === "git-root")
        return value;
    throw new Error(`Subagent settings in '${settingsPath}' have invalid 'projectRootResolution'; expected 'nearest' or 'git-root'.`);
}
export function findNearestProjectRoot(cwd) {
    return findProjectRootCandidates(cwd)[0] ?? null;
}
export function findConfiguredProjectRoot(cwd) {
    const candidates = findProjectRootCandidates(cwd);
    const nearestRoot = candidates[0];
    if (!nearestRoot)
        return null;
    let policyRoot;
    let policyRootIndex = -1;
    for (const [index, candidate] of candidates.entries()) {
        const mode = readProjectRootResolution(candidate);
        if (mode === "nearest")
            return nearestRoot;
        if (mode === "git-root") {
            policyRoot = candidate;
            policyRootIndex = index;
            break;
        }
    }
    if (!policyRoot)
        return nearestRoot;
    const gitRoot = findNearestGitRoot(cwd);
    const gitProjectRoot = gitRoot
        ? candidates.slice(policyRootIndex).find((candidate) => path.resolve(candidate) === path.resolve(gitRoot))
        : undefined;
    const configuredGitRoot = fs.existsSync(path.join(policyRoot, ".git")) ? policyRoot : undefined;
    return gitProjectRoot ?? configuredGitRoot ?? nearestRoot;
}
function getUserAgentSettingsPath() {
    return path.join(getAgentDir(), "settings.json");
}
function getProjectAgentSettingsPath(cwd) {
    const projectRoot = findConfiguredProjectRoot(cwd);
    return projectRoot ? path.join(getProjectConfigDir(projectRoot), "settings.json") : null;
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
    }
    return parsed;
}
function writeSettingsFile(filePath, settings) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
function parseOverrideStringArrayOrFalse(value, meta) {
    if (value === undefined)
        return undefined;
    if (value === false)
        return false;
    if (!Array.isArray(value)) {
        throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
    }
    const items = [];
    for (const item of value) {
        if (typeof item !== "string") {
            throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
        }
        const trimmed = item.trim();
        if (trimmed)
            items.push(trimmed);
    }
    return items;
}
function parseToolsOverride(value, meta) {
    if (typeof value === "string" && value.trim() === "inherit")
        return "inherit";
    if (value === undefined || value === false || Array.isArray(value)) {
        return parseOverrideStringArrayOrFalse(value, { ...meta, field: "tools" });
    }
    throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid 'tools'; expected an array of strings, "inherit", or false.`);
}
function validateOptionalMachine(value, label) {
    if (value === undefined || value === false)
        return undefined;
    if (typeof value !== "string" || !value.trim())
        throw new Error(label + " must be a non-empty string or false.");
    const machine = value.trim();
    if (machine.length > 128)
        throw new Error(label + " must be 128 characters or fewer.");
    if (/[\u0000-\u001f\u007f]/u.test(machine))
        throw new Error(label + " contains control characters.");
    return machine;
}
function parseBuiltinOverrideEntry(name, value, filePath) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
    }
    const input = value;
    if (Object.hasOwn(input, "fallbackModels")) {
        throw new Error(`Builtin override '${name}' in '${filePath}' uses removed field 'fallbackModels'; configure one model instead.`);
    }
    const override = {};
    if ("description" in input) {
        if (typeof input.description === "string" && input.description.trim()) {
            override.description = input.description.trim();
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'description'; expected a non-empty string.`);
        }
    }
    if ("output" in input) {
        if ((typeof input.output === "string" && input.output.trim()) || input.output === false)
            override.output = input.output;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'output'; expected a non-empty string or false.`);
    }
    if ("outputMode" in input) {
        if (input.outputMode === "inline" || input.outputMode === "file-only") {
            override.outputMode = input.outputMode;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'outputMode'; expected 'inline' or 'file-only'.`);
        }
    }
    if ("model" in input) {
        if (typeof input.model === "string" || input.model === false)
            override.model = input.model;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
    }
    if ("fast" in input) {
        if (typeof input.fast === "boolean")
            override.fast = input.fast;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'fast'; expected a boolean.`);
    }
    if ("thinking" in input) {
        if (typeof input.thinking === "string" || input.thinking === false)
            override.thinking = input.thinking;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`);
    }
    if ("systemPromptMode" in input) {
        if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
            override.systemPromptMode = input.systemPromptMode;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`);
        }
    }
    if ("inheritProjectContext" in input) {
        if (typeof input.inheritProjectContext === "boolean") {
            override.inheritProjectContext = input.inheritProjectContext;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`);
        }
    }
    if ("inheritGlobalContext" in input) {
        if (typeof input.inheritGlobalContext === "boolean") {
            override.inheritGlobalContext = input.inheritGlobalContext;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritGlobalContext'; expected a boolean.`);
        }
    }
    if ("inheritSkills" in input) {
        if (typeof input.inheritSkills === "boolean") {
            override.inheritSkills = input.inheritSkills;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
        }
    }
    if ("defaultContext" in input) {
        if (input.defaultContext === "fresh" || input.defaultContext === "fork" || input.defaultContext === false) {
            override.defaultContext = input.defaultContext;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`);
        }
    }
    if ("acceptanceRole" in input) {
        if (input.acceptanceRole === "read-only" || input.acceptanceRole === "writer" || input.acceptanceRole === false) {
            override.acceptanceRole = input.acceptanceRole;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'acceptanceRole'; expected 'read-only', 'writer', or false.`);
        }
    }
    if ("disabled" in input) {
        if (typeof input.disabled === "boolean") {
            override.disabled = input.disabled;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
        }
    }
    if ("toolBudget" in input) {
        if (input.toolBudget === false) {
            override.toolBudget = false;
        }
        else if (input.toolBudget && typeof input.toolBudget === "object" && !Array.isArray(input.toolBudget)) {
            override.toolBudget = input.toolBudget;
        }
        else {
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolBudget'; expected an object or false.`);
        }
    }
    if ("systemPrompt" in input) {
        if (typeof input.systemPrompt === "string")
            override.systemPrompt = input.systemPrompt;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
    }
    if (input.machine === false)
        override.machine = false;
    else {
        const machine = validateOptionalMachine(input.machine, `Builtin override '${name}' in '${filePath}' field 'machine'`);
        if (machine !== undefined)
            override.machine = machine;
    }
    const defaultReads = parseOverrideStringArrayOrFalse(input.defaultReads, { filePath, name, field: "defaultReads" });
    if (defaultReads !== undefined)
        override.defaultReads = defaultReads;
    if ("defaultProvider" in input) {
        if (input.defaultProvider === false)
            override.defaultProvider = false;
        else if (typeof input.defaultProvider === "string" && input.defaultProvider.trim())
            override.defaultProvider = input.defaultProvider.trim();
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'defaultProvider'; expected a non-empty string or false.`);
    }
    const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
    if (skills !== undefined)
        override.skills = skills;
    const tools = parseToolsOverride(input.tools, { filePath, name });
    if (tools !== undefined)
        override.tools = tools;
    const excludeTools = parseOverrideStringArrayOrFalse(input.excludeTools, { filePath, name, field: "excludeTools" });
    if (excludeTools !== undefined)
        override.excludeTools = excludeTools;
    if ("allowNestedSubagents" in input) {
        if (typeof input.allowNestedSubagents === "boolean")
            override.allowNestedSubagents = input.allowNestedSubagents;
        else
            throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'allowNestedSubagents'; expected a boolean.`);
    }
    const allowedAgents = parseOverrideStringArrayOrFalse(input.allowedAgents, { filePath, name, field: "allowedAgents" });
    if (allowedAgents !== undefined)
        override.allowedAgents = allowedAgents === false ? false : normalizeCapabilityCeilingAllowedAgents(allowedAgents);
    const extensions = parseOverrideStringArrayOrFalse(input.extensions, { filePath, name, field: "extensions" });
    if (extensions !== undefined)
        override.extensions = extensions;
    const subagentOnlyExtensions = parseOverrideStringArrayOrFalse(input.subagentOnlyExtensions, { filePath, name, field: "subagentOnlyExtensions" });
    if (subagentOnlyExtensions !== undefined)
        override.subagentOnlyExtensions = subagentOnlyExtensions;
    const mutationTools = parseOverrideStringArrayOrFalse(input.mutationTools, { filePath, name, field: "mutationTools" });
    if (mutationTools !== undefined)
        override.mutationTools = mutationTools;
    return Object.keys(override).length > 0 ? override : undefined;
}
function readSubagentSettings(filePath) {
    if (!filePath)
        return EMPTY_SUBAGENT_SETTINGS;
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return EMPTY_SUBAGENT_SETTINGS;
    const subagentsObject = subagents;
    let disableBuiltins;
    if ("disableBuiltins" in subagentsObject) {
        if (typeof subagentsObject.disableBuiltins === "boolean") {
            disableBuiltins = subagentsObject.disableBuiltins;
        }
        else {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
        }
    }
    let disableThinking;
    if ("disableThinking" in subagentsObject) {
        if (typeof subagentsObject.disableThinking === "boolean") {
            disableThinking = subagentsObject.disableThinking;
        }
        else {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'disableThinking'; expected a boolean.`);
        }
    }
    let defaultModel;
    if ("defaultModel" in subagentsObject) {
        if (typeof subagentsObject.defaultModel === "string" && subagentsObject.defaultModel.trim()) {
            defaultModel = subagentsObject.defaultModel.trim();
        }
        else {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`);
        }
    }
    let defaultProvider;
    if ("defaultProvider" in subagentsObject) {
        if (typeof subagentsObject.defaultProvider === "string" && subagentsObject.defaultProvider.trim()) {
            defaultProvider = subagentsObject.defaultProvider.trim();
        }
        else {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultProvider'; expected a non-empty string.`);
        }
    }
    let defaultThinking;
    if ("defaultThinking" in subagentsObject) {
        if (typeof subagentsObject.defaultThinking === "string" && subagentsObject.defaultThinking.trim()) {
            defaultThinking = subagentsObject.defaultThinking.trim();
        }
        else {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultThinking'; expected a non-empty string.`);
        }
    }
    let maxThinking;
    if ("maxThinking" in subagentsObject) {
        try {
            maxThinking = parseThinkingLevel(subagentsObject.maxThinking, `'${filePath}' subagents.maxThinking`);
        }
        catch (error) {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'maxThinking'; expected one of off, minimal, low, medium, high, xhigh, or max.`, { cause: error instanceof Error ? error : undefined });
        }
    }
    let defaultExtensions;
    if ("defaultExtensions" in subagentsObject) {
        if (!Array.isArray(subagentsObject.defaultExtensions)
            || subagentsObject.defaultExtensions.some((item) => typeof item !== "string" || !item.trim())) {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultExtensions'; expected an array of non-empty strings.`);
        }
        defaultExtensions = subagentsObject.defaultExtensions.map((item) => item.trim());
    }
    let defaultSubagentOnlyExtensions;
    if ("defaultSubagentOnlyExtensions" in subagentsObject) {
        if (!Array.isArray(subagentsObject.defaultSubagentOnlyExtensions)
            || subagentsObject.defaultSubagentOnlyExtensions.some((item) => typeof item !== "string" || !item.trim())) {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'defaultSubagentOnlyExtensions'; expected an array of non-empty strings.`);
        }
        defaultSubagentOnlyExtensions = subagentsObject.defaultSubagentOnlyExtensions.map((item) => item.trim());
    }
    let agentScanDirs;
    if ("agentScanDirs" in subagentsObject) {
        if (!Array.isArray(subagentsObject.agentScanDirs)
            || subagentsObject.agentScanDirs.some((item) => typeof item !== "string" || !item.trim())) {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'agentScanDirs'; expected an array of non-empty strings.`);
        }
        agentScanDirs = subagentsObject.agentScanDirs.map((item) => item.trim());
    }
    let agentExcludeDirs;
    if ("agentExcludeDirs" in subagentsObject) {
        if (!Array.isArray(subagentsObject.agentExcludeDirs)
            || subagentsObject.agentExcludeDirs.some((item) => typeof item !== "string" || !item.trim())) {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'agentExcludeDirs'; expected an array of non-empty strings.`);
        }
        agentExcludeDirs = subagentsObject.agentExcludeDirs.map((item) => item.trim());
    }
    const modelScope = parseModelScopeConfig(subagentsObject.modelScope, { filePath });
    const parsed = {};
    const providerOverrides = {};
    const agentOverrides = subagentsObject.agentOverrides;
    const agentOverridesByProvider = subagentsObject.agentOverridesByProvider;
    const parsedSettings = {
        overrides: parsed,
        providerOverrides,
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        ...(defaultProvider !== undefined ? { defaultProvider } : {}),
        ...(defaultThinking !== undefined ? { defaultThinking } : {}),
        ...(maxThinking !== undefined ? { maxThinking } : {}),
        ...(defaultExtensions !== undefined ? { defaultExtensions } : {}),
        ...(defaultSubagentOnlyExtensions !== undefined ? { defaultSubagentOnlyExtensions } : {}),
        ...(agentScanDirs !== undefined ? { agentScanDirs } : {}),
        ...(agentExcludeDirs !== undefined ? { agentExcludeDirs } : {}),
        ...(disableBuiltins !== undefined ? { disableBuiltins } : {}),
        ...(disableThinking !== undefined ? { disableThinking } : {}),
        ...(modelScope !== undefined ? { modelScope } : {}),
    };
    if (agentOverrides && typeof agentOverrides === "object" && !Array.isArray(agentOverrides)) {
        for (const [name, value] of Object.entries(agentOverrides)) {
            const override = parseBuiltinOverrideEntry(name, value, filePath);
            if (override)
                parsed[name] = override;
        }
    }
    if (agentOverridesByProvider !== undefined) {
        if (!agentOverridesByProvider || typeof agentOverridesByProvider !== "object" || Array.isArray(agentOverridesByProvider)) {
            throw new Error(`Subagent settings in '${filePath}' have invalid 'agentOverridesByProvider'; expected an object keyed by provider.`);
        }
        for (const [provider, value] of Object.entries(agentOverridesByProvider)) {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                throw new Error(`Subagent settings in '${filePath}' have invalid 'agentOverridesByProvider.${provider}'; expected an object keyed by agent.`);
            }
            const entries = {};
            for (const [agentName, agentValue] of Object.entries(value)) {
                const override = parseBuiltinOverrideEntry(`agentOverridesByProvider.${provider}.${agentName}`, agentValue, filePath);
                if (override)
                    entries[agentName] = override;
            }
            providerOverrides[provider] = entries;
        }
    }
    return parsedSettings;
}
function selectProviderOverrides(settings, provider) {
    if (!provider)
        return settings;
    const selected = settings.providerOverrides[provider];
    if (!selected)
        return settings;
    const overrides = { ...settings.overrides };
    for (const [name, override] of Object.entries(selected)) {
        overrides[name] = { ...overrides[name], ...override };
    }
    return { ...settings, overrides };
}
function resolveSubagentDefaultProvider(userSettings, projectSettings, projectSettingsPath) {
    if (projectSettingsPath && projectSettings.defaultProvider !== undefined)
        return projectSettings.defaultProvider;
    return userSettings.defaultProvider;
}
function resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath, defaultProvider) {
    if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
        return { type: "subagents.defaultModel", scope: "project", path: projectSettingsPath, model: projectSettings.defaultModel, ...(defaultProvider ? { defaultProvider } : {}) };
    }
    return userSettings.defaultModel !== undefined
        ? { type: "subagents.defaultModel", scope: "user", path: userSettingsPath, model: userSettings.defaultModel, ...(defaultProvider ? { defaultProvider } : {}) }
        : undefined;
}
function applySubagentDefaultModel(agents, defaultModel, defaultProvider) {
    if (!defaultModel && !defaultProvider)
        return agents;
    return agents.map((agent) => {
        if (agent.model !== undefined && (agent.modelProvider !== undefined || !defaultProvider))
            return agent;
        const next = {
            ...agent,
            ...(agent.model === undefined && defaultModel ? { model: defaultModel.model, modelSource: defaultModel } : {}),
            ...(defaultProvider ? { modelProvider: defaultProvider } : {}),
        };
        const frontmatterFields = agentFrontmatterFields.get(agent);
        if (frontmatterFields)
            agentFrontmatterFields.set(next, frontmatterFields);
        return next;
    });
}
function resolveSubagentDefaultThinking(userSettings, projectSettings, projectSettingsPath) {
    if (projectSettingsPath && projectSettings.defaultThinking !== undefined)
        return projectSettings.defaultThinking;
    return userSettings.defaultThinking;
}
function applySubagentDefaultThinking(agents, defaultThinking) {
    if (defaultThinking === undefined)
        return agents;
    return agents.map((agent) => {
        if (agent.thinking !== undefined)
            return agent;
        const next = { ...agent, thinking: defaultThinking };
        const frontmatterFields = agentFrontmatterFields.get(agent);
        if (frontmatterFields)
            agentFrontmatterFields.set(next, frontmatterFields);
        return next;
    });
}
function resolveSubagentMaxThinking(userSettings, projectSettings, projectSettingsPath) {
    if (projectSettingsPath && projectSettings.maxThinking !== undefined)
        return projectSettings.maxThinking;
    return userSettings.maxThinking;
}
function applySubagentMaxThinking(agents, maxThinking) {
    if (maxThinking === undefined)
        return agents;
    return agents.map((agent) => agent.maxThinking === maxThinking ? agent : { ...agent, maxThinking });
}
function resolveSubagentDefaultExtensions(userSettings, projectSettings, projectSettingsPath) {
    if (projectSettingsPath && projectSettings.defaultExtensions !== undefined)
        return projectSettings.defaultExtensions;
    return userSettings.defaultExtensions;
}
function applySubagentDefaultExtensions(agents, defaultExtensions) {
    if (defaultExtensions === undefined)
        return agents;
    return agents.map((agent) => {
        if (agent.extensions !== undefined)
            return agent;
        const next = { ...agent, extensions: [...defaultExtensions], extensionsFromDefault: true };
        const frontmatterFields = agentFrontmatterFields.get(agent);
        if (frontmatterFields)
            agentFrontmatterFields.set(next, frontmatterFields);
        return next;
    });
}
function resolveSubagentDefaultSubagentOnlyExtensions(userSettings, projectSettings, projectSettingsPath) {
    if (projectSettingsPath && projectSettings.defaultSubagentOnlyExtensions !== undefined)
        return projectSettings.defaultSubagentOnlyExtensions;
    return userSettings.defaultSubagentOnlyExtensions;
}
function applySubagentDefaultSubagentOnlyExtensions(agents, defaultSubagentOnlyExtensions) {
    if (defaultSubagentOnlyExtensions === undefined)
        return agents;
    return agents.map((agent) => {
        if (agent.subagentOnlyExtensions !== undefined)
            return agent;
        const next = { ...agent, subagentOnlyExtensions: [...defaultSubagentOnlyExtensions] };
        const frontmatterFields = agentFrontmatterFields.get(agent);
        if (frontmatterFields)
            agentFrontmatterFields.set(next, frontmatterFields);
        return next;
    });
}
function applySubagentDefaults(agents, defaultModel, defaultProvider, defaultThinking, defaultExtensions, defaultSubagentOnlyExtensions) {
    return applySubagentDefaultSubagentOnlyExtensions(applySubagentDefaultExtensions(applySubagentDefaultThinking(applySubagentDefaultModel(agents, defaultModel, defaultProvider), defaultThinking), defaultExtensions), defaultSubagentOnlyExtensions);
}
function applyToolsOverride(target, toolsOverride) {
    if (toolsOverride === "inherit") {
        delete target.tools;
        delete target.mcpDirectTools;
        return;
    }
    const { tools, mcpDirectTools } = splitToolList(toolsOverride === false ? [] : toolsOverride);
    if (tools === undefined)
        delete target.tools;
    else
        target.tools = tools;
    if (mcpDirectTools === undefined)
        delete target.mcpDirectTools;
    else
        target.mcpDirectTools = mcpDirectTools;
}
function applyBuiltinOverride(agent, override, meta) {
    const overrideInfo = {
        ...meta,
        base: agent.override?.base ?? cloneOverrideBase(agent),
        fields: [...new Set([...(agent.override?.fields ?? []), ...Object.keys(override)])].sort(),
        fieldScopes: Object.fromEntries(Object.entries({ ...(agent.override?.fieldScopes ?? {}) }).map(([field, scopes]) => [field, [...scopes]])),
    };
    for (const field of Object.keys(override)) {
        const scopes = overrideInfo.fieldScopes[field] ?? [];
        overrideInfo.fieldScopes[field] = [...new Set([...scopes, meta.scope])].sort();
    }
    const next = {
        ...agent,
        override: overrideInfo,
    };
    if (override.description !== undefined)
        next.description = override.description;
    if (override.machine !== undefined) {
        if (override.machine === false)
            delete next.machine;
        else
            next.machine = override.machine;
    }
    if (override.output !== undefined) {
        if (override.output === false)
            delete next.output;
        else
            next.output = override.output;
    }
    if (override.outputMode !== undefined)
        next.outputMode = override.outputMode;
    if (override.defaultReads !== undefined) {
        if (override.defaultReads === false)
            delete next.defaultReads;
        else
            next.defaultReads = [...override.defaultReads];
    }
    if (override.model !== undefined) {
        if (override.model === false)
            delete next.model;
        else
            next.model = override.model;
        delete next.modelSource;
    }
    if (override.defaultProvider !== undefined) {
        if (override.defaultProvider === false)
            delete next.modelProvider;
        else
            next.modelProvider = override.defaultProvider;
    }
    if (override.fast !== undefined)
        next.fast = override.fast;
    if (override.thinking !== undefined) {
        if (override.thinking === false)
            delete next.thinking;
        else
            next.thinking = override.thinking;
    }
    if (override.systemPromptMode !== undefined)
        next.systemPromptMode = override.systemPromptMode;
    if (override.inheritProjectContext !== undefined)
        next.inheritProjectContext = override.inheritProjectContext;
    if (override.inheritGlobalContext !== undefined)
        next.inheritGlobalContext = override.inheritGlobalContext;
    if (override.inheritSkills !== undefined)
        next.inheritSkills = override.inheritSkills;
    if (override.defaultContext !== undefined) {
        if (override.defaultContext === false)
            delete next.defaultContext;
        else
            next.defaultContext = override.defaultContext;
    }
    if (override.acceptanceRole !== undefined) {
        if (override.acceptanceRole === false)
            delete next.acceptanceRole;
        else
            next.acceptanceRole = override.acceptanceRole;
    }
    if (override.disabled !== undefined)
        next.disabled = override.disabled;
    if (override.systemPrompt !== undefined)
        next.systemPrompt = override.systemPrompt;
    if (override.skills !== undefined) {
        if (override.skills === false)
            delete next.skills;
        else
            next.skills = [...override.skills];
    }
    if (override.tools !== undefined)
        applyToolsOverride(next, override.tools);
    if (override.excludeTools !== undefined) {
        if (override.excludeTools === false)
            delete next.excludeTools;
        else
            next.excludeTools = [...override.excludeTools];
    }
    if (override.allowNestedSubagents !== undefined)
        next.allowNestedSubagents = override.allowNestedSubagents;
    if (override.allowedAgents !== undefined) {
        if (override.allowedAgents === false)
            delete next.allowedAgents;
        else
            next.allowedAgents = [...override.allowedAgents];
    }
    if (override.extensions !== undefined) {
        if (override.extensions === false)
            delete next.extensions;
        else
            next.extensions = [...override.extensions];
    }
    if (override.subagentOnlyExtensions !== undefined) {
        if (override.subagentOnlyExtensions === false)
            delete next.subagentOnlyExtensions;
        else
            next.subagentOnlyExtensions = [...override.subagentOnlyExtensions];
    }
    if (override.mutationTools !== undefined) {
        if (override.mutationTools === false)
            delete next.mutationTools;
        else
            next.mutationTools = [...override.mutationTools];
    }
    if (override.toolBudget !== undefined) {
        if (override.toolBudget === false)
            delete next.toolBudget;
        else
            next.toolBudget = override.toolBudget;
    }
    return next;
}
function clearBuiltinThinking(agent, meta) {
    if (agent.thinking === undefined)
        return agent;
    const { thinking: _thinking, ...next } = agent;
    return { ...next, override: agent.override ?? { ...meta, base: cloneOverrideBase(agent) } };
}
function applyBuiltinOverrides(builtinAgents, userSettings, projectSettings, userSettingsPath, projectSettingsPath) {
    const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
    const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;
    const projectThinkingConfigured = projectSettings.disableThinking !== undefined && projectSettingsPath !== null;
    const disableThinking = projectThinkingConfigured ? projectSettings.disableThinking === true : userSettings.disableThinking === true;
    const disableThinkingMeta = projectThinkingConfigured
        ? { scope: "project", path: projectSettingsPath }
        : { scope: "user", path: userSettingsPath };
    const applyGlobalThinking = (agent, hasExplicitThinkingOverride) => {
        if (!disableThinking || hasExplicitThinkingOverride)
            return agent;
        return clearBuiltinThinking(agent, disableThinkingMeta);
    };
    return builtinAgents.map((agent) => {
        const projectOverride = projectSettings.overrides[agent.name];
        if (projectOverride && projectSettingsPath) {
            return applyGlobalThinking(applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath }), projectOverride.thinking !== undefined);
        }
        if (projectBulkDisabled && projectSettingsPath) {
            return applyGlobalThinking(applyBuiltinOverride(agent, { disabled: true }, { scope: "project", path: projectSettingsPath }), false);
        }
        const userOverride = userSettings.overrides[agent.name];
        if (userOverride) {
            return applyGlobalThinking(applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath }), !projectThinkingConfigured && userOverride.thinking !== undefined);
        }
        if (userBulkDisabled) {
            return applyGlobalThinking(applyBuiltinOverride(agent, { disabled: true }, { scope: "user", path: userSettingsPath }), false);
        }
        return applyGlobalThinking(agent, false);
    });
}
function applyCustomAgentOverride(agent, override, meta) {
    const next = applyBuiltinOverride(agent, override, meta);
    const frontmatterFields = agentFrontmatterFields.get(agent);
    if (frontmatterFields)
        agentFrontmatterFields.set(next, frontmatterFields);
    return next;
}
function applyCustomAgentOverrides(agents, userSettings, projectSettings, userSettingsPath, projectSettingsPath) {
    // Apply user then project so project fields win without dropping user-only fields.
    return agents.map((agent) => {
        const userOverride = userSettings.overrides[agent.name];
        const withUserOverride = userOverride
            ? applyCustomAgentOverride(agent, userOverride, { scope: "user", path: userSettingsPath })
            : agent;
        const projectOverride = projectSettings.overrides[agent.name];
        if (projectOverride && projectSettingsPath) {
            return applyCustomAgentOverride(withUserOverride, projectOverride, { scope: "project", path: projectSettingsPath });
        }
        return withUserOverride;
    });
}
function runtimeAgentOverrides(settings) {
    const overrides = {};
    for (const [name, override] of Object.entries(settings.overrides)) {
        const narrowed = {};
        if (override.model !== undefined)
            narrowed.model = override.model;
        if (override.defaultProvider !== undefined)
            narrowed.defaultProvider = override.defaultProvider;
        if (override.fast !== undefined)
            narrowed.fast = override.fast;
        if (override.thinking !== undefined)
            narrowed.thinking = override.thinking;
        if (Object.keys(narrowed).length > 0)
            overrides[name] = narrowed;
    }
    return { ...settings, overrides };
}
/**
 * Runtime-registered agents keep their extension-owned definition (prompt,
 * tools, context, budgets, and every other launch field) but follow the same
 * model-tier settings as every other agent: `subagents.defaultModel`,
 * `defaultProvider`, `defaultThinking`, and the `model`, `defaultProvider`,
 * `fast`, and `thinking` fields of `agentOverrides.<name>`, user then project,
 * provider-scoped overrides included. Other override fields are ignored for
 * runtime agents. A definition `model` still wins over `defaultModel`.
 */
export function applyRuntimeAgentSettings(agents, context) {
    if (agents.length === 0)
        return agents;
    const sources = getAgentDiscoverySources(context.cwd, context.preferredModelProvider);
    const { user, project } = settingsForScope(sources, context.scope);
    const defaultProvider = resolveSubagentDefaultProvider(user, project, sources.projectSettingsPath);
    const defaultModel = resolveSubagentDefaultModel(user, project, sources.userSettingsPath, sources.projectSettingsPath, defaultProvider);
    const defaultThinking = resolveSubagentDefaultThinking(user, project, sources.projectSettingsPath);
    const withDefaults = applySubagentDefaultThinking(applySubagentDefaultModel(agents, defaultModel, defaultProvider), defaultThinking);
    return applyCustomAgentOverrides(withDefaults, runtimeAgentOverrides(user), runtimeAgentOverrides(project), sources.userSettingsPath, sources.projectSettingsPath);
}
export function buildBuiltinOverrideConfig(base, draft) {
    const override = {};
    if (draft.machine !== base.machine)
        override.machine = draft.machine ?? false;
    if (draft.description !== undefined) {
        const description = draft.description.trim();
        if (description && description !== base.description)
            override.description = description;
    }
    if (draft.output !== base.output)
        override.output = draft.output ?? false;
    if (draft.outputMode !== undefined && draft.outputMode !== base.outputMode)
        override.outputMode = draft.outputMode;
    if (!arraysEqual(draft.defaultReads, base.defaultReads))
        override.defaultReads = draft.defaultReads ? [...draft.defaultReads] : false;
    if (draft.model !== base.model)
        override.model = draft.model ?? false;
    if (draft.modelProvider !== base.modelProvider)
        override.defaultProvider = draft.modelProvider ?? false;
    if (draft.fast !== base.fast)
        override.fast = draft.fast === true;
    if (draft.thinking !== base.thinking)
        override.thinking = draft.thinking ?? false;
    if (draft.systemPromptMode !== base.systemPromptMode)
        override.systemPromptMode = draft.systemPromptMode;
    if (draft.inheritProjectContext !== base.inheritProjectContext)
        override.inheritProjectContext = draft.inheritProjectContext;
    if (draft.inheritGlobalContext !== base.inheritGlobalContext)
        override.inheritGlobalContext = draft.inheritGlobalContext;
    if (draft.inheritSkills !== base.inheritSkills)
        override.inheritSkills = draft.inheritSkills;
    if (draft.defaultContext !== base.defaultContext)
        override.defaultContext = draft.defaultContext ?? false;
    if (draft.acceptanceRole !== base.acceptanceRole)
        override.acceptanceRole = draft.acceptanceRole ?? false;
    if (draft.disabled !== base.disabled)
        override.disabled = draft.disabled ?? false;
    if (draft.systemPrompt !== base.systemPrompt)
        override.systemPrompt = draft.systemPrompt;
    if (!arraysEqual(draft.skills, base.skills))
        override.skills = draft.skills ? [...draft.skills] : false;
    const baseTools = joinToolList(base);
    const draftTools = joinToolList(draft);
    if (!arraysEqual(draftTools, baseTools))
        override.tools = draftTools ? [...draftTools] : false;
    if (!arraysEqual(draft.excludeTools, base.excludeTools))
        override.excludeTools = draft.excludeTools ? [...draft.excludeTools] : false;
    if (draft.allowNestedSubagents !== base.allowNestedSubagents)
        override.allowNestedSubagents = draft.allowNestedSubagents === true;
    if (!arraysEqual(draft.extensions, base.extensions))
        override.extensions = draft.extensions ? [...draft.extensions] : false;
    if (!arraysEqual(draft.subagentOnlyExtensions, base.subagentOnlyExtensions)) {
        override.subagentOnlyExtensions = draft.subagentOnlyExtensions ? [...draft.subagentOnlyExtensions] : false;
    }
    if (!arraysEqual(draft.mutationTools, base.mutationTools))
        override.mutationTools = draft.mutationTools ? [...draft.mutationTools] : false;
    if (JSON.stringify(draft.toolBudget) !== JSON.stringify(base.toolBudget))
        override.toolBudget = draft.toolBudget ?? false;
    return Object.keys(override).length > 0 ? override : undefined;
}
export function saveBuiltinAgentOverride(cwd, name, scope, override) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...settings.subagents }
        : {};
    const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
        ? { ...subagents.agentOverrides }
        : {};
    agentOverrides[name] = cloneOverrideValue(override);
    subagents.agentOverrides = agentOverrides;
    settings.subagents = subagents;
    writeSettingsFile(filePath, settings);
    return filePath;
}
export function removeBuiltinAgentOverride(cwd, name, scope, options) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    if (!fs.existsSync(filePath))
        return { path: filePath, removed: false, machinePreserved: false };
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return { path: filePath, removed: false, machinePreserved: false };
    const nextSubagents = { ...subagents };
    const agentOverrides = nextSubagents.agentOverrides;
    if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides))
        return { path: filePath, removed: false, machinePreserved: false };
    const nextOverrides = { ...agentOverrides };
    const current = nextOverrides[name];
    if (!Object.prototype.hasOwnProperty.call(nextOverrides, name))
        return { path: filePath, removed: false, machinePreserved: false };
    const configuredMachine = current && typeof current === "object" && !Array.isArray(current) ? current.machine : undefined;
    const machine = configuredMachine === false || (typeof configuredMachine === "string" && configuredMachine.trim()) ? configuredMachine : undefined;
    if (options?.preserveMachine && machine !== undefined)
        nextOverrides[name] = { machine };
    else
        delete nextOverrides[name];
    if (Object.keys(nextOverrides).length > 0)
        nextSubagents.agentOverrides = nextOverrides;
    else
        delete nextSubagents.agentOverrides;
    if (Object.keys(nextSubagents).length > 0)
        settings.subagents = nextSubagents;
    else
        delete settings.subagents;
    writeSettingsFile(filePath, settings);
    return { path: filePath, removed: true, machinePreserved: options?.preserveMachine === true && machine !== undefined };
}
export function mergeBuiltinAgentOverride(cwd, name, scope, fields) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...settings.subagents }
        : {};
    const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
        ? { ...subagents.agentOverrides }
        : {};
    const existing = agentOverrides[name];
    const base = existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : {};
    agentOverrides[name] = { ...base, ...cloneOverrideValue(fields) };
    subagents.agentOverrides = agentOverrides;
    settings.subagents = subagents;
    writeSettingsFile(filePath, settings);
    return filePath;
}
export function removeBuiltinAgentOverrideFields(cwd, name, scope, fields) {
    const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
    if (!filePath)
        throw new Error("Project override is not available here. No project config root was found.");
    if (!fs.existsSync(filePath))
        return { path: filePath, removed: false };
    const settings = readSettingsFileStrict(filePath);
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
        return { path: filePath, removed: false };
    const agentOverrides = subagents.agentOverrides;
    if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides))
        return { path: filePath, removed: false };
    const entry = agentOverrides[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return { path: filePath, removed: false };
    const nextEntry = { ...entry };
    let removed = false;
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(nextEntry, field)) {
            delete nextEntry[field];
            removed = true;
        }
    }
    if (!removed)
        return { path: filePath, removed: false };
    const nextSubagents = { ...subagents };
    if (Object.keys(nextEntry).length > 0) {
        nextSubagents.agentOverrides[name] = nextEntry;
    }
    else {
        const nextOverrides = { ...agentOverrides };
        delete nextOverrides[name];
        if (Object.keys(nextOverrides).length > 0)
            nextSubagents.agentOverrides = nextOverrides;
        else
            delete nextSubagents.agentOverrides;
    }
    if (Object.keys(nextSubagents).length > 0)
        settings.subagents = nextSubagents;
    else
        delete settings.subagents;
    writeSettingsFile(filePath, settings);
    return { path: filePath, removed: true };
}
const DISCOVERY_PRUNED_DIR_NAMES = new Set([".git", "node_modules", ".pi", "sync-backups"]);
function isDiscoveryNestedProjectRoot(dir) {
    return isDirectory(getProjectConfigDir(dir)) || isDirectory(path.join(dir, ".agents"));
}
function shouldPruneDiscoveryDir(rootDir, dir, dirName) {
    if (DISCOVERY_PRUNED_DIR_NAMES.has(dirName))
        return true;
    if (fs.existsSync(path.join(dir, ".git")))
        return true;
    return path.resolve(dir) !== path.resolve(rootDir) && isDiscoveryNestedProjectRoot(dir);
}
function listFilesRecursive(dir, predicate, rootDir = dir, visitedDirectories = new Set(), inspectedDirectories = new Set()) {
    const files = [];
    if (!fs.existsSync(dir))
        return files;
    inspectedDirectories.add(path.resolve(dir));
    let realDir;
    try {
        realDir = fs.realpathSync(dir);
    }
    catch {
        return files;
    }
    if (visitedDirectories.has(realDir))
        return files;
    visitedDirectories.add(realDir);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return files;
    }
    for (const entry of entries) {
        const filePath = path.join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            try {
                isDirectory = fs.statSync(filePath).isDirectory();
            }
            catch {
                isDirectory = false;
            }
        }
        if (isDirectory) {
            if (!shouldPruneDiscoveryDir(rootDir, filePath, entry.name)) {
                files.push(...listFilesRecursive(filePath, predicate, rootDir, visitedDirectories, inspectedDirectories));
            }
            continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink())
            continue;
        if (!predicate(entry.name))
            continue;
        files.push(filePath);
    }
    return files;
}
const agentDefinitionInspectionDirectories = new WeakMap();
function rememberAgentDefinitionInspection(inspection, directories) {
    agentDefinitionInspectionDirectories.set(inspection, [...new Set([...directories].map((directory) => path.resolve(directory)))]);
    return inspection;
}
function inspectedAgentDefinitionDirectories(inspection, root) {
    return agentDefinitionInspectionDirectories.get(inspection) ?? [path.resolve(root)];
}
const DEFAULT_AGENT_DEFINITION_INSPECTION_FS = {
    existsSync: fs.existsSync,
    realpathSync: fs.realpathSync,
    statSync: fs.statSync,
    readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
};
/**
 * Inspect one agent-definition directory while retaining traversal failure
 * state. A nested unreadable directory makes the whole inspection unavailable,
 * preventing a partial traversal from being reported as empty or complete.
 */
export function inspectAgentDefinitionDirectory(dir, operations = DEFAULT_AGENT_DEFINITION_INSPECTION_FS, isExcluded = () => false) {
    const root = path.resolve(dir);
    if (isExcluded(root))
        return rememberAgentDefinitionInspection({ files: [], state: "empty" }, []);
    try {
        if (!operations.existsSync(root))
            return rememberAgentDefinitionInspection({ files: [], state: "absent" }, [root]);
        if (!operations.statSync(root).isDirectory())
            return rememberAgentDefinitionInspection({ files: [], state: "not-directory" }, [root]);
    }
    catch {
        return rememberAgentDefinitionInspection({ files: [], state: "unreadable" }, [root]);
    }
    const files = [];
    let unreadable = false;
    const visitedDirectories = new Set();
    const inspectedDirectories = new Set();
    const visit = (current) => {
        inspectedDirectories.add(path.resolve(current));
        let realDir;
        try {
            realDir = operations.realpathSync?.(current) ?? path.resolve(current);
        }
        catch {
            unreadable = true;
            return;
        }
        if (visitedDirectories.has(realDir))
            return;
        visitedDirectories.add(realDir);
        let entries;
        try {
            entries = operations.readdirSync(current).sort((a, b) => a.name.localeCompare(b.name));
        }
        catch {
            unreadable = true;
            return;
        }
        for (const entry of entries) {
            const filePath = path.join(current, entry.name);
            if (isExcluded(filePath))
                continue;
            let isDirectory = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    isDirectory = operations.statSync(filePath).isDirectory();
                }
                catch {
                    isDirectory = false;
                }
            }
            if (isDirectory) {
                if (!shouldPruneDiscoveryDir(root, filePath, entry.name))
                    visit(filePath);
                continue;
            }
            if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md") && !isLegacyAgentSkillPath(root, filePath))
                files.push(filePath);
        }
    };
    visit(root);
    return rememberAgentDefinitionInspection({ files, state: unreadable ? "unreadable" : files.length ? "candidates" : "empty" }, inspectedDirectories);
}
function isLegacyAgentSkillPath(rootDir, filePath) {
    const relative = path.relative(rootDir, filePath);
    const parts = relative.split(path.sep).map((part) => part.toLowerCase());
    if (path.basename(rootDir).toLowerCase() === ".agents") {
        parts.unshift(".agents");
    }
    return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}
function isJsonSerializable(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonSerializable);
    if (value && typeof value === "object")
        return Object.values(value).every(isJsonSerializable);
    return false;
}
function parseAgentRunnerFrontmatter(raw, agentName) {
    if (raw === undefined || !raw.trim())
        return undefined;
    let parsed;
    try {
        parsed = parseYaml(raw);
    }
    catch (error) {
        throw new Error(`Agent '${agentName}' has invalid runner frontmatter: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Agent '${agentName}' has invalid runner frontmatter; expected an object.`);
    }
    const runner = parsed;
    if (runner.type === "pi") {
        if (Object.keys(runner).some((key) => key !== "type"))
            throw new Error(`Agent '${agentName}' has invalid Pi runner frontmatter; only 'type' is supported.`);
        return { type: "pi" };
    }
    if (runner.type === "external-job") {
        if (typeof runner.provider !== "string" || !runner.provider.trim() || runner.provider.trim() !== runner.provider) {
            throw new Error(`Agent '${agentName}' external-job runner requires a non-empty trimmed provider string.`);
        }
        if (runner.options !== undefined && (!runner.options || typeof runner.options !== "object" || Array.isArray(runner.options) || !isJsonSerializable(runner.options))) {
            throw new Error(`Agent '${agentName}' external-job runner options must be a JSON-serializable object.`);
        }
        const supported = new Set(["type", "provider", "options"]);
        const unknown = Object.keys(runner).filter((key) => !supported.has(key));
        if (unknown.length > 0)
            throw new Error(`Agent '${agentName}' external-job runner has unsupported fields: ${unknown.join(", ")}.`);
        return {
            type: "external-job",
            provider: runner.provider,
            ...(runner.options ? { options: runner.options } : {}),
        };
    }
    if (runner.type !== "external-cli") {
        throw new Error(`Agent '${agentName}' has invalid runner.type; expected 'pi', 'external-cli', or 'external-job'.`);
    }
    if (typeof runner.command !== "string" || !runner.command.trim()) {
        throw new Error(`Agent '${agentName}' external-cli runner requires a non-empty command string.`);
    }
    if (runner.args !== undefined && (!Array.isArray(runner.args) || runner.args.some((arg) => typeof arg !== "string"))) {
        throw new Error(`Agent '${agentName}' external-cli runner args must be an array of strings.`);
    }
    if (runner.adapter !== undefined && !isCodeOwnedExternalCliAdapterId(runner.adapter))
        throw new Error(`Agent '${agentName}' external-cli runner adapter must be ${CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL}.`);
    if (runner.adapter !== undefined && Array.isArray(runner.args) && runner.args.length > 0)
        throw new Error(`Agent '${agentName}' ${runner.adapter} adapter owns its argv; runner args are not supported.`);
    if (runner.promptDelivery !== undefined && runner.promptDelivery !== "stdin") {
        throw new Error(`Agent '${agentName}' external-cli runner promptDelivery must be 'stdin'.`);
    }
    const capabilities = parseExternalCliCapabilityNarrowing(runner.capabilities, `Agent '${agentName}' external-cli runner capabilities`);
    const supported = new Set(["type", "adapter", "command", "args", "promptDelivery", "capabilities"]);
    const unknown = Object.keys(runner).filter((key) => !supported.has(key));
    if (unknown.length > 0)
        throw new Error(`Agent '${agentName}' external-cli runner has unsupported fields: ${unknown.join(", ")}.`);
    const runnerArgs = Array.isArray(runner.args) ? runner.args.filter((arg) => typeof arg === "string") : undefined;
    return {
        type: "external-cli",
        ...(isCodeOwnedExternalCliAdapterId(runner.adapter) ? { adapter: runner.adapter } : {}),
        command: runner.command.trim(),
        ...(runnerArgs?.length ? { args: runnerArgs } : {}),
        ...(runner.promptDelivery ? { promptDelivery: "stdin" } : {}),
        ...(capabilities ? { capabilities } : {}),
    };
}
function validateExternalRunnerProfile(frontmatter, agentName, runner) {
    if (runner?.type !== "external-cli" && runner?.type !== "external-job")
        return;
    const unsupported = ["tools", "excludeTools", "allowNestedSubagents", "allowedAgents", "model", "thinking", "extensions", "subagentOnlyExtensions", "mutationTools", "maxSubagentDepth", "skills", "skill", "skillPath", "toolBudget", "permission", "permissions"]
        .filter((field) => frontmatter[field] !== undefined);
    if (unsupported.length > 0) {
        throw new Error(`Agent '${agentName}' uses runner.type='${runner.type}' and declares unsupported Pi-only fields: ${unsupported.join(", ")}.`);
    }
}
function parseAgentAcceptanceFrontmatter(raw, agentName) {
    if (raw === undefined || !raw.trim())
        return undefined;
    let parsed;
    try {
        parsed = parseYaml(raw);
    }
    catch (error) {
        throw new Error(`Agent '${agentName}' has invalid acceptance frontmatter: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const errors = validateAcceptanceInput(parsed, `Agent '${agentName}' acceptance frontmatter`);
    if (errors.length > 0)
        throw new Error(errors.join(" "));
    return parsed;
}
function readAgentDefinitionFiles(dir, inspection = inspectAgentDefinitionDirectory(dir)) {
    const files = [];
    for (const filePath of inspection.files) {
        if (isLegacyAgentSkillPath(dir, filePath)) {
            continue;
        }
        try {
            files.push({ filePath, content: fs.readFileSync(filePath, "utf-8") });
        }
        catch {
            continue;
        }
    }
    return files;
}
function resolveAgentRelativeExtensionPaths(paths, agentFilePath) {
    if (paths === undefined)
        return undefined;
    const baseDir = path.dirname(agentFilePath);
    return paths.map((entry) => {
        const trimmed = entry.trim();
        if (trimmed === "." || trimmed === ".." || trimmed.startsWith("./") || trimmed.startsWith("../")) {
            return path.resolve(baseDir, trimmed);
        }
        return entry;
    });
}
function loadAgentsFromDefinitionFiles(files, source, discoveryPriority, packageSource) {
    const agents = [];
    const diagnostics = [];
    for (const { filePath, content } of files) {
        let name;
        let runtimeName;
        let packageSpecified = false;
        try {
            const { frontmatter, body } = parseFrontmatter(content);
            if (!frontmatter.name || !frontmatter.description) {
                continue;
            }
            const localName = frontmatter.name;
            name = localName;
            const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
            packageSpecified = parsedPackage.packageName !== undefined || parsedPackage.error !== undefined;
            if (parsedPackage.error)
                throw new Error(parsedPackage.error);
            const packageName = parsedPackage.packageName;
            runtimeName = buildRuntimeName(localName, packageName);
            const runner = parseAgentRunnerFrontmatter(frontmatter.runner, localName);
            validateExternalRunnerProfile(frontmatter, localName, runner);
            let advertise;
            if (frontmatter.advertise !== undefined) {
                if (frontmatter.advertise === "true")
                    advertise = true;
                else if (frontmatter.advertise === "false")
                    advertise = false;
                else
                    throw new Error(`Agent '${localName}' has invalid advertise frontmatter; expected true or false.`);
            }
            const rawTools = parseFrontmatterList(frontmatter.tools);
            const parsedTools = splitToolList(rawTools);
            const tools = parsedTools.tools ?? [];
            const mcpDirectTools = parsedTools.mcpDirectTools ?? [];
            const excludeTools = parseFrontmatterList(frontmatter.excludeTools);
            const parsedAllowedAgents = parseFrontmatterList(frontmatter.allowedAgents);
            const allowedAgents = parsedAllowedAgents === undefined ? undefined : normalizeCapabilityCeilingAllowedAgents(parsedAllowedAgents);
            const defaultReads = parseFrontmatterList(frontmatter.defaultReads);
            const aliases = normalizeAgentAliases(parseFrontmatterList(frontmatter.aliases ?? frontmatter.alias), runtimeName);
            const profileError = validateCodeOwnedProfileRunner({ name: runtimeName, localName, aliases, runner });
            if (profileError)
                throw new Error(profileError);
            const skillStr = frontmatter.skill || frontmatter.skills;
            const skills = parseFrontmatterList(skillStr);
            const skillPath = parseFrontmatterList(frontmatter.skillPath);
            if (frontmatter.fallbackModels !== undefined)
                throw new Error(`Agent '${filePath}' uses removed frontmatter field 'fallbackModels'. Configure one model instead.`);
            const systemPromptMode = frontmatter.systemPromptMode === "replace"
                ? "replace"
                : frontmatter.systemPromptMode === "append"
                    ? "append"
                    : defaultSystemPromptMode(localName);
            const inheritProjectContext = frontmatter.inheritProjectContext === "true"
                ? true
                : frontmatter.inheritProjectContext === "false"
                    ? false
                    : defaultInheritProjectContext(localName);
            const inheritGlobalContext = frontmatter.inheritGlobalContext === "true";
            const inheritSkills = frontmatter.inheritSkills === "true"
                ? true
                : frontmatter.inheritSkills === "false"
                    ? false
                    : defaultInheritSkills();
            const defaultContext = frontmatter.defaultContext === "fork"
                ? "fork"
                : frontmatter.defaultContext === "fresh"
                    ? "fresh"
                    : undefined;
            let defaultAsync;
            if (frontmatter.async !== undefined) {
                if (frontmatter.async === "true")
                    defaultAsync = true;
                else if (frontmatter.async === "false")
                    defaultAsync = false;
                else
                    throw new Error(`Agent '${localName}' has invalid async frontmatter; expected true or false.`);
            }
            let defaultTimeoutMs;
            if (frontmatter.timeoutMs !== undefined) {
                const parsed = Number(frontmatter.timeoutMs);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    throw new Error(`Agent '${localName}' has invalid timeoutMs frontmatter; expected a positive integer.`);
                }
                defaultTimeoutMs = parsed;
            }
            let defaultToolTimeoutMs;
            if (frontmatter.toolTimeoutMs !== undefined) {
                const parsed = Number(frontmatter.toolTimeoutMs);
                if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
                    throw new Error(`Agent '${localName}' has invalid toolTimeoutMs frontmatter; expected a positive integer no larger than 2147483647.`);
                }
                defaultToolTimeoutMs = parsed;
            }
            const defaultAcceptance = parseAgentAcceptanceFrontmatter(frontmatter.acceptance, localName);
            let outputMode;
            if (frontmatter.outputMode !== undefined) {
                if (frontmatter.outputMode === "inline" || frontmatter.outputMode === "file-only")
                    outputMode = frontmatter.outputMode;
                else
                    throw new Error(`Agent '${localName}' has invalid outputMode frontmatter; expected 'inline' or 'file-only'.`);
            }
            let acceptanceRole;
            if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim()) {
                if (frontmatter.acceptanceRole === "read-only" || frontmatter.acceptanceRole === "writer")
                    acceptanceRole = frontmatter.acceptanceRole;
                else
                    throw new Error(`Agent '${localName}' has invalid acceptanceRole frontmatter; expected 'read-only' or 'writer'.`);
            }
            const extensions = resolveAgentRelativeExtensionPaths(parseFrontmatterList(frontmatter.extensions), filePath);
            const subagentOnlyExtensions = resolveAgentRelativeExtensionPaths(parseFrontmatterList(frontmatter.subagentOnlyExtensions), filePath);
            const mutationTools = parseFrontmatterList(frontmatter.mutationTools);
            let fast;
            if (frontmatter.fast !== undefined) {
                if (frontmatter.fast === "true")
                    fast = true;
                else if (frontmatter.fast === "false")
                    fast = false;
                else
                    throw new Error(`Agent '${localName}' has invalid fast frontmatter; expected true or false.`);
            }
            let allowNestedSubagents;
            if (frontmatter.allowNestedSubagents !== undefined) {
                if (frontmatter.allowNestedSubagents === "true")
                    allowNestedSubagents = true;
                else if (frontmatter.allowNestedSubagents === "false")
                    allowNestedSubagents = false;
                else
                    throw new Error(`Agent '${localName}' has invalid allowNestedSubagents frontmatter; expected true or false.`);
            }
            const extraFields = {};
            for (const [key, value] of Object.entries(frontmatter)) {
                if (!KNOWN_FIELDS.has(key))
                    extraFields[key] = value;
            }
            const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
            if (frontmatter.permission !== undefined && frontmatter.permissions !== undefined) {
                throw new Error(`Agent '${localName}' cannot declare both permission and permissions frontmatter.`);
            }
            const permissionSource = frontmatter.permissions ?? frontmatter.permission;
            const permissions = permissionSource?.trim()
                ? validatePermissionRules(parseYaml(permissionSource), `Agent '${localName}' permissions`)
                : undefined;
            let toolBudget;
            if (frontmatter.toolBudget !== undefined && frontmatter.toolBudget.trim()) {
                const parsed = JSON.parse(frontmatter.toolBudget);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    throw new Error(`Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`);
                }
                toolBudget = parsed;
            }
            let outputSchema;
            if (frontmatter.outputSchema !== undefined && frontmatter.outputSchema.trim()) {
                const parsed = JSON.parse(frontmatter.outputSchema);
                assertJsonSchemaObject(parsed, `Agent '${localName}' outputSchema`);
                outputSchema = parsed;
            }
            const maxSubagentDepth = Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
                ? parsedMaxSubagentDepth
                : undefined;
            const memory = parseMemoryFrontmatter(frontmatter.memory);
            const machine = validateOptionalMachine(frontmatter.machine, `Agent '${runtimeName}' frontmatter 'machine'`);
            const agent = {
                name: runtimeName,
                ...(runner !== undefined ? { runner } : {}),
                localName,
                ...(packageName !== undefined ? { packageName } : {}),
                ...(packageSource?.packageName ? { packageSourceName: packageSource.packageName } : {}),
                ...(packageSource?.packageVersion ? { packageSourceVersion: packageSource.packageVersion } : {}),
                ...(packageSource?.packageRoot ? { packageSourceRoot: packageSource.packageRoot } : {}),
                description: frontmatter.description,
                ...(advertise !== undefined ? { advertise } : {}),
                ...(aliases !== undefined ? { aliases } : {}),
                ...(rawTools !== undefined ? { tools } : {}),
                ...(excludeTools !== undefined ? { excludeTools } : {}),
                ...(allowNestedSubagents !== undefined ? { allowNestedSubagents } : {}),
                ...(allowedAgents !== undefined ? { allowedAgents } : {}),
                ...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
                ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
                ...(fast !== undefined ? { fast } : {}),
                ...(frontmatter.thinking !== undefined ? { thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking } : {}),
                systemPromptMode,
                inheritProjectContext,
                inheritGlobalContext,
                inheritSkills,
                ...(defaultContext !== undefined ? { defaultContext } : {}),
                ...(defaultAsync !== undefined ? { defaultAsync } : {}),
                ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
                ...(defaultToolTimeoutMs !== undefined ? { defaultToolTimeoutMs } : {}),
                ...(defaultAcceptance !== undefined ? { defaultAcceptance } : {}),
                ...(acceptanceRole !== undefined ? { acceptanceRole } : {}),
                systemPrompt: body,
                source,
                filePath,
                ...(discoveryPriority !== undefined ? { discoveryPriority } : {}),
                ...(skills?.length ? { skills } : {}),
                ...(skillPath?.length ? { skillPath } : {}),
                ...(extensions !== undefined ? { extensions } : {}),
                ...(subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions } : {}),
                ...(mutationTools?.length ? { mutationTools } : {}),
                ...(machine !== undefined ? { machine } : {}),
                ...(frontmatter.output !== undefined ? { output: frontmatter.output } : {}),
                ...(outputMode !== undefined ? { outputMode } : {}),
                ...(outputSchema !== undefined ? { outputSchema } : {}),
                ...(defaultReads?.length ? { defaultReads } : {}),
                defaultProgress: frontmatter.defaultProgress === "true",
                interactive: frontmatter.interactive === "true",
                ...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
                ...(toolBudget !== undefined ? { toolBudget } : {}),
                ...(permissions !== undefined ? { permissions } : {}),
                ...(memory !== undefined ? { memory } : {}),
                ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
            };
            agentFrontmatterFields.set(agent, new Set(Object.keys(frontmatter)));
            agents.push(agent);
        }
        catch (error) {
            diagnostics.push({ source, filePath, ...(name ? { name } : {}), ...(runtimeName && runtimeName !== name ? { runtimeName } : {}), ...(packageSpecified ? { packageSpecified: true } : {}), ...(discoveryPriority !== undefined ? { discoveryPriority } : {}), error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { agents, diagnostics };
}
function loadAgentsFromDir(dir, source, discoveryPriority, packageSource, inspection = inspectAgentDefinitionDirectory(dir)) {
    return loadAgentsFromDefinitionFiles(readAgentDefinitionFiles(dir, inspection), source, discoveryPriority, packageSource);
}
function reportAgentDefinitionDirectory(source, dir, inspection) {
    return {
        source,
        path: path.resolve(dir),
        state: inspection.state,
        ...(inspection.state === "candidates" ? { candidateCount: inspection.files.length } : {}),
    };
}
function loadChainsFromDir(dir, source) {
    const chains = new Map();
    const diagnostics = [];
    const directories = new Set();
    const files = listFilesRecursive(dir, (fileName) => fileName.endsWith(".chain.md") || fileName.endsWith(".chain.json"), dir, new Set(), directories);
    for (const filePath of files) {
        let content;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        }
        catch {
            continue;
        }
        try {
            const chain = filePath.endsWith(".chain.json") ? parseJsonChain(content, source, filePath) : parseChain(content, source, filePath);
            const existing = chains.get(chain.name);
            if (existing && existing.filePath.endsWith(".chain.json") && filePath.endsWith(".chain.md"))
                continue;
            chains.set(chain.name, chain);
        }
        catch (error) {
            diagnostics.push({ source, filePath, error: error instanceof Error ? error.message : String(error) });
            continue;
        }
    }
    return { chains: Array.from(chains.values()), diagnostics, files, directories: [...directories] };
}
function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
function resolveNearestProjectAgentDirs(cwd) {
    const projectRoot = findConfiguredProjectRoot(cwd);
    if (!projectRoot)
        return { readDirs: [], candidateDirs: [], preferredDir: null };
    const legacyDir = path.join(projectRoot, ".agents");
    const preferredDir = path.join(getProjectConfigDir(projectRoot), "agents");
    const candidateDirs = [legacyDir, preferredDir];
    const readDirs = [];
    if (isDirectory(legacyDir))
        readDirs.push(legacyDir);
    if (isDirectory(preferredDir))
        readDirs.push(preferredDir);
    return { readDirs, candidateDirs, preferredDir };
}
function resolveNearestProjectChainDirs(cwd) {
    const projectRoot = findConfiguredProjectRoot(cwd);
    if (!projectRoot)
        return { readDirs: [], preferredDir: null };
    const preferredDir = path.join(getProjectConfigDir(projectRoot), "chains");
    return {
        readDirs: isDirectory(preferredDir) ? [preferredDir] : [],
        preferredDir,
    };
}
const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
// Candidate files and inspection state must describe the same cached builtin scan.
const BUILTIN_AGENT_DEFINITION_INSPECTION = inspectAgentDefinitionDirectory(BUILTIN_AGENTS_DIR);
const BUILTIN_AGENT_DEFINITION_FILES = readAgentDefinitionFiles(BUILTIN_AGENTS_DIR, BUILTIN_AGENT_DEFINITION_INSPECTION);
export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";
// Additional read-only directories to scan for agent definitions, supplied by the
// launcher via PI_SUBAGENT_EXTRA_AGENT_DIRS (PATH-style, split on os/path delimiter).
// Lets a hermetic wrapper (e.g. a Nix-store install) expose bundled agents without
// copying or symlinking them into the writable agent dir. Loaded as "user" source,
// at lower precedence than agents the user placed in their own agent dir.
function extraUserAgentDirs() {
    const raw = process.env[EXTRA_AGENT_DIRS_ENV];
    if (!raw)
        return [];
    return raw
        .split(path.delimiter)
        .map((dir) => dir.trim())
        .filter((dir) => dir.length > 0);
}
function readConfiguredAgentScanDirs(filePath, key = "agentScanDirs") {
    if (!filePath)
        return [];
    try {
        const settings = readSettingsFileStrict(filePath);
        const subagents = settings.subagents;
        if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
            return [];
        const dirs = subagents[key];
        return Array.isArray(dirs) ? dirs.filter((dir) => typeof dir === "string" && dir.trim().length > 0) : [];
    }
    catch {
        return [];
    }
}
// Resolve existing ancestors to canonicalize missing descendants of symlinks.
function canonicalAgentPath(filePath) {
    const resolved = path.resolve(filePath);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        const parent = path.dirname(resolved);
        return parent === resolved ? resolved : path.join(canonicalAgentPath(parent), path.basename(resolved));
    }
}
function agentExclusionRoots(userSettingsPath, projectSettingsPath) {
    return [userSettingsPath, projectSettingsPath].flatMap((settingsPath) => settingsPath
        ? readConfiguredAgentScanDirs(settingsPath, "agentExcludeDirs").map((entry) => {
            const resolved = path.resolve(path.dirname(settingsPath), expandHomePath(entry.trim()).replace(/[\\/]+/g, path.sep));
            return { resolved, real: canonicalAgentPath(resolved) };
        }) : []);
}
function agentExclusions(roots) {
    return (filePath) => {
        if (!roots.length)
            return false;
        if (roots.some((root) => isPathWithin(root.resolved, filePath)))
            return true;
        const real = canonicalAgentPath(filePath);
        return roots.some((root) => isPathWithin(root.real, real));
    };
}
function expandAgentScanDirPattern(pattern, isExcluded) {
    const expanded = expandHomePath(pattern.trim()).replace(/[\\/]+/g, path.sep);
    if (!expanded)
        return { dirs: [], watchPaths: [] };
    const wildcardMatches = [...expanded.matchAll(/\*/g)];
    if (wildcardMatches.length === 0) {
        const dir = path.resolve(expanded);
        return { dirs: !isExcluded(dir) && fs.existsSync(dir) ? [dir] : [], watchPaths: [dir] };
    }
    const parts = expanded.split(path.sep);
    const wildcardIndex = parts.findIndex((part) => part.includes("*"));
    if (wildcardMatches.length !== 1 || wildcardIndex === -1 || parts[wildcardIndex] !== "*")
        return { dirs: [], watchPaths: [] };
    const base = path.resolve(parts.slice(0, wildcardIndex).join(path.sep) || path.sep);
    if (isExcluded(base))
        return { dirs: [], watchPaths: [base] };
    const rest = parts.slice(wildcardIndex + 1);
    let entries;
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    }
    catch {
        return { dirs: [], watchPaths: [base] };
    }
    const candidateDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name, ...rest));
    return {
        dirs: candidateDirs.filter((dir) => !isExcluded(dir) && fs.existsSync(dir)),
        watchPaths: [base, ...candidateDirs],
    };
}
function settingsAgentScanDirs(entries, isExcluded) {
    const dirs = new Set();
    const watchPaths = new Set();
    for (const entry of entries) {
        const expanded = expandAgentScanDirPattern(entry, isExcluded);
        for (const dir of expanded.dirs)
            dirs.add(dir);
        for (const watchPath of expanded.watchPaths)
            watchPaths.add(watchPath);
    }
    return { dirs: [...dirs], watchPaths: [...watchPaths] };
}
const agentDiscoveryCache = new Map();
function isPathWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function addDirectoryWatchPaths(paths, root, files, directories = []) {
    const resolvedRoot = path.resolve(root);
    paths.add(resolvedRoot);
    // The initial recursive inspection is already bounded to this discovery
    // root. Keep every visited directory in the fingerprint so a file added to
    // an existing empty nested directory invalidates the snapshot too.
    for (const directory of directories) {
        if (isPathWithin(resolvedRoot, directory))
            paths.add(path.resolve(directory));
    }
    for (const file of files) {
        paths.add(path.resolve(file));
        let current = path.resolve(path.dirname(file));
        while (isPathWithin(resolvedRoot, current)) {
            paths.add(current);
            if (current === resolvedRoot)
                break;
            current = path.dirname(current);
        }
    }
}
function watchPathSignature(filePath, isExcluded) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(filePath, { withFileTypes: true })
                .filter((entry) => !isExcluded || !isExcluded(path.join(filePath, entry.name)))
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((entry) => `${entry.name}:${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? (isExcluded ? `l:${canonicalAgentPath(path.join(filePath, entry.name))}` : "l") : "f"}`)
                .join("|");
            return `directory:${entries}`;
        }
        return `file:${stat.size}:${stat.mtimeMs}`;
    }
    catch {
        return "missing";
    }
}
function discoveryFingerprint(sources) {
    const exclusionIdentity = JSON.stringify(sources.exclusionRoots.map((root) => ({ resolved: root.resolved, real: canonicalAgentPath(root.resolved) })));
    // A retargeted exclusion needs a fresh scan before fingerprinting old roots.
    if (exclusionIdentity !== JSON.stringify(sources.exclusionRoots))
        return exclusionIdentity;
    const rootIdentities = JSON.stringify(sources.identityWatchPaths.map((root) => [root, canonicalAgentPath(root)]));
    // Package metadata can redirect agents outside an excluded tree without chains.
    const unfilteredPaths = new Set([...sources.packageSubagentPaths.watchPaths, ...(sources.chainWatchPaths ?? [])]);
    return exclusionIdentity + "\n" + rootIdentities + "\n" + [...new Set([...sources.watchPaths, ...unfilteredPaths])]
        .filter((filePath) => unfilteredPaths.has(filePath) || filePath === sources.userSettingsPath || filePath === sources.projectSettingsPath || !sources.isExcluded(filePath))
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => `${filePath}:${watchPathSignature(filePath, sources.exclusionRoots.length && !unfilteredPaths.has(filePath) ? sources.isExcluded : undefined)}`)
        .join("\n");
}
function discoveryCacheKey(cwd, preferredModelProvider) {
    return JSON.stringify([
        path.resolve(cwd),
        preferredModelProvider ?? null,
        getProjectConfigDir(path.resolve(cwd)),
        getAgentDir(),
        os.homedir(),
        process.env.HOME ?? "",
        process.env.USERPROFILE ?? "",
        process.env[EXTRA_AGENT_DIRS_ENV] ?? "",
        process.env.PI_OFFLINE ?? "",
        process.env.APPDATA ?? "",
    ]);
}
function projectDiscoveryWatchPaths(cwd) {
    const paths = [];
    let current = path.resolve(cwd);
    while (true) {
        paths.push(getProjectConfigDir(current), path.join(current, ".agents"), path.join(current, ".git"));
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return paths;
}
function packageEntryIncluded(scope, packageScopes) {
    if (scope === "both" || packageScopes.has("root"))
        return true;
    return packageScopes.has(scope);
}
function buildAgentDiscoverySources(cwd, preferredModelProvider) {
    const effectiveCwd = path.resolve(cwd);
    const userDirOld = path.join(getAgentDir(), "agents");
    const userDirNew = path.join(os.homedir(), ".agents");
    const userChainDir = getUserChainDir();
    const { readDirs: projectAgentDirs, candidateDirs: projectCandidateDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(effectiveCwd);
    const { readDirs: projectChainDirs, preferredDir: projectChainDir } = resolveNearestProjectChainDirs(effectiveCwd);
    const userSettingsPath = getUserAgentSettingsPath();
    const projectSettingsPath = getProjectAgentSettingsPath(effectiveCwd);
    const packageSubagentPaths = collectPackageSubagentPaths(effectiveCwd);
    const exclusionRoots = agentExclusionRoots(userSettingsPath, projectSettingsPath);
    const isExcluded = agentExclusions(exclusionRoots);
    const userScanDirs = settingsAgentScanDirs(readConfiguredAgentScanDirs(userSettingsPath), isExcluded);
    const projectScanDirs = settingsAgentScanDirs(readConfiguredAgentScanDirs(projectSettingsPath), isExcluded);
    const builtinLoaded = loadAgentsFromDefinitionFiles(BUILTIN_AGENT_DEFINITION_FILES, "builtin");
    const userLoaded = [...extraUserAgentDirs(), ...userScanDirs.dirs, userDirOld, userDirNew].filter((dir) => !isExcluded(dir)).map((dir, discoveryPriority) => {
        const inspection = inspectAgentDefinitionDirectory(dir, undefined, isExcluded);
        return { dir, inspection, loaded: loadAgentsFromDir(dir, "user", discoveryPriority, undefined, inspection) };
    });
    const projectInspections = new Map(projectCandidateDirs.filter((dir) => !isExcluded(dir)).map((dir) => [dir, inspectAgentDefinitionDirectory(dir, undefined, isExcluded)]));
    const projectLoaded = [...projectScanDirs.dirs, ...projectAgentDirs].filter((dir) => !isExcluded(dir)).map((dir, discoveryPriority) => {
        const inspection = projectInspections.get(dir) ?? inspectAgentDefinitionDirectory(dir, undefined, isExcluded);
        return { dir, inspection, loaded: loadAgentsFromDir(dir, "project", dir === projectAgentsDir ? 1 : discoveryPriority, undefined, inspection) };
    });
    const packageLoaded = packageSubagentPaths.agents.filter((entry) => !isExcluded(entry.dir)).map((entry, index) => {
        const inspection = inspectAgentDefinitionDirectory(entry.dir, undefined, isExcluded);
        return { dir: entry.dir, inspection, packageEntry: entry, loaded: loadAgentsFromDir(entry.dir, "package", packageSubagentPaths.agents.length - index, entry, inspection) };
    });
    const watchPaths = new Set([
        userSettingsPath,
        ...(projectSettingsPath ? [projectSettingsPath] : []),
        ...projectDiscoveryWatchPaths(effectiveCwd),
        ...findProjectRootCandidates(effectiveCwd).map((root) => path.join(getProjectConfigDir(root), "settings.json")),
        ...userScanDirs.watchPaths,
        ...projectScanDirs.watchPaths,
        ...packageSubagentPaths.watchPaths,
    ]);
    for (const directory of userLoaded)
        addDirectoryWatchPaths(watchPaths, directory.dir, directory.inspection.files, inspectedAgentDefinitionDirectories(directory.inspection, directory.dir));
    for (const dir of projectCandidateDirs) {
        const inspection = projectInspections.get(dir);
        addDirectoryWatchPaths(watchPaths, dir, inspection?.files ?? [], inspection ? inspectedAgentDefinitionDirectories(inspection, dir) : []);
    }
    for (const directory of projectLoaded)
        addDirectoryWatchPaths(watchPaths, directory.dir, directory.inspection.files, inspectedAgentDefinitionDirectories(directory.inspection, directory.dir));
    for (const directory of packageLoaded)
        addDirectoryWatchPaths(watchPaths, directory.dir, directory.inspection.files, inspectedAgentDefinitionDirectories(directory.inspection, directory.dir));
    const userDir = process.env.PI_CODING_AGENT_DIR ? userDirOld : fs.existsSync(userDirNew) ? userDirNew : userDirOld;
    return {
        cwd: effectiveCwd,
        ...(preferredModelProvider !== undefined ? { preferredModelProvider } : {}),
        userDir,
        userDirOld,
        userDirNew,
        userChainDir,
        projectAgentDirs,
        projectCandidateDirs: projectCandidateDirs.filter((dir) => !isExcluded(dir)),
        projectAgentsDir,
        projectChainDirs,
        projectChainDir,
        userSettingsPath,
        projectSettingsPath,
        packageSubagentPaths,
        builtinLoaded,
        userLoaded,
        projectLoaded,
        projectInspections,
        packageLoaded,
        isExcluded,
        exclusionRoots,
        // Aliases outside excluded lexical subtrees can be retargeted into allowed
        // storage. Watch only their identity, never the excluded target's contents.
        identityWatchPaths: [...new Set([
                ...userScanDirs.watchPaths, ...projectScanDirs.watchPaths,
                ...extraUserAgentDirs(), userDirOld, userDirNew, ...projectCandidateDirs,
                ...packageSubagentPaths.agents.map((entry) => entry.dir),
            ])]
            .filter((dir) => !exclusionRoots.some((root) => isPathWithin(root.resolved, dir)) && isExcluded(dir)),
        watchPaths: [...watchPaths].filter((filePath) => !isExcluded(filePath) || filePath === userSettingsPath || filePath === projectSettingsPath),
    };
}
function ensureDiscoveryChains(sources) {
    if (sources.userChains)
        return;
    sources.packageChainLoaded = sources.packageSubagentPaths.chains.map((entry) => ({ entry, loaded: loadChainsFromDir(entry.dir, "package") }));
    sources.userChains = loadChainsFromDir(sources.userChainDir, "user");
    sources.projectChainLoaded = sources.projectChainDirs.map((dir) => ({ dir, loaded: loadChainsFromDir(dir, "project") }));
    const watchPaths = new Set(sources.packageSubagentPaths.watchPaths);
    addDirectoryWatchPaths(watchPaths, sources.userChainDir, sources.userChains.files, sources.userChains.directories);
    for (const chain of sources.projectChainLoaded)
        addDirectoryWatchPaths(watchPaths, chain.dir, chain.loaded.files, chain.loaded.directories);
    for (const chain of sources.packageChainLoaded)
        addDirectoryWatchPaths(watchPaths, chain.entry.dir, chain.loaded.files, chain.loaded.directories);
    sources.chainWatchPaths = watchPaths;
    sources.watchPaths = [...new Set([...sources.watchPaths, ...watchPaths])];
}
function getAgentDiscoverySources(cwd, preferredModelProvider, includeChains = false) {
    const key = discoveryCacheKey(cwd, preferredModelProvider);
    const cached = agentDiscoveryCache.get(key);
    if (cached && cached.fingerprint === discoveryFingerprint(cached.sources)) {
        if (includeChains) {
            ensureDiscoveryChains(cached.sources);
            cached.fingerprint = discoveryFingerprint(cached.sources);
        }
        return cached.sources;
    }
    const sources = buildAgentDiscoverySources(cwd, preferredModelProvider);
    const entry = { sources, fingerprint: discoveryFingerprint(sources) };
    agentDiscoveryCache.set(key, entry);
    if (includeChains) {
        ensureDiscoveryChains(sources);
        entry.fingerprint = discoveryFingerprint(sources);
    }
    return sources;
}
/** Clear process-local discovery snapshots, primarily for hosts that reload settings in place. */
export function clearAgentDiscoveryCache() {
    agentDiscoveryCache.clear();
}
function ensureSettingsForScope(sources, scope, preferredModelProvider) {
    if (scope !== "project" && sources.userSettings === undefined) {
        if (sources.packageSubagentPaths.settingsErrors.user)
            throw sources.packageSubagentPaths.settingsErrors.user;
        sources.userSettings = selectProviderOverrides(readSubagentSettings(sources.userSettingsPath), preferredModelProvider);
    }
    if (scope !== "user" && sources.projectSettings === undefined) {
        if (sources.packageSubagentPaths.settingsErrors.project)
            throw sources.packageSubagentPaths.settingsErrors.project;
        sources.projectSettings = selectProviderOverrides(readSubagentSettings(sources.projectSettingsPath), preferredModelProvider);
    }
}
function settingsForScope(sources, scope) {
    // Parse only settings that participate in this projection. The source cache
    // still retains both source trees, while malformed out-of-scope settings do
    // not make an otherwise valid scoped projection fail.
    ensureSettingsForScope(sources, scope, sources.preferredModelProvider);
    return {
        user: scope === "project" ? EMPTY_SUBAGENT_SETTINGS : sources.userSettings ?? EMPTY_SUBAGENT_SETTINGS,
        project: scope === "user" ? EMPTY_SUBAGENT_SETTINGS : sources.projectSettings ?? EMPTY_SUBAGENT_SETTINGS,
    };
}
function configuredAgentsForScope(sources, scope, settingsScope = scope) {
    const { user: userSettings, project: projectSettings } = settingsForScope(sources, settingsScope);
    const defaultProvider = resolveSubagentDefaultProvider(userSettings, projectSettings, sources.projectSettingsPath);
    const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, sources.userSettingsPath, sources.projectSettingsPath, defaultProvider);
    const defaultThinking = resolveSubagentDefaultThinking(userSettings, projectSettings, sources.projectSettingsPath);
    const maxThinking = resolveSubagentMaxThinking(userSettings, projectSettings, sources.projectSettingsPath);
    const defaultExtensions = resolveSubagentDefaultExtensions(userSettings, projectSettings, sources.projectSettingsPath);
    const defaultSubagentOnlyExtensions = resolveSubagentDefaultSubagentOnlyExtensions(userSettings, projectSettings, sources.projectSettingsPath);
    const applyDefaults = (agents) => applySubagentDefaults(agents, defaultModel, defaultProvider, defaultThinking, defaultExtensions, defaultSubagentOnlyExtensions);
    const builtin = applyBuiltinOverrides(applyDefaults(sources.builtinLoaded.agents), userSettings, projectSettings, sources.userSettingsPath, sources.projectSettingsPath);
    const user = applyCustomAgentOverrides(applyDefaults(scope === "project" ? [] : sources.userLoaded.flatMap((loaded) => loaded.loaded.agents)), userSettings, projectSettings, sources.userSettingsPath, sources.projectSettingsPath);
    const projectMap = new Map();
    if (scope !== "user")
        for (const loaded of sources.projectLoaded)
            for (const agent of loaded.loaded.agents)
                projectMap.set(agent.name, agent);
    const project = applyCustomAgentOverrides(applyDefaults(Array.from(projectMap.values())), userSettings, projectSettings, sources.userSettingsPath, sources.projectSettingsPath);
    const packageMap = new Map();
    for (const loaded of sources.packageLoaded) {
        if (!loaded.packageEntry || !packageEntryIncluded(scope, loaded.packageEntry.scope))
            continue;
        for (const agent of loaded.loaded.agents)
            if (!packageMap.has(agent.name))
                packageMap.set(agent.name, agent);
    }
    const packageAgents = applyCustomAgentOverrides(applyDefaults(Array.from(packageMap.values())), userSettings, projectSettings, sources.userSettingsPath, sources.projectSettingsPath);
    return {
        builtin,
        package: packageAgents,
        user,
        project,
        userSettings,
        projectSettings,
        maxThinking,
        modelScope: projectSettings.modelScope ?? userSettings.modelScope,
    };
}
function discoveryDirectories(sources, scope) {
    const directories = [reportAgentDefinitionDirectory("builtin", BUILTIN_AGENTS_DIR, BUILTIN_AGENT_DEFINITION_INSPECTION)];
    if (scope !== "project")
        for (const directory of sources.userLoaded)
            directories.push(reportAgentDefinitionDirectory("user", directory.dir, directory.inspection));
    if (scope !== "user") {
        const reported = new Set();
        for (const dir of sources.projectCandidateDirs) {
            reported.add(path.resolve(dir));
            directories.push(reportAgentDefinitionDirectory("project", dir, sources.projectInspections.get(dir)));
        }
        for (const directory of sources.projectLoaded) {
            if (!reported.has(path.resolve(directory.dir)))
                directories.push(reportAgentDefinitionDirectory("project", directory.dir, directory.inspection));
        }
    }
    for (const directory of sources.packageLoaded) {
        if (directory.packageEntry && packageEntryIncluded(scope, directory.packageEntry.scope))
            directories.push(reportAgentDefinitionDirectory("package", directory.dir, directory.inspection));
    }
    return directories;
}
function discoveryDiagnostics(sources, scope) {
    return [
        ...sources.builtinLoaded.diagnostics,
        ...(scope === "project" ? [] : sources.userLoaded.flatMap((loaded) => loaded.loaded.diagnostics)),
        ...(scope === "user" ? [] : sources.projectLoaded.flatMap((loaded) => loaded.loaded.diagnostics)),
        ...sources.packageLoaded
            .filter((loaded) => loaded.packageEntry && packageEntryIncluded(scope, loaded.packageEntry.scope))
            .flatMap((loaded) => loaded.loaded.diagnostics),
    ];
}
function buildEffectiveDiscovery(sources, scope) {
    const configured = configuredAgentsForScope(sources, scope);
    const agents = applySubagentMaxThinking(mergeAgentsForScope(scope, configured.user, configured.project, configured.builtin, configured.package).filter((agent) => agent.disabled !== true), configured.maxThinking);
    return {
        agents,
        agentDiagnostics: discoveryDiagnostics(sources, scope),
        projectAgentsDir: sources.projectAgentsDir,
        cwd: sources.cwd,
        scope,
        directories: discoveryDirectories(sources, scope),
        ...(configured.modelScope !== undefined ? { modelScope: configured.modelScope } : {}),
        ...(configured.maxThinking !== undefined ? { maxThinking: configured.maxThinking } : {}),
    };
}
function buildAllDiscovery(sources, includeChains, settingsScope) {
    if (includeChains)
        ensureDiscoveryChains(sources);
    const configured = configuredAgentsForScope(sources, "both", settingsScope);
    const packageChainMap = new Map();
    const packageChainDiagnostics = [];
    for (const chain of sources.packageChainLoaded ?? []) {
        packageChainDiagnostics.push(...chain.loaded.diagnostics);
        for (const definition of chain.loaded.chains)
            if (!packageChainMap.has(definition.name))
                packageChainMap.set(definition.name, definition);
    }
    const projectChainMap = new Map();
    const projectChainDiagnostics = [];
    for (const chain of sources.projectChainLoaded ?? []) {
        projectChainDiagnostics.push(...chain.loaded.diagnostics);
        for (const definition of chain.loaded.chains)
            projectChainMap.set(definition.name, definition);
    }
    const chains = [
        ...Array.from(packageChainMap.values()),
        ...(sources.userChains?.chains ?? []),
        ...Array.from(projectChainMap.values()),
    ];
    return {
        builtin: applySubagentMaxThinking(configured.builtin, configured.maxThinking),
        package: applySubagentMaxThinking(configured.package, configured.maxThinking),
        user: applySubagentMaxThinking(configured.user, configured.maxThinking),
        project: applySubagentMaxThinking(configured.project, configured.maxThinking),
        agentDiagnostics: [
            ...sources.builtinLoaded.diagnostics,
            ...sources.userLoaded.flatMap((loaded) => loaded.loaded.diagnostics),
            ...sources.packageLoaded.flatMap((loaded) => loaded.loaded.diagnostics),
            ...sources.projectLoaded.flatMap((loaded) => loaded.loaded.diagnostics),
        ],
        chains,
        chainDiagnostics: [...packageChainDiagnostics, ...(sources.userChains?.diagnostics ?? []), ...projectChainDiagnostics],
        cwd: sources.cwd,
        userDir: sources.userDir,
        projectDir: sources.projectAgentsDir,
        userChainDir: sources.userChainDir,
        projectChainDir: sources.projectChainDir,
        userSettingsPath: sources.userSettingsPath,
        projectSettingsPath: sources.projectSettingsPath,
        ...(configured.maxThinking !== undefined ? { maxThinking: configured.maxThinking } : {}),
    };
}
export function discoverAgentSnapshot(cwd, scope, preferredModelProvider, options = {}) {
    const includeChains = options.includeChains !== false;
    const sources = getAgentDiscoverySources(cwd, preferredModelProvider, includeChains);
    return { effective: buildEffectiveDiscovery(sources, scope), all: buildAllDiscovery(sources, includeChains, scope) };
}
function discoverAgentsUncached(cwd, scope, preferredModelProvider) {
    const effectiveCwd = path.resolve(cwd);
    const userDirOld = path.join(getAgentDir(), "agents");
    const userDirNew = path.join(os.homedir(), ".agents");
    const { readDirs: projectAgentDirs, candidateDirs: projectCandidateDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(effectiveCwd);
    const userSettingsPath = getUserAgentSettingsPath();
    const projectSettingsPath = getProjectAgentSettingsPath(effectiveCwd);
    const userSettings = selectProviderOverrides(scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath), preferredModelProvider);
    const projectSettings = selectProviderOverrides(scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath), preferredModelProvider);
    const defaultProvider = resolveSubagentDefaultProvider(userSettings, projectSettings, projectSettingsPath);
    const defaultModel = resolveSubagentDefaultModel(userSettings, projectSettings, userSettingsPath, projectSettingsPath, defaultProvider);
    const defaultThinking = resolveSubagentDefaultThinking(userSettings, projectSettings, projectSettingsPath);
    const maxThinking = resolveSubagentMaxThinking(userSettings, projectSettings, projectSettingsPath);
    const defaultExtensions = resolveSubagentDefaultExtensions(userSettings, projectSettings, projectSettingsPath);
    const defaultSubagentOnlyExtensions = resolveSubagentDefaultSubagentOnlyExtensions(userSettings, projectSettings, projectSettingsPath);
    const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
    const packageSubagentPaths = collectPackageSubagentPaths(effectiveCwd, { includeUser: scope !== "project", includeProject: scope !== "user" });
    const isExcluded = agentExclusions(agentExclusionRoots(userSettingsPath, projectSettingsPath));
    const directories = [reportAgentDefinitionDirectory("builtin", BUILTIN_AGENTS_DIR, BUILTIN_AGENT_DEFINITION_INSPECTION)];
    const builtinLoaded = loadAgentsFromDefinitionFiles(BUILTIN_AGENT_DEFINITION_FILES, "builtin");
    const applyDefaults = (agents) => applySubagentDefaults(agents, defaultModel, defaultProvider, defaultThinking, defaultExtensions, defaultSubagentOnlyExtensions);
    const builtinAgents = applyBuiltinOverrides(applyDefaults(builtinLoaded.agents), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const userScanDirs = settingsAgentScanDirs(userSettings.agentScanDirs ?? [], isExcluded);
    const projectScanDirs = settingsAgentScanDirs(projectSettings.agentScanDirs ?? [], isExcluded);
    const userLoaded = scope === "project" ? [] : [...extraUserAgentDirs(), ...userScanDirs.dirs, userDirOld, userDirNew].filter((dir) => !isExcluded(dir)).map((dir, discoveryPriority) => {
        const inspection = inspectAgentDefinitionDirectory(dir, undefined, isExcluded);
        directories.push(reportAgentDefinitionDirectory("user", dir, inspection));
        return loadAgentsFromDir(dir, "user", discoveryPriority, undefined, inspection);
    });
    const userAgents = applyCustomAgentOverrides(applyDefaults(userLoaded.flatMap((loaded) => loaded.agents)), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const projectInspections = scope === "user" ? new Map() : new Map(projectCandidateDirs.filter((dir) => !isExcluded(dir)).map((dir) => [dir, inspectAgentDefinitionDirectory(dir, undefined, isExcluded)]));
    if (scope !== "user")
        for (const [dir, inspection] of projectInspections)
            directories.push(reportAgentDefinitionDirectory("project", dir, inspection));
    const projectLoaded = scope === "user" ? [] : [...projectScanDirs.dirs, ...projectAgentDirs].filter((dir) => !isExcluded(dir)).map((dir, discoveryPriority) => {
        const inspection = projectInspections.get(dir) ?? inspectAgentDefinitionDirectory(dir, undefined, isExcluded);
        if (!projectInspections.has(dir))
            directories.push(reportAgentDefinitionDirectory("project", dir, inspection));
        return loadAgentsFromDir(dir, "project", dir === projectAgentsDir ? 1 : discoveryPriority, undefined, inspection);
    });
    const projectAgents = applyCustomAgentOverrides(applyDefaults(projectLoaded.flatMap((loaded) => loaded.agents)), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const packageLoaded = packageSubagentPaths.agents.filter((entry) => !isExcluded(entry.dir)).map((entry, index) => {
        const inspection = inspectAgentDefinitionDirectory(entry.dir, undefined, isExcluded);
        directories.push(reportAgentDefinitionDirectory("package", entry.dir, inspection));
        return loadAgentsFromDir(entry.dir, "package", packageSubagentPaths.agents.length - index, entry, inspection);
    });
    const packageMap = new Map();
    for (const loaded of packageLoaded)
        for (const agent of loaded.agents)
            if (!packageMap.has(agent.name))
                packageMap.set(agent.name, agent);
    const packageAgents = applyCustomAgentOverrides(applyDefaults(Array.from(packageMap.values())), userSettings, projectSettings, userSettingsPath, projectSettingsPath);
    const agents = applySubagentMaxThinking(mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents, packageAgents).filter((agent) => agent.disabled !== true), maxThinking);
    const agentDiagnostics = [...builtinLoaded.diagnostics, ...userLoaded.flatMap((loaded) => loaded.diagnostics), ...projectLoaded.flatMap((loaded) => loaded.diagnostics), ...packageLoaded.flatMap((loaded) => loaded.diagnostics)];
    return { agents, agentDiagnostics, projectAgentsDir, cwd: effectiveCwd, scope, directories, ...(modelScope !== undefined ? { modelScope } : {}), ...(maxThinking !== undefined ? { maxThinking } : {}) };
}
export function discoverAgents(cwd, scope, preferredModelProvider) {
    if (scope !== "both")
        return discoverAgentsUncached(cwd, scope, preferredModelProvider);
    const sources = getAgentDiscoverySources(cwd, preferredModelProvider);
    return buildEffectiveDiscovery(sources, scope);
}
export function discoverAgentsAll(cwd, preferredModelProvider) {
    return discoverAgentSnapshot(cwd, "both", preferredModelProvider).all;
}
//# sourceMappingURL=agents.js.map