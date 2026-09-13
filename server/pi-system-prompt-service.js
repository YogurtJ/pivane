const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { safeFile, fail } = require('./pi-native-service');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const privateFiles = require('./pi-private-files');
const { replaceFileSync } = require('./pi-win32-native');
const LIMIT = 64 * 1024;
const names = { append: 'APPEND_SYSTEM.md', base: 'SYSTEM.md' };
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

// Only server-selected native prompt files are readable. Keep the opened object,
// kernel path, high precision identity and pre/post read checks together.
function readPrompt(file) {
    let fd;
    try {
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(LIMIT)) throw fail('提示词必须是至多 64 KiB 的普通 UTF-8 文件');
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) throw fail('提示词文件已变化，请重新读取', 409);
        const bytes = Buffer.alloc(LIMIT + 1); let size = 0, n;
        while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, size))) size += n;
        if (size > LIMIT) throw fail('提示词必须是至多 64 KiB 的普通 UTF-8 文件');
        const after = fs.lstatSync(file, { bigint: true });
        if (stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true })) || stamp(after) !== stamp(opened)
            || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity)) throw fail('提示词文件已变化，请重新读取', 409);
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
        if (content.includes('\0')) throw fail('提示词不能包含空字符');
        return { content, identity: `${identity || ''}:${stamp(opened)}`, revision: hash(bytes.subarray(0, size)) };
    } catch (error) {
        if (error.code === 'ENOENT' && fd === undefined) return { content: null, identity: null, revision: null };
        if (error.status) throw error;
        throw fail('无法安全读取提示词文件，请检查文件类型、权限和 UTF-8 编码');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function filesFor(ctx) {
    return Object.fromEntries(['global', 'project'].map(scope => [scope, Object.fromEntries(Object.entries(names).map(([kind, name]) => {
        const file = scope === 'global' ? safeFile(ctx.agentDir, [name]) : safeFile(ctx.cwd, ['.pi', name]);
        return [kind, { path: file, ...readPrompt(file) }];
    }))]));
}
const revisionFor = (ctx, files) => hash(JSON.stringify([ctx.cwd, ctx.revision, files]));
function selected(files, trusted, kind) {
    const scope = trusted && files.project[kind].content !== null ? 'project' : files.global[kind].content !== null ? 'global' : 'default';
    return { scope, path: scope === 'default' ? null : files[scope][kind].path, content: scope === 'default' ? null : files[scope][kind].content };
}
class PiSystemPromptService {
    constructor(native) { this.native = native; }
    async snapshot(cwd) {
        const ctx = await this.native.context(cwd), files = filesFor(ctx);
        return { cwd: ctx.cwd, revision: revisionFor(ctx, files), maxBytes: LIMIT, trust: ctx.trust,
            files: Object.fromEntries(Object.entries(files).map(([scope, values]) => [scope, Object.fromEntries(Object.entries(values).map(([kind, { identity, ...value }]) => [kind, value]))])),
            selected: Object.fromEntries(Object.keys(names).map(kind => [kind, selected(files, ctx.trust.effective, kind)])) };
    }
    async save(input) {
        if (!input || Object.keys(input).some(k => !['cwd', 'scope', 'kind', 'content', 'expectedRevision'].includes(k))
            || !['global', 'project'].includes(input.scope) || !['append', 'base'].includes(input.kind)
            || typeof input.expectedRevision !== 'string') throw fail('提示词范围、类型或修订无效');
        if (input.content !== null && (typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > LIMIT || input.content.includes('\0') || !input.content.isWellFormed())) throw fail('请输入非空且至多 64 KiB 的提示词；恢复默认请使用恢复按钮');
        if (this.native.busy) throw fail('配置正在保存，请稍后再试', 409);
        this.native.busy = true;
        try {
            const ctx = await this.native.context(input.cwd), files = filesFor(ctx);
            if (revisionFor(ctx, files) !== input.expectedRevision) throw fail('提示词或配置已变化，请刷新核对；草稿已保留', 409);
            if (input.scope === 'project' && !ctx.trust.effective) throw fail('请先信任项目，再保存项目提示词');
            const old = files[input.scope][input.kind];
            if (old.content === input.content) return { ok: true, requiresReload: true };
            const name = names[input.kind];
            const file = input.scope === 'global' ? safeFile(ctx.agentDir, [name], true) : safeFile(ctx.cwd, ['.pi', name], true);
            const directory = path.dirname(file), canonical = fs.realpathSync.native(directory);
            let directoryFd;
            try {
            directoryFd = io.openReadSync(directory);
            const parent = fs.fstatSync(directoryFd, { bigint: true }), parentIdentity = io.identity(directoryFd);
            const check = () => {
                const now = fs.statSync(directory, { bigint: true });
                if (!parent.isDirectory() || canonical !== directory || descriptorPathSync(directoryFd) !== canonical
                    || fs.realpathSync.native(directory) !== canonical || !io.sameIdentityAtPath(directory, parentIdentity)
                    || process.platform !== 'win32' && (parent.dev !== now.dev || parent.ino !== now.ino)
                    || JSON.stringify(readPrompt(file)) !== JSON.stringify({ content: old.content, identity: old.identity, revision: old.revision })) throw fail('提示词文件已变化，请重新读取', 409);
            };
            // No await from revision comparison through replacement. Backups are private
            // .txt files outside native prompt discovery, including on restore.
            const backup = safeFile(directory, ['.web-backups', `${name}-${Date.now()}-${randomUUID()}.txt`], true);
            privateFiles.privateDirectory(path.dirname(backup));
            check();
            if (old.content !== null) privateFiles.writePrivateFileSync(backup, old.content, true);
            const temp = path.join(directory, `.web-system-${randomUUID()}.tmp`);
            try {
                if (input.content !== null) privateFiles.writePrivateFileSync(temp, input.content, true);
                check();
                if (input.content === null) fs.unlinkSync(file);
                else replaceFileSync(temp, file);
                if (process.platform !== 'win32') {
                    const dirFd = fs.openSync(directory, 'r');
                    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
                }
            } finally { try { fs.unlinkSync(temp); } catch {} }
            return { ok: true, requiresReload: true };
            } finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
        } catch (error) {
            if (error.status) throw error;
            throw fail('提示词保存未确认，请刷新核对；未自动重试', 409);
        } finally { this.native.busy = false; }
    }
    async inspect(snapshot) {
        try {
            const ctx = await this.native.context(snapshot.cwd), files = filesFor(ctx);
            const configured = Object.fromEntries(Object.keys(names).map(kind => {
                const value = selected(files, snapshot.projectTrusted, kind);
                const loaded = kind === 'base' ? snapshot.customPrompt : snapshot.appendSystemPrompt;
                return [kind, { scope: value.scope, path: value.path, matchesLoaded: (value.content || '').replace(/^\uFEFF/, '') === (loaded || '') }];
            }));
            return { ...snapshot, configured, savedTrust: ctx.trust.effective,
                matchesSavedFiles: Object.values(configured).every(v => v.matchesLoaded) && ctx.trust.effective === snapshot.projectTrusted };
        } catch {
            return { ...snapshot, configured: null, matchesSavedFiles: null };
        }
    }
}
module.exports = { PiSystemPromptService, readPrompt, LIMIT };
