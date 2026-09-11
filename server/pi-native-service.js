const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const schema = {
    defaultTools: { label: '默认启用的内置工具', type: 'tools' },
    defaultProjectTrust: { label: '未决项目的默认信任策略', type: 'select', choices: ['ask', 'always', 'never'], globalOnly: true },
    steeringMode: { label: '引导消息投递', type: 'select', choices: ['one-at-a-time', 'all'] },
    followUpMode: { label: '后续消息投递', type: 'select', choices: ['one-at-a-time', 'all'] },
    transport: { label: '模型连接方式', type: 'select', choices: ['auto', 'sse', 'websocket', 'websocket-cached'] },
    'compaction.enabled': { label: '自动压缩', type: 'boolean' },
    'compaction.reserveTokens': { label: '压缩预留 Token', type: 'number', min: 1024, max: 1000000 },
    'compaction.keepRecentTokens': { label: '保留近期 Token', type: 'number', min: 1024, max: 1000000 },
    'retry.enabled': { label: '自动重试', type: 'boolean' },
    'retry.maxRetries': { label: 'Agent 最大重试次数', type: 'number', min: 0, max: 20 },
    'retry.baseDelayMs': { label: '重试基础等待（毫秒）', type: 'number', min: 100, max: 600000 },
    'retry.provider.timeoutMs': { label: 'Provider 请求超时（毫秒）', type: 'number', min: 1000, max: 3600000 },
    'retry.provider.maxRetryDelayMs': { label: 'Provider 最大等待（毫秒，0 不限制）', type: 'number', min: 0, max: 3600000 },
    httpIdleTimeoutMs: { label: '流空闲超时（毫秒，0 不限制）', type: 'number', min: 0, max: 3600000 },
    websocketConnectTimeoutMs: { label: 'WebSocket 建连超时（毫秒，0 不限制）', type: 'number', min: 0, max: 600000 },
    'images.autoResize': { label: '自动缩放图片', type: 'boolean' },
    'images.blockImages': { label: '阻止图片发送给模型', type: 'boolean' },
    enabledModels: { label: '常用模型范围（每行一个模型或模式）', type: 'lines' },
    enableInstallTelemetry: { label: 'Pi 安装遥测与 Provider 归因', type: 'boolean', globalOnly: true }
};

function nativeSchema(sdk, cwd) {
    // Public factories only construct tools; no runtime, discovery or tool execution.
    const defaults = sdk.createCodingTools(cwd).map(tool => tool.name);
    const choices = [...new Set([...defaults, ...sdk.createReadOnlyTools(cwd).map(tool => tool.name), sdk.createPowerShellTool(cwd).name])];
    return { ...schema, defaultTools: { ...schema.defaultTools, choices, defaults, platform: process.platform } };
}

