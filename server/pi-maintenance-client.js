const { randomUUID } = require('node:crypto');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
class MaintenanceClient {
    constructor({ send, managed = Boolean(process.send && process.env.PI_MANAGED_LAUNCHER), nonce = process.env.PI_MANAGED_LAUNCHER } = {}) {
        this.managed = managed; this.nonce = nonce;
        this.send = send || (message => {
            if (!process.connected) throw new Error('Maintenance IPC is disconnected');
            process.send({ ...message, nonce: this.nonce }, error => {
                if (error) this.state = { ...this.state, transportUncertain: true };
            });
        });
        this.locked = managed; this.active = 0; this.tickets = new Map();
        this.state = { supported: false, busy: false, reason: 'managed-launcher-required' };
        this.generation = randomUUID();
    }
    receive(message) {
        if (message?.nonce !== this.nonce) return;
        if (message.type === 'maintenance-status') {
            if (this.pendingId && message.status?.job?.id !== this.pendingId) return;
            this.state = message.status;
        }
        if (message.type === 'maintenance-activate' || message.type === 'maintenance-release' && message.id === this.state.job?.id) { this.locked = false; this.pendingId = null; }
        if (message.type === 'maintenance-rejected' && message.id === this.state.job?.id) { this.locked = false; this.pendingId = null; this.state = { ...this.state, busy: false, job: { id: message.id, phase: 'failed', error: 'rejected' } }; }
    }
    enter() {
        if (this.locked) throw fail('实例正在维护，请等待完成');
        this.active++; let released = false;
        return () => { if (!released) { released = true; this.active--; } };
    }
    http(req, res, next) {
        if (!req.path.startsWith('/api/') || req.path.startsWith('/api/pi/settings/updates') || req.method === 'GET' && req.path === '/api/access/status') return next();
        let leave;
        try { leave = this.enter(); } catch (error) { return res.status(503).json({ error: error.message }); }
        const end = res.end;
        res.end = function (...args) { leave(); return end.apply(this, args); };
        // A disconnected response alone does not imply its asynchronous work stopped.
        res.once('finish', leave);
        next();
    }
    status() { return { ...this.state, busy: this.locked || this.state.busy, generation: this.generation }; }
    assertAvailable(action, idle) {
        if (!this.managed || !this.state.supported) throw fail('请通过 npm start 启用独立维护启动器', 503);
        if (this.locked || this.state.busy || this.active || !idle()) throw fail('实例仍有任务、侧聊、临时会话、配置或请求正在处理，请完成后再试');
        if (action === 'application' && !this.state.appUpdateSupported) throw fail('当前启动器不支持 Pivane 应用更新，请先加载新版启动器');
        if (action === 'update' && !this.state.updateSupported) throw fail('Pi 更新需要 Node 22 或 24 和默认的本地 Pi 安装');
    }
    review({ action, version, release }, idle) {
        if (!['update', 'application', 'backup', 'restart'].includes(action)) throw fail('维护操作无效', 400);
        this.assertAvailable(action, idle);
        for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= Date.now()) this.tickets.delete(id);
        if (this.tickets.size >= 16) throw fail('待确认维护操作过多，请稍后再试', 429);
        const ticket = { id: randomUUID(), action, version: version || null, ...(release ? { release: { ...release } } : {}), generation: this.generation, expiresAt: Date.now() + 10 * 60 * 1000 };
        this.tickets.set(ticket.id, ticket); return { ...ticket, storage: this.state.storage, backupScope: this.state.backupScope };
    }
    execute(input, { idle, pause }) {
        if (input?.confirmed !== true || input.externalWritersStopped !== true || input.draftsSaved !== true || Object.keys(input).some(k => !['ticket', 'confirmed', 'externalWritersStopped', 'draftsSaved'].includes(k))) throw fail('请确认已保存草稿并停止使用同一数据的外部 Pi 进程', 400);
        const ticket = this.tickets.get(input.ticket);
        if (!ticket || ticket.expiresAt <= Date.now() || ticket.generation !== this.generation) throw fail('维护确认已失效，请重新检查');
        this.assertAvailable(ticket.action, idle);
        this.locked = true; this.tickets.clear();
        try { pause(); } catch { this.locked = false; throw fail('预约暂停失败，尚未提交维护操作'); }
        const id = ticket.id; this.pendingId = id;
        this.state = { ...this.state, busy: true, job: { id, action: ticket.action, targetVersion: ticket.version, phase: 'preparing' } };
        try { this.send({ type: 'maintenance-request', id, action: ticket.action, version: ticket.version, ...(ticket.release ? { release: ticket.release } : {}) }); }
        catch { throw fail('维护提交结果未知，请查看状态，不要重复提交', 503); }
        return { id, accepted: true };
    }
}
module.exports = { MaintenanceClient };
