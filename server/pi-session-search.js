const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { getSdk } = require('./pi-session-store');
const fail = (text, status = 400) => Object.assign(new Error(text), { status });
class PiSessionSearch {
    constructor(store, preferences) { this.store = store; this.preferences = preferences; this.cache = null; this.pending = null; this.disposed = false; }
    async search(query, signal) {
        if (this.disposed) throw fail('服务正在关闭', 503);
        if (Object.keys(query).some(k => !['q', 'cwd', 'offset', 'searchId', 'includeArchived'].includes(k)) || typeof query.q !== 'string' || query.q.trim().length < 2 || query.q.length > 200) throw fail('请输入 2–200 个字符的关键词');
        const q = query.q.trim(), cwd = query.cwd ? this.store.resolveProject(query.cwd) : null;
        const offset = query.offset === undefined ? 0 : Number(query.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > 200 || offset % 20) throw fail('搜索分页无效');
        if (query.includeArchived !== undefined && !['true', 'false'].includes(query.includeArchived)) throw fail('Invalid includeArchived');
        const includeArchived = query.includeArchived === 'true';
        const archives = this.preferences.getArchives?.() || { revision: 0, projects: [], sessions: [] };
        const key = JSON.stringify([q, cwd, this.preferences.getHiddenProjects(), includeArchived, archives.revision]);
        let cache = this.cache;
        if (offset) {
            if (!cache || cache.id !== query.searchId || cache.key !== key || Date.now() - cache.at > 60000) throw fail('搜索结果已过期，请重新搜索', 409);
        } else {
            if (this.pending) throw fail('其他会话搜索正在进行，请稍后重试', 429);
            const pending = {}; this.pending = pending;
            try {
                const { getAgentDir } = await getSdk();
                if (signal.aborted || this.disposed) throw fail('搜索已取消');
                const data = await new Promise((resolve, reject) => {
                    const worker = new Worker(path.join(__dirname, 'pi-session-search-worker.js'), { workerData: { root: path.join(getAgentDir(), 'sessions'), roots: this.store.roots, q, cwd, hidden: this.preferences.getHiddenProjects(), archives, includeArchived }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
                    let done = false;
                    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); void worker.terminate().then(() => error ? reject(fail(error, 503)) : resolve(value), () => reject(fail('搜索进程未正常结束', 503))); };
                    const cancel = () => finish('搜索已取消'); pending.cancel = cancel;
                    const timer = setTimeout(() => finish('搜索超时，请缩小范围'), 15000);
                    signal.addEventListener('abort', cancel, { once: true });
                    worker.once('message', m => finish(m.error, m.value)); worker.once('error', () => finish('会话搜索暂时不可用')); worker.once('exit', () => finish('搜索未完成'));
                });
                cache = { key, id: randomUUID(), at: Date.now(), ...data }; this.cache = cache;
            } finally { if (this.pending === pending) this.pending = null; }
        }
        if ((this.preferences.getArchives?.().revision || 0) !== archives.revision) throw fail('搜索结果已过期，请重新搜索', 409);
        const rows = cache.results.filter(row => { try { return this.store.resolveProject(row.cwd) === row.cwd; } catch { return false; } });
        return { q, searchId: cache.id, offset, results: rows.slice(offset, offset + 20), total: rows.length, hasMore: offset + 20 < rows.length,
            coverage: cache.coverage, partial: cache.coverage.limited || cache.coverage.skippedFiles > 0 };
    }
    dispose() { this.disposed = true; this.pending?.cancel?.(); this.cache = null; }
}
module.exports = { PiSessionSearch };