// All paths are selected by the server. Never offer an arbitrary settings-file editor.
function safeFile(base, parts, create = false) {
    if (!fs.existsSync(base)) { if (!create) return path.join(base, ...parts); fs.mkdirSync(base, { recursive: true, mode: 0o700 }); }
    let current = fs.realpathSync.native(base);
    for (let index = 0; index < parts.length - 1; index++) {
        const part = parts[index];
        current = path.join(current, part);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!create) return path.join(current, ...parts.slice(index + 1));
            fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('配置目录不能是符号链接');
        if (create && process.platform === 'win32' && part === '.pi') privateFiles.privateDirectory(current);
    }
    const file = path.join(current, parts.at(-1));
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw fail('配置必须是普通文件'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return file;
}
function read(file) {
    let fd;
    try {
        fd = require('./pi-file-io').openReadSync(file);
        if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 1024 * 1024) throw fail('配置文件超过 1 MiB 或不是普通文件');
        const bytes = Buffer.alloc(1024 * 1024 + 1), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (size > 1024 * 1024) throw fail('配置文件过大');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(raw) {
    if (raw === null) return {};
    let data;
    try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw fail('配置 JSON 损坏，请先修复原文件'); }
    if (!data || Array.isArray(data) || typeof data !== 'object') throw fail('配置必须是 JSON 对象');
    return data;
}
function atomic(file, text) {
    const previous = read(file);
    if (previous !== null) privateFiles.writePrivateFileSync(`${file}.bak-web-${Date.now()}-${randomUUID()}`, previous);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { privateFiles.writePrivateFileSync(tmp, text); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
}
function patch(data, key, value) {
    const parts = key.split('.'); let target = data;
    for (const part of parts.slice(0, -1)) {
        if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
        target = target[part];
    }
    if (value === null) delete target[parts.at(-1)]; else target[parts.at(-1)] = value;
}
class PiNativeService {
    constructor(store) { this.store = store; this.busy = false; }
    async context(cwdInput) {
        const cwd = this.store.resolveProject(cwdInput);
        const sdk = await getSdk(); const agentDir = sdk.getAgentDir();
        const globalFile = safeFile(agentDir, ['settings.json']);
        const projectFile = safeFile(cwd, ['.pi', 'settings.json']);
        const trustFile = safeFile(agentDir, ['trust.json']);
        const raws = [read(globalFile), read(projectFile), read(trustFile)];
        const revision = createHash('sha256').update(JSON.stringify([cwd, ...raws, process.env.PI_WEB_APPROVE_PROJECTS || ''])).digest('hex');
        const global = json(raws[0]), project = json(raws[1]);
        const trustStore = new sdk.ProjectTrustStore(agentDir), entry = trustStore.getEntry(cwd);
        const override = process.env.PI_WEB_APPROVE_PROJECTS === 'true' ? true : process.env.PI_WEB_APPROVE_PROJECTS === 'false' ? false : null;
        const effective = override ?? entry?.decision ?? (global.defaultProjectTrust === 'always');
        const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: effective });
        if (settings.drainErrors().length) throw fail('无法读取原生设置');
        return { cwd, sdk, agentDir, globalFile, projectFile, trustFile, global, project, revision, trustStore, settings,
            trust: { decision: entry?.decision ?? null, savedPath: entry?.path || null, override, effective,
                defaultPolicy: settings.getDefaultProjectTrust(), requiresTrust: sdk.hasTrustRequiringProjectResources(cwd) } };
    }
    async snapshot(cwd) {
        const ctx = await this.context(cwd), s = ctx.settings, fields = nativeSchema(ctx.sdk, ctx.cwd);
        const values = {
            defaultTools: s.getDefaultTools() ?? fields.defaultTools.defaults,
            defaultProjectTrust: s.getDefaultProjectTrust(),
            steeringMode: s.getSteeringMode(), followUpMode: s.getFollowUpMode(), transport: s.getTransport(),
            ...Object.fromEntries(Object.entries(s.getCompactionSettings()).map(([k, v]) => ['compaction.' + k, v])),
            ...Object.fromEntries(Object.entries(s.getRetrySettings()).map(([k, v]) => ['retry.' + k, v])),
            ...Object.fromEntries(Object.entries(s.getProviderRetrySettings()).map(([k, v]) => ['retry.provider.' + k, v])),
            httpIdleTimeoutMs: s.getHttpIdleTimeoutMs(), websocketConnectTimeoutMs: s.getWebSocketConnectTimeoutMs(),
            'images.autoResize': s.getImageAutoResize(), 'images.blockImages': s.getBlockImages(),
            enabledModels: s.getEnabledModels() || [], enableInstallTelemetry: s.getEnableInstallTelemetry()
        };
        return { cwd: ctx.cwd, revision: ctx.revision, trust: ctx.trust, schema: fields,
            settings: Object.fromEntries(Object.keys(schema).map(key => [key, { value: values[key] ?? null,
                global: get(ctx.global, key) ?? null, project: get(ctx.project, key) ?? null,
                source: ctx.trust.effective && get(ctx.project, key) !== undefined && !schema[key].globalOnly ? 'project' : get(ctx.global, key) !== undefined ? 'global' : 'default' }])),
            environment: { telemetry: process.env.PI_TELEMETRY === undefined ? null : !['0', 'false', 'no'].includes(process.env.PI_TELEMETRY.toLowerCase()), offline: ['1', 'true'].includes(process.env.PI_OFFLINE), versionCheckDisabled: true } };
    }
    async mutate(input, action) {
        if (this.busy) throw fail('配置正在保存，请稍后再试', 409);
        this.busy = true;
        try { const ctx = await this.context(input.cwd); if (ctx.revision !== input.expectedRevision) throw fail('配置已变化，请刷新后再保存', 409); return await action(ctx); }
        finally { this.busy = false; }
    }
    async saveTrust(input) {
        if (![true, false, null].includes(input.decision) || input.confirmed !== true) throw fail('请明确确认项目信任决定');
        return this.mutate(input, ctx => {
            safeFile(ctx.agentDir, ['trust.json'], true);
            ctx.trustStore.set(ctx.cwd, input.decision);
            privateFiles.privateFileMode(ctx.trustFile);
            return { ok: true, requiresRuntimeRestart: true };
        });
    }
    async saveSettings(input) {
        if (!['global', 'project'].includes(input.scope) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw fail('设置范围或内容无效');
        const fields = nativeSchema(await getSdk(), this.store.resolveProject(input.cwd));
        for (const [key, value] of Object.entries(input.values)) {
            const field = fields[key];
            if (!field || !own(schema, key) || input.scope === 'project' && field.globalOnly) throw fail('不支持此设置');
            if (value === null) continue;
            if (field.type === 'boolean' && typeof value !== 'boolean' || field.type === 'select' && !field.choices.includes(value)
                || field.type === 'number' && (!Number.isInteger(value) || value < field.min || value > field.max)
                || field.type === 'tools' && (!Array.isArray(value) || value.length > field.choices.length || new Set(value).size !== value.length || value.some(v => !field.choices.includes(v)))
                || field.type === 'lines' && (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 500 || /[\x00-\x1f]/.test(v)))) throw fail('设置值无效：' + field.label);
        }
        return this.mutate(input, async ctx => {
            if (input.scope === 'project' && !ctx.trust.effective) throw fail('请先信任项目，再保存项目设置');
            const file = input.scope === 'global' ? safeFile(ctx.agentDir, ['settings.json'], true) : safeFile(ctx.cwd, ['.pi', 'settings.json'], true);
            // Cooperate with native proper-lockfile's settings.json.lock directory; no await while held.
            const lock = file + '.lock';
            try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw fail('原生设置正在写入，请稍后再试', 409); }
            try {
                const data = json(read(file));
                for (const [key, value] of Object.entries(input.values)) patch(data, key, value);
                atomic(file, JSON.stringify(data, null, 2) + '\n');
            } finally { fs.rmdirSync(lock); }
            return { ok: true, requiresRuntimeRestart: true };
        });
    }
}
module.exports = { PiNativeService, schema, nativeSchema, safeFile, read, json, atomic, fail };
