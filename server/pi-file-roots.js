const path = require('node:path');
const fs = require('node:fs/promises');
const { fileScope, fail, fileError } = require('./pi-file-scope');
const { windowsPath, withinCanonical: within } = require('./pi-platform-path');
const policy = require('../public/pi-file-policy');

function fields(input, keys) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw fail('文件目录参数无效', 400, 'FILE_PATH');
}
function absolute(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw fail('目录路径无效', 400, 'FILE_PATH');
    let result;
    try { result = windowsPath(value); } catch { throw fail('目录路径无效', 400, 'FILE_PATH'); }
    if (!path.isAbsolute(result) || process.platform !== 'win32' && result.includes('\\')) throw fail('请使用服务器上的绝对路径', 400, 'FILE_PATH');
    if (policy.restricted(result)) throw fail('此目录不提供网页浏览', 403, 'FILE_PRIVATE');
    return result;
}

// Navigation preferences only: never changes the native session or tool permissions.
class PiFileRoots {
    constructor({ store, browser, preferences, isSuspended = () => false }) { Object.assign(this, { store, browser, preferences, isSuspended }); this.jobs = new Map(); this.stopping = false; }
    async dispose() {
        this.stopping = true;
        await Promise.all([...this.jobs.values()]);
    }
    async project(input) { return (await fileScope(this.store, absolute(input))).cwd; }
    async list(input) {
        fields(input, ['cwd']);
        const cwd = await this.project(input.cwd), saved = this.preferences.getFileRoots(cwd);
        return { cwd, ...saved };
    }
    async change(input) {
        fields(input, ['cwd', 'root', 'action', 'expectedRevision']);
        const candidate = absolute(input.root);
        if (!['add', 'remove'].includes(input.action) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw fail('文件目录参数无效', 400, 'FILE_PATH');
        if (this.stopping || this.isSuspended()) throw fail('维护期间暂不能保存关联目录', 409, 'FILE_ROOTS_BUSY');
        const cwd = this.store.resolveProject(absolute(input.cwd));
        if (this.jobs.has(cwd)) throw fail('正在保存关联目录，请稍后核对', 409, 'FILE_ROOTS_BUSY');
        let settled;
        this.jobs.set(cwd, new Promise(resolve => { settled = resolve; }));
        try {
            await this.project(cwd);
            // Removal uses the saved spelling so missing/unmounted roots remain removable.
            const root = input.action === 'add' ? await this.browser.resolveRoot(candidate) : candidate;
            if (this.stopping || this.isSuspended()) throw fail('维护期间暂不能保存关联目录', 409, 'FILE_ROOTS_BUSY');
            return { cwd, ...this.preferences.changeFileRoot(cwd, root, input.action, input.expectedRevision) };
        } finally { this.jobs.delete(cwd); settled(); }
    }
    async directories(input, signal) {
        fields(input, ['path']);
        if (input.path === '') {
            const roots = [];
            for (const candidate of this.store.roots.slice(0, 26)) {
                if (signal?.aborted) throw fail('文件浏览已取消', 499, 'FILE_ABORTED');
                try { const root = await this.browser.resolveRoot(candidate); roots.push({ name: root, path: root }); }
                catch (error) { if (!['FILE_PRIVATE', 'FILE_PROJECT', 'FILE_DENIED', 'FILE_MISSING'].includes(error.code)) throw error; }
            }
            return { current: null, parent: null, directories: roots, partial: this.store.roots.length > 26 };
        }
        const current = await this.browser.resolveRoot(absolute(input.path));
        const data = await this.browser.request({ cwd: current, path: '', hidden: 'false' }, false, signal);
        const candidate = path.dirname(current);
        let parent = null;
        if (candidate !== current) {
            try { parent = await this.project(candidate); } catch {}
        }
        return { current, parent, directories: data.entries.filter(entry => entry.kind === 'directory').map(entry => ({ name: entry.name, path: path.join(current, entry.path) })), partial: data.partial };
    }
    async resolve(input) {
        fields(input, ['cwd', 'path']);
        const cwd = await this.project(input.cwd);
        if (typeof input.path !== 'string' || !input.path.trim() || input.path.length > 4096 || /[\x00-\x1f\x7f]/.test(input.path)) throw fail('文件路径无效', 400, 'FILE_PATH');
        let native;
        try { native = windowsPath(input.path); } catch { throw fail('文件路径无效', 400, 'FILE_PATH'); }
        if (process.platform !== 'win32' && native.includes('\\')) throw fail('文件路径无效', 400, 'FILE_PATH');
        if (policy.restricted(native)) throw fail('此文件不提供网页预览', 403, 'FILE_PRIVATE');
        const requested = path.resolve(cwd, native), saved = this.preferences.getFileRoots(cwd);
        // Keep lexical and resolved checks on the chosen root. A link inside A
        // escaping to B is not turned into permission to read B, even if both are saved.
        const roots = [];
        for (const root of [cwd, ...saved.roots]) {
            if (within(root, requested)) { roots.push(root); continue; }
            if (process.platform !== 'win32' || !within(root.toLowerCase(), requested.toLowerCase())) continue;
            // Only an actual case alias is a match. Distinct case-sensitive
            // siblings stay external; final file scope still rejects symlink escape.
            try { if (await fs.realpath(requested.slice(0, root.length)) === root) roots.push(root); } catch {}
        }
        roots.sort((a, b) => b.length - a.length);
        const root = roots[0] || path.dirname(requested);
        const result = await this.browser.resolveFile(root, requested);
        return { ...result, associated: roots.length > 0, revision: saved.revision };
    }
}

function mountFileRoots(router, service) {
    const route = action => async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', cancel);
        try { const result = await action(req, controller.signal); if (!controller.signal.aborted) res.json(result); }
        catch (error) { if (!controller.signal.aborted) { const e = fileError(error); res.status(e.status || 500).json({ error: e.message, code: e.code }); } }
        finally { res.off('close', cancel); }
    };
    router.get('/files/roots', route(req => service.list(req.query)));
    router.post('/files/roots', route(req => service.change(req.body)));
    router.get('/files/directories', route((req, signal) => service.directories(req.query, signal)));
    router.get('/files/resolve', route(req => service.resolve(req.query)));
}
module.exports = { PiFileRoots, mountFileRoots };
