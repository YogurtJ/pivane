const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeFile, read, json, atomic, fail } = require('./pi-native-service');
const { packageIdentity } = require('./pi-default-capabilities-installer');
const definition = require('./pi-default-capabilities').find(entry => entry.id === 'subagents');
const roleName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && !['constructor', 'prototype', '__proto__'].includes(name);
const fields = value => ({ model: typeof value?.model === 'string' ? value.model : null,
    thinking: value?.thinking === false ? 'off' : typeof value?.thinking === 'string' ? value.thinking : null });
class PiSubagentSettingsService {
    constructor(native, resources, settings) { this.native = native; this.resources = resources; this.settings = settings; }
    async context(cwd) {
        const ctx = await this.resources.context(cwd, 'project');
        const packages = ctx.manager.listConfiguredPackages().filter(item => packageIdentity(item, definition.name));
        const installed = packages.filter(item => item.installedPath);
        const manifests = installed.map(item => ({ item, manifest: json(read(safeFile(item.installedPath, ['package.json']))) }));
        const versions = manifests.map(item => item.manifest.version);
        const enabled = ctx.resources.some(item => item.type === 'extensions' && item.enabled && installed.some(pkg => item.metadata.source === pkg.source));
        const status = !installed.length ? 'missing' : versions.some(version => version !== definition.version) ? 'unsupported' : !enabled ? 'disabled' : 'ready';
        const revision = createHash('sha256').update(JSON.stringify([ctx.revision, packages, versions, enabled])).digest('hex');
        return { ...ctx, packages, manifests, status, revision, nativeRevision: ctx.revision };
    }
    async snapshot(cwd) {
        const ctx = await this.context(cwd);
        const project = ctx.project.subagents || {}, global = ctx.global.subagents || {};
        const names = new Set([...Object.keys(global.agentOverrides || {}), ...Object.keys(project.agentOverrides || {})].filter(roleName));
        // This is a settings inventory, not the plugin's live runtime discovery.
        for (const { item } of (ctx.status === 'ready' ? ctx.manifests : [])) {
            const directory = safeFile(item.installedPath, ['agents', '.inventory']);
            try {
                for (const entry of fs.readdirSync(path.dirname(directory), { withFileTypes: true })) {
                    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
                    const source = read(safeFile(item.installedPath, ['agents', entry.name]));
                    const { frontmatter } = ctx.sdk.parseFrontmatter(source);
                    if (roleName(frontmatter.name) && !frontmatter.runner) names.add(frontmatter.name);
                }
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (names.size > 200) throw fail('子 Agent 角色过多，请使用插件管理');
        return { version: 1, cwd: ctx.cwd, revision: ctx.revision, trust: ctx.trust,
            plugin: { name: definition.name, version: definition.version, status: ctx.status,
                installedVersions: ctx.manifests.map(item => item.manifest.version),
                canInstall: ctx.status === 'missing' && ctx.packages.every(item => item.scope === 'user' && item.source === definition.source) },
            defaults: { global: fields({ model: global.defaultModel, thinking: global.defaultThinking }), project: fields({ model: project.defaultModel, thinking: project.defaultThinking }) },
            roles: [...names].sort().map(name => ({ name, global: fields(global.agentOverrides?.[name]), project: fields(project.agentOverrides?.[name]) })) };
    }
    async install(input) {
        if (!input || Object.keys(input).some(key => !['cwd', 'expectedRevision', 'confirmed'].includes(key)) || input.confirmed !== true) throw fail('请确认安装子 Agent 插件');
        return this.native.mutate({ cwd: input.cwd, expectedRevision: (await this.native.context(input.cwd)).revision }, async () => {
            const ctx = await this.context(input.cwd);
            if (ctx.revision !== input.expectedRevision) throw fail('配置已变化，请刷新', 409);
            if (ctx.status !== 'missing' || ctx.packages.some(item => item.scope !== 'user' || item.source !== definition.source)) throw fail('已有插件配置，请通过 Packages 管理');
            try { await ctx.manager.installAndPersist(definition.source, { local: false }); }
            catch { throw fail('子 Agent 插件安装未完成，请刷新核对安装状态后再操作'); }
            return { ok: true, requiresRuntimeRestart: true };
        });
    }
    async save(input) {
        if (!input || Object.keys(input).some(key => !['cwd', 'scope', 'expectedRevision', 'changes'].includes(key)) || !['global', 'project'].includes(input.scope)
            || !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || Object.keys(input.changes).length > 402) throw fail('子 Agent 设置参数无效');
        // Reserve the same lock used by native settings, packages and credentials before model lookup.
        return this.native.mutate({ cwd: input.cwd, expectedRevision: (await this.native.context(input.cwd)).revision }, async () => {
            const ctx = await this.context(input.cwd);
            if (ctx.revision !== input.expectedRevision) throw fail('配置已变化，请刷新后再保存', 409);
            if (ctx.status !== 'ready') throw fail('请先安装并启用受支持的 pi-subagents 插件');
            if (input.scope === 'project' && !ctx.trust.effective) throw fail('请先信任项目');
            const catalog = await this.settings.getModelSnapshot();
            const models = catalog.models.filter(model => model.available);
            const thinking = new Set(models.flatMap(model => model.thinkingLevels || []));
            for (const [key, value] of Object.entries(input.changes)) {
                const parts = key.split('.');
                if (!(parts.length === 1 && ['defaultModel', 'defaultThinking'].includes(key))
                    && !(parts.length === 3 && parts[0] === 'agentOverrides' && roleName(parts[1]) && ['model', 'thinking'].includes(parts[2]))) throw fail('不支持此子 Agent 设置');
                if (value === null) continue;
                if (typeof value !== 'string' || value.length > 500) throw fail('子 Agent 设置值无效');
                const isModel = key === 'defaultModel' || parts[2] === 'model';
                if (isModel ? !(value === 'inherit' && parts[2] === 'model') && !models.some(model => `${model.provider}/${model.id}` === value) : !thinking.has(value)) throw fail('请选择可用模型与思考等级');
            }
            const fresh = await this.context(input.cwd);
            if (fresh.revision !== input.expectedRevision) throw fail('配置已变化，请刷新后再保存', 409);
            const file = input.scope === 'global' ? safeFile(ctx.agentDir, ['settings.json'], true) : safeFile(ctx.cwd, ['.pi', 'settings.json'], true);
            const lock = file + '.lock';
            try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw fail('原生设置正在写入，请稍后再试', 409); }
            try {
                // Recheck under the filesystem lock before touching the canonical settings file.
                const currentRevision = createHash('sha256').update(JSON.stringify([ctx.cwd,
                    read(ctx.globalFile), read(ctx.projectFile), read(ctx.trustFile), process.env.PI_WEB_APPROVE_PROJECTS || ''])).digest('hex');
                if (currentRevision !== ctx.nativeRevision) throw fail('配置已变化，请刷新', 409);
                const data = json(read(file));
                if (data.subagents !== undefined && (!data.subagents || typeof data.subagents !== 'object' || Array.isArray(data.subagents))) throw fail('子 Agent 配置格式无效，请先修复原配置');
                data.subagents ||= {};
                for (const [key, value] of Object.entries(input.changes)) {
                    const parts = key.split('.'); let target = data.subagents;
                    for (const part of parts.slice(0, -1)) {
                        if (!Object.hasOwn(target, part) || !target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
                        target = target[part];
                    }
                    if (value === null) delete target[parts.at(-1)]; else target[parts.at(-1)] = value;
                }
                atomic(file, JSON.stringify(data, null, 2) + '\n');
            } finally { fs.rmdirSync(lock); }
            return { ok: true, requiresRuntimeRestart: true };
        });
    }
}
module.exports = { PiSubagentSettingsService };
