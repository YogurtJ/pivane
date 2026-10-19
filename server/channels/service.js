const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { ChannelStore, pending } = require('./store');
const { WeixinComponent } = require('./weixin-component');
const { WeixinAdapter, createTransport, validId } = require('./weixin-adapter');
const { outcome } = require('./runtime');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => a?.cwd === b?.cwd && a?.sessionId === b?.sessionId;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
class ChannelsService {
    constructor({ store, supervisor, isSuspended = () => false, directory, componentFactory, adapterFactory }) {
        Object.assign(this, { store, supervisor, isSuspended, directory, componentFactory, adapterFactory });
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
            jobs: (this.db?.value.jobs || []).slice(-60).reverse().map(({ id, accountId, peerId, target, status, reason, at, sentChunks, waiting, sendStarted }) => ({ id, accountId, peerId, target, status, reason, at, sentChunks, waiting, canRecover: status === 'uncertain' && !sendStarted })),
            login: this.login ? { id: this.login.id, matrix: this.login.matrix, status: this.login.status, expiresAt: this.login.expiresAt } : null,
            capabilities: { text: true, images: false, groups: false, proactive: false } };
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
                    for (const j of v.jobs) if (j.accountId === account.id && j.status === 'queued' && (!input.enabled || !allow.includes(j.peerId))) { j.status = 'cancelled'; delete j.text; }
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
                this.updateJob(job.id, { status: 'reviewed', reason: 'user-reviewed', text: undefined });
            } else if (action === 'recover') {
                const job = this.job(input.jobId);
                if (!job || job.status !== 'uncertain' || job.sendStarted || this.runs.has(job.id)) throw fail('此消息不能恢复自动发送，请在网页查看回复');
                const result = await this.readOutcome(job);
                if (!result || !['completed', 'error', 'stopped'].includes(result.status)) throw fail('未找到原生完成记录；不会重新运行任务');
                this.updateJob(job.id, { status: 'ready', reason: null, text: undefined });
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
                const isStop = msg.text.trim() === '/stop';
                const stopQueued = isStop && v.jobs.some(j => pending(j) && j.accountId === accountId && j.peerId === msg.peerId && j.text?.trim() === '/stop');
                const reason = !binding ? 'unbound' : msg.unsupported ? 'unsupported-message' : !msg.text.trim() ? 'empty-message'
                    : !peer.contextToken && !isStop ? 'reply-context-missing' : stopQueued ? 'stop-already-queued' : activeCount >= 20 && !isStop ? 'queue-full' : null;
                v.jobs.push({ id, accountId, peerId: msg.peerId, target: binding ? { cwd: binding.cwd, sessionId: binding.sessionId } : null,
                    bindingId: binding?.id, status: reason ? 'ignored' : 'queued', reason, at: Date.now(), ...(reason ? {} : { text: msg.text }) });
            }
            // Cursor commits with admitted intents and deduplication receipts.
            if (typeof response.get_updates_buf === 'string') account.cursor = response.get_updates_buf;
            while (v.jobs.length > 4500) { const index = v.jobs.findIndex(j => !pending(j)); if (index < 0) throw fail('渠道消息记录已满'); v.jobs.splice(index, 1); }
        });
    }
    job(id) { return this.db.value.jobs.find(j => j.id === id); }
    updateJob(id, changes) { this.db.change(v => { const j = v.jobs.find(j => j.id === id); if (j) Object.assign(j, changes); }); }
    pump() {
        if (this.stopping || this.isSuspended() || this.mutating || this.error || !this.db?.owner) return;
        for (const job of this.db.value.jobs) {
            const stopping = job.status === 'queued' && job.text?.trim() === '/stop';
            if (this.runs.size >= (stopping ? 4 : 3)) continue;
            if (!['queued', 'ready'].includes(job.status) || this.runs.has(job.id)) continue;
            const account = this.db.value.accounts.find(a => a.id === job.accountId);
            if (!account?.enabled || !account.allowedUsers.includes(job.peerId)) continue;
            if (!stopping && ([...this.runs.values()].some(r => same(r.target, job.target)) || this.db.value.jobs.some(j => j.id !== job.id && same(j.target, job.target) && j.status === 'uncertain'))) continue;
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
    async run(id, run) {
        let job = this.job(id);
        if (!this.bindingFor(job)) { this.updateJob(id, { status: 'failed', reason: 'binding-changed', text: undefined }); return; }
        if (job.status === 'queued') {
            if (job.text.trim() === '/stop') {
                const targetRun = [...this.runs.entries()].find(([key, r]) => key !== id && same(r.target, job.target));
                if (targetRun?.[1].worker) await targetRun[1].worker.request('abort');
                this.updateJob(id, { status: 'reviewed', reason: 'stop-request', text: undefined }); return;
            }
            const session = await this.store.getSession(job.target.cwd, job.target.sessionId);
            let worker = this.supervisor.getActiveWorker(session.path);
            if (worker && !worker.isIdle()) return;
            worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            run.worker = worker;
            if (!worker.isIdle() || !this.canAdmit(this.job(id)) || this.job(id).status !== 'queued') return;
            this.updateJob(id, { status: 'dispatching' });
            let result;
            try {
                result = await worker.channelTurn({ id, peerId: job.peerId, text: job.text }, {
                    admit: () => this.canAdmit(this.job(id)),
                    accepted: () => this.updateJob(id, { status: 'running', text: undefined }),
                    waiting: () => { try { this.updateJob(id, { waiting: true }); } catch { this.error = '渠道记录保存失败'; } }
                });
            } catch (error) {
                if (error.code === 'SESSION_BUSY') { this.updateJob(id, { status: 'queued' }); return; }
                throw error;
            }
            if (result?.cancelled) { this.updateJob(id, { status: 'cancelled', reason: 'admission-changed', text: undefined }); return; }
            if (!result || !['completed', 'stopped', 'error'].includes(result.status)) throw fail('No native completion proof');
            this.updateJob(id, { status: 'ready', text: undefined, waiting: false });
        }
        if (this.stopping || this.isSuspended()) return;
        job = this.job(id);
        const account = this.db.value.accounts.find(a => a.id === job.accountId);
        if (!account?.enabled || !account.allowedUsers.includes(job.peerId) || !this.bindingFor(job)) return;
        const session = await this.store.getSession(job.target.cwd, job.target.sessionId);
        const activeWorker = this.supervisor.getActiveWorker(session.path);
        if (activeWorker && !activeWorker.isIdle()) return;
        let result;
        try { result = await this.readOutcome(job); }
        catch (error) { if (error.code === 'SESSION_BUSY') return; throw error; }
        if (!result) throw fail('Native reply is unavailable');
        const text = result.status === 'stopped' ? '任务已停止。已发生的操作不会撤销，请在 Pivane 网页核对。'
            : result.status === 'error' ? '本次任务未成功完成，请在 Pivane 网页查看。' : result.body || '任务已完成，请在 Pivane 网页查看工具结果。';
        const chunks = Array.from(text.matchAll(/[\s\S]{1,1800}/gu), m => m[0]);
        this.updateJob(id, { status: 'sending', sendStarted: true, sentChunks: 0 });
        for (let i = 0; i < chunks.length; i++) {
            if (this.stopping || this.isSuspended()) throw fail('Delivery interrupted');
            const latestAccount = this.db.value.accounts.find(a => a.id === job.accountId);
            if (!latestAccount?.enabled || !latestAccount.allowedUsers.includes(job.peerId) || !this.bindingFor(job)) throw fail('Delivery permission changed');
            const peer = this.db.value.peers.find(p => p.accountId === latestAccount.id && p.peerId === job.peerId);
            const receipt = await this.adapter.send(latestAccount, peer || { peerId: job.peerId }, chunks[i], `pivane-${id}-${i}`);
            this.updateJob(id, { sentChunks: i + 1, lastPlatformMessageId: receipt?.message_id ? String(receipt.message_id) : null });
        }
        this.updateJob(id, { status: 'delivered', reason: null });
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
module.exports = { ChannelsService, mountChannels, digest };
