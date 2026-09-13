const privateFiles = require('./pi-private-files');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const { getSdk } = require('./pi-session-store');
const { withinCanonical: isWithin } = require('./pi-platform-path');

// Web equivalents for the installed Pi 0.85 built-ins; runtime resources come from get_commands.
const BUILTINS = [
    ['settings', '打开工作台设置'], ['model', '选择当前会话模型', '<provider/model>'],
    ['thinking', '选择思考等级', '<level>'], ['name', '命名当前会话', '<名称>'],
    ['session', '查看会话详情与用量'], ['new', '新建当前项目会话'], ['resume', '选择已有会话'],
    ['compact', '压缩当前上下文', '[摘要要求]'], ['copy', '复制最近一条回复'], ['quit', '退出当前运行实例'],
    ['reload', '空闲时重新加载原生资源'], ['fork', '打开历史问题分叉入口'], ['clone', '复制当前分支为新线程'],
    ['login', '打开 Provider 凭据设置'], ['logout', '打开 Provider 凭据管理，不自动删除凭据'],
    ['scoped-models', '打开模型配置'], ['hotkeys', '查看网页键盘操作'],
    ['tree', '查看会话树，选择从哪里继续', '', true], ['export', '请使用线程菜单 → 导出记录（需后端启用）', '', false],
    ['import', '请使用项目入口 → 导入 Pi 会话（需后端启用）', '', false], ['share', 'GitHub 分享仅终端支持', '', false],
    ['trust', '项目 trust 管理仅终端支持', '', false], ['changelog', 'Pi 上游 changelog 请在终端查看', '', false]
].map(([name, description, argumentHint, available = true]) => ({ name, description, argumentHint, source: 'builtin', available }));
const RESERVED = new Set([...BUILTINS.map(c => c.name), 'btw', 'commands', 'templates', 'files']);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const LIMIT = 64 * 1024;
const revision = text => createHash('sha256').update(text).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const excluded = relative => relative.split('/').some(part => ['.git', 'node_modules', '.web-backups', 'backups', '.pivane-runtime', '.venv', '__pycache__'].includes(part)
    || /^\.env(?:\.|$)/i.test(part) || /^(?:auth|models-store)\.json$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));

