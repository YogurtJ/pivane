const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const path = require('path');
const { INTERNAL_COMMAND_PATTERN, isInternalCommand, privateReply } = require('./pivane-compat');
const { PiRpcClient } = require('./pi-rpc-client');
const { PiRuntimeActivity, isCompactionNoop } = require('./pi-runtime-activity');
const { workerLifecycle } = require('./pi-worker-lifecycle');

const { PiRuntimeControls } = require('./pi-runtime-controls');
const { PiShellExecution } = require('./pi-shell-execution');
const DEFAULT_IDLE_MS = 15 * 60 * 1000;

// Pi 0.86 persists prompt/tool checkpoints as role=system messages. They are
// needed by Pi's provider transcript but are not user-visible chat messages.
function publicMessages(value) {
    if (!value || !Array.isArray(value.messages)) return value;
    return { ...value, messages: value.messages.filter(message => message?.role !== 'system') };
}

class AgentWorker extends EventEmitter {
    constructor(options) {
        super();
        this.cwd = options.cwd;
        this.sessionPath = options.sessionPath;
        this.sessionId = options.sessionId;
        this.activity = new PiRuntimeActivity();
        this.compactPending = false;
        this.promptPending = 0;
        this.modelChangesPending = 0;
        this.modelChangeUncertain = false;
        this.compaction = null;
        this.live = new (require('./pi-live-state').PiLiveState)();
        this.controls = new PiRuntimeControls();
        this.shell = new PiShellExecution(this);
        this.queueModeRevision = 0;
        this.controlPending = false;
        this.controlGeneration = 0;
        this.pendingUi = new Map();
        this.noSession = Boolean(options.noSession);
        this.managed = options.profile !== 'side-chat';
        this.operation = null;
        this.navigationToken = randomUUID();
        this.navigationResults = new Map();
        this.contextResults = new Map();
        this.modelCatalog = new (require('./pi-model-catalog').PiModelCatalog)(this);
        this.resourceResults = new Map();
        this.autoTitleEligible = false;
        this.titleResults = new Map();
        this.titleGeneration = false;
        this.historyResults = new Map();
        this.navigation = new (require('./pi-history-navigation').PiHistoryNavigation)(this);
        this.historyPending = 0;
        this.historyWriting = null;
        this.contextCapture = null;
        this.client = new PiRpcClient({ ...options,
            extraArgs: [...(options.extraArgs || []), ...(options.profile === 'side-chat' ? [] : ['-e', path.join(__dirname, 'pi-web-session-extension.ts')])],
            env: { ...options.env, ...(options.profile === 'side-chat' ? {} : { PI_WEB_NAVIGATION_TOKEN: this.navigationToken }) }
        });
        this.subscribers = new Set();
        this.streaming = false;
        this.lastUsedAt = Date.now();
        this.readyPromise = null;
        this.disposed = false;

        this.client.on('event', event => this._handleEvent(event));
        this.client.on('protocol_error', error => this._broadcast({
            type: 'gateway_error',
            error: error.message
        }));
        this.client.on('exit', error => {
            for (const id of this.pendingUi.keys()) this.resolveUi(id);
            this._broadcast({ type: 'gateway_error', error: error.message });
            this.emit('exit', error);
        });
    }

    ensureReady() {
        if (!this.readyPromise) this.readyPromise = (async () => {
            if (this.managed) {
                try { this.configRevision = (await new (require('./pi-native-service').PiNativeService)({ resolveProject: cwd => cwd }).context(this.cwd)).revision; }
                catch { this.configRevision = null; } // Inspection restrictions must not change native startup behavior.
            }
            await this.client.start();
            if (!this.managed) return;
            const raw = await this.client.request('get_commands');
            if (!raw.commands.some(c => c.source === 'extension' && (c.sourceInfo?.path || c.path) === path.join(__dirname, 'pi-web-session-extension.ts') && c.description?.includes('managed-v1'))) {
                throw new Error('网页会话保护扩展未加载，已拒绝启动');
            }
            const state = await this.client.request('get_state');
            if (this.noSession ? Boolean(state.sessionFile) : state.sessionFile !== this.sessionPath || state.sessionId !== this.sessionId) throw new Error('启动的原生会话归属与网页不一致');
        })();
        return this.readyPromise;
    }

