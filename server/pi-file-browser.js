const fs = require('node:fs/promises');
const path = require('node:path');
const fileIo = require('./pi-file-io');
const { descriptorPath } = require('./pi-file-descriptor');
const { windowsPath } = require('./pi-platform-path');
const { fileScope, fileError, fail } = require('./pi-file-scope');
const policy = require('../public/pi-file-policy');
const skippedSearchDirectories = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '__pycache__', '.next', '.venv', 'venv']);
const changed = () => fail('目录正在变化，请刷新后重试', 409, 'FILE_CHANGED');
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const webPath = value => value.split(path.sep).join('/');

// Enumeration yields untrusted names. Validate every published child against an
// opened descriptor too; opendir itself does not expose an fd on all platforms.
async function opened(scope, requested) {
    scope.check(requested, true);
    const resolved = await fs.realpath(requested); scope.check(resolved);
    const handle = await fileIo.openRead(resolved);
    try {
        const identity = fileIo.identity(handle.fd);
        const verify = async () => {
            const actual = await descriptorPath(handle.fd); scope.check(actual);
            if (actual !== resolved || await fs.realpath(requested) !== resolved || !fileIo.sameIdentityAtPath(resolved, identity)) throw changed();
        };
        await verify();
        const stat = await handle.stat({ bigint: true });
        return { handle, resolved, stat, verify };
    } catch (error) { await handle.close(); throw error; }
}

class PiFileBrowser {
    constructor(store) { this.store = store; this.running = 0; }
    async request(input, search = false, signal) {
        const allowed = search ? ['cwd', 'q', 'hidden'] : ['cwd', 'path', 'hidden'];
        if (!input || Object.keys(input).some(key => !allowed.includes(key))
            || input.hidden !== undefined && !['true', 'false'].includes(input.hidden)
            || typeof input[search ? 'q' : 'path'] !== 'string'
            || input[search ? 'q' : 'path'].length > (search ? 200 : 4096)
            || /[\x00-\x1f\x7f]/.test(input[search ? 'q' : 'path'])
            || search && !input.q.trim()) throw fail('文件浏览参数无效', 400, 'FILE_PATH');
        let relative;
        try { relative = search ? '' : windowsPath(input.path || '.'); }
        catch { throw fail('文件路径无效', 400, 'FILE_PATH'); }
        if (process.platform !== 'win32' && relative.includes('\\')) throw fail('文件路径无效', 400, 'FILE_PATH');
        if (this.running >= 2) throw fail('文件浏览正在进行，请稍后再试', 429, 'FILE_BUSY');
        this.running++;
        try {
            const scope = await fileScope(this.store, input.cwd);
            const budget = { signal, deadline: Date.now() + 3000, visited: 0, limit: search ? 12000 : 4000, partial: false };
            const hidden = input.hidden === 'true';
            const root = path.resolve(scope.cwd, relative);
            if (!search) {
                const result = await this.directory(scope, root, hidden, budget, 500);
                return { cwd: scope.cwd, path: webPath(path.relative(scope.cwd, root)), entries: result.entries, partial: budget.partial };
            }
            const queue = [scope.cwd], seen = new Set(), entries = [], query = input.q.trim().toLowerCase();
            while (queue.length && entries.length < 100 && !this.exhausted(budget)) {
                const directory = queue.shift();
                let result;
                try { result = await this.directory(scope, directory, hidden, budget, 4000); }
                catch (error) {
                    if (directory === scope.cwd || signal?.aborted) throw error;
                    budget.partial = true; continue;
                }
                if (seen.has(result.resolved)) continue;
                seen.add(result.resolved);
                for (const entry of result.entries) {
                    if (entry.kind === 'directory') {
                        // Do not recurse through aliases or bulky generated trees.
                        if (!entry.link && !skippedSearchDirectories.has(entry.name) && queue.length < 500) queue.push(path.join(scope.cwd, entry.path));
                        else if (queue.length >= 500) budget.partial = true;
                    } else if (entry.path.toLowerCase().includes(query)) {
                        entries.push(entry);
                        if (entries.length === 100) { budget.partial = true; break; }
                    }
                }
            }
            if (queue.length) budget.partial = true;
            entries.sort((a, b) => Number(!a.name.toLowerCase().includes(query)) - Number(!b.name.toLowerCase().includes(query)) || a.path.localeCompare(b.path));
            return { cwd: scope.cwd, entries, partial: budget.partial };
        } catch (error) { throw fileError(error); }
        finally { this.running--; }
    }
    exhausted(budget) {
        if (budget.signal?.aborted) throw fail('文件浏览已取消', 499, 'FILE_ABORTED');
        if (budget.visited >= budget.limit || Date.now() >= budget.deadline) { budget.partial = true; return true; }
        return false;
    }
    async directory(scope, requested, hidden, budget, limit) {
        const parent = await opened(scope, requested);
        let dir;
        try {
            if (!parent.stat.isDirectory()) throw fail('请选择一个目录', 415, 'FILE_TYPE');
            const kernelPath = process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}` : await descriptorPath(parent.handle.fd);
            dir = await fs.opendir(kernelPath);
            const entries = [];
            while (!this.exhausted(budget)) {
                const candidate = await dir.read();
                if (!candidate) break;
                budget.visited++;
                const name = candidate.name;
                if ((!hidden && name.startsWith('.')) || /[\x00-\x1f\x7f]/.test(name) || policy.restricted(name)) continue;
                let child;
                try {
                    child = await opened(scope, path.join(requested, name));
                    const kind = child.stat.isDirectory() ? 'directory' : child.stat.isFile() ? 'file' : null;
                    if (!kind) continue;
                    await child.verify();
                    if (!sameStat(child.stat, await child.handle.stat({ bigint: true }))) throw changed();
                    entries.push({ name, path: webPath(path.relative(scope.cwd, path.join(requested, name))), kind,
                        link: candidate.isSymbolicLink() });
                } catch (error) {
                    if (!['FILE_PRIVATE', 'FILE_OUTSIDE', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error;
                    if (['EACCES', 'EPERM'].includes(error.code)) budget.partial = true;
                } finally { await child?.handle.close(); }
                if (entries.length >= limit) { budget.partial = true; break; }
            }
            await parent.verify();
            if (!sameStat(parent.stat, await parent.handle.stat({ bigint: true }))) throw changed();
            entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }));
            return { entries, resolved: parent.resolved };
        } finally { try { await dir?.close(); } finally { await parent.handle.close(); } }
    }
}
module.exports = { PiFileBrowser };
