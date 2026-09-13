const privateFiles = require('./pi-private-files');
const fs = require('fs');
const { replaceFileSync } = require('./pi-win32-native');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { validateMessage, assertSendable } = require('./pi-message-payload');

const ACTIVE = new Set(['scheduled', 'waiting', 'paused', 'expired', 'failed', 'uncertain', 'dispatching']);
const READY = new Set(['scheduled', 'waiting']);

class PiDeferredMessages {
    constructor({ store, supervisor, filePath, now = Date.now, intervalMs = 1000, isSuspended = () => false }) {
        this.isSuspended = isSuspended;
        this.store = store;
        this.supervisor = supervisor;
        this.now = now;
        const portSuffix = String(process.env.PORT || '3000') === '3001' ? '' : `-${String(process.env.PORT || '3000').replace(/[^0-9]/g, '')}`;
        this.filePath = filePath || process.env.PI_WEB_DEFERRED_FILE || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), `pi5-deferred-messages${portSuffix}.json`);
        this.jobs = [];
        this.disposed = false;
        this.running = null;
        this.error = null;
        try {
            const document = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (document.version !== 1 || !Array.isArray(document.jobs)) throw new Error('Invalid deferred store');
            this.jobs = document.jobs;
            for (const job of this.jobs) {
                if (job.status === 'dispatching') { job.status = 'uncertain'; job.reason = '服务重启，无法确认是否已投递'; job.revision++; }
                else if (READY.has(job.status) && job.dueAt <= now()) { job.status = 'expired'; job.reason = '服务停机期间已过期，请重新确认'; job.revision++; }
            }
            this.persist();
        } catch (error) {
            if (error.code !== 'ENOENT') this.error = '延迟消息文件无法读取，已停止自动投递';
        }
        this.timer = setInterval(() => { void this.tick().catch(() => { this.error = '延迟消息保存失败，已停止自动投递'; }); }, intervalMs);
        this.timer.unref?.();
    }

    assertHealthy() {
        if (this.error) throw new Error(this.error);
    }

    persist() {
        const text = `${JSON.stringify({ version: 1, jobs: this.jobs })}\n`;
        if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('待发送附件总量超过 64MB');
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temp = `${this.filePath}.${randomUUID()}.tmp`;
        let fd;
        try {
            fd = privateFiles.openPrivateFileSync(temp);
            fs.writeFileSync(fd, text);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            replaceFileSync(temp, this.filePath);
            // Windows uses MoveFileExW WRITE_THROUGH; it cannot fsync a directory.
            if (process.platform !== 'win32') {
                const directory = fs.openSync(path.dirname(this.filePath), 'r');
                try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
            }
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }

    change(callback) {
        this.assertHealthy();
        const previous = this.jobs;
        this.jobs = structuredClone(previous);
        try { const result = callback(); this.persist(); return result; }
        catch (error) { this.jobs = previous; throw error; }
    }

    list(cwd, sessionId, { detail = false } = {}) {
        this.assertHealthy();
        return this.jobs.filter(job => job.cwd === cwd && job.sessionId === sessionId).map(job => {
            const { payload, ...metadata } = job;
            return { ...metadata, preview: payload?.message.slice(0, 160) || '', imageCount: payload?.images.length || 0, ...(detail ? { payload } : {}) };
        });
    }

    summary() {
        if (this.error) return { error: this.error, sessions: [] };
        const sessions = new Map();
        for (const job of this.jobs.filter(job => ACTIVE.has(job.status))) {
            try { this.store.resolveProject(job.cwd); } catch { continue; }
            const key = JSON.stringify([job.cwd, job.sessionId]);
            const item = sessions.get(key) || { cwd: job.cwd, sessionId: job.sessionId, count: 0, attention: false };
            item.count++;
            item.attention ||= ['paused', 'expired', 'failed', 'uncertain'].includes(job.status);
            sessions.set(key, item);
        }
        return { sessions: [...sessions.values()] };
    }

    create(session, input) {
        if (this.disposed) throw new Error('服务正在关闭');
        const payload = validateMessage(input, { plain: true });
        const dueAt = Number(input.dueAt);
        if (!Number.isFinite(dueAt) || dueAt <= this.now() || dueAt > this.now() + 366 * 86400000) throw new Error('请选择未来一年内的发送时间');
        if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error('请求 ID 无效');
        const existing = this.jobs.find(job => job.id === input.id);
        if (existing) {
            if (existing.cwd !== session.cwd || existing.sessionId !== session.id) throw new Error('请求 ID 冲突');
            if (existing.dueAt !== dueAt || JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error('该请求已处理，请在待发送列表查看或修改');
            return existing;
        }
        return this.change(() => {
            if (this.jobs.filter(job => ACTIVE.has(job.status)).length >= 50) throw new Error('待发送消息最多 50 条');
            const job = { id: input.id, cwd: session.cwd, sessionId: session.id, dueAt, payload, status: 'scheduled', revision: 1, createdAt: this.now() };
            this.jobs.push(job);
            this.prune();
            return job;
        });
    }

    update(cwd, sessionId, id, input) {
        if (this.disposed) throw new Error('服务正在关闭');
        return this.change(() => {
            const job = this.jobs.find(item => item.id === id && item.cwd === cwd && item.sessionId === sessionId);
            if (!job) throw new Error('待发送消息不存在');
            if (job.revision !== input.revision) throw new Error('消息已在其他页面更新，请刷新');
            if (!ACTIVE.has(job.status) || job.status === 'dispatching') throw new Error('消息已提交，不能再修改或取消');
            if (input.action === 'cancel') { job.status = 'cancelled'; delete job.payload; }
            else if (input.action === 'pause') job.status = 'paused';
            else if (['save', 'send'].includes(input.action)) {
                if (job.status === 'uncertain' && input.confirmUncertain !== true) throw new Error('请先确认会话中没有这条消息，避免重复执行');
                if (input.action === 'save') {
                    job.payload = validateMessage(input, { plain: true });
                    const dueAt = Number(input.dueAt);
                    if (!Number.isFinite(dueAt) || dueAt <= this.now() || dueAt > this.now() + 366 * 86400000) throw new Error('请选择未来一年内的发送时间');
                    job.dueAt = dueAt;
                } else job.dueAt = this.now();
                job.status = 'scheduled';
            } else throw new Error('不支持的操作');
            delete job.reason;
            job.revision++;
            this.prune();
            return job;
        });
    }

    pauseAll() {
        this.assertHealthy();
        if (this.running) throw new Error('预约正在处理，请稍后再试');
        if (!this.jobs.some(job => READY.has(job.status))) return;
        this.change(() => {
            for (const job of this.jobs) if (READY.has(job.status)) {
                job.status = 'paused'; job.reason = '实例维护，完成后请重新确认发送'; job.revision++;
            }
        });
    }

    pauseSession(cwd, sessionId, reason = '会话已回退，请重新确认发送内容') {
        if (!this.jobs.some(job => job.cwd === cwd && job.sessionId === sessionId && READY.has(job.status))) return;
        this.change(() => {
            for (const job of this.jobs) {
                if (job.cwd === cwd && job.sessionId === sessionId && READY.has(job.status)) {
                    job.status = 'paused'; job.reason = reason; job.revision++;
                }
            }
        });
    }

    cancelSession(cwd, sessionId) {
        this.change(() => {
            for (const job of this.jobs) {
                if (job.cwd === cwd && job.sessionId === sessionId && ACTIVE.has(job.status)) {
                    job.status = 'cancelled'; job.revision++; delete job.payload;
                }
            }
            this.prune();
        });
    }

    prune() {
        const terminal = this.jobs.filter(job => !ACTIVE.has(job.status)).slice(-100);
        this.jobs = this.jobs.filter(job => ACTIVE.has(job.status) || terminal.includes(job));
    }

    async tick() {
        if (this.running || this.disposed || this.error || this.isSuspended()) return;
        this.running = this.dispatchDue();
        try { await this.running; } finally { this.running = null; }
    }

    async dispatchDue() {
        const ids = this.jobs.filter(job => READY.has(job.status) && job.dueAt <= this.now()).sort((a, b) => a.dueAt - b.dueAt).map(job => job.id);
        await Promise.all(ids.map(id => this.dispatch(id)));
    }

    async dispatch(id) {
        let handedOff = false;
        try {
            let job = this.jobs.find(item => item.id === id);
            const session = await this.store.getSession(job.cwd, job.sessionId);
            if (this.disposed) return;
            const worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionId: session.id, sessionPath: session.path });
            await worker.exclusive(async (rpc, runtime) => {
                await this.store.getSession(session.cwd, session.id);
                job = this.jobs.find(item => item.id === id);
                if (this.disposed || !READY.has(job.status) || job.dueAt > this.now()) return;
                const payload = validateMessage(job.payload, { plain: true });
                assertSendable(runtime, payload);
                this.change(() => { const current = this.jobs.find(item => item.id === id); current.status = 'dispatching'; current.revision++; });
                handedOff = true;
                await rpc('prompt', payload, 60000);
                this.change(() => { const current = this.jobs.find(item => item.id === id); current.status = 'sent'; current.sentAt = this.now(); current.revision++; delete current.payload; this.prune(); });
            });
        } catch (error) {
            const job = this.jobs.find(item => item.id === id);
            if (!job || !READY.has(job.status) && job.status !== 'dispatching') return;
            const status = error.code === 'SESSION_BUSY' ? 'waiting' : handedOff && error.code !== 'RPC_REJECTED' ? 'uncertain' : 'failed';
            if (job.status === status) return;
            this.change(() => {
                const current = this.jobs.find(item => item.id === id);
                current.status = status; current.revision++;
                current.reason = status === 'waiting' ? '已到时间，等待会话空闲' : status === 'uncertain' ? '无法确认投递结果，请检查会话后再决定是否重发' : '投递失败，请检查会话、模型和附件后重新确认';
            });
        }
    }

    async dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        await this.running;
    }
}

module.exports = { PiDeferredMessages };
