// Pi 1.0.0 SDK boundary: the official extensions own transports, OAuth,
// discovery, tool execution and shutdown. No adapter protocol is reimplemented.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { recordNativeMcpTools, readNativeSnapshot, configHash } from './pi-subagent-mcp-resolution.mjs';
import * as sdk from '@earendil-works/pi-coding-agent';
import { captureNativeMcpControl } from './pi-native-mcp-control.mjs';
import { wrapCodemodeExtension } from './pi-codemode-policy.mjs';
const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
// Version-reviewed config/name helpers are not exported by the root SDK.
const configApi = await import(pathToFileURL(path.join(piRoot, 'dist/extensions/mcp/config.js')).href);
const toolsApi = await import(pathToFileURL(path.join(piRoot, 'dist/extensions/mcp/tools.js')).href);
const serversApi = await import(pathToFileURL(path.join(piRoot, 'dist/core/mcp-servers.js')).href);
export const loadNativeMcpConfig = configApi.loadMcpConfig;
export const nativeMcpNamespace = serversApi.mcpNamespace;
export const nativeMcpToolName = toolsApi.createMcpToolName;
export const nativeBuiltins = ['llama.cpp', 'codemode', 'tool-search', 'mcp'];
export async function nativeExtensionFactories() {
    const { builtInExtensions } = await import(pathToFileURL(path.join(piRoot, 'dist/extensions/index.js')).href);
    return builtInExtensions.map(entry => entry.name === 'mcp' ? { ...entry, factory: recordNativeMcpTools(captureNativeMcpControl(entry.factory)) }
        : entry.name === 'codemode' ? { ...entry, factory: wrapCodemodeExtension(entry.factory) } : entry);
}
export function selectedNativeBuiltins(settings, parsed = {}) {
    const global = settings.getGlobalSettings().extensions || [];
    const project = settings.getProjectSettings().extensions || [];
    return nativeBuiltins.filter(name => {
        const id = `builtin:${name}`;
        if (parsed.extensions?.includes(id)) return true;
        if (parsed.noExtensions) return false;
        const last = [...global, ...project].filter(item => typeof item === 'string' && item.replace(/^[!+-]/, '') === id).at(-1);
        return !last || !/^[!-]/.test(last);
    }).map(name => `builtin:${name}`);
}
export function childNativeExtensions({ cwd, agentDir, settings, allowedTools, excludeTools = [], ambientExtensions = false, denyExtensions = false, captureApi }) {
    const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
    const excluded = new Set(excludeTools);
    const permits = name => (!allowed || allowed.has(name)) && !excluded.has(name);
    // Explicit child allowlists are enforced for nested calls too. Pi's exposure
    // 'codemode' deliberately remains callable even when not in the active set.
    const gate = pi => {
        captureApi?.(pi);
        pi.on('tool_call', event => permits(event.toolName) ? undefined : { block: true, reason: 'Tool is outside this child\'s authorized tool allowlist.' });
    };
    const factories = [{ name: 'pivane-child-tools', factory: gate }];
    if (!denyExtensions && (ambientExtensions || allowed?.has('codemode')) && permits('codemode')) factories.push({ name: 'codemode', builtin: true, factory: wrapCodemodeExtension(sdk.createCodemodeExtension()) });
    if (!denyExtensions && (ambientExtensions || allowed?.has('tool_search')) && permits('tool_search')) factories.push({ name: 'tool-search', builtin: true, factory: sdk.createToolSearchExtension() });
    const needsMcp = !denyExtensions && (allowed === undefined ? ambientExtensions : [...allowed].some(name => name.startsWith('mcp__') || ['codemode', 'tool_search', 'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates'].includes(name)));
    if (needsMcp) factories.push({ name: 'mcp', builtin: true, factory: sdk.createMcpExtension({
        loadConfig: ctx => {
            const loaded = loadNativeMcpConfig({ cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
            if (allowed === undefined) return loaded;
            return { ...loaded, autoEnableCodemode: permits('codemode'), servers: loaded.servers.flatMap(entry => {
                const tools = readNativeSnapshot().filter(item => item.cwd === cwd && item.server === entry.name && item.hash === configHash(entry.config) && allowed.has(item.name) && permits(item.name));
                if (!tools.length) return [];
                // Use exact raw names, including names shortened/hashed by Pi.
                const toolExposure = Object.fromEntries(tools.map(item => [item.raw, 'direct']));
                return [{ ...entry, config: { ...entry.config, exposure: 'hidden', toolExposure } }];
            }) };
        },
    }) });
    return factories;
}