class PiComposerService {
    constructor(store) { this.store = store; this.searches = 0; }
    async root(scope, cwd, create = false) {
        if (!['user', 'project'].includes(scope)) throw fail('模板范围无效');
        this.store.resolveProject(cwd);
        const { getAgentDir } = await getSdk();
        const base = scope === 'user' ? path.resolve(getAgentDir()) : this.store.resolveProject(cwd);
        if (create && scope === 'user') fs.mkdirSync(base, { recursive: true, mode: 0o700 });
        if (!fs.existsSync(base)) return null;
        let current = fs.realpathSync.native(base);
        for (const part of scope === 'user' ? ['prompts'] : ['.pi', 'prompts']) {
            current = path.join(current, part);
            if (!fs.existsSync(current)) {
                // lstat also detects dangling symlinks.
                try { fs.lstatSync(current); throw fail('模板目录不能是符号链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
                if (!create) return null;
                fs.mkdirSync(current, { mode: 0o700 });
            }
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('模板目录必须是普通目录，不能是符号链接');
        }
        return current;
    }
    file(root, name) {
        if (!NAME.test(name || '')) throw fail('模板名仅支持字母、数字、短横线和下划线，最多 80 字符');
        return root && path.join(root, `${name}.md`);
    }
    readFile(file) {
        if (!file) return null;
        let stat;
        try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw fail('模板必须是至多 64 KiB 的普通 Markdown 文件');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            if (fs.fstatSync(fd).size > LIMIT) throw fail('模板过大');
            const bytes = Buffer.alloc(LIMIT + 1); const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
            if (size > LIMIT) throw fail('模板过大');
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        } finally { fs.closeSync(fd); }
    }
    async list(cwd) {
        cwd = this.store.resolveProject(cwd);
        const { parseFrontmatter } = await getSdk();
        const templates = []; const warnings = [];
        for (const scope of ['user', 'project']) {
            try {
                const root = await this.root(scope, cwd);
                if (!root) continue;
                const names = fs.readdirSync(root).filter(n => n.endsWith('.md')).sort();
                if (names.length > 500) warnings.push(`${scope} 模板超过 500 项，列表已截断`);
                for (const filename of names.slice(0, 500)) {
                    const name = filename.slice(0, -3);
                    if (!NAME.test(name)) { warnings.push(`跳过不能在网页管理的模板名：${filename}`); continue; }
                    try {
                        const filePath = this.file(root, name), raw = this.readFile(filePath);
                        if (raw === null) continue;
                        const { frontmatter, body } = parseFrontmatter(raw);
                        templates.push({ name, scope, filePath, revision: revision(raw), description: String(frontmatter.description || body.trim().split('\n')[0] || '').slice(0, 300), argumentHint: String(frontmatter['argument-hint'] || '').slice(0, 300) });
                    } catch { warnings.push(`无法读取模板：${scope}/${name}`); }
                }
            } catch (e) { warnings.push(e.message); }
        }
        return { cwd, builtins: BUILTINS, templates, warnings: warnings.slice(0, 30) };
    }
    async get({ cwd, scope, name }) {
        const raw = this.readFile(this.file(await this.root(scope, cwd), name));
        if (raw === null) throw fail('模板不存在', 404);
        return { name, scope, content: raw, revision: revision(raw) };
    }
    backup(root, name, raw) {
        const dir = path.join(root, '.web-backups');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
        if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) throw fail('模板备份目录无效');
        const target = path.join(dir, `${name}-${Date.now()}-${randomUUID()}.md`);
        privateFiles.writePrivateFileSync(target, raw);
        return target;
    }
    async save(input, remove = false) {
        if (!remove && (typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > LIMIT || input.content.includes('\0'))) throw fail('请输入至多 64 KiB 的模板 Markdown');
        if (!Object.hasOwn(input, 'expectedRevision')) throw fail('缺少模板修订，请重新打开', 409);
        if (RESERVED.has(input.name) && !remove) throw fail('模板名与内置命令冲突，请换一个名称');
        // No await between the current-file comparison and atomic replacement.
        const root = await this.root(input.scope, input.cwd, !remove);
        const file = this.file(root, input.name); const old = this.readFile(file);
        if ((old === null ? null : revision(old)) !== input.expectedRevision) throw fail('模板已被其他页面或终端修改，请重新打开后再保存', 409);
        if (remove && old === null) throw fail('模板不存在', 404);
        if (old !== null) this.backup(root, input.name, old);
        if (remove) fs.unlinkSync(file);
        else {
            const tmp = path.join(root, `.web-${randomUUID()}.tmp`);
            try { privateFiles.writePrivateFileSync(tmp, input.content); fs.renameSync(tmp, file); }
            finally { try { fs.unlinkSync(tmp); } catch {} }
        }
        return { ok: true, requiresReload: true, revision: remove ? null : revision(input.content) };
    }
    async files(cwd, query = '') {
        cwd = this.store.resolveProject(cwd);
        if (typeof query !== 'string' || query.length > 200 || /[\x00-\x1f]/.test(query)) throw fail('文件查询无效');
        if (this.searches >= 2) throw fail('文件搜索正在进行，请稍后重试', 429);
        this.searches++;
        try {
            return await new Promise((resolve, reject) => {
                const child = spawn('rg', ['--files', '--hidden', '--null', '-g', '!.git/**', '-g', '!node_modules/**', '-g', '!backups/**', '-g', '!.pivane-runtime/**', '-g', '!.venv/**', '-g', '!public/images/**', '-g', '!public/videos/**', '-g', '!public/audio/**'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
                let pending = Buffer.alloc(0), bytes = 0, seen = 0, truncated = false, failed = false;
                const candidates = []; const needle = query.toLowerCase().replace(/^@?(?:\.\/)?/, '');
                const letters = [...needle], started = Date.now();
                const compare = (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path);
                const stop = () => { truncated = true; child.kill(); };
                const timer = setTimeout(stop, 1800);
                child.on('error', () => { failed = true; clearTimeout(timer); reject(fail('无法启动项目搜索，请确认服务器已安装 ripgrep')); });
                child.stdout.on('data', chunk => {
                    if (truncated) return;
                    bytes += chunk.length;
                    if (bytes > 8 * 1024 * 1024) return stop();
                    pending = Buffer.concat([pending, chunk]);
                    let end;
                    while ((end = pending.indexOf(0)) !== -1) {
                        const relative = pending.subarray(0, end).toString('utf8').split(path.sep).join('/'); pending = pending.subarray(end + 1);
                        if (++seen > 100000 || Date.now() - started > 1800) { stop(); break; }
                        if (excluded(relative) || /[\x00-\x1f\x7f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').includes('..')) continue;
                        const lower = relative.toLowerCase(); let at = 0;
                        for (const char of lower) if (char === letters[at]) at++;
                        if (needle && at !== letters.length) continue;
                        const score = !needle ? 0 : path.basename(lower).startsWith(needle) ? 3 : lower.includes(needle) ? 2 : 1;
                        const candidate = { path: relative, score };
                        let low = 0, high = candidates.length;
                        while (low < high) { const mid = (low + high) >>> 1; if (compare(candidate, candidates[mid]) < 0) high = mid; else low = mid + 1; }
                        if (low < 100) { candidates.splice(low, 0, candidate); if (candidates.length > 100) candidates.pop(); }
                    }
                });
                child.on('close', code => {
                    clearTimeout(timer); if (failed) return;
                    if (!truncated && ![0, 1].includes(code)) return reject(fail('无法读取项目文件列表'));
                    const files = candidates.filter(item => {
                        try { const real = fs.realpathSync.native(path.join(cwd, item.path)); return isWithin(cwd, real) && !excluded(path.relative(cwd, real)) && fs.statSync(real).isFile(); } catch { return false; }
                    }).slice(0, 50).map(({ path: relative }) => ({ path: relative }));
                    resolve({ cwd, files, truncated: truncated || candidates.length > 50 });
                });
            });
        } finally { this.searches--; }
    }
}
module.exports = { PiComposerService, BUILTINS };
