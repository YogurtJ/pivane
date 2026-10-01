#!/usr/bin/env node
'use strict';
// Explicit stopped-maintenance migration. Normal installation never calls it.
// Preserves user/CLI files except the selected MCP config and adapter declaration.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const privateFiles = require('../server/pi-private-files');
const { readSafe } = require('../server/pi-maintenance-files');
const { obsoleteMcpAdapter } = require('../server/pi-bundled-resources');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function read(file, optional = false) {
    if (optional && !fs.existsSync(file)) return { bytes: null, value: {} };
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(file) !== path.resolve(file) || stat.size > 1024 * 1024) throw new Error('Migration requires bounded regular config files without symlinks');
    const bytes = readSafe(file, 1024 * 1024); const value = JSON.parse(bytes.toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid configuration object');
    return { bytes, value };
}
function bearerHeader(value) {
    if (value.startsWith('!') && !value.startsWith('!!')) {
        if (process.platform === 'win32') throw new Error('Command-backed bearer migration requires an explicitly reviewed Windows header command');
        // Keep the credential command unevaluated. Native commands must emit
        // the entire header, not only its token. A failed/empty command fails.
        return `!token=$(${value.slice(1)}) && [ -n "$token" ] && printf 'Bearer %s' "$token"`;
    }
    const template = value.startsWith('!!') ? value.slice(1) : value;
    // Old adapter references are ${NAME}, $env:NAME and {env:NAME}; native
    // additionally interprets $NAME, so escape other dollars as literals.
    return 'Bearer ' + template.replace(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}|\$/g,
        (_match, a, b, c) => a || b || c ? '${' + (a || b || c) + '}' : '$$');
}
function convert(config, defaults = {}) {
    for (const source of [config, defaults]) {
        if (source.imports?.length || source.settings?.agentPluginPaths || source.settings?.claudePluginPaths) throw new Error('Imported/plugin MCP definitions need an explicit reviewed conversion');
    }
    const servers = { ...(defaults.mcpServers || {}), ...(config.mcpServers || {}) };
    const result = structuredClone(config); result.mcpServers = {};
    for (const [name, local] of Object.entries(servers)) {
        const server = { ...(defaults.mcpServers?.[name] || {}), ...local };
        if (server.socket || server.type === 'sse' || server.requestHeadersCommand || server.includeTools?.length || server.excludeTools?.length || server.toolPrefix || server.bearerTokenEnv) throw new Error('Unsupported legacy MCP transport/auth/filter; explicit review required (no config written)');
        if (!server.command && !server.url) throw new Error('MCP entry has no transport; supply reviewed legacy defaults');
        if (server.bearerToken !== undefined) {
            if (typeof server.bearerToken !== 'string' || Object.keys(server.headers || {}).some(key => key.toLowerCase() === 'authorization')) throw new Error('Ambiguous MCP bearer authentication');
            server.headers = { ...server.headers, Authorization: bearerHeader(server.bearerToken) };
            delete server.bearerToken;
        }
        if (server.auth && !['bearer', 'none', 'oauth'].includes(server.auth)) throw new Error('Unsupported MCP authentication');
        if (server.requestTimeoutMs !== undefined) {
            if (!Number.isFinite(server.requestTimeoutMs) || server.requestTimeoutMs <= 0) throw new Error('Invalid legacy MCP timeout');
            server.timeout ??= server.requestTimeoutMs / 1000;
        }
        // Native MCP has no lazy/idle lifecycle; connections are session-owned.
        for (const key of ['auth', 'lifecycle', 'idleTimeout', 'requestTimeoutMs']) delete server[key];
        server.exposure ??= 'codemode'; result.mcpServers[name] = server;
    }
    return result;
}
async function migrate({ agentDir, defaultsFile, apply = false }) {
    agentDir = fs.realpathSync.native(agentDir);
    const configFile = path.join(agentDir, 'mcp.json'), settingsFile = path.join(agentDir, 'settings.json');
    const lock = path.join(agentDir, '.pivane-native-mcp-migration.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    try {
        const config = read(configFile), settings = read(settingsFile, true), defaults = defaultsFile ? read(path.resolve(defaultsFile)).value : {};
        const next = convert(config.value, defaults);
        const piRoot = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent');
        // Validate through the exact pinned native schema before any write.
        const { validateMcpServerConfig } = await import(require('node:url').pathToFileURL(path.join(piRoot, 'dist/core/mcp-servers.js')).href);
        for (const [name, server] of Object.entries(next.mcpServers)) if (typeof validateMcpServerConfig(name, server) === 'string') throw new Error('Converted MCP definition is not valid for pinned Pi');
        const nextSettings = { ...settings.value, packages: (settings.value.packages || []).filter(item => !obsoleteMcpAdapter(typeof item === 'string' ? item : item.source, agentDir)),
            extensions: (settings.value.extensions || []).filter(item => !obsoleteMcpAdapter(item.replace(/^[!+-]/, ''), agentDir)) };
        const rows = [{ file: configFile, before: config.bytes, after: Buffer.from(JSON.stringify(next, null, 2) + '\n') },
            { file: settingsFile, before: settings.bytes, after: Buffer.from(JSON.stringify(nextSettings, null, 2) + '\n') }];
        // Preflight every target before the first replacement; partial filesystem
        // failures remain explicit and are never automatically replayed.
        for (const row of rows) {
            const now = read(row.file, true).bytes;
            if (Boolean(now) !== Boolean(row.before) || now && digest(now) !== digest(row.before)) throw new Error('Configuration changed before migration');
        }
        const changes = rows.filter(row => !row.before || !row.before.equals(row.after));
        const receipt = { version: 1, servers: Object.keys(next.mcpServers), removedAdapterDeclarations: (settings.value.packages || []).length - nextSettings.packages.length,
            changed: changes.map(row => path.basename(row.file)), applied: false };
        if (!apply || !changes.length) return receipt;
        const backup = privateFiles.privateDirectory(path.join(agentDir, '.pivane-migrations', 'native-mcp-' + randomUUID()));
        for (const row of changes) if (row.before) privateFiles.writePrivateFileSync(path.join(backup, path.basename(row.file)), row.before, true);
        for (const row of changes) {
            const now = read(row.file, true).bytes;
            if (Boolean(now) !== Boolean(row.before) || now && digest(now) !== digest(row.before)) throw new Error('Configuration changed; no replay. Review migration backup.');
            const temporary = row.file + '.native-mcp-' + randomUUID();
            try { privateFiles.writePrivateFileSync(temporary, row.after, true); fs.renameSync(temporary, row.file); privateFiles.privateFileMode(row.file); }
            finally { fs.rmSync(temporary, { force: true }); }
        }
        if (process.platform !== 'win32') {
            const fd = fs.openSync(agentDir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        const output = { ...receipt, applied: true, backup };
        privateFiles.writePrivateFileSync(path.join(backup, 'receipt.json'), JSON.stringify(output, null, 2) + '\n', true);
        return output;
    } finally { fs.rmdirSync(lock); }
}
module.exports = { convert, migrate };
if (require.main === module) (async () => {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--agent-dir') options.agentDir = args[++i];
        else if (args[i] === '--legacy-defaults') options.defaultsFile = args[++i];
        else if (args[i] === '--apply') options.apply = true;
        else throw new Error('Usage: migrate-native-mcp.cjs --agent-dir PATH [--legacy-defaults FILE] [--apply]');
    }
    if (!options.agentDir || !path.isAbsolute(options.agentDir)) throw new Error('An explicit absolute agent directory is required');
    console.log(JSON.stringify(await migrate(options)));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