    async request(type, payload = {}, timeoutMs, operationToken) {
        if (this.disposed || this.restarting) throw new Error('Pi runtime 已关闭或正在重新打开');
        if (['bash', 'abort_bash', 'set_steering_mode', 'set_follow_up_mode'].includes(type)) throw new Error('请使用受控运行入口');
        if (this.shell.busy && !type.startsWith('get_')) throw new Error('Shell 正在执行，请等待命令终态');
        if (this.controlPending && !type.startsWith('get_')) throw new Error('正在停止或取回队列，请等待状态确认');
        if (this.operation && operationToken !== this.operation && !type.startsWith('get_')) throw new Error('会话操作进行中，请稍后重试');
        const controlGeneration = this.controlGeneration;
        const checkingUncertainControl = this.controlUncertain;
        this.lastUsedAt = Date.now();
        const compacting = this.compactPending || this.activity.compacting;
        if (type === 'compact' && this.historyWriting) throw new Error('正在保存书签，请稍后压缩');
        if (type === 'compact' && (compacting || this.promptPending > 0 || this.activity.snapshot().busy)) {
            throw new Error('会话正在运行或压缩，请等待完成，或先停止当前任务');
        }
        if (compacting && ['prompt', 'steer', 'follow_up', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level'].includes(type)) {
            throw new Error('上下文正在压缩，请等待完成');
        }
        // Reserve before awaiting readiness so two browser clients cannot compact together.
        if (type === 'compact') this.compactPending = true;
        const changingModel = ['set_model', 'cycle_model'].includes(type);
        if (changingModel) this.modelChangesPending++;
        const prompting = ['prompt', 'steer', 'follow_up'].includes(type);
        if (prompting) this.promptPending++;
        try {
            await this.ensureReady();
            const data = await this.client.request(type, payload, timeoutMs, undefined, value => {
                if (type === 'get_state') this.live.state(value);
                if (type === 'get_messages') value = publicMessages(value);
                if (type === 'get_messages' && this.managed) {
                    const result = { ...value, webLive: this.live.snapshot() };
                    Object.defineProperty(result, 'webSnapshot', { value: {
                        controls: structuredClone(this.controls.snapshot()), pendingUi: structuredClone(this.getPendingUi()),
                        webCompaction: structuredClone(this.compaction), webShell: this.shell.snapshot(), webNavigation: this.navigation.snapshot()
                    } });
                    return result;
                }
                return value;
            });
            if (type === 'get_state') {
                if (this.managed && (this.noSession ? Boolean(data.sessionFile) : data.sessionFile !== this.sessionPath || data.sessionId !== this.sessionId)) {
                    this._broadcast({ type: 'gateway_error', error: '原生会话归属发生异常，当前连接已停止，请重新打开线程' });
                    await this.dispose();
                    throw new Error('原生会话归属与网页不一致');
                }
                if (checkingUncertainControl && this.controlUncertain && controlGeneration === this.controlGeneration
                    && !data.isStreaming && !data.isCompacting && !data.pendingMessageCount
                    && !this.activity.snapshot().busy && !this.compactPending) this.finishControl();
                return { ...data, webNavigation: this.navigation.snapshot(), webShell: this.shell.snapshot(), webQueueModes: this.queueModes(data), webCompaction: this.compaction, webOperation: Boolean(this.operation || this.controlPending || this.shell.busy), webControls: this.controls.snapshot() };
            }
            if (type === 'get_commands') return { ...data, commands: data.commands.filter(command => !isInternalCommand(command.name)) };
            return data;
        } catch (error) {
            if (changingModel && error.code === 'RPC_TIMEOUT') this.modelChangeUncertain = true;
            if (prompting && /^No API key found for the selected model\./.test(error.message)) {
                throw Object.assign(new Error('当前会话没有可用的模型认证。请在“供应商与模型”中登录，再为本会话选择已接入的模型'), { code: 'MODEL_AUTH_REQUIRED' });
            }
            throw error;
        } finally {
            if (changingModel) this.modelChangesPending--;
            if (prompting) this.promptPending--;
            if (type === 'compact') this.compactPending = false;
        }
    }

    queueModes(data) {
        return { runtimeId: this.shell.runtimeId, revision: this.queueModeRevision,
            steeringMode: data.steeringMode, followUpMode: data.followUpMode };
    }

    async setQueueMode(type, input) {
        if (this.shell.busy || this.activity.compacting) throw new Error('Shell 或压缩正在执行，请等待结束');
        if (Object.keys(input).some(key => !['mode', 'runtimeId', 'revision'].includes(key)) || !['all', 'one-at-a-time'].includes(input.mode)) throw new Error('投递模式仅支持逐条或全部');
        return this.exclusive(async () => {
            if (input.runtimeId !== this.shell.runtimeId || input.revision !== this.queueModeRevision) throw new Error('投递设置已变化，请刷新后再修改');
            this.queueModeRevision++;
            await this.client.request(type, { mode: input.mode }, null);
            const data = this.queueModes(await this.client.request('get_state'));
            this._broadcast({ type: 'gateway_queue_modes', modes: data });
            return data;
        }, { idle: false });
    }

    broadcastControls() {
        this._broadcast({ type: 'gateway_controls', controls: this.controls.snapshot() });
    }

    finishControl() {
        this.controlPending = false;
        this.controlUncertain = false;
        this.controls.stopping = false;
        this.controls.changed();
        this.broadcastControls();
    }

    async recoverQueue(stop) {
        if (this.shell.busy || this.disposed || this.operation || this.controlPending || this.promptPending) throw new Error('会话正在处理其他操作，请稍后重试');
        const recovery = this.controls.reserveRecovery();
        this.controlPending = true; // Reserve before any await, including readiness.
        this.controlGeneration++;
        this.controls.stopping = true;
        this.broadcastControls();
        let cleared = false;
        try {
            await this.ensureReady();
            const queue = await this.client.request('clear_queue', {}, 30000);
            cleared = true;
            this.controls.finishRecovery(recovery, queue);
            this.broadcastControls(); // Available even if abort or the browser connection subsequently fails.
            if (stop) await this.client.request('abort', {}, 120000);
            this.finishControl();
        } catch (error) {
            if (!cleared) { recovery.status = 'uncertain'; this.controls.changed(); }
            if (error.code === 'RPC_TIMEOUT') this.controlUncertain = true;
            else this.finishControl();
            this.broadcastControls();
            throw error;
        }
        return this.controls.snapshot();
    }

    acknowledgeRecovery(id) {
        this.controls.acknowledge(id);
        this.broadcastControls();
        return this.controls.snapshot();
    }

    async exclusive(callback, { idle = true } = {}) {
        if (idle && this.shell.busy || this.disposed || this.operation || this.controlPending || this.promptPending || this.compactPending || idle && (this.activity.snapshot().busy || this.historyWriting)) {
            const error = new Error('会话正在运行或处理其他操作，请等待空闲');
            error.code = 'SESSION_BUSY';
            throw error;
        }
        const token = Symbol('session-operation');
        this.operation = token;
        const rpc = (type, payload = {}, timeout) => this.request(type, payload, timeout, token);
        try {
            const runtime = await rpc('get_state');
            if (idle && (runtime.isStreaming || runtime.isCompacting || runtime.pendingMessageCount || this.pendingUi.size)) {
                const error = new Error('会话尚未空闲');
                error.code = 'SESSION_BUSY';
                throw error;
            }
            return await callback(rpc, runtime, token);
        } finally {
            this.operation = null;
            this.lastUsedAt = Date.now();
        }
    }

    async launchTask(task) {
        return this.exclusive(async (_rpc, runtime) => {
            if (runtime.model?.provider !== task.model.provider || runtime.model?.id !== task.model.modelId
                || runtime.thinkingLevel !== task.thinkingLevel) throw new Error('Task model or thinking level changed during startup');
            const raw = await this.client.request('get_commands');
            const command = raw.commands.find(c => c.source === 'extension'
                && (c.sourceInfo?.path || c.path) === path.join(__dirname, 'pi-web-session-extension.ts')
                && new RegExp(`^${INTERNAL_COMMAND_PATTERN}(?::[0-9]+)?$`).test(c.name) && c.description?.includes('task-v1'));
            if (!command) throw new Error('Task launch bridge is not available');
            const id = randomUUID();
            this.navigationResults.set(id, null);
            try {
                await this.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'task', requestId: task.requestId, id, token: this.navigationToken })}` }, null);
                const result = this.navigationResults.get(id);
                if (!result?.success) throw new Error(result?.error || 'Task launch was not acknowledged');
            } finally { this.navigationResults.delete(id); }
        });
    }

    async titleRequest(input, { idle = true } = {}) {
        if (this.noSession) throw new Error('临时会话不支持标题生成');
        const available = () => {
            if (this.disposed || this.operation || this.controlPending || this.shell.busy || this.compactPending || this.historyWriting
                || idle && (this.promptPending || this.activity.snapshot().busy)) throw new Error('请等待当前任务和队列结束');
        };
        available();
        if (this.titleResults.size) throw new Error('标题操作正在进行');
        const id = randomUUID();
        this.titleResults.set(id, null); // Reserve the private bridge before awaiting readiness.
        try {
            await this.ensureReady();
            const raw = await this.client.request('get_commands');
            const command = raw.commands.find(c => c.source === 'extension'
                && (c.sourceInfo?.path || c.path) === path.join(__dirname, 'pi-web-session-extension.ts')
                && new RegExp(`^${INTERNAL_COMMAND_PATTERN}(?::[0-9]+)?$`).test(c.name) && c.description?.includes('title-v1'));
            if (!command) throw new Error('当前运行实例尚未加载标题接口，请在任务结束后退出并重新打开线程');
            available();
            // Synchronous bridge reads/CAS do not reserve the main prompt pipeline. Keep
            // this request slot until acknowledgement or process exit, never a timeout.
            await this.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'title', input, id, token: this.navigationToken })}` }, null);
            const result = this.titleResults.get(id);
            if (!result?.success) throw new Error(result?.error || '未收到标题操作确认');
            return result.data;
        } finally { this.titleResults.delete(id); }
    }

    async historyRequest(kind, raw) {
        const input = require('./pi-history-model').validateHistoryRequest(kind, raw);
        if (this.noSession) throw new Error('临时会话不提供持久历史和书签');
        if (this.shell.busy || this.disposed || this.operation) throw new Error('会话正在执行命令、切换或重新加载，请稍后查询历史');
        if (this.historyPending >= 2) throw new Error('历史查询正在进行，请稍后重试');
        const writing = kind === 'bookmark';
        if (writing && (this.historyWriting || this.controlPending || this.compactPending || this.activity.compacting)) throw new Error('书签操作、停止或压缩尚未结束，请稍后保存');
        const id = randomUUID(), slot = { result: null, writing, entryId: input.entryId };
        if (writing) this.historyWriting = slot;
        this.historyPending++;
        let submitted = false, uncertain = false;
        try {
            await this.ensureReady();
            const commands = await this.client.request('get_commands');
            const extensionPath = path.join(__dirname, 'pi-web-session-extension.ts');
            const command = commands.commands.find(c => c.source === 'extension'
                && (c.sourceInfo?.path || c.path) === extensionPath && isInternalCommand(c.name)
                && c.description?.includes(kind === 'tree' ? 'tree-v1' : 'history-v1'));
            if (!command) throw new Error('当前运行实例尚未加载历史接口，请在任务结束后退出并重新打开会话');
            if (writing && (this.controlPending || this.compactPending || this.activity.compacting)) throw new Error('停止或压缩正在进行，请稍后保存书签');
            this.historyResults.set(id, slot); submitted = true;
            try {
                await this.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'history', kind, input, id, token: this.navigationToken })}` }, 30000);
            } catch (error) {
                if (!slot.result) { uncertain = writing && error.code === 'RPC_TIMEOUT'; throw error; }
            }
            if (!slot.result) { uncertain = writing; throw new Error('未收到历史操作确认，请重新读取记录核对；未自动重试'); }
            if (!slot.result.success) throw Object.assign(new Error(slot.result.error || '历史操作失败'), { code: slot.result.code });
            return slot.result.data;
        } finally {
            this.historyPending--;
            if (!submitted || !uncertain || slot.result) {
                this.historyResults.delete(id);
                if (this.historyWriting === slot) this.historyWriting = null;
            }
            this.lastUsedAt = Date.now();
        }
    }

    async getNativeResources(systemPrompt = false, operationToken) {
        if (this.disposed || this.resourceResults.size || this.operation && operationToken !== this.operation) throw new Error('资源读取或会话操作正在进行');
        const id = randomUUID();
        this.resourceResults.set(id, null);
        try {
            await this.ensureReady();
            const raw = await this.client.request('get_commands');
            const command = raw.commands.find(c => c.source === 'extension'
                && (c.sourceInfo?.path || c.path) === path.join(__dirname, 'pi-web-session-extension.ts')
                && isInternalCommand(c.name) && c.description?.includes(systemPrompt ? 'system-prompt-v1' : 'resources-v1'));
            if (!command) throw new Error('当前实例尚未加载资源查看接口，请在任务结束后退出并重新打开线程');
            if (this.disposed || this.operation && operationToken !== this.operation) throw new Error('资源读取或会话操作正在进行');
            // Keep the private slot until acknowledgement or process exit, even if the
            // browser stops waiting. A timeout must not allow another read/reload.
            await this.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'resources', systemPrompt, id, token: this.navigationToken })}` }, null);
            const result = this.resourceResults.get(id);
            if (!result?.success) throw new Error(result?.error || '未收到资源快照');
            return result.data;
        } finally { this.resourceResults.delete(id); }
    }

    async reloadResources() {
        if (this.contextCapture || this.resourceResults.size) throw new Error('正在读取侧聊背景或资源，请稍后重新加载资源');
        return this.exclusive(async rpc => {
            const extensionPath = path.join(__dirname, 'pi-web-session-extension.ts');
            const find = data => data.commands.find(item => item.source === 'extension'
                && (item.sourceInfo?.path || item.path) === extensionPath
                && isInternalCommand(item.name)
                && item.description?.includes('reload-v1:'));
            const before = find(await this.client.request('get_commands'));
            if (!before) throw new Error('当前 runtime 尚未加载重载接口，请在任务结束后退出并重新打开会话');
            try {
                await rpc('prompt', { message: `/${before.name} ${JSON.stringify({ mode: 'reload', token: this.navigationToken })}` }, 120000);
                const raw = await this.client.request('get_commands');
                const after = find(raw);
                const commands = { ...raw, commands: raw.commands.filter(c => !isInternalCommand(c.name)) };
                if (!after || after.description === before.description) throw new Error('未确认资源重新加载成功，请检查扩展错误并重新查看命令目录');
                this._broadcast({ type: 'gateway_commands', commands: commands.commands });
                return commands;
            } catch (error) {
                if (error.code === 'RPC_TIMEOUT') {
                    this._broadcast({ type: 'gateway_reconnect' });
                    await this.dispose();
                }
                throw error;
            }
        });
    }

    async captureContext() {
        if (this.contextCapture) return this.contextCapture;
        const capture = (async () => {
            if (this.disposed || this.operation) throw new Error('主会话正在切换上下文，请稍后重新打开侧聊');
            await this.ensureReady();
            const commands = await this.client.request('get_commands');
            const extensionPath = path.join(__dirname, 'pi-web-session-extension.ts');
            const command = commands.commands.find(item => item.source === 'extension'
                && (item.sourceInfo?.path || item.path) === extensionPath
                && isInternalCommand(item.name)
                && item.description?.includes('context snapshot'));
            if (!command) throw new Error('主 runtime 尚未加载上下文快照接口，请在任务结束后重新打开主会话');
            const id = randomUUID();
            this.contextResults.set(id, null);
            try {
                // An extension command is handled before ordinary prompt preflight, including while busy.
                // This is a private read, not a user prompt or an idle/exclusive navigation operation.
                await this.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'context', id, token: this.navigationToken })}` }, 30000);
                const result = this.contextResults.get(id);
                if (!result?.success) throw new Error(result?.error || '未收到主上下文快照，请重新尝试');
                return result.snapshot;
            } finally { this.contextResults.delete(id); }
        })();
        this.contextCapture = capture;
        try { return await capture; } finally { if (this.contextCapture === capture) this.contextCapture = null; }
    }

    async navigate(rpc, payload, options = {}) {
        const id = randomUUID();
        try {
            const commands = await this.client.request('get_commands');
            const extensionPath = path.join(__dirname, 'pi-web-session-extension.ts');
            const command = commands.commands.find(item => item.source === 'extension'
                && (item.sourceInfo?.path || item.path) === extensionPath
                && isInternalCommand(item.name));
            if (!command) throw new Error('原生回退扩展未加载，请重新打开 runtime');
            if (payload.mode === 'tree' && !command.description?.includes('tree-v1')) throw new Error('当前实例尚未加载会话树导航，请在任务结束后退出并重新打开线程');
            if (options.beforeSend && !options.beforeSend()) return { cancelled: true };
            this.navigationResults.set(id, null);
            await rpc('prompt', { message: `/${command.name} ${JSON.stringify({ ...payload, id, token: this.navigationToken })}` }, options.timeoutMs || 120000);
            const result = this.navigationResults.get(id);
            if (!result) throw new Error('未收到原生回退结果，请重新读取会话状态');
            if (!result.success) throw new Error(result.error || '会话回退失败');
            return result.data;
        } catch (error) {
            if (error.code === 'RPC_TIMEOUT') {
                // The extension may still be navigating; never unlock a live, uncertain mutation.
                this._broadcast({ type: 'gateway_reconnect' });
                await this.dispose();
            }
            throw error;
        } finally {
            this.navigationResults.delete(id);
        }
    }

    send(record) {
        this.lastUsedAt = Date.now();
        if (record.type === 'extension_ui_response') {
            const pending = this.pendingUi.get(record.id);
            if (!pending || pending.expiresAt && pending.expiresAt <= Date.now()) {
                this.resolveUi(record.id);
                return false;
            }
            this.client.send(record);
            this.resolveUi(record.id);
            return true;
        }
        this.client.send(record);
    }

    resolveUi(id) {
        const pending = this.pendingUi.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingUi.delete(id);
        this.lastUsedAt = Date.now();
        this.activity.waitingCount = this.pendingUi.size;
        this._broadcast({ type: 'gateway_ui_resolved', id });
    }

    getPendingUi() {
        return [...this.pendingUi.values()].map(({ event, expiresAt }) => ({ ...event, expiresAt }));
    }

    subscribe(listener) {
        this.subscribers.add(listener);
        this.lastUsedAt = Date.now();
        return () => {
            this.subscribers.delete(listener);
            this.lastUsedAt = Date.now();
        };
    }

    _handleEvent(event) {
        if (this.shell.handle(event)) return;
        if (event.type === 'extension_ui_request' && event.method === 'notify') {
            try {
                const result = privateReply(JSON.parse(event.message));
                if (this.modelCatalog.handle(result)) return;
                if (typeof result.pivaneResources === 'string') {
                    if (this.resourceResults.has(result.pivaneResources)) this.resourceResults.set(result.pivaneResources, result);
                    return; // Including late/unknown private replies.
                }
                if (typeof result.pivaneTitleEligibility === 'boolean') {
                    this.autoTitleEligible = result.pivaneTitleEligibility;
                    return;
                }
                if (typeof result.pivaneTitle === 'string') {
                    if (this.titleResults.has(result.pivaneTitle)) this.titleResults.set(result.pivaneTitle, result);
                    return; // Never broadcast private excerpts, including late/unknown replies.
                }
                if (typeof result.pivaneHistory === 'string') {
                    const slot = this.historyResults.get(result.pivaneHistory);
                    if (slot) {
                        slot.result = result;
                        if (slot.writing) {
                            if (this.historyWriting === slot) this.historyWriting = null;
                            this.historyResults.delete(result.pivaneHistory);
                            if (result.success) this._broadcast({ type: 'gateway_history_changed', entryId: slot.entryId });
                        }
                    }
                    return; // Unknown and late history responses are private too.
                }
                if (typeof result.pivaneContext === 'string') {
                    if (this.contextResults.has(result.pivaneContext)) this.contextResults.set(result.pivaneContext, result);
                    return; // Late/unknown private responses must never reach a browser.
                }
                if (typeof result.pivaneNavigation === 'string') {
                    if (this.navigationResults.has(result.pivaneNavigation)) this.navigationResults.set(result.pivaneNavigation, result);
                    return;
                }
            } catch {}
        }
        this.live.handle(event);
        this.navigation.handle(event);
        this.lastUsedAt = Date.now();
        if (this.controls.handle(event)) this.broadcastControls();
        if (event.type === 'agent_settled' && this.controlUncertain) this.finishControl();
        if (event.type === 'compaction_start') {
            this.compaction = { status: 'running', reason: event.reason, startedAt: this.lastUsedAt };
        } else if (event.type === 'compaction_end') {
            const result = event.result;
            this.compaction = {
                startedAt: this.compaction?.startedAt,
                finishedAt: this.lastUsedAt,
                reason: event.reason,
                status: event.aborted ? 'cancelled' : isCompactionNoop(event) ? 'unchanged' : event.errorMessage || !result ? 'error' : 'success',
                errorMessage: event.errorMessage,
                tokensBefore: result?.tokensBefore,
                estimatedTokensAfter: result?.estimatedTokensAfter,
                willRetry: Boolean(event.willRetry)
            };
        } else if (event.type === 'summarization_retry_scheduled' && this.activity.compacting) {
            this.compaction = { ...this.compaction, status: 'retrying', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs };
        } else if (event.type === 'summarization_retry_attempt_start' && this.activity.compacting) {
            this.compaction = { ...this.compaction, status: 'running' };
        }
        if (event.type === 'agent_start') this.streaming = true;
        if (event.type === 'agent_settled') this.streaming = false;
        if (event.type === 'agent_settled') {
            for (const [id, pending] of this.pendingUi) {
                if (pending.runBound) this.resolveUi(id);
            }
        }
        if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)) {
            clearTimeout(this.pendingUi.get(event.id)?.timer);
            const timeout = Number(event.timeout);
            const expiresAt = Number.isFinite(timeout) && timeout !== 0 ? Date.now() + Math.max(0, timeout) : null;
            const timer = expiresAt === null ? null : setTimeout(() => this.resolveUi(event.id), timeout);
            timer?.unref?.();
            this.pendingUi.set(event.id, { event, expiresAt, timer, runBound: this.activity.running });
            this.activity.waitingCount = this.pendingUi.size;
        }
        const completed = this.activity.handle(event);
        if (!this.noSession && this.sessionId && (
            event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)
            || event.type === 'agent_settled' && this.activity.snapshot().phase === 'error')) {
            this.emit('attention', { cwd: this.cwd, sessionId: this.sessionId,
                kind: event.type === 'agent_settled' ? 'error' : 'waiting', completionId: randomUUID() });
        }
        if (completed && !this.noSession && this.sessionId) {
            this.emit('completion', { cwd: this.cwd, sessionId: this.sessionId, completionId: randomUUID(), completedAt: new Date().toISOString() });
        }
        this._broadcast(event);
    }

    _broadcast(event) {
        // Pi 0.86 exposes persisted system prompt checkpoints as message events.
        // They are internal transcript state and must not enter the browser chat,
        // side-chat event stream, or extension UI history.
        if (event?.message?.role === 'system') return;
        event = { ...event, webRuntimeId: this.live.runtimeId, webSequence: ++this.live.sequence };
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch (error) {
                console.error('Pi Web subscriber failed:', error.message);
            }
        }
    }

    lifecycle() {
        return workerLifecycle(this);
    }

    isIdle() {
        return this.lifecycle().blockers.length === 0;
    }

    canEvict(now, idleMs) {
        return this.isIdle() && this.subscribers.size === 0 && now - this.lastUsedAt >= idleMs;
    }

    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const id of this.pendingUi.keys()) this.resolveUi(id);
        this.subscribers.clear();
        await this.shell.dispose();
        await this.client.dispose();
        this.historyResults.clear(); this.historyWriting = null;
        this.emit('disposed');
    }
}

class PiAgentSupervisor extends EventEmitter {
    constructor(options = {}) {
        super();
        this.idleMs = options.idleMs || Number(process.env.PI_WEB_IDLE_MS) || DEFAULT_IDLE_MS;
        this.workers = new Map();
        this.disposing = false;
        this.starting = new Map();
        this.ephemeralWorkers = new Set();
        this.sweepTimer = setInterval(() => this._sweep(), Math.min(this.idleMs, 60000));
        this.sweepTimer.unref?.();
    }

    async getWorker({ cwd, sessionPath, sessionId }) {
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        const existing = this.workers.get(sessionPath);
        if (existing && !existing.disposed && !existing.restarting) return existing;
        if (this.starting.has(sessionPath)) return this.starting.get(sessionPath);

        const starting = (async () => {
            const env = this.workerEnvironment ? await this.workerEnvironment({ cwd, sessionId }) : {};
            const worker = new AgentWorker({ cwd, sessionPath, sessionId, env });
            worker.on('completion', notice => this.emit('completion', notice, worker));
            worker.on('attention', event => this.emit('attention', event));
            worker.on('exit', () => {
                if (this.workers.get(sessionPath) === worker) this.workers.delete(sessionPath);
            });
            worker.on('disposed', () => {
                if (this.workers.get(sessionPath) === worker) this.workers.delete(sessionPath);
            });
            try {
                await worker.ensureReady();
                if (this.disposing) throw new Error('Pi supervisor is shutting down');
                this.workers.set(sessionPath, worker);
                return worker;
            } catch (error) {
                await worker.dispose();
                throw error;
            }
        })();
        this.starting.set(sessionPath, starting);

        try {
            return await starting;
        } finally {
            this.starting.delete(sessionPath);
        }
    }

    async createEphemeralWorker(cwd, options = {}) {
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        const worker = new AgentWorker({ ...options, cwd, noSession: true });
        this.ephemeralWorkers.add(worker);
        const forget = () => this.ephemeralWorkers.delete(worker);
        worker.once('exit', forget);
        worker.once('disposed', forget);
        try {
            await worker.ensureReady();
            return worker;
        } catch (error) {
            await worker.dispose();
            throw error;
        }
    }

    restartWorker(worker) {
        const file = worker.sessionPath;
        if (!file || this.workers.get(file) !== worker || worker.restarting) throw new Error('运行实例已变化');
        worker.restarting = true;
        const replacement = (async () => {
            await Promise.resolve(); // Publish the replacement promise before disconnecting subscribers.
            worker._broadcast({ type: 'gateway_reconnect' });
            await worker.dispose();
            if (this.workers.get(file) === worker) this.workers.delete(file);
            if (this.starting.get(file) === replacement) this.starting.delete(file);
            return this.getWorker({ cwd: worker.cwd, sessionPath: file, sessionId: worker.sessionId });
        })();
        this.starting.set(file, replacement);
        return replacement.finally(() => { if (this.starting.get(file) === replacement) this.starting.delete(file); });
    }

    hasProjectRuntime(cwd) {
        return [...this.workers.values(), ...this.ephemeralWorkers].some(worker => worker.cwd === cwd && !worker.disposed);
    }

    isIdle() {
        return !this.disposing && !this.starting.size && !this.ephemeralWorkers.size
            && [...this.workers.values()].every(worker => worker.isIdle());
    }

    getActivity() {
        return [...this.workers.values()]
            .filter(worker => !worker.disposed && worker.sessionId)
            .map(worker => ({ cwd: worker.cwd, sessionId: worker.sessionId, titleGenerating: worker.titleGeneration,
                ...worker.lifecycle().activity }));
    }

    getActiveWorker(sessionPath) {
        return this.workers.get(sessionPath);
    }

    async stopSession(sessionPath) {
        const worker = this.workers.get(sessionPath);
        this.workers.delete(sessionPath);
        if (worker) await worker.dispose();
    }

    async _sweep() {
        const now = Date.now();
        const evictions = [];
        for (const [sessionPath, worker] of this.workers) {
            if (!worker.canEvict(now, this.idleMs)) continue;
            this.workers.delete(sessionPath);
            evictions.push(worker.dispose());
        }
        await Promise.allSettled(evictions);
    }

    async dispose() {
        this.disposing = true;
        clearInterval(this.sweepTimer);
        await Promise.allSettled([...this.starting.values()]);
        const workers = [...this.workers.values(), ...this.ephemeralWorkers];
        this.workers.clear();
        this.ephemeralWorkers.clear();
        await Promise.allSettled(workers.map(worker => worker.dispose()));
    }
}

module.exports = { PiAgentSupervisor };
