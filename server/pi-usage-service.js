const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getSdk } = require('./pi-session-store');

function usageQuery(query = {}) {
    if (Object.keys(query).some(key => !['from', 'to', 'timeZone'].includes(key))) throw new Error('未知用量筛选参数');
    const { from, to, timeZone = 'UTC' } = query;
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(from) || !validDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 365) {
        throw new Error('请选择有效的起止日期，范围最多 366 天');
    }
    if (typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('时区无效');
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('时区无效'); }
    return { from, to, timeZone };
}

class PiUsageService {
    constructor(store) { this.store = store; this.pending = null; this.cache = null; this.stopped = false; }
    start() {
        if (this.timer || this.stopped) return;
        this.timer = setInterval(() => {
            if (!this.pending && !this.stopped) void this.sync().catch(() => {});
        }, 60000);
        this.timer.unref();
    }
    sync(onlyFile) {
        if (this.pending) return this.pending.promise.then(() => this.sync(onlyFile));
        // Reserve before SDK initialization or worker creation.
        const promise = this.scan(null, onlyFile).finally(() => { this.pending = null; this.cache = null; });
        this.pending = { key: null, promise };
        return promise;
    }
    async preserveSession(filename) {
        if (this.pending) await this.pending.promise;
        return this.sync(filename);
    }
    async dispose() {
        this.stopped = true; clearInterval(this.timer);
        if (this.pending) await this.pending.promise.catch(() => {});
    }
    async report(query) {
        const filter = usageQuery(query);
        const key = JSON.stringify(filter);
        if (this.cache?.key === key && Date.now() - this.cache.at < 15000) return this.cache.value;
        if (this.pending) {
            if (this.pending.key === key) return this.pending.promise;
            throw Object.assign(new Error('正在统计其他日期范围，请稍后刷新'), { statusCode: 429 });
        }
        const promise = this.scan(filter).then(value => {
            this.cache = { key, at: Date.now(), value };
            return value;
        }).finally(() => { this.pending = null; });
        this.pending = { key, promise };
        return promise;
    }
    async scan(filter, onlyFile) {
        const { getAgentDir } = await getSdk();
        return new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, 'pi-usage-worker.js'), {
                workerData: { root: path.join(getAgentDir(), 'sessions'), roots: this.store.roots, filter,
                    ledgerPath: path.join(getAgentDir(), 'pivane-usage', 'ledger.sqlite'), onlyFile },
                resourceLimits: { maxOldGenerationSizeMb: 192 }
            });
            let finished = false;
            const finish = async (error, value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                await worker.terminate();
                if (error) reject(Object.assign(new Error(error), { statusCode: 503 }));
                else resolve(value);
            };
            const timer = setTimeout(() => finish('统计超时，请稍后刷新'), 30000);
            worker.once('message', message => finish(message.error, message.value));
            worker.once('error', () => finish('用量统计暂时不可用'));
            worker.once('exit', () => finish('用量统计未完成，请稍后刷新'));
        });
    }
}
module.exports = { PiUsageService, usageQuery };
