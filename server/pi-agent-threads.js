const fs = require('node:fs');
const { createHash, timingSafeEqual } = require('node:crypto');
const { getSdk } = require('./pi-session-store');

const { customTypeIs } = require('./pivane-compat');
const TASK_ENTRY = 'pivane-agent-task';
const TASK_MESSAGE = 'pivane-agent-task-message';
const TASK_RECEIPT = 'pivane-agent-task-receipt';
function taskProfile(manager) {
    return manager.getEntries().find(entry => entry.type === 'custom' && customTypeIs(entry, TASK_ENTRY)
        && entry.data?.version === 1 && entry.data.sessionId === manager.getSessionId())?.data || null;
}
function taskState(manager) {
    return manager.getEntries().findLast(entry => entry.type === 'custom' && customTypeIs(entry, 'pivane-agent-task-state')
        && entry.data?.sessionId === manager.getSessionId())?.data || null;
}
function validateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['requestId', 'title', 'message', 'provider', 'modelId', 'thinkingLevel'].includes(key))) throw new Error('Invalid task request');
    for (const [key, max] of [['requestId', 160], ['title', 120], ['message', 40000]]) {
        if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) throw new Error(`Invalid ${key}`);
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(input.requestId)) throw new Error('Invalid requestId');
    if ((input.provider === undefined) !== (input.modelId === undefined)) throw new Error('Specify provider and modelId together');
    for (const key of ['provider', 'modelId', 'thinkingLevel']) if (input[key] !== undefined
        && (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 500)) throw new Error(`Invalid ${key}`);
    return { ...input, title: input.title.trim() };
}

