const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { ChannelStore, pending } = require('./store');
const { WeixinComponent } = require('./weixin-component');
const { WeixinAdapter, createTransport, validId } = require('./weixin-adapter');
const { outcome } = require('./runtime');
const { DeliverableStore } = require('../pi-deliverables');
const { sessionStats } = require('../pi-session-store');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => a?.cwd === b?.cwd && a?.sessionId === b?.sessionId;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const SLASH_COMMANDS = new Set(['/help', '/status', '/stop', '/new', '/reset', '/resume', '/name', '/model', '/thinking', '/compact', '/reload']);
function fmtTokens(n) {
    if (!Number.isFinite(n) || n < 0) return null;
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(Math.round(n));
}
function parseSlash(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith('/')) return null;
    const match = /^(\/[a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!match) return null;
    const cmd = match[1].toLowerCase();
    return SLASH_COMMANDS.has(cmd) ? { command: cmd, args: (match[2] || '').trim() } : null;
}
class ChannelsService {
    constructor({ store, supervisor, isSuspended = () => false, directory, componentFactory, adapterFactory }) {
        Object.assign(this, { store, supervisor, isSuspended, directory, componentFactory, adapterFactory });
        this.deliverables = new DeliverableStore(store);
        this.mutating = false; this.operations = new Set(); this.pollers = new Map(); this.runs = new Map(); this.connections = new Map();
        this.stopping = false; this.stopController = new AbortController(); this.login = null; this.loginFlight = null; this.error = null;
        this.initializing = true;
        this.ready = this.initialize().catch(() => { this.error = '消息渠道记录或组件无法读取，已停止连接，请检查安装与数据。'; }).finally(() => { this.initializing = false; });
    }
    async initialize() {
        this.directory ||= path.join((await require('../pi-session-store').getSdk()).getAgentDir(), 'pivane-channels');
        this.db = new ChannelStore(this.directory);
        this.component = this.componentFactory?.(this.directory) || new WeixinComponent(this.directory);
        if (this.db.value.accounts.some(a => a.enabled)) {
            this.db.claim();
            try { await this.ensureAdapter(); this.start(); }
            catch { this.componentError = '微信组件无法加载，请先停用连接，再卸载并重新安装组件。'; }
        }
    }
    get busy() { return this.initializing || this.mutating || Boolean(this.login && Date.now() < this.login.expiresAt) || Boolean(this.loginFlight) || this.operations.size > 0 || this.runs.size > 0; }
    healthy() { if (this.error) throw fail(this.error); if (this.stopping || this.isSuspended()) throw fail('工作台正在维护，请稍后再试', 409); }
    async ensureAdapter() {
        if (!this.adapter) this.adapter = this.adapterFactory ? await this.adapterFactory() : new WeixinAdapter(await this.component.load(createTransport(this.stopController.signal, () => this.login?.controller?.signal)));
        return this.adapter;
    }
    track(promise) { this.operations.add(promise); promise.finally(() => this.operations.delete(promise)).catch(() => {}); return promise; }
    start() {
        if (!this.timer) { this.timer = setInterval(() => { void this.pump(); }, 1000); this.timer.unref?.(); }
        for (const account of this.db.value.accounts) if (account.enabled && !this.pollers.has(account.id)) this.startPoll(account.id);
    }
    async snapshot() {
        await this.ready;
        if (this.login && Date.now() >= this.login.expiresAt) { this.login.controller?.abort(); this.login = null; }
        let component = { installed: false };
        try { component = this.component?.status() || component; }
        catch { component = { installed: true, broken: true, error: '微信组件校验失败，请先停用连接，再卸载并重新安装。' }; }
        if (this.componentError) component.error = this.componentError;
        return { revision: this.db?.value.revision, error: this.error, busy: this.mutating, component,
            accounts: (this.db?.value.accounts || []).map(({ id, userId, enabled, allowedUsers }) => ({ id, userId, enabled, allowedUsers, connection: this.connections.get(id) || (enabled ? 'starting' : 'disabled') })),
            bindings: this.db?.value.bindings || [], peers: (this.db?.value.peers || []).map(({ accountId, peerId, lastSeenAt }) => ({ accountId, peerId, lastSeenAt })),
            jobs: (this.db?.value.jobs || []).slice(-60).reverse().map(({ id, accountId, peerId, target, status, reason, at, sentChunks, sentMedia, waiting, sendStarted, kind }) => ({ id, accountId, peerId, target, status, reason, at, sentChunks, sentMedia, waiting, kind, canRecover: status === 'uncertain' && !sendStarted })),
            login: this.login ? { id: this.login.id, matrix: this.login.matrix, status: this.login.status, expiresAt: this.login.expiresAt } : null,
            capabilities: { text: true, images: true, files: true, slashCommands: true, typing: true, groups: false, proactive: true } };
    }
    claim() { this.db.claim(); }
    async action(input) {
        await this.ready; this.healthy();
        if (this.mutating) throw fail('渠道配置正在处理，请刷新核对', 409);
        if (!input || input.confirmed !== true || typeof input.action !== 'string' || input.expectedRevision !== this.db.value.revision) throw fail('配置已变化或操作未确认，请刷新核对', 409);
        const fields = ['action', 'confirmed', 'expectedRevision', 'accountId', 'enabled', 'allowedUsers', 'peerId', 'cwd', 'sessionId', 'newSession', 'jobId', 'loginId', 'code'];
        if (Object.keys(input).some(key => !fields.includes(key))) throw fail('未知渠道参数');
        this.mutating = true;
        try {
            this.claim();
            const action = input.action;
            if (action === 'install') { await this.component.install(this.stopController.signal); this.componentError = null; }
            else if (action === 'uninstall') {
                if (this.db.value.accounts.some(a => a.enabled) || this.runs.size || this.login || this.loginFlight || this.pollers.size) throw fail('请先停用连接并结束登录，再卸载组件');
                this.component.uninstall(); this.adapter = null; this.componentError = null;
            } else if (action === 'login') {
                if (this.login || this.loginFlight) throw fail('已有登录正在进行');
                await this.ensureAdapter();
                const login = await this.adapter.loginStart(this.stopController.signal, this.db.value.accounts.map(a => a.token));
                this.healthy(); this.login = { ...login, controller: new AbortController() }; this.scheduleLogin();
            } else if (action === 'cancel-login') {
                if (input.loginId !== this.login?.id) throw fail('登录已变化');
                this.login.controller?.abort(); this.login = null;
            } else if (action === 'verify-login') {
                if (input.loginId !== this.login?.id || this.login.status !== 'need_verifycode' || !/^\d{1,12}$/.test(input.code || '')) throw fail('验证码或登录状态无效');
                this.login.code = input.code; this.login.status = 'wait'; this.scheduleLogin();
            } else if (action === 'account') {
                const account = this.db.value.accounts.find(a => a.id === input.accountId);
                if (!account || typeof input.enabled !== 'boolean' || !Array.isArray(input.allowedUsers) || input.allowedUsers.length > 100 || !input.allowedUsers.every(validId)) throw fail('微信账号或允许用户无效');
                const allow = [...new Set(input.allowedUsers)];
                if (input.enabled && !allow.length) throw fail('启用前请指定允许使用的微信用户');
                if (input.enabled) await this.ensureAdapter();
                this.healthy();
                this.db.change(v => {
                    Object.assign(v.accounts.find(a => a.id === account.id), { enabled: input.enabled, allowedUsers: allow });
                    for (const j of v.jobs) if (j.accountId === account.id && j.status === 'queued' && (!input.enabled || !allow.includes(j.peerId))) { j.status = 'cancelled'; delete j.text; delete j.images; }
                }, { config: true, revision: input.expectedRevision });
                if (!input.enabled) { await this.stopPoll(account.id); this.connections.set(account.id, 'disabled'); }
                else this.start();
            } else if (action === 'bind') {
                const account = this.db.value.accounts.find(a => a.id === input.accountId);
                if (!account || !validId(input.peerId) || !account.allowedUsers.includes(input.peerId)) throw fail('请先将此微信用户加入允许列表');
                if (this.db.value.bindings.length >= 200) throw fail('绑定数量超过限制');
                this.assertPeerIdle(account.id, input.peerId);
                const cwd = this.store.resolveProject(input.cwd);
                let session;
                if (input.newSession === true) session = await this.store.createSession(cwd, '微信对话');
                else session = await this.store.getSession(cwd, input.sessionId);
                await this.store.withSessionRead(cwd, session.id, async (_session, read) => {
                    if (read.manager().getEntries().some(e => e.type === 'custom' && ['pivane-extension-assistant', 'pivane-profile-authoring'].includes(e.customType))) throw fail('管理助手线程不能绑定外部聊天');
                    read.validate();
                });
                this.healthy();
                this.db.change(v => {
                    v.bindings = v.bindings.filter(b => !(b.accountId === account.id && b.peerId === input.peerId));
                    v.bindings.push({ id: randomUUID(), accountId: account.id, peerId: input.peerId, cwd: session.cwd, sessionId: session.id, name: session.name || '微信对话' });
                }, { config: true, revision: input.expectedRevision });
            } else if (action === 'unbind') {
                this.assertPeerIdle(input.accountId, input.peerId);
                this.db.change(v => { v.bindings = v.bindings.filter(b => !(b.accountId === input.accountId && b.peerId === input.peerId)); }, { config: true });
            } else if (action === 'acknowledge') {
                const job = this.job(input.jobId);
                if (!job || this.runs.has(job.id) || !['uncertain', 'failed', 'ready'].includes(job.status)) throw fail('此消息不能标记为已核对');
                this.updateJob(job.id, { status: 'reviewed', reason: 'user-reviewed', text: undefined, images: undefined, directReply: undefined });
            } else if (action === 'recover') {
                const job = this.job(input.jobId);
                if (!job || job.status !== 'uncertain' || job.sendStarted || this.runs.has(job.id)) throw fail('此消息不能恢复自动发送，请在网页查看回复');
                const result = job.directReply ? { status: 'completed', body: job.directReply } : await this.readOutcome(job);
                if (!result || !['completed', 'error', 'stopped'].includes(result.status)) throw fail('未找到原生完成记录；不会重新运行任务');
                this.updateJob(job.id, { status: 'ready', reason: null, text: undefined, images: undefined });
            } else if (action === 'stop') {
                const job = this.job(input.jobId), run = job && this.runs.get(job.id);
                if (!run?.worker || run.worker.channelRun !== job.id) throw fail('此微信任务当前没有运行');
                await run.worker.request('abort');
            } else throw fail('不支持的渠道操作');
            return { ...await this.snapshot(), busy: false };
        } finally { this.mutating = false; }
    }
    assertPeerIdle(accountId, peerId) {
        if (this.db.value.jobs.some(j => j.accountId === accountId && j.peerId === peerId && pending(j))) throw fail('此聊天还有待处理或待核对消息，请先处理后更改绑定', 409);
    }
    assertUnbound(cwd, sessionId) {
        if (this.initializing || this.error || !this.db) throw fail('消息渠道状态尚无法核对，请先处理后再删除或移动线程', 409);
        if (this.mutating) throw fail('消息渠道配置正在处理，请稍后再操作线程', 409);
        if (this.db?.value.bindings.some(b => b.cwd === cwd && b.sessionId === sessionId)) throw fail('请先解除此线程的消息渠道绑定', 409);
    }
    scheduleLogin() {
        if (this.loginFlight || !this.login || this.stopping) return;
        const login = this.login;
        const promise = (async () => {
            while (this.login === login && !this.stopping && Date.now() < login.expiresAt) {
                if (this.isSuspended()) return;
                const code = login.code; delete login.code;
                let response;
                try { response = await this.adapter.loginPoll(login, code); }
                catch { if (this.login === login) login.status = 'error'; return; }
                if (this.login !== login || this.stopping || this.isSuspended()) return;
                if (Date.now() >= login.expiresAt) { this.login = null; return; }
                login.status = response.status;
                if (response.account) {
                    this.db.change(v => {
                        const old = v.accounts.find(a => a.id === response.account.id);
                        if (old) Object.assign(old, { token: response.account.token, baseUrl: response.account.baseUrl, userId: response.account.userId });
                        else { if (v.accounts.length >= 10) throw fail('最多连接 10 个微信账号'); v.accounts.push(response.account); }
                    }, { config: true });
                    this.login = null; this.start(); return;
                }
                if (['need_verifycode', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(response.status)) return;
                await delay(750, undefined, { signal: this.stopController.signal });
            }
            if (this.login === login) this.login = null;
        })();
        this.loginFlight = promise;
        promise.catch(() => { if (this.login === login) login.status = 'error'; }).finally(() => {
            if (this.loginFlight === promise) this.loginFlight = null;
            if (this.login === login && login.code && login.status === 'wait' && !this.stopping) this.scheduleLogin();
        });
    }
    startPoll(accountId) {
        if (this.stopping || this.pollers.has(accountId)) return;
        const controller = new AbortController(), poller = { controller, promise: null };
        this.pollers.set(accountId, poller);
        poller.promise = (async () => {
            let announced = false, failures = 0;
            while (!this.stopping && !controller.signal.aborted) {
                const account = this.db.value.accounts.find(a => a.id === accountId);
                if (!account?.enabled) return;
                if (this.isSuspended() || this.mutating) { await delay(500, undefined, { signal: controller.signal }); continue; }
                try {
                    if (!announced) { await this.adapter.notify(account, true); announced = true; }
                    const result = await this.adapter.poll(account, controller.signal);
                    if (controller.signal.aborted || this.stopping || this.isSuspended()) continue;
                    try { this.receive(accountId, result); }
                    catch { this.error = '渠道消息记录保存失败，已停止接收与投递，请核对数据文件。'; return; }
                    this.connections.set(accountId, 'connected'); failures = 0;
                    await delay(250, undefined, { signal: controller.signal });
                } catch (error) {
                    if (controller.signal.aborted || this.stopping) return;
                    this.connections.set(accountId, 'error'); failures++;
                    await delay(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal: controller.signal });
                }
            }
        })();
        poller.promise.catch(() => {}).finally(() => { if (this.pollers.get(accountId) === poller) this.pollers.delete(accountId); });
    }
    async stopPoll(id) {
        const poller = this.pollers.get(id); if (!poller) return;
        poller.controller.abort(); await poller.promise.catch(() => {});
        const account = this.db.value.accounts.find(a => a.id === id);
        if (account && this.adapter && !this.stopping) await this.adapter.notify(account, false).catch(() => {});
    }
    receive(accountId, response) {
        const current = this.db.value.accounts.find(a => a.id === accountId);
        if (!(response.msgs?.length) && (response.get_updates_buf === undefined || response.get_updates_buf === current?.cursor)) return;
        this.db.change(v => {
            const account = v.accounts.find(a => a.id === accountId); if (!account?.enabled) return;
            for (const raw of response.msgs || []) {
                const msg = this.adapter.message(raw);
                if (!msg || !account.allowedUsers.includes(msg.peerId)) continue;
                const id = digest(['weixin', accountId, msg.peerId, msg.messageId]);
                if (v.jobs.some(j => j.id === id)) continue;
                let peer = v.peers.find(p => p.accountId === accountId && p.peerId === msg.peerId);
                if (!peer) { if (v.peers.length >= 500) continue; peer = { accountId, peerId: msg.peerId, contextToken: '' }; v.peers.push(peer); }
                Object.assign(peer, { ...(msg.contextToken ? { contextToken: msg.contextToken } : {}), lastSeenAt: Date.now() });
                const binding = v.bindings.find(b => b.accountId === accountId && b.peerId === msg.peerId);
                const activeCount = v.jobs.filter(j => pending(j) && j.accountId === accountId && j.peerId === msg.peerId).length;
                const slash = !msg.images?.length ? parseSlash(msg.text) : null;
                const isControl = Boolean(slash && ['/stop', '/status', '/help'].includes(slash.command));
                const isStop = slash?.command === '/stop';
                const stopQueued = isStop && v.jobs.some(j => pending(j) && j.accountId === accountId && j.peerId === msg.peerId && parseSlash(j.text)?.command === '/stop');
                const hasContent = Boolean(msg.text.trim() || msg.images?.length);
                const reason = !binding ? 'unbound' : msg.unsupported ? 'unsupported-message' : !hasContent ? 'empty-message'
                    : !peer.contextToken && !isStop ? 'reply-context-missing' : stopQueued ? 'stop-already-queued' : activeCount >= 20 && !isControl ? 'queue-full' : null;
                v.jobs.push({ id, accountId, peerId: msg.peerId, target: binding ? { cwd: binding.cwd, sessionId: binding.sessionId } : null,
                    bindingId: binding?.id, status: reason ? 'ignored' : 'queued', reason, at: Date.now(),
                    ...(reason ? {} : { text: msg.text, ...(msg.images?.length ? { images: msg.images } : {}) }) });
            }
            // Cursor commits with admitted intents and deduplication receipts.
            if (typeof response.get_updates_buf === 'string') account.cursor = response.get_updates_buf;
            while (v.jobs.length > 4500) { const index = v.jobs.findIndex(j => !pending(j)); if (index < 0) throw fail('渠道消息记录已满'); v.jobs.splice(index, 1); }
        });
    }
    async notifyScheduledRun(event) {
        await this.ready;
        if (this.stopping || this.error || !this.db?.owner || !event?.target) return;
        const bindings = this.db.value.bindings.filter(b => b.cwd === event.target.cwd && b.sessionId === event.target.sessionId);
        if (!bindings.length) return;
        let replyText = '';
        let deliverables = [];
        try {
            const session = await this.store.getSession(event.target.cwd, event.target.sessionId);
            await this.store.withSessionRead(session.cwd, session.id, async (_s, read) => {
                const branch = read.manager().getBranch();
                const entry = event.replyEntryId && branch.find(e => e.id === event.replyEntryId);
                if (entry?.type === 'message' && entry.message?.role === 'assistant') {
                    replyText = (entry.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
                }
                const start = branch.findLastIndex(e => e.type === 'custom' && e.customType === 'pivane-cron-run' && e.data?.runId === event.runId);
                if (start >= 0) {
                    const seen = new Set();
                    for (const item of branch.slice(start + 1)) {
                        if (item.type === 'custom' && item.customType === 'pivane-deliverable' && item.data?.id && item.data.manifestRevision) {
                            const key = `${item.data.id}:${item.data.manifestRevision}`;
                            if (!seen.has(key)) { seen.add(key); deliverables.push({ id: item.data.id, manifestRevision: item.data.manifestRevision }); }
                        }
                    }
                }
                read.validate();
            });
        } catch { return; }
        const header = `⏰ 定时任务「${event.name}」`;
        const body = event.status === 'stopped' ? `${header}已停止。`
            : event.status === 'error' ? `${header}执行失败，请在 Pivane 网页查看。`
            : `${header}\n\n${replyText || '已完成，请在 Pivane 网页查看结果。'}`;
        this.db.change(v => {
            for (const binding of bindings) {
                const account = v.accounts.find(a => a.id === binding.accountId);
                if (!account?.enabled || !account.allowedUsers.includes(binding.peerId)) continue;
                const peer = v.peers.find(p => p.accountId === binding.accountId && p.peerId === binding.peerId);
                const id = digest(['weixin-cron', event.runId, binding.accountId, binding.peerId]);
                if (v.jobs.some(j => j.id === id)) continue;
                const reason = !peer?.contextToken ? 'reply-context-missing' : null;
                v.jobs.push({ id, kind: 'cron', accountId: binding.accountId, peerId: binding.peerId,
                    target: { cwd: binding.cwd, sessionId: binding.sessionId }, bindingId: binding.id,
                    status: reason ? 'ignored' : 'ready', reason, at: Date.now(),
                    ...(reason ? {} : { directReply: body.slice(0, 60000), deliverables }) });
            }
            while (v.jobs.length > 4500) { const index = v.jobs.findIndex(j => !pending(j)); if (index < 0) break; v.jobs.splice(index, 1); }
        });
        this.pump();
    }
    job(id) { return this.db.value.jobs.find(j => j.id === id); }
    updateJob(id, changes) { this.db.change(v => { const j = v.jobs.find(j => j.id === id); if (j) Object.assign(j, changes); }); }
    pump() {
        if (this.stopping || this.isSuspended() || this.mutating || this.error || !this.db?.owner) return;
        for (const job of this.db.value.jobs) {
            const slash = job.status === 'queued' && !job.images?.length ? parseSlash(job.text) : null;
            const control = Boolean(slash && ['/stop', '/status', '/help'].includes(slash.command));
            if (this.runs.size >= (control ? 4 : 3)) continue;
            if (!['queued', 'ready'].includes(job.status) || this.runs.has(job.id)) continue;
            const account = this.db.value.accounts.find(a => a.id === job.accountId);
            if (!account?.enabled || !account.allowedUsers.includes(job.peerId)) continue;
            if (!control && ([...this.runs.values()].some(r => same(r.target, job.target)) || this.db.value.jobs.some(j => j.id !== job.id && same(j.target, job.target) && j.status === 'uncertain'))) continue;
            const run = { target: job.target, worker: null, promise: null }; this.runs.set(job.id, run);
            run.promise = Promise.resolve().then(() => this.run(job.id, run)).catch(() => {
                try { this.updateJob(job.id, { status: 'uncertain', reason: 'execution-or-delivery-uncertain' }); }
                catch { this.error = '渠道投递记录无法保存，已停止后续投递'; }
            }).finally(() => this.runs.delete(job.id));
        }
    }
    bindingFor(job) {
        return this.db.value.bindings.find(b => b.id === job.bindingId && b.accountId === job.accountId && b.peerId === job.peerId && same(b, job.target));
    }
    canAdmit(job) {
        const account = this.db.value.accounts.find(a => a.id === job?.accountId);
        return !this.stopping && !this.isSuspended() && ['queued', 'dispatching'].includes(job?.status)
            && Boolean(account?.enabled && account.allowedUsers.includes(job.peerId) && this.bindingFor(job));
    }
    async startTyping(account, peerId) {
        const peer = this.db.value.peers.find(p => p.accountId === account.id && p.peerId === peerId);
        if (!peer?.contextToken || !this.adapter?.typing) return () => Promise.resolve();
        let ticket = peer.typingTicket || '';
        try {
            if (!ticket && this.adapter.typingTicket) {
                ticket = await this.adapter.typingTicket(account, peer);
                if (ticket) this.db.change(v => { const p = v.peers.find(x => x.accountId === account.id && x.peerId === peerId); if (p) p.typingTicket = ticket; });
            }
        } catch { ticket = ''; }
        if (!ticket) return () => Promise.resolve();
        const send = active => this.adapter.typing(account, peer, ticket, active).catch(() => {});
        await send(true);
        const timer = setInterval(() => { if (!this.stopping && !this.isSuspended()) void send(true); }, 5000);
        timer.unref?.();
        let stopped = false;
        return async () => {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            await send(false);
        };
    }
    async handleSlash(job, slash, run) {
        const binding = this.bindingFor(job);
        if (!binding) return null;
        const busyWithOther = () => [...this.runs.entries()].some(([key, r]) => key !== job.id && same(r.target, job.target));
        const bindToSession = targetSession => {
            const newBindingId = randomUUID();
            this.db.change(v => {
                v.bindings = v.bindings.filter(b => !(b.accountId === job.accountId && b.peerId === job.peerId));
                v.bindings.push({ id: newBindingId, accountId: job.accountId, peerId: job.peerId, cwd: targetSession.cwd, sessionId: targetSession.id, name: targetSession.name || targetSession.id });
                const current = v.jobs.find(j => j.id === job.id);
                if (current) { current.bindingId = newBindingId; current.target = { cwd: targetSession.cwd, sessionId: targetSession.id }; }
            }, { config: true });
        };
        if (slash.command === '/help') {
            return [
                '📋 微信可用指令：',
                '/status — 查看当前线程详情、上下文用量、模型与统计',
                '/stop — 停止当前正在运行的任务',
                '/new [标题] — 新建线程并切换微信绑定（别名 /reset）',
                '/resume [序号|关键词|ID] — 查看最近线程列表或切换绑定线程',
                '/name <新标题> — 重命名当前绑定的线程',
                '/model [模型名] — 查看或切换当前线程模型',
                '/thinking [等级] — 查看或切换思考等级（如 off/low/medium/high）',
                '/compact [附加要求] — 手动压缩当前线程上下文',
                '/reload — 重新加载当前线程的技能、提示词与扩展资源',
                '/help — 查看此帮助说明'
            ].join('\n');
        }
        if (slash.command === '/stop') {
            const targetRun = [...this.runs.entries()].find(([key, r]) => key !== job.id && same(r.target, job.target) && r.worker);
            if (targetRun?.[1].worker) {
                await targetRun[1].worker.request('abort');
                return '';
            }
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            const active = this.supervisor.getActiveWorker(session.path);
            if (active && !active.isIdle()) {
                await active.request('abort').catch(() => {});
                return '⏹ 已向当前线程发送停止请求。';
            }
            return '当前线程没有正在运行的任务。';
        }
        if (slash.command === '/status') {
            let offlineStats = null;
            const session = await this.store.withSessionRead(binding.cwd, binding.sessionId, (s, read) => {
                offlineStats = sessionStats(read.manager());
                return s;
            });
            const worker = this.supervisor.getActiveWorker(session.path);
            const running = [...this.runs.entries()].find(([key, r]) => key !== job.id && same(r.target, job.target) && r.worker);
            const waitingJob = running && this.job(running[0])?.waiting;
            let modelText = offlineStats?.model?.id ? `${offlineStats.model.provider ? offlineStats.model.provider + '/' : ''}${offlineStats.model.id}` : '将在首次运行时加载';
            let stateText = worker ? (worker.isIdle() ? '空闲' : '运行中') : '未打开（空闲）';
            if (waitingJob) stateText = '⚠️ 等待网页交互确认';
            let contextLine = null;
            let messagesCount = offlineStats?.messages ?? session.messageCount ?? 0;
            const compactionsCount = offlineStats?.compactions ?? 0;
            const contextKept = offlineStats?.context ?? messagesCount;
            let usageLine = null;
            if (worker) {
                try {
                    const [state, stats] = await Promise.all([
                        worker.request('get_state'),
                        worker.request('get_session_stats').catch(() => null)
                    ]);
                    if (state.model) modelText = `${state.model.provider}/${state.model.id}（思考：${state.thinkingLevel || '默认'}）`;
                    if (state.isCompacting) stateText = '正在压缩上下文';
                    const autoCompact = state.autoCompactionEnabled !== false ? '开启' : '关闭';
                    stateText += ` · 自动压缩：${autoCompact}`;
                    if (stats?.totalMessages != null) messagesCount = stats.totalMessages;
                    const cu = stats?.contextUsage;
                    if (cu && Number.isFinite(cu.percent) && Number.isFinite(cu.tokens)) {
                        const cap = Number.isFinite(cu.contextWindow) ? ` / ${fmtTokens(cu.contextWindow)}` : '';
                        contextLine = `${Math.round(cu.percent)}%（${fmtTokens(cu.tokens)}${cap} tokens）`;
                    } else if (cu && Number.isFinite(cu.contextWindow)) {
                        const est = offlineStats?.contextTokens ? `约 ${fmtTokens(offlineStats.contextTokens)}` : '--';
                        contextLine = `${est} / ${fmtTokens(cu.contextWindow)} tokens`;
                    }
                    const tok = stats?.tokens;
                    if (tok && (tok.input || tok.output || tok.cacheRead)) {
                        const parts = [
                            `输入 ${fmtTokens(tok.input || 0)}`,
                            `输出 ${fmtTokens(tok.output || 0)}`,
                            ...(tok.cacheRead ? [`缓存 ${fmtTokens(tok.cacheRead)}`] : [])
                        ];
                        if (Number.isFinite(Number(stats.cost)) && Number(stats.cost) > 0) parts.push(`约 $${Number(stats.cost).toFixed(3)}`);
                        usageLine = parts.join(' / ');
                    }
                } catch {}
            }
            if (!contextLine && offlineStats?.contextTokens) {
                contextLine = `最近约 ${fmtTokens(offlineStats.contextTokens)} tokens`;
            }
            const profileName = session.agentProfile?.name || '无身份';
            const recordParts = [`共 ${messagesCount} 条消息`];
            if (compactionsCount > 0) recordParts.push(`已压缩 ${compactionsCount} 次（当前保留 ${contextKept} 条）`);
            const lines = [
                `📌 线程：${session.name || session.id}`,
                `🆔 会话 ID：${session.id}`,
                `📁 项目：${session.cwd}`,
                `👤 身份：${profileName}`,
                `⚙️ 状态：${stateText}`,
                `🤖 模型：${modelText}`,
                `📊 上下文：${contextLine || '暂无统计'}`,
                `💬 记录：${recordParts.join(' · ')}`
            ];
            if (usageLine) lines.push(`💰 累计用量：${usageLine}`);
            if (session.modified) {
                const d = new Date(session.modified);
                if (Number.isFinite(d.getTime())) lines.push(`🕒 更新于：${d.toLocaleString('zh-CN', { hour12: false })}`);
            }
            return lines.join('\n');
        }
        if (slash.command === '/new' || slash.command === '/reset') {
            if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请先发送 /stop 或等待完成后再新建线程。';
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            const active = this.supervisor.getActiveWorker(session.path);
            if (active && !active.isIdle()) return '⚠️ 当前线程正忙，请稍后再新建线程。';
            const title = slash.args ? slash.args.slice(0, 80) : '微信对话';
            const created = await this.store.createSession(binding.cwd, title);
            bindToSession(created);
            return `✅ 已新建并绑定线程：${created.name || created.id}\n🆔 会话 ID：${created.id}\n原线程历史已完整保留。`;
        }
        if (slash.command === '/resume') {
            if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请先发送 /stop 或等待完成后再切换线程。';
            const currentSession = await this.store.getSession(binding.cwd, binding.sessionId);
            const active = this.supervisor.getActiveWorker(currentSession.path);
            if (active && !active.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再切换线程。';
            const allSessions = await this.store.listSessions(binding.cwd);
            if (!allSessions.length) return '当前项目下暂无可切换的会话线程。';
            const formatList = (list, headerText) => {
                const candidateIds = list.map(s => s.id);
                this.db.change(v => {
                    const p = v.peers.find(x => x.accountId === job.accountId && x.peerId === job.peerId);
                    if (p) p.resumeCandidates = candidateIds;
                });
                const rows = list.map((s, idx) => {
                    const currentMark = s.id === binding.sessionId ? '（当前绑定）' : '';
                    const title = s.name || s.firstMessage?.slice(0, 28) || s.id.slice(0, 8);
                    const count = s.stats?.messages ?? s.messageCount ?? 0;
                    return `[${idx + 1}] ${title}${currentMark}\n    ID: ${s.id.slice(0, 8)}… · ${count} 条消息`;
                });
                return `${headerText}\n${rows.join('\n')}\n\n💡 发送 /resume <序号> 或 /resume <标题关键词> 即可切换绑定。`;
            };
            const arg = slash.args.trim();
            if (!arg || arg.toLowerCase() === 'list') {
                return formatList(allSessions.slice(0, 10), `📂 当前项目最近线程（共 ${allSessions.length} 条，显示前 ${Math.min(10, allSessions.length)} 条）：`);
            }
            const peer = this.db.value.peers.find(p => p.accountId === job.accountId && p.peerId === job.peerId);
            let chosen = null;
            if (/^\d{1,2}$/.test(arg)) {
                const index = Number(arg) - 1;
                const candidates = peer?.resumeCandidates?.length
                    ? peer.resumeCandidates.map(id => allSessions.find(s => s.id === id)).filter(Boolean)
                    : allSessions.slice(0, 10);
                if (index < 0 || index >= candidates.length) {
                    return `❌ 序号 ${arg} 超出范围（1–${candidates.length}）。请先发送 /resume 查看列表。`;
                }
                chosen = candidates[index];
            } else {
                const q = arg.toLowerCase();
                const exactId = allSessions.find(s => s.id.toLowerCase() === q);
                if (exactId) chosen = exactId;
                else {
                    const matches = allSessions.filter(s => s.id.toLowerCase().startsWith(q)
                        || (s.name || '').toLowerCase().includes(q)
                        || (s.firstMessage || '').toLowerCase().includes(q));
                    if (!matches.length) return `❌ 未找到匹配「${arg}」的线程。可发送 /resume 查看最近线程列表。`;
                    if (matches.length > 1) {
                        return formatList(matches.slice(0, 10), `🔍 找到 ${matches.length} 条匹配「${arg}」的线程，请按序号选择：`);
                    }
                    chosen = matches[0];
                }
            }
            if (chosen.id === binding.sessionId) {
                return `📌 当前已绑定在该线程：${chosen.name || chosen.id}\n🆔 会话 ID：${chosen.id}`;
            }
            bindToSession(chosen);
            return `✅ 已切换微信绑定到线程：${chosen.name || chosen.id}\n🆔 会话 ID：${chosen.id}\n💬 消息数：${chosen.stats?.messages ?? chosen.messageCount ?? 0} 条`;
        }
        if (slash.command === '/name') {
            const newName = slash.args.trim().slice(0, 120);
            if (!newName) return '✏️ 请提供新线程名称，例如：/name 微信渠道优化讨论';
            if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再修改名称。';
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            const active = this.supervisor.getActiveWorker(session.path);
            if (active && !active.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再修改名称。';
            const renamed = await this.store.renameSession(binding.cwd, binding.sessionId, newName, active);
            this.db.change(v => {
                for (const b of v.bindings) if (b.cwd === binding.cwd && b.sessionId === binding.sessionId) b.name = renamed.name;
            }, { config: true });
            return `✅ 已将当前线程重命名为：${renamed.name}`;
        }
        if (slash.command === '/model') {
            if (busyWithOther()) return '⚠️ 当前线程正在运行，请等待完成后再查看或切换模型。';
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            let worker = this.supervisor.getActiveWorker(session.path);
            if (worker && !worker.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再切换模型。';
            worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            const state = await worker.request('get_state');
            const catalog = await worker.request('get_available_models');
            const models = catalog?.models || [];
            if (!slash.args || slash.args.toLowerCase() === 'list') {
                const current = state.model ? `${state.model.provider}/${state.model.id}` : '未选择';
                const sample = models.slice(0, 12).map(m => `- ${m.provider}/${m.id}`).join('\n');
                return `🤖 当前模型：${current}\n思考等级：${state.thinkingLevel || '默认'}\n\n可用模型示例：\n${sample || '（暂无可用模型）'}\n\n发送 /model <provider/modelId> 即可切换。`;
            }
            const query = slash.args.trim().toLowerCase();
            const exact = models.find(m => `${m.provider}/${m.id}`.toLowerCase() === query || String(m.id).toLowerCase() === query);
            const matches = exact ? [exact] : models.filter(m => `${m.provider}/${m.id} ${m.name || ''}`.toLowerCase().includes(query));
            if (!matches.length) return `❌ 未找到匹配的可用模型：${slash.args}`;
            if (matches.length > 1) return `找到多个匹配模型，请指定完整名称：\n${matches.slice(0, 8).map(m => `- ${m.provider}/${m.id}`).join('\n')}`;
            const chosen = matches[0];
            await worker.request('set_model', { provider: chosen.provider, modelId: chosen.id });
            return `✅ 已将当前线程模型切换为：${chosen.provider}/${chosen.id}`;
        }
        if (slash.command === '/thinking') {
            if (busyWithOther()) return '⚠️ 当前线程正在运行，请等待完成后再查看或切换思考等级。';
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            let worker = this.supervisor.getActiveWorker(session.path);
            if (worker && !worker.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再切换思考等级。';
            worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            const [state, available] = await Promise.all([
                worker.request('get_state'),
                worker.request('get_available_thinking_levels')
            ]);
            const levels = available?.levels || [];
            const arg = slash.args.trim().toLowerCase();
            if (!arg || arg === 'list') {
                return `🧠 当前思考等级：${state.thinkingLevel || '默认'}\n当前模型支持的等级：${levels.join('、') || '默认'}\n\n发送 /thinking <等级> 即可切换。`;
            }
            if (!levels.includes(arg)) {
                return `❌ 当前模型不支持思考等级「${slash.args.trim()}」。\n可选等级：${levels.join('、') || '无'}`;
            }
            await worker.request('set_thinking_level', { level: arg });
            return `✅ 已将当前线程思考等级切换为：${arg}`;
        }
        if (slash.command === '/compact') {
            if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再压缩上下文。';
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            let worker = this.supervisor.getActiveWorker(session.path);
            if (worker && !worker.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再压缩上下文。';
            worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            if (run) run.worker = worker;
            const account = this.db.value.accounts.find(a => a.id === job.accountId);
            const stopTyping = account ? await this.startTyping(account, job.peerId) : () => Promise.resolve();
            try {
                const customInstructions = slash.args.trim().slice(0, 4000);
                await worker.request('compact', customInstructions ? { customInstructions } : {}, 11 * 60 * 1000);
                const state = await worker.request('get_state');
                const c = state.webCompaction;
                if (c?.status === 'unchanged') return 'ℹ️ 当前上下文无需压缩（内容较少或刚刚压缩过）。';
                if (c?.status === 'cancelled') return '⏹ 上下文压缩已取消。';
                if (c?.status === 'error') return `❌ 上下文压缩未完成：${c.errorMessage || '请稍后重试'}`;
                const details = [];
                if (Number.isFinite(c?.tokensBefore)) details.push(`压缩前 ${fmtTokens(c.tokensBefore)}`);
                if (Number.isFinite(c?.estimatedTokensAfter)) details.push(`压缩后约 ${fmtTokens(c.estimatedTokensAfter)} tokens`);
                return `✅ 上下文压缩完成${details.length ? `（${details.join(' → ')}）` : ''}。`;
            } catch (error) {
                if (/Already compacted|Nothing to compact/i.test(error.message || '')) return 'ℹ️ 当前上下文无需压缩（内容较少或刚刚压缩过）。';
                return `❌ 上下文压缩失败：${error.message || '请稍后重试'}`;
            } finally {
                await stopTyping();
            }
        }
        if (slash.command === '/reload') {
            if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再重新加载资源。';
            const session = await this.store.getSession(binding.cwd, binding.sessionId);
            let worker = this.supervisor.getActiveWorker(session.path);
            if (worker && !worker.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再重新加载资源。';
            worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            try {
                const commands = await worker.reloadResources();
                const count = commands?.commands?.length ?? 0;
                return `✅ 已重新加载当前线程的技能、提示词与扩展资源（当前可用命令 ${count} 项）。`;
            } catch (error) {
                return `❌ 重新加载资源失败：${error.message || '请稍后重试'}`;
            }
        }
        return null;
    }
    async run(id, run) {
        let job = this.job(id);
        if (!this.bindingFor(job)) { this.updateJob(id, { status: 'failed', reason: 'binding-changed', text: undefined, images: undefined }); return; }
        let stopTyping = () => Promise.resolve();
        let slash = null;
        try {
            if (job.status === 'queued') {
                slash = !job.images?.length ? parseSlash(job.text) : null;
                if (slash) {
                    const reply = await this.handleSlash(job, slash, run);
                    this.updateJob(id, { status: 'ready', kind: 'slash', directReply: reply, text: undefined, images: undefined, waiting: false });
                } else {
                    const session = await this.store.getSession(job.target.cwd, job.target.sessionId);
                    let worker = this.supervisor.getActiveWorker(session.path);
                    if (worker && !worker.isIdle()) return;
                    worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
                    run.worker = worker;
                    if (!worker.isIdle() || !this.canAdmit(this.job(id)) || this.job(id).status !== 'queued') return;
                    const account = this.db.value.accounts.find(a => a.id === job.accountId);
                    stopTyping = await this.startTyping(account, job.peerId);
                    let images = [];
                    if (job.images?.length) {
                        try {
                            for (const ref of job.images) images.push(await this.adapter.downloadImage(ref));
                        } catch (error) {
                            this.updateJob(id, { status: 'ready', directReply: `⚠️ 微信图片读取失败：${error.message || '请稍后重试'}`, text: undefined, images: undefined });
                            images = null;
                        }
                    }
                    if (images !== null) {
                        if (!worker.isIdle() || !this.canAdmit(this.job(id)) || this.job(id).status !== 'queued') return;
                        this.updateJob(id, { status: 'dispatching' });
                        let waitingNotified = false;
                        let result;
                        try {
                            result = await worker.channelTurn({ id, peerId: job.peerId, text: job.text, images }, {
                                admit: () => this.canAdmit(this.job(id)),
                                accepted: () => this.updateJob(id, { status: 'running', text: undefined, images: undefined }),
                                waiting: () => {
                                    try { this.updateJob(id, { waiting: true }); } catch { this.error = '渠道记录保存失败'; }
                                    if (waitingNotified) return;
                                    waitingNotified = true;
                                    const currentAccount = this.db.value.accounts.find(a => a.id === job.accountId);
                                    const peer = this.db.value.peers.find(p => p.accountId === job.accountId && p.peerId === job.peerId);
                                    if (currentAccount?.enabled && peer?.contextToken) {
                                        void this.adapter.send(currentAccount, peer, '⚠️ 当前任务正在等待交互确认，请打开 Pivane 网页端处理。', `pivane-wait-${id}`).catch(() => {});
                                    }
                                }
                            });
                        } catch (error) {
                            if (error.code === 'SESSION_BUSY') { this.updateJob(id, { status: 'queued' }); return; }
                            if (/不支持图片输入|配置可用模型/.test(error.message || '')) {
                                this.updateJob(id, { status: 'ready', directReply: `⚠️ ${error.message}`, text: undefined, images: undefined, waiting: false });
                                result = null;
                            } else throw error;
                        }
                        if (result?.cancelled) { this.updateJob(id, { status: 'cancelled', reason: 'admission-changed', text: undefined, images: undefined }); return; }
                        if (result) {
                            if (!['completed', 'stopped', 'error'].includes(result.status)) throw fail('No native completion proof');
                            this.updateJob(id, { status: 'ready', text: undefined, images: undefined, waiting: false });
                        }
                    }
                }
            }
        } finally {
            await stopTyping();
        }
        if (this.stopping || this.isSuspended()) return;
        job = this.job(id);
        if (job.status !== 'ready') return;
        const account = this.db.value.accounts.find(a => a.id === job.accountId);
        if (!account?.enabled || !account.allowedUsers.includes(job.peerId) || !this.bindingFor(job)) return;
        const isStop = slash?.command === '/stop';
        let result;
        if (typeof job.directReply === 'string') {
            if (isStop && (!job.directReply || !this.db.value.peers.find(p => p.accountId === account.id && p.peerId === job.peerId)?.contextToken)) {
                this.updateJob(id, { status: 'reviewed', reason: 'stop-request', directReply: undefined });
                return;
            }
            result = { status: 'completed', body: job.directReply, deliverables: job.deliverables || [] };
        } else {
            const session = await this.store.getSession(job.target.cwd, job.target.sessionId);
            const activeWorker = this.supervisor.getActiveWorker(session.path);
            if (activeWorker && !activeWorker.isIdle()) return;
            try { result = await this.readOutcome(job); }
            catch (error) { if (error.code === 'SESSION_BUSY') return; throw error; }
        }
        if (!result) throw fail('Native reply is unavailable');
        const text = result.status === 'stopped' ? '任务已停止。已发生的操作不会撤销，请在 Pivane 网页核对。'
            : result.status === 'error' ? '本次任务未成功完成，请在 Pivane 网页查看。' : result.body || '任务已完成，请在 Pivane 网页查看工具结果。';
        const chunks = Array.from(text.matchAll(/[\s\S]{1,1800}/gu), m => m[0]);
        const mediaFiles = await this.collectDeliverables(result.deliverables || []);
        this.updateJob(id, { status: 'sending', sendStarted: true, sentChunks: 0, sentMedia: 0 });
        for (let i = 0; i < chunks.length; i++) {
            if (this.stopping || this.isSuspended()) throw fail('Delivery interrupted');
            const latestAccount = this.db.value.accounts.find(a => a.id === job.accountId);
            if (!latestAccount?.enabled || !latestAccount.allowedUsers.includes(job.peerId) || !this.bindingFor(job)) throw fail('Delivery permission changed');
            const peer = this.db.value.peers.find(p => p.accountId === latestAccount.id && p.peerId === job.peerId);
            const receipt = await this.adapter.send(latestAccount, peer || { peerId: job.peerId }, chunks[i], `pivane-${id}-${i}`);
            this.updateJob(id, { sentChunks: i + 1, lastPlatformMessageId: receipt?.message_id ? String(receipt.message_id) : null });
        }
        for (let i = 0; i < mediaFiles.length; i++) {
            if (this.stopping || this.isSuspended()) throw fail('Media delivery interrupted');
            const latestAccount = this.db.value.accounts.find(a => a.id === job.accountId);
            if (!latestAccount?.enabled || !latestAccount.allowedUsers.includes(job.peerId) || !this.bindingFor(job)) throw fail('Delivery permission changed');
            const peer = this.db.value.peers.find(p => p.accountId === latestAccount.id && p.peerId === job.peerId);
            if (typeof this.adapter.sendMedia === 'function') {
                const receipt = await this.adapter.sendMedia(latestAccount, peer || { peerId: job.peerId }, mediaFiles[i], `pivane-media-${id}-${i}`);
                this.updateJob(id, { sentMedia: i + 1, lastPlatformMessageId: receipt?.message_id ? String(receipt.message_id) : null });
            }
        }
        this.updateJob(id, { status: isStop ? 'reviewed' : 'delivered', reason: isStop ? 'stop-request' : null, directReply: undefined, deliverables: undefined });
    }
    async collectDeliverables(refs) {
        const items = [];
        for (const ref of refs.slice(0, 6)) {
            try {
                const { manifest } = await this.deliverables.manifest(ref.id, ref.manifestRevision);
                const root = await this.deliverables.root();
                for (const file of manifest.files) {
                    if (items.length >= 6 || file.size > 16 * 1024 * 1024) continue;
                    const verified = await this.deliverables.readObject(root, path.join(root, ref.id, `${file.index}.bin`), 16 * 1024 * 1024);
                    if (verified.revision !== file.revision || verified.size !== file.size) continue;
                    const type = require('../pi-file-types').classify(verified.bytes, file.name);
                    items.push({ kind: type.kind === 'image' ? 'image' : 'file', name: file.name, mime: type.mime, bytes: verified.bytes });
                }
            } catch {}
        }
        return items;
    }
    async readOutcome(job) {
        const session = await this.store.getSession(job.target.cwd, job.target.sessionId);
        const worker = this.supervisor.getActiveWorker(session.path);
        if (worker) return worker.exclusive(rpc => worker.navigate(rpc, { mode: 'channel', input: { action: 'status', id: job.id, sessionId: session.id } }));
        return this.store.withSessionRead(session.cwd, session.id, async (_s, read) => { const result = outcome(read.manager(), job.id); read.validate(); return result; });
    }
    async dispose() {
        if (this.disposal) return this.disposal;
        this.stopping = true; this.login = null; clearInterval(this.timer); this.stopController.abort();
        const notices = [];
        for (const [id, p] of this.pollers) {
            p.controller.abort();
            const account = this.db?.value.accounts.find(a => a.id === id);
            if (account && this.adapter) notices.push(this.adapter.notify(account, false).catch(() => {}));
        }
        this.disposal = (async () => {
            await this.ready;
            await Promise.allSettled([...notices, this.loginFlight, ...this.operations, ...[...this.pollers.values()].map(p => p.promise), ...[...this.runs.values()].map(r => r.promise)].filter(Boolean));
            this.db?.close();
        })();
        return this.disposal;
    }
}
function mountChannels(router, service) {
    router.get('/channels', async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await service.snapshot()); } catch { res.status(500).json({ error: '无法读取消息渠道状态' }); }
    });
    router.post('/channels/weixin/actions', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await service.track(service.action(req.body))); }
        catch (error) { res.status(error.status || 400).json({ error: error.status ? error.message : '操作失败或结果待核对，请刷新状态；不会自动重试。' }); }
    });
}
module.exports = { ChannelsService, mountChannels, digest, parseSlash };
