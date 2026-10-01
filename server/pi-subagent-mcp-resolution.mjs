// Native MCP selector resolution for the version-reviewed pi-subagents seam.
// Uses the names actually registered by Pi, not adapter metadata/cache/naming.
import { createHash } from 'node:crypto';
import { loadNativeMcpConfig } from './pi-native-mcp.mjs';
import { getAgentDir, SettingsManager, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
const SNAPSHOT_ENV = 'PIVANE_NATIVE_MCP_TOOL_SNAPSHOT';
const MAX_BYTES = 16 * 1024;
export function configHash(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
export function readNativeSnapshot() {
    try {
        const text = process.env[SNAPSHOT_ENV];
        if (!text || Buffer.byteLength(text) > MAX_BYTES) return [];
        const data = JSON.parse(text);
        if (data.version !== 1 || !Array.isArray(data.tools) || data.tools.length > 1024) return [];
        return data.tools.filter(item => item && typeof item.server === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.name)
            && typeof item.raw === 'string' && item.raw.length <= 500 && typeof item.cwd === 'string' && /^[a-f0-9]{64}$/.test(item.hash));
    } catch { return []; }
}
export function recordNativeMcpTools(factory) {
    return host => {
        const observed = new Map(); let entries = [], sessionCwd;
        const publish = () => {
            const tools = [...observed.values()].flatMap(item => {
                const entry = entries.find(entry => entry.name === item.server && entry.config.enabled !== false);
                return entry && item.exposure !== 'hidden' ? [{ ...item, cwd: sessionCwd, hash: configHash(entry.config) }] : [];
            });
            const value = JSON.stringify({ version: 1, tools });
            if (Buffer.byteLength(value) <= MAX_BYTES && tools.length <= 1024) process.env[SNAPSHOT_ENV] = value;
            else delete process.env[SNAPSHOT_ENV]; // fail closed rather than silently grant an incomplete catalog
        };
        const wrapped = new Proxy(host, { get(target, property) {
            if (property === 'registerTool') return definition => {
                const namespace = definition.namespace?.name;
                if (namespace?.startsWith('mcp__') && definition.label?.startsWith(namespace.slice(5) + '/')) {
                    observed.set(definition.name, { server: namespace.slice(5), raw: definition.label.slice(namespace.length - 5 + 1),
                        name: definition.name, exposure: definition.exposure });
                    publish();
                }
                return target.registerTool(definition);
            };
            const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        factory(wrapped);
        host.on('session_start', (_event, ctx) => {
            sessionCwd = ctx.cwd;
            entries = loadNativeMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }).servers;
            publish();
        });
        host.on('session_shutdown', () => { observed.clear(); delete process.env[SNAPSHOT_ENV]; });
    };
}
export function resolveMcpDirectToolResolution(selectors = [], cwd = process.cwd()) {
    const unique = [...new Set(selectors.map(item => item.replace(/\/+$/, '')).filter(Boolean))];
    if (!unique.length) return { selections: [], unresolvedSelectors: [] };
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const trusted = new ProjectTrustStore(agentDir).get(cwd) ?? (settings.getDefaultProjectTrust() === 'always');
    const config = loadNativeMcpConfig({ cwd, agentDir, projectTrusted: trusted });
    const valid = readNativeSnapshot().filter(item => {
        const entry = config.servers.find(entry => entry.name === item.server);
        return item.cwd === cwd && entry && entry.config.enabled !== false && configHash(entry.config) === item.hash;
    });
    const selections = valid.filter(item => unique.includes(item.server) || unique.includes(`${item.server}/${item.raw}`))
        .map(item => ({ name: item.name, selector: `${item.server}/${item.raw}` }));
    return { selections, unresolvedSelectors: unique.filter(selector => !selections.some(item => selector.includes('/')
        ? item.selector === selector : item.selector.startsWith(selector + '/'))) };
}
export function resolveMcpDirectToolSelections(...args) { return resolveMcpDirectToolResolution(...args).selections; }
export function resolveMcpDirectToolNames(...args) { return resolveMcpDirectToolSelections(...args).map(item => item.name); }
export function formatUnresolvedMcpDirectToolSelectors(selectors) {
    return `Unresolved native MCP tool selectors: ${selectors.join(', ')}. Connect the server in the parent session first; verify project trust, current mcp.json, tool exposure and the exact server/tool selector. Runtime-only server registrations cannot be handed to a child.`;
}