class AgentThreadsService {
    constructor({ store, supervisor, settingsService, isSuspended = () => false }) {
        Object.assign(this, { store, supervisor, settingsService, isSuspended });
        this.jobs = new Map();
    }
    authenticate(req) {
        const bearer = String(req.headers.authorization || '');
        for (const worker of this.supervisor.workers.values()) {
            if (worker.disposed || worker.restarting || worker.noSession) continue;
            const expected = `Bearer ${worker.navigationToken}`;
            if (Buffer.byteLength(bearer) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(bearer), Buffer.from(expected)))
                return { kind: 'agent-thread', worker };
        }
        return null;
    }
    async catalog(cwd) {
        const { SettingsManager, getAgentDir } = await getSdk();
        const settings = SettingsManager.create(cwd, getAgentDir());
        const runtime = await this.settingsService.createModelRuntime();
        const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(20000) });
        if (available.length > 5000) throw new Error('Model catalog exceeds 5000 entries');
        const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
        return { defaults: { provider: settings.getDefaultProvider(), modelId: settings.getDefaultModel(), thinkingLevel: settings.getDefaultThinkingLevel() || 'medium' },
            models: available.map(model => ({ provider: model.provider, modelId: model.id, name: model.name,
                thinkingLevels: getSupportedThinkingLevels(model) })) };
    }
    async records(cwd) {
        const { SessionManager } = await getSdk();
        const sessions = await this.store.listSessions(cwd);
        if (sessions.length > 2000) throw new Error('Task lookup is limited to projects with at most 2000 sessions');
        let bytes = 0;
        return sessions.map(row => {
            const session = { ...row, path: fs.realpathSync.native(row.path) };
            bytes += fs.statSync(session.path).size;
            if (bytes > 64 * 1024 * 1024) throw new Error('Task lookup exceeds the 64 MiB session budget');
            const manager = SessionManager.open(session.path);
            return { session, task: taskProfile(manager), state: taskState(manager) };
        }).filter(record => record.task);
    }
    receipt({ session, task, state }, extra = {}) {
        const worker = this.supervisor.getActiveWorker(session.path);
        const activity = worker?.activity.snapshot();
        return { session: { id: session.id, cwd: session.cwd, name: session.name }, requestId: task.requestId,
            source: task.source, model: task.model, thinkingLevel: task.thinkingLevel,
            status: activity?.busy ? activity.phase : state?.status === 'settled' ? state.outcome : state ? (worker ? 'submitted' : 'uncertain') : 'saved',
            ...extra };
    }
    async lookup(source, requestId) {
        if (typeof requestId !== 'string' || requestId.length > 160) throw new Error('Invalid requestId');
        if (this.jobs.has(`${source.sessionId}:${requestId}`)) return { requestId, status: 'preparing' };
        const record = (await this.records(source.cwd)).find(row => row.task.source.sessionId === source.sessionId && row.task.requestId === requestId);
        if (!record) throw new Error('Task not found for this source thread');
        return this.receipt(record);
    }
    create(source, raw) {
        const input = validateInput(raw);
        const key = `${source.sessionId}:${input.requestId}`;
        if (this.jobs.has(key)) throw new Error('Task creation is still in progress; use status instead of resubmitting');
        if (this.stopping || this.isSuspended() || this.supervisor.disposing) throw new Error('Workspace is stopping');
        if (this.jobs.size >= 3) throw new Error('At most three task launches may be prepared at once');
        // Reserve before the first await. Unknown outcomes are never automatically replayed.
        this.jobs.set(key, true);
        const job = this._create(source, input).finally(() => this.jobs.delete(key));
        this.jobs.set(key, job);
        return job;
    }
    async dispose() {
        this.stopping = true;
        await Promise.allSettled([...this.jobs.values()]);
    }
    async _create(source, input) {
        const fingerprint = createHash('sha256').update(JSON.stringify([input.title, input.message, input.provider ?? null, input.modelId ?? null, input.thinkingLevel ?? null])).digest('hex');
        const records = await this.records(source.cwd);
        const existing = records.find(row => row.task.source.sessionId === source.sessionId && row.task.requestId === input.requestId);
        if (existing) {
            if (existing.task.fingerprint !== fingerprint) throw new Error('requestId already belongs to a different task');
            return this.receipt(existing, { reused: true });
        }
        const parent = records.find(row => row.session.id === source.sessionId)?.task;
        const depth = (parent?.depth || 0) + 1;
        if (depth > 3) throw new Error('Task thread nesting is limited to three levels');
        const siblings = records.filter(row => row.task.source.sessionId === source.sessionId && row.state?.status !== 'settled');
        const preparing = [...this.jobs.keys()].filter(key => key.startsWith(`${source.sessionId}:`)).length;
        if (siblings.length + preparing > 3) throw new Error('This source already has three unfinished task threads; inspect them before creating another');
        const catalog = await this.catalog(source.cwd);
        const provider = input.provider ?? catalog.defaults.provider, modelId = input.modelId ?? catalog.defaults.modelId;
        const model = catalog.models.find(row => row.provider === provider && row.modelId === modelId);
        if (!model) throw new Error('The selected or default model is unavailable. Configure a new-thread default or specify an available provider/modelId.');
        const requestedThinking = input.thinkingLevel ?? catalog.defaults.thinkingLevel;
        if (input.thinkingLevel !== undefined && !model.thinkingLevels.includes(input.thinkingLevel)) throw new Error('Thinking level is not supported by the selected model');
        const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        const thinkingLevel = model.thinkingLevels.includes(requestedThinking) ? requestedThinking
            : model.thinkingLevels.filter(level => order.indexOf(level) <= order.indexOf(requestedThinking)).at(-1) || model.thinkingLevels[0];
        if (!thinkingLevel) throw new Error('No supported thinking level for the selected model');
        if (source.disposed || source.restarting || this.stopping || this.isSuspended() || this.supervisor.disposing) throw new Error('Source runtime or workspace is stopping');
        const task = { version: 1, requestId: input.requestId, fingerprint, depth,
            source: { sessionId: source.sessionId, cwd: source.cwd }, model: { provider, modelId }, thinkingLevel };
        const session = await this.store.createSession(source.cwd, input.title, { task: { ...task, message: input.message } });
        let submitted = false;
        try {
            const worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            await worker.launchTask(task);
            submitted = true;
        } catch {
            // Keep the native task and identity even if startup/acknowledgement fails. No new session and no replay.
        }
        const { SessionManager } = await getSdk();
        const state = taskState(SessionManager.open(session.path));
        return this.receipt({ session, task, state }, submitted ? {} : {
            status: state?.status === 'settled' ? state.outcome : state ? 'uncertain' : 'saved',
            notice: 'Task saved. Startup was not confirmed; inspect this same thread before sending anything again.'
        });
    }
}
function mountAgentThreads(router, options) {
    const service = new AgentThreadsService(options);
    options.access.agentThreadIdentity = req => service.authenticate(req);
    for (const action of ['create', 'status', 'models']) router.post(`/agent-threads/${action}`, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const source = req.workspaceIdentity?.kind === 'agent-thread' && req.workspaceIdentity.worker;
            if (!source || source.disposed || source.restarting) return res.status(403).json({ error: 'A live source Agent thread is required' });
            const data = action === 'create' ? await service.create(source, req.body)
                : action === 'models' ? await service.catalog(source.cwd) : await service.lookup(source, req.body?.requestId);
            res.json(data);
        } catch (error) { res.status(400).json({ error: error.message }); }
    });
    return service;
}
module.exports = { TASK_ENTRY, TASK_MESSAGE, TASK_RECEIPT, taskProfile, taskState, AgentThreadsService, mountAgentThreads };
