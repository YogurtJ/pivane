const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeFile, read, atomic, fail } = require('./pi-native-service');
const TYPES = ['extensions', 'skills', 'prompts', 'themes'];
const hash = value => createHash('sha256').update(value).digest('hex');
const target = value => /^[!+-]/.test(value) ? value.slice(1) : value;
const sourceText = pkg => typeof pkg === 'string' ? pkg : pkg.source;
const local = source => path.isAbsolute(source) || source.startsWith('.') || source.startsWith('~');
const normalized = (source, base) => local(source) ? path.resolve(base, source.startsWith('~') ? require('node:os').homedir() + source.slice(1) : source) : source;
class PiResourceService {
    constructor(native) { this.native = native; }
    async context(cwd, scope) {
        if (!['global', 'project'].includes(scope)) throw fail('资源范围无效');
        const ctx = await this.native.context(cwd);
        const settings = ctx.sdk.SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: scope === 'project' && ctx.trust.effective });
        const manager = new ctx.sdk.DefaultPackageManager({ cwd: ctx.cwd, agentDir: ctx.agentDir, settingsManager: settings });
        const resolved = await manager.resolve(async () => 'skip');
        const resources = TYPES.flatMap(type => resolved[type].map(item => ({ ...item, type,
            id: hash(JSON.stringify([type, item.path, item.metadata.source, item.metadata.scope])) })));
        if (resources.length > 3000) throw fail('资源超过 3000 项，请在终端缩小配置范围');
        return { ...ctx, settings, manager, resources, scope };
    }
    packageMatch(ctx, source, fromScope, pkg, scope) {
        return normalized(source, fromScope === 'project' ? path.join(ctx.cwd, '.pi') : ctx.agentDir)
            === normalized(sourceText(pkg), scope === 'project' ? path.join(ctx.cwd, '.pi') : ctx.agentDir);
    }
    patterns(ctx, item, scope) {
        const config = scope === 'project' ? ctx.project : ctx.global;
        if (item.metadata.origin !== 'package') return config[item.type] || [];
        return config.packages?.find(p => this.packageMatch(ctx, item.metadata.source, item.metadata.scope, p, scope))?.[item.type] || [];
    }
    async snapshot(cwd, scope = 'project') {
        const ctx = await this.context(cwd, scope);
        return { cwd: ctx.cwd, scope, revision: ctx.revision, trust: ctx.trust,
            packages: ctx.manager.listConfiguredPackages().map(p => ({ source: p.source, scope: p.scope, installed: Boolean(p.installedPath), filtered: p.filtered })),
            resources: ctx.resources.map(item => {
                const pattern = item.metadata.origin === 'package' ? path.relative(item.metadata.baseDir, item.path) : item.path;
                const exact = this.patterns(ctx, item, scope).filter(p => target(p) === pattern || path.resolve(item.metadata.baseDir || ctx.agentDir, target(p)) === item.path).at(-1);
                return { id: item.id, type: item.type, path: item.path, enabled: item.enabled, source: item.metadata.source, scope: item.metadata.scope,
                    override: exact ? /^[!-]/.test(exact) ? 'off' : 'on' : 'inherit' };
            }), compatibility: '工具、命令与标准对话框使用原生 RPC；终端组件、快捷键和自定义渲染不等同于网页组件。扩展会话替换受网站管理限制。' };
    }
    async toggle(input) {
        if (!['on', 'off', 'inherit'].includes(input.state) || input.confirmed !== true) throw fail('请确认资源开关');
        return this.native.mutate(input, async () => {
            const ctx = await this.context(input.cwd, input.scope);
            if (ctx.revision !== input.expectedRevision) throw fail('配置已变化，请刷新', 409);
            if (input.scope === 'project' && !ctx.trust.effective) throw fail('请先信任项目');
            const item = ctx.resources.find(r => r.id === input.resourceId);
            if (!item) throw fail('资源已变化或不存在，请刷新', 409);
            if (item.path === path.join(__dirname, 'pi-web-session-extension.ts')) throw fail('网页内部资源不能禁用');
            const config = input.scope === 'project' ? ctx.settings.getProjectSettings() : ctx.settings.getGlobalSettings();
            let key = item.type, value;
            if (item.metadata.origin === 'package') {
                key = 'packages'; value = structuredClone(config.packages || []);
                let index = value.findIndex(p => this.packageMatch(ctx, item.metadata.source, item.metadata.scope, p, input.scope));
                if (index < 0) {
                    if (input.state === 'inherit') return { ok: true, requiresReload: true };
                    const source = local(item.metadata.source) ? ctx.manager.getInstalledPath(item.metadata.source, item.metadata.scope) : item.metadata.source;
                    if (!source) throw fail('无法确定包来源');
                    index = value.push({ source, autoload: false }) - 1;
                }
                const pkg = typeof value[index] === 'string' ? { source: value[index] } : value[index];
                const pattern = path.relative(item.metadata.baseDir, item.path);
                let patterns = pkg[item.type];
                // Explicit [] means all disabled; keep that meaning when enabling one item.
                if (patterns?.length === 0 && pkg.autoload !== false) patterns = ['!**/*'];
                patterns = (patterns || []).filter(p => target(p) !== pattern);
                if (input.state !== 'inherit') patterns.push((input.state === 'on' ? '+' : '-') + pattern);
                if (patterns.length) pkg[item.type] = patterns; else delete pkg[item.type];
                if (pkg.autoload === false && !TYPES.some(t => pkg[t] !== undefined)) value.splice(index, 1);
                else value[index] = pkg;
            } else {
                const base = input.scope === 'project' ? path.join(ctx.cwd, '.pi') : ctx.agentDir;
                const alternatives = new Set([item.path, path.relative(base, item.path), path.relative(item.metadata.baseDir || base, item.path)]);
                value = (config[key] || []).filter(p => !alternatives.has(target(p)));
                if (input.state !== 'inherit') {
                    if (input.scope === 'project' && item.metadata.scope === 'user') value.push(item.path);
                    value.push((input.state === 'on' ? '+' : '-') + item.path);
                }
            }
            if ((await this.native.context(ctx.cwd)).revision !== input.expectedRevision) throw fail('配置已变化，请刷新', 409);
            const names = { extensions: 'ExtensionPaths', skills: 'SkillPaths', prompts: 'PromptTemplatePaths', themes: 'ThemePaths', packages: 'Packages' };
            const file = input.scope === 'project' ? safeFile(ctx.cwd, ['.pi', 'settings.json'], true) : safeFile(ctx.agentDir, ['settings.json'], true);
            const old = read(file);
            if (old !== null) privateFiles.writePrivateFileSync(`${file}.bak-web-${Date.now()}`, old);
            ctx.settings[`set${input.scope === 'project' ? 'Project' : ''}${names[key]}`](value);
            await ctx.settings.flush();
            if (ctx.settings.drainErrors().length) throw fail('资源设置可能未保存，请刷新核对', 409);
            privateFiles.privateFileMode(file);
            return { ok: true, requiresReload: true };
        });
    }
    async packageAction(input) {
        if (input.confirmed !== true || !['install', 'remove', 'update'].includes(input.action) || typeof input.source !== 'string' || !input.source.trim() || input.source.startsWith('-') || input.source.length > 1000) throw fail('包操作无效或未确认');
        return this.native.mutate(input, async () => {
            const ctx = await this.context(input.cwd, input.scope);
            if (ctx.revision !== input.expectedRevision) throw fail('配置已变化，请刷新', 409);
            if (input.scope === 'project' && !ctx.trust.effective) throw fail('请先信任项目');
            const wantedScope = input.scope === 'project' ? 'project' : 'user';
            const matches = ctx.manager.listConfiguredPackages().filter(p => p.source === input.source);
            if (input.action !== 'install' && !matches.some(p => p.scope === wantedScope)) throw fail('该范围内不存在此包');
            // Native update(source) acts on all matching scopes; never silently update two installations.
            if (input.action === 'update' && matches.some(p => p.scope !== wantedScope)) throw fail('此包有多个安装范围，请在终端指定更新范围');
            const options = { local: input.scope === 'project' };
            if (input.action === 'install') await ctx.manager.installAndPersist(input.source, options);
            if (input.action === 'remove') await ctx.manager.removeAndPersist(input.source, options);
            if (input.action === 'update') await ctx.manager.update(input.source);
            const file = input.scope === 'project' ? ctx.projectFile : ctx.globalFile;
            if (fs.existsSync(file)) privateFiles.privateFileMode(file);
            return { ok: true, requiresReload: true };
        });
    }
    async skillPath(input, create = false) {
        if (!['global', 'project'].includes(input.scope) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name || '') || input.name.length > 64) throw fail('Skill 名称或范围无效');
        const ctx = await this.native.context(input.cwd);
        if (create && input.scope === 'project' && !ctx.trust.effective) throw fail('请先信任项目');
        const file = input.scope === 'global' ? safeFile(ctx.agentDir, ['skills', input.name, 'SKILL.md'], create) : safeFile(ctx.cwd, ['.pi', 'skills', input.name, 'SKILL.md'], create);
        return { ctx, file };
    }
    async readSkill(input) {
        const { file } = await this.skillPath(input), content = read(file);
        if (content === null) return { name: input.name, content: '', revision: null };
        if (Buffer.byteLength(content) > 64 * 1024) throw fail('网页 Skill 编辑限 64 KiB');
        return { name: input.name, content, revision: hash(content) };
    }
    async saveSkill(input) {
        if (input.confirmed !== true || typeof input.content !== 'string' || Buffer.byteLength(input.content) > 64 * 1024 || input.content.includes('\0')) throw fail('请确认至多 64 KiB 的 Skill 内容');
        if (this.native.busy) throw fail('资源正在保存，请稍后再试', 409);
        this.native.busy = true;
        try {
            const { ctx, file } = await this.skillPath(input, true);
            const { frontmatter } = ctx.sdk.parseFrontmatter(input.content);
            if (frontmatter.name !== input.name || typeof frontmatter.description !== 'string' || !frontmatter.description.trim() || frontmatter.description.length > 1024) throw fail('Skill frontmatter 需要匹配的 name 和 description');
            const old = read(file);
            if ((old === null ? null : hash(old)) !== input.expectedRevision) throw fail('Skill 已变化，请重新读取', 409);
            // Backup is outside skill discovery: hidden directory, not a sibling .md file.
            const backup = safeFile(path.dirname(file), ['.web-backups', `${Date.now()}.txt`], true);
            if (old !== null) privateFiles.writePrivateFileSync(backup, old);
            const temp = safeFile(path.dirname(file), ['.web-skill.tmp']);
            try { privateFiles.writePrivateFileSync(temp, input.content); fs.renameSync(temp, file); }
            finally { try { fs.unlinkSync(temp); } catch {} }
            return { ok: true, revision: hash(input.content), requiresReload: true };
        } finally { this.native.busy = false; }
    }
}
module.exports = { PiResourceService };
