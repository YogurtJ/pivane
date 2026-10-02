// Saved configuration only: this module never constructs a connection or evaluates references.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { safeFile } = require('./pi-native-service');
const privateFiles = require('./pi-private-files');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { getSdk } = require('./pi-session-store');
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const httpConfig = config => typeof config.url === 'string' && [undefined, 'http', 'streamable-http'].includes(config.type);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, statusCode: status });
const controlKeys = new Set(['type', 'enabled', 'exposure', 'timeout', 'toolExposure', 'description']);
const privateKeys = new Set(['command', 'args', 'cwd', 'url', 'env', 'headers', 'oauth']);
const oauthKeys = new Set(['clientId', 'clientSecret', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl']);
let native;
async function nativeApi() {
    if (!native) {
        const root = path.resolve(path.dirname(require('node:url').fileURLToPath((await import('./pi-native-mcp-control.mjs')).nativePiEntry())), '..');
        native = import(pathToFileURL(path.join(root, 'dist/core/mcp-servers.js')).href);
    }
    return native;
}
// Match native loading order without evaluating references or opening transports.
function namespaceConflicts(data, validate, namespace, projectTrusted) {
    const selected = new Map(), conflicts = new Set();
    for (const index of projectTrusted ? [0, 1] : [0]) {
        for (const [name, value] of Object.entries(data[index].mcpServers || {})) {
            const config = validate(name, value);
            if (typeof config === 'string') continue;
            if ([...selected.keys()].some(other => other !== name && namespace(other) === namespace(name))) {
                conflicts.add(`${index}:${name}`); continue;
            }
            if (index === 1 && 'url' in config && config.auth) continue;
            selected.set(name, config);
        }
    }
    return conflicts;
}
function read(file) {
    let fd;
    try {
        fd = io.openReadSync(file);
        const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!before.isFile() || before.size > 1048576n || descriptorPathSync(fd) !== file) throw fail('MCP_UNSAFE_FILE');
        const bytes = Buffer.alloc(1048577), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(fd, { bigint: true }), atPath = fs.statSync(file, { bigint: true });
        if (size > 1048576 || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(k => before[k] !== after[k] || after[k] !== atPath[k]) || !io.sameIdentityAtPath(file, identity)) throw fail('MCP_CHANGED', 409);
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    } catch (error) { if (error.code === 'ENOENT' && fd === undefined) return null; if (error.statusCode) throw error; throw fail('MCP_READ_FAILED'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parse(raw) {
    if (raw === null) return {};
    try { const data = JSON.parse(raw); if (!record(data)) throw 0; return data; } catch { throw fail('MCP_INVALID_JSON'); }
}
function shape(data) {
    if (data.mcpServers !== undefined && !record(data.mcpServers) || data.autoEnableCodemode !== undefined && typeof data.autoEnableCodemode !== 'boolean') throw fail('MCP_INVALID_CONFIG');
}
function editable(config) {
    const safe = {}, secretFields = {};
    for (const [key, value] of Object.entries(config)) {
        if (controlKeys.has(key)) safe[key] = value;
        else if (['env', 'headers', 'oauth', 'auth'].includes(key) && record(value)) {
            safe[key] = {};
            for (const [field, item] of Object.entries(value)) {
                if (key === 'oauth' && field === 'callbackPort' || key === 'auth' && field === 'provider') safe[key][field] = item;
                else { safe[key][field] = null; secretFields[`${key}.${field}`] = { present: true }; }
            }
        } else { safe[key] = null; secretFields[key] = { present: true }; }
    }
    return { config: safe, secretFields };
}
function secretEdit(target, key, operation) {
    if (!record(operation) || !['keep', 'replace', 'remove'].includes(operation.op) || Object.keys(operation).some(k => !['op', 'value'].includes(k))) throw fail('MCP_SECRET_OPERATION_REQUIRED');
    if (operation.op === 'keep') { if (!own(target, key) || own(operation, 'value')) throw fail('MCP_INVALID_KEEP'); }
    else if (operation.op === 'remove') { if (own(operation, 'value')) throw fail('MCP_INVALID_REMOVE'); delete target[key]; }
    else { if (!own(operation, 'value')) throw fail('MCP_REPLACEMENT_REQUIRED'); target[key] = operation.value; }
}
function applyConfig(previous, edits) {
    if (!record(edits)) throw fail('MCP_INVALID_EDIT');
    const result = structuredClone(previous);
    for (const [key, value] of Object.entries(edits)) {
        if (controlKeys.has(key)) { if (value === null) delete result[key]; else result[key] = value; }
        else if (key === 'auth') {
            if (value === null) delete result.auth;
            else {
                if (!record(value) || Object.keys(value).some(field => field !== 'provider')) throw fail('MCP_UNKNOWN_FIELD');
                if (!record(result.auth)) result.auth = {};
                if (value.provider === null) delete result.auth.provider;
                else if (own(value, 'provider')) result.auth.provider = value.provider;
                if (!Object.keys(result.auth).length) delete result.auth;
            }
        } else if (privateKeys.has(key)) {
            if (['env', 'headers', 'oauth'].includes(key) && record(value) && !own(value, 'op')) {
                if (!record(result[key])) result[key] = {};
                for (const [field, operation] of Object.entries(value)) {
                    if (['__proto__', 'constructor', 'prototype'].includes(field)) throw fail('MCP_INVALID_EDIT');
                    if (key === 'oauth' && field === 'callbackPort') { if (operation === null) delete result[key][field]; else result[key][field] = operation; }
                    else { if (key === 'oauth' && !oauthKeys.has(field)) throw fail('MCP_UNKNOWN_FIELD'); secretEdit(result[key], field, operation); }
                }
            } else secretEdit(result, key, value);
        } else throw fail('MCP_UNKNOWN_FIELD');
    }
    return result;
}
class PiMcpSettingsService {
    constructor(store, options = {}) { this.store = store; this.getSdk = options.getSdk || getSdk; this.native = options.nativeService; this.busy = false; }
    async context(cwdInput) {
        const cwd = this.store.resolveProject(cwdInput), sdk = await this.getSdk(), agentDir = sdk.getAgentDir();
        const files = [safeFile(agentDir, ['mcp.json']), safeFile(cwd, ['.pi', 'mcp.json']), safeFile(agentDir, ['settings.json']), safeFile(cwd, ['.pi', 'settings.json']), safeFile(agentDir, ['trust.json'])];
        const raws = files.map(read), data = raws.map(parse); shape(data[0]); shape(data[1]);
        const entry = new sdk.ProjectTrustStore(agentDir).getEntry(cwd);
        const override = process.env.PI_WEB_APPROVE_PROJECTS === 'true' ? true : process.env.PI_WEB_APPROVE_PROJECTS === 'false' ? false : null;
        const defaultPolicy = data[2].defaultProjectTrust || 'ask';
        const trust = { decision: entry?.decision ?? null, override, effective: override ?? entry?.decision ?? (defaultPolicy === 'always'), defaultPolicy };
        const revision = createHash('sha256').update(JSON.stringify([cwd, raws, trust])).digest('hex');
        return { cwd, agentDir, files, raws, data, trust, revision };
    }
    async snapshot(cwdInput, scope = 'global') {
        if (!['global', 'project'].includes(scope)) throw fail('MCP_INVALID_SCOPE');
        const ctx = await this.context(cwdInput), { validateMcpServerConfig: validate, mcpNamespace } = await nativeApi();
        const index = scope === 'global' ? 0 : 1;
        const conflicts = namespaceConflicts(ctx.data, validate, mcpNamespace, ctx.trust.effective || scope === 'project');
        const servers = Object.entries(ctx.data[index].mcpServers || {}).map(([name, config]) => {
            const valid = validate(name, config);
            if (conflicts.has(`${index}:${name}`)) return { name, scope, valid: false, transport: 'unknown', config: {}, secretFields: {}, error: 'MCP_NAMESPACE_CONFLICT' };
            if (typeof valid === 'string' || config.auth !== undefined && (scope !== 'global' || !httpConfig(valid))) return { name, scope, valid: false, transport: 'unknown', config: {}, secretFields: {}, error: 'MCP_INVALID_SERVER' };
            return { name, scope, valid: true, enabled: config.enabled !== false, exposure: valid.exposure || 'codemode', timeout: config.timeout ?? 60, transport: typeof config.url === 'string' && config.type !== 'stdio' ? 'http' : 'stdio', ...editable({ ...config, ...(valid.exposure ? { exposure: valid.exposure } : {}), ...(valid.toolExposure ? { toolExposure: valid.toolExposure } : {}) }) };
        });
        const global = ctx.data[0].autoEnableCodemode ?? null, project = ctx.data[1].autoEnableCodemode ?? null;
        return { cwd: ctx.cwd, scope, revision: ctx.revision, trust: ctx.trust, autoEnableCodemode: { global, project, value: (ctx.trust.effective ? project : null) ?? global ?? true }, servers, capabilities: { native: true, runtimeManagement: true } };
    }
    async save(input) {
        if (this.busy || this.native?.busy) throw fail('MCP_BUSY', 409);
        this.busy = true; // Reserve before the first await, including SDK loading.
        if (this.native) this.native.busy = true;
        try {
            if (!record(input) || Object.keys(input).some(key => !['cwd', 'scope', 'expectedRevision', 'confirmed', 'action', 'name', 'config', 'patch', 'autoEnableCodemode'].includes(key)) || input.confirmed !== true || !['global', 'project'].includes(input.scope) || !['upsert', 'remove', 'patch', 'preferences'].includes(input.action)) throw fail('MCP_CONFIRMATION_REQUIRED');
            const ctx = await this.context(input.cwd), { validateMcpServerConfig: validate, mcpNamespace } = await nativeApi();
            if (ctx.revision !== input.expectedRevision) throw fail('MCP_CHANGED', 409);
            if (input.scope === 'project' && !ctx.trust.effective) throw fail('MCP_PROJECT_UNTRUSTED', 403);
            const index = input.scope === 'global' ? 0 : 1, data = structuredClone(ctx.data[index]);
            if (input.action === 'preferences') {
                if (input.autoEnableCodemode === null) delete data.autoEnableCodemode;
                else if (typeof input.autoEnableCodemode === 'boolean') data.autoEnableCodemode = input.autoEnableCodemode;
                else throw fail('MCP_INVALID_PREFERENCE');
            } else {
                if (typeof input.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.name) || ['__proto__', 'constructor', 'prototype'].includes(input.name)) throw fail('MCP_INVALID_NAME');
                data.mcpServers ??= {};
                if (input.action === 'remove') delete data.mcpServers[input.name];
                else {
                    const previous = own(data.mcpServers, input.name) ? data.mcpServers[input.name] : {};
                    if (!record(previous) || input.action === 'patch' && !own(data.mcpServers, input.name)) throw fail('MCP_SERVER_NOT_FOUND');
                    const edits = input.action === 'patch' ? input.patch : input.config;
                    const next = applyConfig(previous, edits);
                    const valid = validate(input.name, next);
                    if (next.auth !== undefined && (input.scope !== 'global' || typeof valid === 'string' || !httpConfig(valid))) throw fail('MCP_INVALID_SERVER');
                    if (own(edits, 'description') && next.description !== undefined && (typeof next.description !== 'string' || next.description.length > 4096)) throw fail('MCP_INVALID_SERVER');
                    if (next.auth?.provider !== previous.auth?.provider && next.auth?.provider && Object.keys(next.headers || {}).some(key => key.toLowerCase() === 'authorization')) throw fail('MCP_AUTH_HEADER_CONFLICT');
                    if (typeof valid === 'string' || next.timeout !== undefined && !Number.isFinite(next.timeout)) throw fail('MCP_INVALID_SERVER');
                    data.mcpServers[input.name] = next;
                    const before = namespaceConflicts(ctx.data, validate, mcpNamespace, ctx.trust.effective);
                    const afterData = [...ctx.data]; afterData[index] = data;
                    const after = namespaceConflicts(afterData, validate, mcpNamespace, ctx.trust.effective);
                    if ([...after].some(name => !before.has(name))) throw fail('MCP_NAMESPACE_CONFLICT');
                }
            }
            const file = input.scope === 'global' ? safeFile(ctx.agentDir, ['mcp.json'], true) : safeFile(ctx.cwd, ['.pi', 'mcp.json'], true);
            const lock = file + '.lock';
            try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw fail('MCP_BUSY', 409); }
            const tmp = `${file}.${randomUUID()}.tmp`;
            try {
                // No await while locked. Recheck all revision inputs, not only the target file.
                if (ctx.files.some((name, i) => read(name) !== ctx.raws[i])) throw fail('MCP_CHANGED', 409);
                const text = JSON.stringify(data, null, 2) + '\n';
                if (Buffer.byteLength(text) > 1048576) throw fail('MCP_CONFIG_TOO_LARGE');
                const resolvedTarget = () => input.scope === 'global' ? safeFile(ctx.agentDir, ['mcp.json']) : safeFile(ctx.cwd, ['.pi', 'mcp.json']);
                if (resolvedTarget() !== file) throw fail('MCP_UNSAFE_FILE');
                privateFiles.writePrivateFileSync(tmp, text, true);
                if (ctx.files.some((name, i) => read(name) !== ctx.raws[i])) throw fail('MCP_CHANGED', 409);
                if (resolvedTarget() !== file) throw fail('MCP_UNSAFE_FILE');
                if (process.platform === 'win32') require('./pi-win32-native').replaceFileSync(tmp, file);
                else { fs.renameSync(tmp, file); const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
            } finally { try { fs.unlinkSync(tmp); } catch {} fs.rmdirSync(lock); }
            return { ok: true, requiresRuntimeRestart: true };
        } catch (error) { if (error.statusCode) throw error; throw fail('MCP_SAVE_FAILED'); }
        finally { this.busy = false; if (this.native) this.native.busy = false; }
    }
}
module.exports = { PiMcpSettingsService };
