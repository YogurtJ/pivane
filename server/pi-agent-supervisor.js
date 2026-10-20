const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { INTERNAL_COMMAND_PATTERN, isInternalCommand, privateReply } = require('./pivane-compat');
const { PiRpcClient } = require('./pi-rpc-client');
const { PiRuntimeActivity, isCompactionNoop } = require('./pi-runtime-activity');
const { progressValue } = require('./pi-task-progress');
const { workerLifecycle } = require('./pi-worker-lifecycle');

const { PiRuntimeControls } = require('./pi-runtime-controls');
const { PiShellExecution } = require('./pi-shell-execution');
const subagentRuntime = require('./pi-subagent-runtime');
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
// A healthy worker answers get_state in milliseconds. The window is long enough
// that brief synchronous work in an extension does not cause a replacement.
const DEFAULT_HEALTH_TIMEOUT_MS = 15000;
// Only unusually slow cold starts are logged; the log carries no session content.
const SLOW_STARTUP_LOG_MS = 10000;

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
        // In-memory sessions have a native ID, but no persisted session address.
        this.runtimeSessionId = options.sessionId;
        this.activity = new PiRuntimeActivity();
        this.compactPending = false;
        this.promptPending = 0;
        this.promptAdmissionUncertain = false;
        this.runStartupCalls = new Set();
        this.runStartupSequence = 0;
        this.modelChangesPending = 0;
        this.modelChangeUncertain = false;
        this.compaction = null;
        this.live = new (require('./pi-live-state').PiLiveState)();
        this.progress = null;
        this.controls = new PiRuntimeControls();
        this.queueStore = options.queueStore || null;
        this.referenceGuard = options.referenceGuard;
        this.queueToken = randomUUID();
        this.queueAdapterReady = false;
        this.syncQueueRecoveries();
        this.shell = new PiShellExecution(this);
        this.queueModeRevision = 0;
        this.controlPending = false;
        this.controlGeneration = 0;
        this.queueClearOperations = new Map();
        this.queueClearResponseIds = new Set();
        this.pendingUi = new Map();
        this.noSession = Boolean(options.noSession);
        this.managed = options.profile !== 'side-chat';
        this.operation = null;
        this.navigationToken = randomUUID();
        this.navigationResults = new Map();
        this.contextResults = new Map();
        this.modelCatalog = new (require('./pi-model-catalog').PiModelCatalog)(this);
        this.modelSpeed = new (require('./pi-model-speed-control').PiModelSpeedControl)(this);
        this.mcpControl = new (require('./pi-mcp-runtime-control').PiMcpRuntimeControl)(this);
        this.resourceResults = new Map();
        this.subagentResults = new Map();
        this.loadedAgentProfileId = null;
        this.loadedAgentProfileRevision = null;
        this.loadedAgentProfileConfirmed = false;
        this.loadedAssistantProjectId = null;
        this.loadedAssistantProjectRevision = null;
        this.loadedAssistantProjectConfirmed = false;
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
            env: { PIVANE_AGENT_PROFILE_CONTEXT: undefined, PIVANE_HERMES_BUNDLE: undefined,
                PIVANE_ASSISTANT_PROJECT_CONTEXT: undefined, PIVANE_PROFILE_AUTHORING_CONTEXT: undefined,
                PIVANE_PROFILE_MEMORY_REVIEW_MODEL: undefined, ...options.env,
                PI_WEB_NAVIGATION_TOKEN: this.navigationToken, PIVANE_QUEUE_TOKEN: this.queueStore ? this.queueToken : undefined }
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
            this.exited = true;
            this.runStartupCalls.clear();
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
            if (this.noSession ? Boolean(state.sessionFile) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(state.sessionId || '') : state.sessionFile !== this.sessionPath || state.sessionId !== this.sessionId) throw new Error('启动的原生会话归属与网页不一致');
            this.runtimeSessionId = state.sessionId;
        })();
        return this.readyPromise;
    }

    async request(type, payload = {}, timeoutMs, operationToken, beforeSend) {
        if (this.disposed || this.restarting || this.exited) throw new Error('Pi runtime 已关闭或正在重新打开');
        if (!type.startsWith('get_')) this.assertReferenceWritable();
        if (['bash', 'abort_bash', 'set_steering_mode', 'set_follow_up_mode'].includes(type)) throw new Error('请使用受控运行入口');
        if (this.cronRun && (!this.operation || operationToken !== this.operation) && !type.startsWith('get_') && type !== 'abort') throw new Error('定时任务正在运行或恢复设置，请等待结束或在定时任务页核对');
        if (this.shell.busy && !type.startsWith('get_')) throw new Error('Shell 正在执行，请等待命令终态');
        if (this.controlPending && !type.startsWith('get_')) throw new Error('正在停止或取回队列，请等待状态确认');
        if (this.operation && operationToken !== this.operation && !type.startsWith('get_') && !(type === 'abort' && (this.channelRun || this.channelCommandId))) throw new Error('会话操作进行中，请稍后重试');
        const controlGeneration = this.controlGeneration;
        const checkingUncertainControl = this.controlUncertain;
        this.lastUsedAt = Date.now();
        const compacting = this.compactPending || this.activity.compacting;
        if (type === 'compact' && this.historyWriting) throw new Error('正在保存书签，请稍后压缩');
        if (type === 'compact' && (compacting || this.promptPending > 0 || this.runStartupCalls.size > 0 || this.activity.snapshot().busy)) {
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
        let intentId, releaseQueueOperation;
        try {
            if (prompting && this.queueStore) releaseQueueOperation = this.queueStore.beginOperation();
            await this.ensureReady();
            const queueIntended = ['steer', 'follow_up'].includes(type) || type === 'prompt' && ['steer', 'followUp'].includes(payload.streamingBehavior);
            if (queueIntended && this.queueStore) {
                if (!this.queueAdapterReady) throw new Error('持久队列适配未加载，未发送消息，请保留草稿');
                intentId = this.queueStore.reserve(this, type === 'follow_up' || payload.streamingBehavior === 'followUp' ? 'followUp' : 'steering', payload);
                this.syncQueueRecoveries(); this.broadcastControls();
                payload = { ...payload, message: '\u001ePIVANE_QUEUE_V1:' + JSON.stringify({ token: this.queueToken, id: intentId, message: payload.message }) };
            }
            // Pi 0.87 get_messages is the edited provider context. Chat uses the
            // native raw entries selected by compaction, retaining original text.
            // Map one get_entries response synchronously at its stdout boundary so
            // later events cannot be acknowledged by an older transcript snapshot.
            const transcriptSdk = type === 'get_messages' && this.managed ? await require('./pi-session-store').getSdk() : null;
            // Channel controls revalidate authorization at the last synchronous boundary before RPC submission.
            beforeSend?.();
            const data = await this.client.request(transcriptSdk ? 'get_entries' : type, transcriptSdk ? {} : payload, timeoutMs, undefined, value => {
                if (transcriptSdk) {
                    // webAnchors maps each native message entry of the current context to the
                    // rendered message key, so receipts can point at their source message
                    // without the browser downloading raw entries of every branch.
                    const messages = [], webAnchors = [];
                    for (const entry of transcriptSdk.buildContextEntries(value.entries, value.leafId)) {
                        const mapped = transcriptSdk.sessionEntryToContextMessages(entry);
                        const first = mapped[0];
                        if (entry.type === 'message' && typeof entry.id === 'string' && first?.timestamp != null)
                            webAnchors.push([entry.id, first.role, first.timestamp, first.toolCallId || '']);
                        messages.push(...mapped);
                    }
                    value = { messages, webAnchors };
                }
                if (type === 'get_state') this.live.state(value);
                if (type === 'get_messages') value = publicMessages(value);
                if (type === 'get_messages' && this.managed) {
                    const result = { ...value, webProgress: structuredClone(this.progress), webLive: this.live.snapshot() };
                    Object.defineProperty(result, 'webSnapshot', { value: {
                        controls: structuredClone(this.controls.snapshot()), pendingUi: structuredClone(this.getPendingUi()),
                        webCompaction: structuredClone(this.compaction), webShell: this.shell.snapshot(), webNavigation: this.navigation.snapshot(),
                        mcpAuthorization: structuredClone(this.mcpControl.authorization)
                    } });
                    return result;
                }
                return value;
            });
            if (intentId && data?.disposition === 'handled') {
                // A handled extension may have side effects; it is not proof of delivery.
                this.queueStore.update(this, intentId, 'unknown'); this.syncQueueRecoveries(); this.broadcastControls();
            }
            if (type === 'get_state') {
                if (this.managed && (this.noSession ? Boolean(data.sessionFile) : data.sessionFile !== this.sessionPath || data.sessionId !== this.sessionId)) {
                    this._broadcast({ type: 'gateway_error', error: '原生会话归属发生异常，当前连接已停止，请重新打开线程' });
                    await this.dispose();
                    throw new Error('原生会话归属与网页不一致');
                }
                if (checkingUncertainControl && this.controlUncertain && controlGeneration === this.controlGeneration
                    && !data.isStreaming && !data.isCompacting && !data.pendingMessageCount
                    && !this.activity.snapshot().busy && !this.compactPending) this.finishControl();
                return { ...data, webSpeed: structuredClone(this.modelSpeed.value), webNavigation: this.navigation.snapshot(), webShell: this.shell.snapshot(), webQueueModes: this.queueModes(data), webCompaction: this.compaction, webOperation: Boolean(this.operation || this.controlPending || this.shell.busy), webControls: this.controls.snapshot() };
            }
            if (type === 'get_commands') return { ...data, commands: data.commands.filter(command => !isInternalCommand(command.name)) };
            return data;
        } catch (error) {
            if (prompting && error.code === 'RPC_TIMEOUT') this.promptAdmissionUncertain = true;
            if (intentId) {
                try { this.queueStore.update(this, intentId, 'unknown'); this.syncQueueRecoveries(); this.broadcastControls(); }
                catch { this.queuePersistenceFailed(); }
            }
            if (changingModel && error.code === 'RPC_TIMEOUT') this.modelChangeUncertain = true;
            if (prompting && /^No API key found for the selected model\./.test(error.message)) {
                throw Object.assign(new Error('当前会话没有可用的模型认证。请在“供应商与模型”中登录，再为本会话选择已接入的模型'), { code: 'MODEL_AUTH_REQUIRED' });
            }
            throw error;
        } finally {
            releaseQueueOperation?.();
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
        this.assertReferenceWritable();
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

    assertReferenceWritable() {
        const guard = typeof this.referenceGuard === 'function' ? this.referenceGuard() : this.referenceGuard;
        guard?.assertWritable();
        if (this.queueStore?.leased) throw new Error('附件引用正在核验，请稍后处理会话');
    }

    syncQueueRecoveries() {
        if (!this.queueStore) return;
        const summaries = this.queueStore.summaries(this);
        this.controls.intentions = summaries.filter(item => ['saved', 'queued'].includes(item.state));
        this.controls.recoveries = summaries.filter(item => !['saved', 'queued'].includes(item.state));
        this.controls.durable = true;
        this.controls.changed();
    }

    queuePersistenceFailed() {
        this.queueStore.fault = true;
        this.controls.persistenceError = true;
        this.controls.changed(); this.broadcastControls();
        this._broadcast({ type: 'gateway_error', error: '队列持久化未完成，请核对会话；恢复内容不会自动重发' });
    }

    handleQueueEvent(event) {
        // Always intercept private records, including malformed/late/foreign ones.
        if (!this.queueStore || event.token !== this.queueToken || event.sessionId !== this.sessionId) return;
        try {
            if (event.phase === 'ready') { this.queueAdapterReady = true; return; }
            if (event.phase === 'queued' || event.phase === 'started') this.queueStore.update(this, event.id, event.phase, event.payload);
            else if (event.phase === 'persisted' && typeof event.entryId === 'string' && /^[a-f0-9]{64}$/.test(event.entryHash)) this.queueStore.retire(this, event.id);
            else if (event.phase === 'cleared' && Array.isArray(event.ids) && event.legacy) {
                const operation = event.operationId ? this.queueClearOperations.get(event.operationId) : null;
                if (event.operationId && (!operation || operation.generation !== event.generation)) return;
                this.queueStore.reconcileClear(this, operation?.fallbackIds || [], event.ids, event.legacy, operation?.candidateIds ?? null);
                if (operation) {
                    operation.proved = true;
                    this.queueClearOperations.delete(event.operationId);
                }
            } else return;
            this.syncQueueRecoveries(); this.broadcastControls();
        } catch { this.queuePersistenceFailed(); }
    }

    recoveryPayload({ recoveryId, runtimeId, revision }) {
        this.checkRecoveryRevision({ runtimeId, revision });
        if (!this.queueStore) throw new Error('此运行实例仅支持文字取回');
        return this.queueStore.payload(this, recoveryId);
    }

    checkRecoveryRevision(input) {
        if (this.disposed || this.restarting || this.exited) throw new Error('运行实例已变化');
        if (this.controlPending) throw new Error('正在停止或取回队列，请等待状态确认');
        if (input && (input.runtimeId !== this.controls.runtimeId || input.revision !== this.controls.revision)) throw new Error('取回状态已变化，请刷新核对');
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
        this.assertReferenceWritable();
        if (this.shell.busy || this.disposed || this.exited || this.operation || this.controlPending || this.promptPending) throw new Error('会话正在处理其他操作，请稍后重试');
        const release = this.queueStore?.beginOperation();
        let recovery, operation;
        const generation = this.controlGeneration + 1;
        try {
            if (this.queueStore) {
                if (this.queueClearOperations.size >= 32 || this.queueClearResponseIds.size >= 32) throw new Error('尚有未确认的队列取回操作，请重新打开运行实例后核对');
                const candidateIds = this.queueStore.summaries(this).filter(item => !item.legacy).map(item => item.id);
                const fallbackIds = this.queueStore.saveLegacy(this, this.controls.queue);
                operation = { id: randomUUID(), generation, candidateIds, fallbackIds, proved: false };
                this.queueClearOperations.set(operation.id, operation);
                this.syncQueueRecoveries();
            } else recovery = this.controls.reserveRecovery();
        } catch (error) { release?.(); throw error; }
        this.controlPending = true; // Reserve before any await, including readiness.
        this.controlGeneration = generation;
        this.controls.stopping = true;
        this.broadcastControls();
        let cleared = false;
        try {
            await this.ensureReady();
            const queue = operation
                ? await this.client.request('prompt', { message: '\u001ePIVANE_QUEUE_V1:' + JSON.stringify({ token: this.queueToken,
                    id: operation.id, generation, operation: 'clear' }) }, 30000, id => {
                    operation.rpcId = id; this.queueClearResponseIds.add(id);
                })
                : await this.client.request('clear_queue', {}, 30000);
            cleared = true;
            if (this.queueStore) {
                if (this.queueStore.fault) throw new Error('队列取回后的持久化失败，请核对恢复记录');
                if (!operation.proved) {
                    for (const id of operation.candidateIds) this.queueStore.update(this, id, 'unknown');
                    this.syncQueueRecoveries();
                }
            } else this.controls.finishRecovery(recovery, queue);
            this.broadcastControls(); // Available even if abort or the browser connection subsequently fails.
            if (stop) await this.client.request('abort', {}, 120000);
            this.finishControl();
        } catch (error) {
            if (!cleared && recovery) { recovery.status = 'uncertain'; this.controls.changed(); }
            if (error.code === 'RPC_TIMEOUT') {
                this.controlUncertain = true;
                if (operation) operation.timedOut = true;
            }
            else this.finishControl();
            this.broadcastControls();
            throw error;
        } finally {
            release?.();
            if (operation?.rpcId && !operation.timedOut) this.queueClearResponseIds.delete(operation.rpcId);
        }
        return this.controls.snapshot();
    }

    acknowledgeRecovery(id, input) {
        this.assertReferenceWritable(); this.checkRecoveryRevision(input);
        if (this.queueStore) { this.queueStore.acknowledge(this, id); this.syncQueueRecoveries(); }
        else this.controls.acknowledge(id);
        this.broadcastControls();
        return this.controls.snapshot();
    }

    async exclusive(callback, { idle = true, cron = false } = {}) {
        this.assertReferenceWritable();
        if (this.cronRun && !cron || idle && (this.shell.busy || this.promptAdmissionUncertain) || this.disposed || this.operation || this.controlPending || this.promptPending || this.compactPending || idle && (this.activity.snapshot().busy || this.historyWriting)) {
            const error = new Error('会话正在运行或处理其他操作，请等待空闲');
            error.code = 'SESSION_BUSY';
            throw error;
        }
        const token = Symbol('session-operation');
        this.operation = token;
        const rpc = (type, payload = {}, timeout, beforeSend) => this.request(type, payload, timeout, token, beforeSend);
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

    async shutdown(callback) {
        this.assertReferenceWritable();
        if (this.cronRun || this.retainsBackgroundWork()) throw Object.assign(new Error('请先处理定时任务或后台子 Agent，再退出运行实例'), { code: 'SESSION_BUSY' });
        if (this.disposed || this.restarting || this.operation) throw Object.assign(new Error('运行实例正在切换或退出，请稍后核对'), { code: 'SESSION_BUSY' });
        // Explicit termination must not depend on an RPC reply from a hung
        // process. In-flight prompt/clear operations retain their journal proof.
        const token = Symbol('session-shutdown');
        this.operation = token;
        try { return await callback(); }
        finally { if (this.operation === token) this.operation = null; }
    }

    // Keep the existing exclusive operation until the native turn settles or its
    // process actually exits. Web prompts cannot change this reply's destination.
    async channelTurn(input, { accepted = () => {}, waiting = () => {}, admit = () => true } = {}) {
        return this.exclusive(async rpc => {
            this.channelRun = input.id;
            let finish, fail, unsubscribe;
            const settled = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
            settled.catch(() => {});
            const exited = () => fail(new Error('Channel runtime exited before completion'));
            this.once('exit', exited); this.once('disposed', exited);
            unsubscribe = this.subscribe(event => {
                if (event.type === 'agent_settled') setImmediate(finish);
                if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)) waiting();
            });
            try {
                const started = await this.navigate(rpc, { mode: 'channel', input: { ...input, action: 'start', sessionId: this.sessionId } }, { timeoutMs: 30000, beforeSend: admit });
                if (started.cancelled || started.reused || started.status !== 'running') return started;
                try { accepted(started); } catch (error) { await this.dispose(); throw error; }
                await settled;
                return await this.navigate(rpc, { mode: 'channel', input: { action: 'status', id: input.id, sessionId: this.sessionId } });
            } finally {
                unsubscribe?.(); this.removeListener('exit', exited); this.removeListener('disposed', exited); this.channelRun = null;
            }
        });
    }

    async cron(input) {
        return this.exclusive(rpc => this.navigate(rpc, { mode: 'cron', input }, { timeoutMs: 30000 }), { cron: true });
    }

    async taskReturn(input) {
        return this.exclusive(rpc => this.navigate(rpc, { mode: 'task-result', input }, { timeoutMs: 30000 }));
    }

    async agentMessages(input) {
        return this.exclusive(rpc => this.navigate(rpc, { mode: 'agent-message', input }, { timeoutMs: 30000 }));
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
                && c.description?.includes(kind === 'tree' ? 'tree-v1' : kind === 'archive' ? 'history-archive-v1' : 'history-v1'));
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
        if (this.disposed || this.mcpControl.busy || this.resourceResults.size || this.operation && operationToken !== this.operation) throw new Error('资源读取或会话操作正在进行');
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

    async reloadResources({ rpc: reservedRpc } = {}) {
        if (this.contextCapture || this.resourceResults.size) throw new Error('正在读取侧聊背景或资源，请稍后重新加载资源');
        if (reservedRpc && !this.operation) throw new Error('Resource reload requires an active operation');
        const reload = async rpc => {
            const extensionPath = path.join(__dirname, 'pi-web-session-extension.ts');
            const find = data => data.commands.find(item => item.source === 'extension'
                && (item.sourceInfo?.path || item.path) === extensionPath
                && isInternalCommand(item.name)
                && item.description?.includes('reload-v1:'));
            const before = find(await this.client.request('get_commands'));
            if (!before) throw new Error('当前 runtime 尚未加载重载接口，请在任务结束后退出并重新打开会话');
            try {
                this.loadedAgentProfileConfirmed = false;
                this.loadedAssistantProjectConfirmed = false;
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
        };
        return reservedRpc ? reload(reservedRpc) : this.exclusive(reload);
    }

    async subagentRequest(input) {
        const { method, params } = subagentRuntime.validateControl(input);
        if (this.noSession) throw new Error('临时会话不支持子 Agent 控制');
        if (this.disposed || this.operation) throw new Error('会话正在切换或重新加载，请稍后重试');
        if (this.subagentResults.size >= 2) throw new Error('子 Agent 操作正在进行，请稍后重试');
        const id = randomUUID();
        this.subagentResults.set(id, null); // Reserve before awaiting readiness.
        try {
            await this.ensureReady();
            const commands = await this.client.request('get_commands');
            const command = commands.commands.find(item => item.source === 'extension'
                && (item.sourceInfo?.path || item.path) === path.join(__dirname, 'pi-web-session-extension.ts')
                && isInternalCommand(item.name) && item.description?.includes('subagents-v1'));
            if (!command) throw new Error('当前运行实例尚未加载子 Agent 控制接口，请在任务结束后重新打开会话');
            if (this.disposed || this.operation) throw new Error('会话正在切换或重新加载，请稍后重试');
            // Extension commands run before prompt preflight, also while the parent Agent is busy.
            try {
                await this.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'subagents', method, params, id, token: this.navigationToken })}` }, 50000);
            } catch (error) {
                if (!this.subagentResults.get(id) && error.code === 'RPC_TIMEOUT' && !['status', 'cost'].includes(method)) {
                    throw Object.assign(new Error('未收到子 Agent 操作确认，结果不确定；请刷新状态核对，未自动重试'), { code: 'uncertain' });
                }
                if (!this.subagentResults.get(id)) throw error;
            }
            const result = this.subagentResults.get(id);
            if (!result) throw new Error('未收到子 Agent 操作结果，请刷新状态核对');
            if (!result.success) {
                const message = { unavailable: '当前会话没有加载 pi-subagents，请在扩展中启用后重新打开会话',
                    uncertain: '子 Agent 未在时限内确认，结果不确定；请刷新状态核对，未自动重试',
                    unsupported_method: '当前 pi-subagents 版本不支持此操作' }[result.code];
                throw Object.assign(new Error(message || String(result.error || '子 Agent 操作失败').slice(0, 2000)), { code: result.code });
            }
            return subagentRuntime.controlResult(method, result.data);
        } finally { this.subagentResults.delete(id); this.lastUsedAt = Date.now(); }
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
            if (payload.mode === 'channel' && !command.description?.includes('channels-v1')) throw new Error('消息渠道接口尚未加载，请在线程空闲后重开运行实例');
            if (payload.mode === 'cron' && !command.description?.includes('cron-v1')) throw new Error('Scheduled task bridge is not loaded; reopen the idle thread');
            if (payload.mode === 'task-result' && !command.description?.includes('task-results-v1')) throw new Error('Task result bridge is not loaded');
            if (payload.mode === 'agent-message' && !command.description?.includes('agent-messages-v1')) throw new Error('Agent message bridge is not loaded; reopen the thread after it is idle');
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
        if (event.type === 'response' && this.queueClearResponseIds.delete(event.id)) return;
        if (event.type === 'pivane_queue') { this.handleQueueEvent(event); return; }
        if (event.type === 'pivane_run_startup') {
            // Intercept even malformed, foreign and late private frames. Only a
            // matching SDK call completion (or real child exit) releases its slot.
            if (!this.exited && event.token === this.navigationToken && event.sessionId === this.runtimeSessionId
                && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(event.id)
                && Number.isSafeInteger(event.sequence) && event.sequence > this.runStartupSequence
                && ['started', 'finished'].includes(event.phase)
                && (event.phase === 'started' ? !this.runStartupCalls.has(event.id) : this.runStartupCalls.has(event.id))) {
                this.runStartupSequence = event.sequence;
                if (event.phase === 'started') this.runStartupCalls.add(event.id);
                else this.runStartupCalls.delete(event.id);
            }
            return;
        }
        if (this.shell.handle(event)) return;
        if (event.type === 'extension_ui_request' && event.method === 'notify') {
            try {
                const result = privateReply(JSON.parse(event.message));
                if (this.modelCatalog.handle(result) || this.mcpControl.handle(result) || this.modelSpeed.handle(result)) return;
                if (result && Object.hasOwn(result, 'pivaneAgentProfileLoaded')) {
                    if (this.managed && !this.noSession && result.sessionId === this.sessionId
                        && (result.pivaneAgentProfileLoaded === null && result.profileRevision === null
                            || typeof result.pivaneAgentProfileLoaded === 'string' && /^[a-f0-9-]{36}$/.test(result.pivaneAgentProfileLoaded)
                                && typeof result.profileRevision === 'string' && /^[a-f0-9]{64}$/.test(result.profileRevision))) {
                        this.loadedAgentProfileId = result.pivaneAgentProfileLoaded;
                        this.loadedAgentProfileRevision = result.profileRevision;
                        this.loadedAgentProfileConfirmed = true;
                    }
                    return;
                }
                if (result && Object.hasOwn(result, 'pivaneAssistantProjectLoaded')) {
                    if (this.managed && !this.noSession && result.sessionId === this.sessionId
                        && (result.pivaneAssistantProjectLoaded === null && result.projectRevision === null
                            || typeof result.pivaneAssistantProjectLoaded === 'string'
                                && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.pivaneAssistantProjectLoaded)
                                && typeof result.projectRevision === 'string' && /^[a-f0-9]{64}$/.test(result.projectRevision))) {
                        this.loadedAssistantProjectId = result.pivaneAssistantProjectLoaded;
                        this.loadedAssistantProjectRevision = result.projectRevision;
                        this.loadedAssistantProjectConfirmed = true;
                    }
                    return;
                }
                if (result && Object.hasOwn(result, 'pivaneCron')) {
                    const state = result.pivaneCron;
                    if (state?.sessionId === this.sessionId) {
                        this.cronRun = state.active ? state.runId : null;
                        this.cronState = state;
                    }
                    return;
                }
                if (result && Object.hasOwn(result, 'pivaneProgress')) {
                    const update = result.pivaneProgress;
                    if (this.managed && update && (this.noSession || update.sessionId === this.sessionId)) {
                        const progress = update.progress === null ? null : progressValue(update.progress);
                        if (update.progress === null || progress) {
                            this.progress = progress;
                            this._broadcast({ type: 'gateway_progress', progress });
                        }
                    }
                    return; // Malformed/foreign bridge records must not become notifications.
                }
                if (result && Object.hasOwn(result, 'pivaneBackgroundWork')) {
                    const value = this.managed && !this.noSession ? subagentRuntime.backgroundWork(result.pivaneBackgroundWork, this.sessionId) : null;
                    if (value) {
                        if (value.active) this.lastUsedAt = Date.now();
                        if (this.controls.setBackgroundWork(value)) this.broadcastControls();
                    }
                    return; // Private retention signal; never a browser notification.
                }
                if (typeof result.pivaneSubagents === 'string') {
                    if (this.subagentResults.has(result.pivaneSubagents)) this.subagentResults.set(result.pivaneSubagents, result);
                    return;
                }
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
            // Internal observers use this event; browser subscribers alone decide reclaimability.
            if (this.compaction.status === 'success') this.emit('compaction', this.compaction);
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

    // Detached pi-subagents work reports completion to this process. Reaping it
    // would lose the automatic continuation even though the child keeps running.
    retainsBackgroundWork() {
        return Boolean(this.controls.subagents.background?.active);
    }

    canEvict(now, idleMs) {
        return this.isIdle() && !this.retainsBackgroundWork() && this.subscribers.size === 0 && now - this.lastUsedAt >= idleMs;
    }

    // Liveness before an existing worker is reused. Active or detached background
    // work is not probed for replacement: a timeout there does not show that the
    // run ended. Concurrent callers share one bounded read-only probe.
    responsive(timeoutMs) {
        if (!this.isIdle() || this.retainsBackgroundWork()) return Promise.resolve(true);
        if (!this.healthCheck) this.healthCheck = this.client.probe(timeoutMs).finally(() => { this.healthCheck = null; });
        return this.healthCheck;
    }

    dispose() {
        if (this.disposal) return this.disposal;
        this.disposed = true;
        this.disposal = Promise.resolve().then(async () => {
            for (const id of this.pendingUi.keys()) this.resolveUi(id);
            this.subscribers.clear();
            await this.shell.dispose();
            await this.client.dispose();
            this.runStartupCalls.clear();
            this.historyResults.clear(); this.historyWriting = null;
            this.emit('disposed');
        });
        return this.disposal;
    }
}

class PiAgentSupervisor extends EventEmitter {
    constructor(options = {}) {
        super();
        this.idleMs = options.idleMs || Number(process.env.PI_WEB_IDLE_MS) || DEFAULT_IDLE_MS;
        this.healthTimeoutMs = options.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS;
        this.startupTimeoutMs = options.startupTimeoutMs; // Unset: PIVANE_WEB_STARTUP_TIMEOUT_MS or the default.
        this.workers = new Map();
        this.disposing = false;
        this.starting = new Map();
        this.retiring = new Map();
        this.removing = new Map();
        this.editing = new Map();
        this.moving = new Map();
        this.ephemeralWorkers = new Set();
        this.referenceGuard = options.referenceGuard;
        this.queueStore = options.queueStore || null;
        this.queueRoot = options.queueRoot;
        this.sweepTimer = setInterval(() => this._sweep(), Math.min(this.idleMs, 60000));
        this.sweepTimer.unref?.();
    }

    assertReferenceWritable() {
        this.referenceGuard?.assertWritable();
        if (this.queueStore?.leased) throw new Error('附件引用正在核验，请稍后处理会话');
    }

    async getQueueStore() {
        if (this.queueStore) return this.queueStore;
        if (!this.queueStorePromise) this.queueStorePromise = (async () => {
            const sdk = await require('./pi-session-store').getSdk();
            const root = this.queueRoot || path.join(fs.realpathSync.native(sdk.getAgentDir()), 'pivane-queue');
            return this.queueStore = new (require('./pi-queue-store').PiQueueStore)(root);
        })();
        return this.queueStorePromise;
    }

    async protectedDocuments() { return (await this.getQueueStore()).protectedDocuments(); }

    async acquireQueueReferenceLease() {
        const store = await this.getQueueStore();
        if (this.disposing || this.starting.size || this.retiring.size || this.removing.size || this.editing.size || this.moving.size || this.ephemeralWorkers.size
            || [...this.workers.values()].some(worker => worker.lifecycle().activity.busy || worker.retainsBackgroundWork()
                || worker.promptAdmissionUncertain || worker.controls.intentions?.length || worker.controls.persistenceError || worker.queueClearOperations?.size
                || worker.controls.queue.steering.length || worker.controls.queue.followUp.length)) throw new Error('会话正在执行，请稍后核验附件引用');
        return store.acquireReferenceLease();
    }

    async forgetDeletedSession(sessionPath) {
        this.assertReferenceWritable();
        if (!this.removing.has(sessionPath) || this.workers.has(sessionPath) || this.starting.has(sessionPath) || this.retiring.has(sessionPath)) throw new Error('只能在明确删除成功且运行实例已停止后清理队列');
        const store = await this.getQueueStore();
        try { fs.lstatSync(sessionPath); throw new Error('原生会话文件仍存在，不能清理队列恢复内容'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return store.forgetDeletedSession(sessionPath);
    }

    async getWorker({ cwd, sessionPath, sessionId }) {
        this.assertReferenceWritable();
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        if (this.removing.has(sessionPath)) throw new Error('Session is being deleted');
        if (this.editing.has(sessionPath)) throw new Error('Session metadata is being changed');
        if (this.moving.has(sessionPath)) throw new Error('Session is being moved');
        if (this.retiring.has(sessionPath)) {
            await this.retiring.get(sessionPath);
            return this.getWorker({ cwd, sessionPath, sessionId }); // Recheck admission and native path after actual exit.
        }
        // A caller may have resolved the session before a completed deletion.
        if (!fs.existsSync(sessionPath)) throw new Error('Session file no longer exists');
        const existing = this.workers.get(sessionPath);
        if (existing && !existing.disposed && !existing.restarting) return this._reuse(existing, { cwd, sessionPath, sessionId });
        if (this.starting.has(sessionPath)) return this.starting.get(sessionPath);

        const starting = (async () => {
            const env = this.workerEnvironment ? await this.workerEnvironment({ cwd, sessionId, sessionPath }) : {};
            const queueStore = await this.getQueueStore();
            this.assertReferenceWritable();
            const worker = new AgentWorker({ cwd, sessionPath, sessionId, env, queueStore, referenceGuard: () => this.referenceGuard, startupTimeoutMs: this.startupTimeoutMs });
            worker.on('completion', notice => this.emit('completion', notice, worker));
            worker.on('attention', event => this.emit('attention', event));
            worker.on('exit', () => {
                if (this.workers.get(sessionPath) === worker) void this.stopSession(sessionPath).catch(() => {});
            });
            worker.on('disposed', () => {
                if (this.workers.get(sessionPath) === worker) {
                    this.workers.delete(sessionPath);
                    this.retiring.delete(sessionPath); // Exact terminal evidence from this owner.
                }
            });
            try {
                await worker.ensureReady();
                if (this.disposing) throw new Error('Pi supervisor is shutting down');
                if (worker.client.startupMs >= SLOW_STARTUP_LOG_MS) {
                    console.warn(`Pi worker became ready after ${(worker.client.startupMs / 1000).toFixed(1)} s (startup limit ${Math.round(worker.client.startupTimeoutMs / 1000)} s)`);
                }
                this.workers.set(sessionPath, worker);
                this.emit('worker', worker);
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

    // An idle worker whose process no longer answers is replaced through the same
    // path as an explicit restart: the old process exits before a new one starts,
    // so one native session file never has two managed workers.
    async _reuse(worker, target) {
        if (await worker.responsive(this.healthTimeoutMs)) return worker;
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        if (this.removing.has(target.sessionPath)) throw new Error('Session is being deleted');
        if (this.editing.has(target.sessionPath)) throw new Error('Session metadata is being changed');
        if (this.moving.has(target.sessionPath)) throw new Error('Session is being moved');
        if (this.workers.get(target.sessionPath) !== worker || worker.disposed || worker.restarting) return this.getWorker(target);
        // Work that started during the probe is never terminated for a missed reply.
        if (!worker.isIdle() || worker.retainsBackgroundWork()) return worker;
        console.warn(`Pi worker did not answer within ${(this.healthTimeoutMs / 1000).toFixed(1)} s while idle; starting a replacement`);
        return this.restartWorker(worker);
    }

    async createEphemeralWorker(cwd, options = {}) {
        this.assertReferenceWritable();
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        const worker = new AgentWorker({ startupTimeoutMs: this.startupTimeoutMs, ...options, referenceGuard: () => this.referenceGuard, queueStore: null, cwd, noSession: true });
        this.ephemeralWorkers.add(worker);
        const forget = () => this.ephemeralWorkers.delete(worker);
        worker.once('exit', () => { void worker.dispose().catch(() => {}); });
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
            await this.stopSession(file);
            if (this.workers.get(file) === worker) this.workers.delete(file);
            if (this.starting.get(file) === replacement) this.starting.delete(file);
            return this.getWorker({ cwd: worker.cwd, sessionPath: file, sessionId: worker.sessionId });
        })();
        this.starting.set(file, replacement);
        return replacement.finally(() => { if (this.starting.get(file) === replacement) this.starting.delete(file); });
    }

    hasProjectRuntime(cwd) {
        return [...this.workers.values(), ...this.ephemeralWorkers].some(worker => worker.cwd === cwd && (!worker.disposed || worker.disposal));
    }

    isIdle() {
        return !this.disposing && !this.starting.size && !this.retiring.size && !this.removing.size && !this.editing.size && !this.moving.size && !this.ephemeralWorkers.size
            && [...this.workers.values()].every(worker => worker.isIdle() && !worker.retainsBackgroundWork());
    }

    // Per-session idleness for background work sourced from one native session.
    // A worker that is still starting for this file counts as busy.
    isSessionIdle(sessionPath) {
        if (this.disposing) return false;
        if (typeof sessionPath !== 'string' || !sessionPath) return true;
        const real = file => { try { return fs.realpathSync.native(file); } catch { return null; } };
        const target = real(sessionPath) ?? sessionPath;
        const matches = file => file === sessionPath || file === target || real(file) === target;
        if ([...this.removing.keys(), ...this.editing.keys(), ...this.moving.keys(), ...this.retiring.keys()].some(matches) || [...this.starting.keys()].some(matches)) return false;
        const worker = [...this.workers].find(([file, item]) => !item.disposed && matches(file))?.[1];
        return !worker || worker.isIdle() && !worker.retainsBackgroundWork();
    }

    getActivity() {
        return [...this.workers.values()]
            .filter(worker => worker.sessionId)
            .map(worker => ({ cwd: worker.cwd, sessionId: worker.sessionId, titleGenerating: worker.titleGeneration,
                ...worker.lifecycle().activity, backgroundWork: worker.retainsBackgroundWork() }));
    }

    getActiveWorker(sessionPath) {
        return this.workers.get(sessionPath);
    }

    async withSessionMove(sourcePath, targetPath, operation) {
        this.assertReferenceWritable();
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        const paths = [...new Set([sourcePath, targetPath])];
        if (paths.some(file => this.removing.has(file) || this.editing.has(file) || this.moving.has(file))) throw new Error('Session file operation is already in progress');
        const move = Promise.resolve().then(async () => {
            await Promise.all(paths.map(file => this.starting.get(file)));
            if (this.disposing) throw new Error('Pi supervisor is shutting down');
            const worker = this.workers.get(sourcePath);
            if (this.workers.has(targetPath)) throw new Error('Target session already has a worker');
            if (worker?.retainsBackgroundWork()) throw Object.assign(new Error('请等待后台子 Agent 完成后再移动线程'), { code: 'SESSION_BUSY' });
            (await this.getQueueStore()).assertMovable(sourcePath);
            return worker ? worker.exclusive(() => operation(worker)) : operation(null);
        });
        for (const file of paths) this.moving.set(file, move);
        try { return await move; }
        finally { for (const file of paths) if (this.moving.get(file) === move) this.moving.delete(file); }
    }

    async withSessionEdit(sessionPath, operation) {
        this.assertReferenceWritable();
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        if (this.removing.has(sessionPath) || this.editing.has(sessionPath) || this.moving.has(sessionPath))
            throw Object.assign(new Error('会话正在处理其他操作，请等待空闲'), { status: 409 });
        const edit = Promise.resolve().then(async () => {
            await this.starting.get(sessionPath);
            if (this.disposing) throw new Error('Pi supervisor is shutting down');
            const worker = this.workers.get(sessionPath);
            if (worker && (!worker.isIdle() || worker.retainsBackgroundWork())) throw Object.assign(new Error('请等待会话与后台任务空闲后再更改分类'), { status: 409, code: 'SESSION_BUSY' });
            return worker ? worker.exclusive(() => operation(worker)) : operation(null);
        });
        this.editing.set(sessionPath, edit);
        try { return await edit; }
        finally { if (this.editing.get(sessionPath) === edit) this.editing.delete(sessionPath); }
    }

    async withSessionRemoval(sessionPath, operation) {
        this.assertReferenceWritable();
        if (this.disposing) throw new Error('Pi supervisor is shutting down');
        if (this.editing.has(sessionPath)) throw new Error('Session metadata is being changed');
        if (this.moving.has(sessionPath)) throw new Error('Session is being moved');
        if (this.removing.has(sessionPath)) throw new Error('Session is being deleted');
        // Reserve before awaiting startup or shutdown; reconnects must not recreate the worker.
        const removal = Promise.resolve().then(async () => {
            await this.starting.get(sessionPath);
            const worker = this.workers.get(sessionPath);
            return worker ? worker.exclusive(() => operation(worker), { idle: false }) : operation(null);
        });
        this.removing.set(sessionPath, removal);
        try { return await removal; }
        finally { this.removing.delete(sessionPath); }
    }

    stopSession(sessionPath) {
        if (this.retiring.has(sessionPath)) return this.retiring.get(sessionPath);
        const worker = this.workers.get(sessionPath);
        if (!worker) return Promise.resolve();
        // Keep ownership until both Shell and RPC process termination complete.
        // A failed disposal remains a blocker, never an invitation to spawn a
        // second writer or collect files under an uncertain live process.
        const retiring = Promise.resolve().then(() => worker.dispose()).then(() => {
            if (this.workers.get(sessionPath) === worker) this.workers.delete(sessionPath);
            if (this.retiring.get(sessionPath) === retiring) this.retiring.delete(sessionPath);
        });
        this.retiring.set(sessionPath, retiring);
        return retiring;
    }

    async _sweep() {
        const now = Date.now();
        const evictions = [];
        for (const [sessionPath, worker] of this.workers) {
            if (!worker.canEvict(now, this.idleMs)) continue;
            evictions.push(this.stopSession(sessionPath));
        }
        await Promise.allSettled(evictions);
    }

    async dispose() {
        this.disposing = true;
        clearInterval(this.sweepTimer);
        await Promise.allSettled([...this.starting.values(), ...this.retiring.values(), ...this.removing.values(), ...this.editing.values(), ...this.moving.values()]);
        const workers = [...this.workers.values(), ...this.ephemeralWorkers];
        this.workers.clear();
        this.ephemeralWorkers.clear();
        await Promise.allSettled(workers.map(worker => worker.dispose()));
    }
}

module.exports = { PiAgentSupervisor };
