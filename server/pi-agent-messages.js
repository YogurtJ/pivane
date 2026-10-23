const { createHash } = require('node:crypto');
const { MESSAGE_OUT, LIMITS, messageIdFor, outboundMessage, hex64 } = require('./pi-agent-message-format');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PREPARED = 200, MAX_PREPARED_BYTES = 4 * 1024 * 1024;
const DEFAULTS = { sendsPerWindow: 30, wakesPerWindow: 12, pendingPerTarget: 20, concurrentStarts: 2, attempts: 5,
    recoveryMs: 30000, pumpMs: 1500, recoverAgeMs: 7 * 24 * 60 * 60 * 1000, threadList: 40 };
const failure = (message, code) => Object.assign(new Error(message), code ? { code } : {});

// Routes Agent-to-Agent messages between persistent threads of one project.
// Durable truth stays native: the sender's MESSAGE_OUT entry and the
// recipient's MESSAGE_IN custom message. This in-memory queue is rebuilt from
// them after a restart and never replays a message the recipient already has.
class AgentMessages {
    constructor({ catalog, supervisor, isSuspended = () => false, limits = {} }) {
        Object.assign(this, { catalog, supervisor, isSuspended });
        this.limits = { ...DEFAULTS, ...limits };
        this.queue = new Map(); this.prepared = new Map(); this.sends = new Map(); this.wakes = new Map();
        this.starting = new Set(); this.flight = null; this.recovering = null; this.stopping = false;
        this.recoveredAt = new Map();
        this.timer = setInterval(() => { void this.pump(); void this.recover(); }, this.limits.pumpMs); this.timer.unref?.();
    }
    get busy() { return Boolean(this.flight || this.recovering || this.starting.size); }
    recent(map, key) {
        const now = Date.now(), times = (map.get(key) || []).filter(time => now - time < WINDOW_MS);
        map.set(key, times); return times;
    }
    async project(cwd) {
        const snapshot = await this.catalog.refresh(cwd);
        if (!snapshot.complete) throw Object.assign(failure('Thread directory is being prepared; retry shortly. No message was sent.', 'TASK_INDEXING'), { coverage: snapshot.coverage });
        return this.catalog.threads(await this.catalog.project(cwd));
    }
    status(worker) {
        if (!worker) return 'closed';
        const activity = worker.activity?.snapshot?.();
        return activity?.busy ? activity.phase || 'running' : worker.isIdle?.() === false ? 'busy' : 'idle';
    }
    async threads(source, input = {}) {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'limit'].includes(key))
            || input.query !== undefined && !shortText(input.query, 200) || input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw failure('Invalid thread query');
        const rows = await this.project(source.cwd), query = (input.query || '').toLowerCase().trim();
        const self = rows.find(row => row.id === source.sessionId);
        const visible = rows.filter(row => !row.special).map(row => ({
            id: row.id, name: row.name, preview: row.preview, modified: row.modified,
            status: this.status(this.supervisor.getActiveWorker(row.path)),
            relation: row.id === source.sessionId ? 'self' : self?.task?.sourceSessionId === row.id ? 'parent'
                : row.task?.sourceSessionId === source.sessionId ? 'child' : self?.task && row.task?.sourceSessionId === self.task.sourceSessionId ? 'sibling' : null
        })).filter(row => !query || `${row.id} ${row.name} ${row.preview}`.toLowerCase().includes(query))
            .sort((a, b) => (a.relation === 'self') - (b.relation === 'self') || String(b.modified).localeCompare(String(a.modified)));
        const limit = input.limit || this.limits.threadList;
        return { cwd: source.cwd, self: source.sessionId, threads: visible.slice(0, limit), total: visible.length, truncated: visible.length > limit };
    }
    validate(source, input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => !['requestId', 'to', 'message', 'wake', 'replyTo', 'conversationId', 'hop', 'fromName'].includes(key))) throw failure('Invalid Agent message request');
        if (!shortText(input.requestId, 200) || !/^[A-Za-z0-9_.:-]+$/.test(input.requestId)) throw failure('Invalid requestId');
        if (typeof input.to !== 'string' || !input.to || input.to.length > 160) throw failure('Invalid recipient thread');
        if (input.to === source.sessionId) throw failure('A thread cannot message itself');
        if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > LIMITS.text) throw failure(`Message must be 1-${LIMITS.text} characters`);
        if (input.wake !== undefined && typeof input.wake !== 'boolean') throw failure('Invalid wake flag');
        for (const key of ['replyTo', 'conversationId']) if (input[key] != null && !hex64(input[key])) throw failure(`Invalid ${key}`);
        if (!Number.isInteger(input.hop) || input.hop < 0 || input.hop > 1000) throw failure('Invalid hop');
        if (input.fromName !== undefined && !shortText(input.fromName, LIMITS.name)) throw failure('Invalid sender name');
    }
    assertSource(source) {
        if (this.stopping || this.isSuspended() || this.supervisor.disposing || source.disposed || source.restarting) throw failure('Workspace is stopping');
    }
    prunePrepared() {
        const now = Date.now();
        for (const [id, item] of this.prepared) if (item.expiresAt <= now) this.prepared.delete(id);
    }
    preparedReceipt(message) {
        return { messageId: message.messageId, to: message.to, status: 'prepared', wake: message.wake, wakeSuppressed: message.wakeSuppressed,
            conversationId: message.conversationId, hop: message.hop, record: outboundMessage(message) };
    }
    matchesInput(message, input) {
        if (message.to.sessionId !== input.to || message.text !== undefined && message.text !== input.message
            || message.textHash && message.textHash !== createHash('sha256').update(input.message).digest('hex'))
            throw failure('requestId already belongs to a different message');
    }
    // Preparing has no delivery side effect. The source worker must append the
    // returned native record before publication; a lost prepare response is safe.
    async send(source, input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('Invalid Agent message request');
        if (input.phase === 'publish') return this.publish(source, input);
        if (input.phase !== undefined && input.phase !== 'prepare') throw failure('Invalid Agent message phase');
        const { phase, ...draft } = input;
        return this.prepare(source, draft);
    }
    async prepare(source, input) {
        this.validate(source, input); this.assertSource(source); this.prunePrepared();
        const messageId = messageIdFor(source.sessionId, input.requestId);
        const rows = await this.project(source.cwd);
        this.assertSource(source); this.prunePrepared();
        const target = rows.find(row => row.id === input.to);
        if (!target) throw failure('Recipient thread was not found in this project; list threads first');
        if (target.special) throw failure('That thread type cannot receive Agent messages');
        const own = rows.find(row => row.id === source.sessionId);
        if (!own) throw failure('Source thread was not found in this project');
        const existing = this.queue.get(messageId);
        if (existing) { this.matchesInput(existing.message, input); return this.receipt(existing, { reused: true }); }
        const native = own.outbox.find(message => message.messageId === messageId);
        if (native) {
            this.matchesInput(native, input);
            if (target.inbox.has(messageId)) return { messageId, to: native.to, status: 'delivered', reused: true };
            if (typeof native.text !== 'string') throw failure('Native outbound message body is unavailable');
            return { ...this.preparedReceipt(native), reused: true };
        }
        if (target.inbox.has(messageId)) return { messageId, to: { sessionId: target.id, name: target.name }, status: 'delivered', reused: true };
        const prior = this.prepared.get(messageId);
        if (prior) { this.matchesInput(prior.message, input); return this.preparedReceipt(prior.message); }
        if (this.recent(this.sends, source.sessionId).length >= this.limits.sendsPerWindow) throw failure('Message rate limit reached for this thread; wait before sending more');
        const pending = new Set([...this.queue.values()].filter(row => row.message.to.sessionId === target.id && row.status !== 'delivered' && row.status !== 'failed').map(row => row.message.messageId));
        for (const row of this.prepared.values()) if (row.message.to.sessionId === target.id) pending.add(row.message.messageId);
        for (const sender of rows) for (const message of sender.outbox)
            if (message.to.sessionId === target.id && typeof message.text === 'string' && !target.inbox.has(message.messageId)) pending.add(message.messageId);
        if (pending.size >= this.limits.pendingPerTarget) throw failure('Recipient already has too many undelivered messages; wait for it to process them');
        let wake = input.wake !== false, wakeSuppressed = null;
        if (wake && input.hop >= LIMITS.wakeHops) { wake = false; wakeSuppressed = 'hop-limit'; }
        else if (wake && this.recent(this.wakes, target.id).length >= this.limits.wakesPerWindow) { wake = false; wakeSuppressed = 'rate-limit'; }
        const message = outboundMessage({ version: 1, messageId, requestId: input.requestId,
            from: { sessionId: source.sessionId, cwd: source.cwd, name: input.fromName || own.name || '' },
            to: { sessionId: target.id, cwd: source.cwd, name: target.name }, text: input.message, wake, wakeSuppressed, hop: input.hop,
            conversationId: input.conversationId || messageId, replyTo: input.replyTo ?? null, sentAt: new Date().toISOString() });
        if (!message) throw failure('Invalid Agent message');
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (this.prepared.size >= MAX_PREPARED || [...this.prepared.values()].reduce((sum, item) => sum + item.bytes, bytes) > MAX_PREPARED_BYTES)
            throw failure('Message preparation capacity is full; wait before preparing more');
        // Reserve policy and bounded preparation synchronously after all awaits.
        this.recent(this.sends, source.sessionId).push(Date.now());
        if (wake) this.recent(this.wakes, target.id).push(Date.now());
        this.prepared.set(messageId, { message, bytes, expiresAt: Date.now() + WINDOW_MS });
        return this.preparedReceipt(message);
    }
    async publish(source, input) {
        if (Object.keys(input).some(key => !['phase', 'messageId'].includes(key)) || !hex64(input.messageId)) throw failure('Invalid Agent message publication');
        this.assertSource(source);
        const rows = await this.project(source.cwd);
        this.assertSource(source);
        const own = rows.find(row => row.id === source.sessionId);
        const message = own?.outbox.find(item => item.messageId === input.messageId);
        if (!message || message.from.sessionId !== source.sessionId || message.from.cwd !== source.cwd || message.to.cwd !== source.cwd
            || message.messageId !== messageIdFor(source.sessionId, message.requestId)) throw failure('Native outbound intent must be saved before delivery');
        const target = rows.find(row => row.id === message.to.sessionId);
        if (!target || target.special) throw failure('Recipient thread is unavailable for Agent messages');
        this.prepared.delete(message.messageId);
        if (target.inbox.has(message.messageId)) return { messageId: message.messageId, to: message.to, status: 'delivered', reused: true };
        const existing = this.queue.get(message.messageId);
        if (existing) return this.receipt(existing, { reused: true });
        if (typeof message.text !== 'string') throw failure('Native outbound message body is unavailable');
        const row = { message, path: target.path, status: 'queued', attempts: 0, error: null, deliveredAt: null, woke: false };
        this.queue.set(message.messageId, row);
        // Give an idle or quickly started recipient a moment; never wait for its model turn.
        await Promise.race([this.pump(), new Promise(resolve => setTimeout(resolve, 1500).unref?.())]);
        return this.receipt(row);
    }
    receipt(row, extra = {}) {
        const worker = this.supervisor.getActiveWorker(row.path);
        return { messageId: row.message.messageId, to: { sessionId: row.message.to.sessionId, name: row.message.to.name },
            status: row.status === 'delivered' ? 'delivered' : row.status === 'failed' ? 'failed' : row.message.wake ? 'queued' : worker ? 'queued' : 'waiting-for-recipient',
            wake: row.message.wake, wakeSuppressed: row.message.wakeSuppressed, woke: row.woke, conversationId: row.message.conversationId,
            hop: row.message.hop, recipientStatus: this.status(worker), error: row.error, ...extra };
    }
    async lookup(source, input) {
        if (!input || typeof input !== 'object' || !hex64(input.messageId)) throw failure('Invalid messageId');
        const row = this.queue.get(input.messageId);
        if (row) {
            if (row.message.from.sessionId !== source.sessionId) throw failure('Message not found for this thread');
            return this.receipt(row);
        }
        const rows = await this.project(source.cwd);
        const sent = rows.find(r => r.id === source.sessionId)?.outbox.find(message => message.messageId === input.messageId);
        if (!sent) throw failure('Message not found for this thread');
        const target = rows.find(r => r.id === sent.to.sessionId);
        return { messageId: sent.messageId, to: { sessionId: sent.to.sessionId, name: target?.name || sent.to.name },
            status: target?.inbox.has(sent.messageId) ? 'delivered' : target ? 'queued' : 'recipient-missing', wake: sent.wake, conversationId: sent.conversationId };
    }
    pump() {
        if (this.stopping || this.isSuspended() || this.flight) return this.flight || Promise.resolve();
        const flight = Promise.resolve().then(async () => {
            const targets = new Map();
            for (const row of this.queue.values()) {
                if (row.status !== 'queued') continue;
                if (!targets.has(row.path)) targets.set(row.path, []);
                targets.get(row.path).push(row);
            }
            for (const [file, rows] of targets) {
                if (this.stopping || this.isSuspended()) return;
                let worker = this.supervisor.getActiveWorker(file);
                if ((!worker || worker.disposed || worker.restarting) && rows.some(row => row.message.wake)) {
                    if (this.starting.has(file) || this.starting.size >= this.limits.concurrentStarts) continue;
                    this.starting.add(file);
                    // Waking a sleeping thread starts its single managed worker; it idles out normally later.
                    this.supervisor.getWorker({ cwd: rows[0].message.to.cwd, sessionPath: file, sessionId: rows[0].message.to.sessionId })
                        .catch(error => { for (const row of rows) this.failAttempt(row, error); })
                        .finally(() => { this.starting.delete(file); if (!this.stopping) setImmediate(() => void this.pump()); });
                    continue;
                }
                if (!worker || worker.disposed || worker.restarting || !worker.isIdle()) continue;
                const batch = rows.sort((a, b) => a.message.sentAt.localeCompare(b.message.sentAt)).slice(0, LIMITS.batch);
                for (const row of batch) row.status = 'delivering';
                try {
                    const result = await worker.agentMessages({ messages: batch.map(row => row.message) });
                    for (const row of batch) { row.status = 'delivered'; row.deliveredAt = new Date().toISOString(); row.woke = Boolean(result?.woke && row.message.wake); }
                } catch (error) {
                    for (const row of batch) {
                        if (error.code === 'SESSION_BUSY' || /busy|运行|空闲/.test(error.message)) row.status = 'queued';
                        else this.failAttempt(row, error);
                    }
                }
            }
            this.forget();
        });
        this.flight = flight;
        return flight.finally(() => { if (this.flight === flight) this.flight = null; });
    }
    failAttempt(row, error) {
        row.attempts++; row.error = String(error?.message || 'Delivery failed').slice(0, 300);
        row.status = row.attempts >= this.limits.attempts ? 'failed' : 'queued';
        if (row.status === 'failed') row.failedAt = Date.now();
    }
    forget() {
        // Keep delivered rows briefly for status and idempotent sends, then fall back to native records.
        this.prunePrepared();
        const now = Date.now();
        for (const [id, row] of this.queue) {
            if (row.status === 'delivered' && now - Date.parse(row.deliveredAt) > WINDOW_MS) this.queue.delete(id);
            else if (row.status === 'failed' && now - row.failedAt > 6 * WINDOW_MS) this.queue.delete(id);
        }
    }
    // Restart recovery: undelivered outbound records are re-queued from native sessions.
    recover() {
        if (this.stopping || this.isSuspended() || this.recovering) return this.recovering || Promise.resolve();
        const now = Date.now();
        const projects = [...new Set([...(this.supervisor.workers?.values?.() || [])].filter(w => !w.noSession && !w.disposed).map(w => w.cwd))]
            .filter(cwd => now - (this.recoveredAt.get(cwd) || 0) >= this.limits.recoveryMs);
        if (!projects.length) return Promise.resolve();
        const recovering = Promise.resolve().then(async () => {
            for (const cwd of projects) {
                if (this.stopping || this.isSuspended()) return;
                this.recoveredAt.set(cwd, Date.now());
                let rows; try { rows = await this.project(cwd); } catch { continue; }
                const byId = new Map(rows.map(row => [row.id, row]));
                for (const sender of rows) for (const message of sender.outbox) {
                    this.prepared.delete(message.messageId); // Native intent now owns recovery.
                    if (message.text === undefined || this.queue.has(message.messageId) || now - Date.parse(message.sentAt) > this.limits.recoverAgeMs) continue;
                    const target = byId.get(message.to.sessionId);
                    if (!target || target.special || target.inbox.has(message.messageId) || message.to.cwd !== cwd) continue;
                    this.queue.set(message.messageId, { message: { ...message, to: { ...message.to, name: target.name } }, path: target.path, status: 'queued', attempts: 0, error: null, deliveredAt: null, woke: false, recovered: true });
                }
            }
        });
        this.recovering = recovering;
        return recovering.catch(() => {}).finally(() => { if (this.recovering === recovering) this.recovering = null; });
    }
    async dispose() {
        this.stopping = true; clearInterval(this.timer); this.prepared.clear();
        await Promise.allSettled([this.flight, this.recovering].filter(Boolean));
    }
}
function shortText(value, max) { return typeof value === 'string' && value.length <= max; }

function mountAgentMessages(router, { service }) {
    for (const action of ['threads', 'send', 'status']) router.post(`/agent-messages/${action}`, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const source = req.workspaceIdentity?.kind === 'agent-thread' && req.workspaceIdentity.worker;
            if (!source || source.disposed || source.restarting || source.noSession) return res.status(403).json({ error: 'A live source Agent thread is required' });
            const data = action === 'threads' ? await service.threads(source, req.body || {})
                : action === 'send' ? await service.send(source, req.body) : await service.lookup(source, req.body);
            res.json(data);
        } catch (error) {
            res.status(error.code === 'TASK_INDEXING' ? 202 : 400).json({ error: error.message, code: error.code,
                ...(error.coverage ? { status: 'indexing', coverage: error.coverage } : {}) });
        }
    });
}
module.exports = { AgentMessages, mountAgentMessages, MESSAGE_OUT };
