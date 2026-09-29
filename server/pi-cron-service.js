const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { CronStore } = require('./pi-cron-store');
const { nextTimes, parseCron, latestTime } = require('./pi-cron-schedule');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const number = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function limits(value, defaults = { maxRunsPerDay: 8, maxTokensPerDay: 200000, maxCostPerDay: null }) {
    const result = Object.fromEntries(Object.keys(defaults).map(key => [key, value?.[key] === undefined ? defaults[key] : value[key]]));
    if (!number(result.maxRunsPerDay, 1, 1000) || !number(result.maxTokensPerDay, 1000, 10000000)
        || result.maxCostPerDay !== null && (!Number.isFinite(result.maxCostPerDay) || result.maxCostPerDay <= 0 || result.maxCostPerDay > 10000)) fail('Invalid daily budget');
    return result;
}
function validateJob(input, now) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120
        || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 40000
        || typeof input.enabled !== 'boolean' || !['text', 'work'].includes(input.mode)) fail('Invalid scheduled task');
    if (!input.target || !['thread', 'profile'].includes(input.target.kind)) fail('Choose a target thread or profile');
    const target = input.target.kind === 'thread' ? { kind: 'thread', cwd: input.target.cwd, sessionId: input.target.sessionId }
        : { kind: 'profile', profileId: input.target.profileId };
    if (target.kind === 'profile' ? !uuid(target.profileId) : typeof target.cwd !== 'string' || !uuid(target.sessionId)) fail('Invalid task target');
    const schedule = { kind: input.schedule?.kind, timeZone: input.schedule?.timeZone,
        ...(input.schedule?.kind === 'once' ? { at: input.schedule.at } : { expression: parseCron(input.schedule?.expression).expression }) };
    if (schedule.kind === 'once' && (!Number.isFinite(schedule.at) || schedule.at > now + 8 * 366 * 86400000)) fail('Choose an execution time within eight years');
    const startsAt = input.startsAt ?? null;
    if (startsAt !== null && (!Number.isFinite(startsAt) || startsAt < 0 || startsAt > now + 8 * 366 * 86400000)) fail('Invalid task start time');
    const preview = nextTimes(schedule, Math.max(now, startsAt === null ? 0 : startsAt - 1));
    if (!preview.length) fail('No future execution time within eight years');
    const misfire = input.misfire || { policy: 'skip', graceMinutes: 30 };
    if (!['skip', 'latest'].includes(misfire.policy) || !number(misfire.graceMinutes, 1, 1440)) fail('Invalid missed-run policy');
    const execution = { maxCalls: input.execution?.maxCalls ?? 4, maxTokens: input.execution?.maxTokens ?? 32000,
        maxDurationSeconds: input.execution?.maxDurationSeconds ?? 300 };
    if (!number(execution.maxCalls, 1, 50) || !number(execution.maxTokens, 1000, 1000000)
        || !number(execution.maxDurationSeconds, 10, 3600)) fail('Invalid execution limits');
    let model = null;
    if (input.model) {
        if (['provider', 'modelId', 'thinkingLevel'].some(key => typeof input.model[key] !== 'string' || !input.model[key] || input.model[key].length > 500)) fail('Invalid model selection');
        model = { provider: input.model.provider, modelId: input.model.modelId, thinkingLevel: input.model.thinkingLevel };
    }
    const condition = input.condition || null;
    if (condition && (condition.kind !== 'no-user-since' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(condition.time))) fail('Invalid activity condition');
    return { name: input.name.trim(), prompt: input.prompt, enabled: input.enabled, mode: input.mode, target, schedule, startsAt, model,
        condition: condition ? { kind: condition.kind, time: condition.time } : null,
        misfire: { policy: misfire.policy, graceMinutes: misfire.graceMinutes }, execution, budget: limits(input.budget) };
}
class CronService {
    constructor({ store, supervisor, profiles, catalog, isSuspended = () => false, now = Date.now, filename }) {
        Object.assign(this, { store, supervisor, profiles, catalog, isSuspended, now, filename });
        this.stopping = false; this.running = null; this.mutating = null; this.db = null; this.error = null;
        this.ready = this.initialize();
        this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref?.();
    }
    async initialize() {
        try {
            const { getAgentDir } = await getSdk();
            this.db = new CronStore(this.filename || path.join(getAgentDir(), 'pivane-cron', 'scheduler.sqlite'));
            const now = this.now();
            for (const run of this.db.activeRuns()) if (run.status === 'waiting' && (run.job?.misfire.policy === 'skip'
                || now - run.scheduledAt > (run.job?.misfire.graceMinutes || 30) * 60000)) {
                this.db.saveRun({ ...run, status: 'skipped', reason: 'offline', completedAt: now });
            }
            for (const job of this.db.jobs()) if (job.enabled && job.nextAt <= now) {
                const recent = job.misfire.policy === 'latest' ? latestTime(job.schedule, job.nextAt - 1, now, job.misfire.graceMinutes) : null;
                if (recent !== null) this.db.saveJob({ ...job, nextAt: recent });
                else {
                    this.recordSkip(job, job.nextAt, 'offline');
                    this.advance(job, now);
                }
            }
        } catch (error) { this.error = error.message; }
    }
    get busy() { return Boolean(this.running || this.mutating); }
    healthy() { if (this.error) fail(this.error, 503); if (!this.db) fail('Scheduler is loading', 503); }
    reserve(action) {
        if (this.stopping || this.isSuspended() || this.mutating) fail('Scheduler is busy or workspace is stopping', 409);
        const pending = Promise.resolve().then(async () => { await this.ready; this.healthy(); return action(); });
        this.mutating = pending;
        return pending.finally(() => { if (this.mutating === pending) this.mutating = null; });
    }
    async snapshot() {
        await this.ready; this.healthy();
        const now = this.now(), day = new Date(now).toISOString().slice(0, 10);
        return { schedulerError: this.lastError || null, jobs: this.db.jobs().filter(job => !job.deleted).map(job => ({ ...job, today: this.db.usage(day, job.id),
            lastRun: this.db.runs(job.id)[0] || null })), homes: this.db.homes(), limits: this.db.limits(), today: this.db.usage(day),
            capabilities: { maxJobs: 100, maxRuns: 10000, budgetDay: 'UTC', cost: 'estimated', maxConcurrent: 2 }, serverTime: now };
    }
    async target(target) {
        let ref = target;
        if (target.kind === 'profile') {
            const profile = await this.profiles.getProfile(target.profileId);
            if (!profile?.enabled) fail('Target profile is unavailable');
            ref = this.db.home(target.profileId);
            if (!ref?.sessionId || ref.status !== 'ready') fail('Choose or create the profile main thread first');
        }
        const session = await this.store.getSession(ref.cwd, ref.sessionId);
        if (session.assistant || session.profileAuthoring) fail('Management threads cannot receive scheduled tasks');
        if (session.agentProfile && !session.agentProfile.available) fail('Target profile is disabled or unavailable');
        if (target.kind === 'profile' && session.agentProfile?.id !== target.profileId) fail('Main thread identity no longer matches');
        return session;
    }
    save(input) {
        return this.reserve(async () => {
            if (!uuid(input.id)) fail('A stable task ID is required');
            const previous = this.db.job(input.id);
            const job = validateJob(input, this.now());
            if (previous?.deleted) fail('This task was deleted; use a new ID', 409);
            if (previous && previous.revision !== input.revision) {
                if (previous.fingerprint === hash(job)) return previous;
                fail('Task changed; reload before saving', 409);
            }
            if (!previous && this.db.jobs().length >= 100) fail('Task capacity reached');
            if (this.db.activeRuns(input.id).length) fail('Finish or review the active run before editing', 409);
            if (job.enabled || job.target.kind === 'thread') await this.target(job.target);
            if (job.model) {
                const session = await this.target(job.target), catalog = await this.catalog(session.cwd);
                if (!catalog.models.some(model => model.provider === job.model.provider && model.modelId === job.model.modelId
                    && model.thinkingLevels.includes(job.model.thinkingLevel))) fail('Model or thinking level is unavailable');
            }
            if (this.stopping || this.isSuspended()) fail('Workspace is stopping', 409);
            const record = { ...job, id: input.id, revision: (previous?.revision || 0) + 1, fingerprint: hash(job),
                createdAt: previous?.createdAt || this.now(), updatedAt: this.now(), nextAt: nextTimes(job.schedule, Math.max(this.now(), (job.startsAt || 0) - 1), 1)[0] ?? null };
            this.db.saveJob(record); return record;
        });
    }
    home(profileId, input) {
        return this.reserve(() => this.profiles.reserve(async () => {
            const profile = await this.profiles.getProfile(profileId);
            if (!profile?.enabled) fail('Profile is unavailable');
            const previous = this.db.home(profileId);
            const requestHash = hash([input.cwd, input.sessionId ?? null, input.create === true]);
            if ((previous?.revision || 0) !== input.revision) {
                if (input.requestId && previous?.requestId === input.requestId && previous.requestHash === requestHash) return previous;
                fail('Main thread changed; reload first', 409);
            }
            let session;
            if (input.create === true) {
                if (!uuid(input.requestId)) fail('A stable request ID is required');
                if (previous?.status === 'creating') fail('Previous creation needs review; choose the saved thread', 409);
                const cwd = this.store.resolveProject(input.cwd);
                this.db.saveHome(profileId, { ...previous, status: 'creating', revision: (previous?.revision || 0) + 1, requestId: input.requestId, requestHash, cwd });
                session = await this.store.createSession(cwd, `${profile.name} · ${input.language === 'en' ? 'Main conversation' : '主对话'}`,
                    { agentProfileId: profileId });
            } else {
                session = await this.store.getSession(input.cwd, input.sessionId);
                if (session.agentProfile?.id !== profileId || session.assistant || session.profileAuthoring) fail('Choose a regular thread belonging to this profile');
            }
            const result = { status: 'ready', cwd: session.cwd, sessionId: session.id, name: session.name,
                revision: (previous?.revision || 0) + 1, requestId: input.requestId || null, requestHash };
            this.db.saveHome(profileId, result); return result;
        }));
    }
    advance(job, now) {
        const latest = this.db.job(job.id);
        if (!latest || latest.revision !== job.revision) return;
        const nextAt = nextTimes(job.schedule, Math.max(now, (job.startsAt || 0) - 1), 1)[0] ?? null;
        this.db.saveJob({ ...latest, nextAt, enabled: latest.enabled && nextAt !== null });
    }
    recordSkip(job, at, reason) {
        const id = hash([job.id, job.revision, at]);
        if (!this.db.run(id)) this.db.saveRun({ id, jobId: job.id, scheduledAt: at, status: 'skipped', reason, completedAt: this.now() });
    }
    action(id, input) {
        return this.reserve(async () => {
            const job = this.db.job(id);
            if (!job || job.deleted) fail('Task not found', 404);
            if (input.revision !== job.revision) fail('Task changed; reload first', 409);
            if (input.action === 'pause' || input.action === 'delete' || input.action === 'resume') {
                if (input.action === 'resume') {
                    if (this.db.activeRuns(id).length) fail('Review the active run first', 409);
                    await this.target(job.target);
                }
                if (input.action === 'delete' && this.db.activeRuns(id).length) fail('Finish or review the active run before deleting', 409);
                const nextAt = input.action === 'resume' ? nextTimes(job.schedule, Math.max(this.now(), (job.startsAt || 0) - 1), 1)[0] : job.nextAt;
                if (input.action === 'resume' && !nextAt) fail('Choose a future execution time');
                const result = { ...job, enabled: input.action === 'resume', deleted: input.action === 'delete', fingerprint: null, revision: job.revision + 1, nextAt };
                this.db.saveJob(result);
                for (const run of this.db.activeRuns(id)) if (run.status === 'waiting') this.db.saveRun({ ...run, status: 'cancelled', completedAt: this.now() });
                return result;
            }
            if (input.action === 'run') {
                if (!uuid(input.requestId)) fail('A stable request ID is required');
                const runId = hash([id, 'manual', input.requestId]);
                const previous = this.db.run(runId); if (previous) return previous;
                return this.enqueue(job, this.now(), runId, true);
            }
            const run = this.db.run(input.runId);
            if (!run || run.jobId !== id) fail('Run not found');
            if (input.action === 'acknowledge' && run.status === 'uncertain') {
                if (run.target) {
                    let session;
                    try { session = await this.store.getSession(run.target.cwd, run.target.sessionId); }
                    catch (error) {
                        if ([...this.supervisor.workers.values()].some(worker => worker.sessionId === run.target.sessionId && !worker.disposed)) throw error;
                    }
                    if (session) {
                        const worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionId: session.id, sessionPath: session.path });
                        await worker.cron({ action: 'acknowledge', runId: run.id });
                    }
                }
                this.db.saveRun({ ...run, status: 'stopped', reason: 'reviewed-uncertain', completedAt: this.now() });
                return this.db.run(run.id);
            }
            if (input.action === 'stop') {
                if (run.status === 'waiting') this.db.saveRun({ ...run, status: 'cancelled', completedAt: this.now() });
                else if (run.target) {
                    const session = await this.store.getSession(run.target.cwd, run.target.sessionId);
                    const worker = this.supervisor.getActiveWorker(session.path);
                    if (!worker || worker.cronRun !== run.id) fail('Execution state needs review', 409);
                    await worker.request('abort');
                }
                return this.db.run(run.id);
            }
            fail('Unsupported task action');
        });
    }
    enqueue(job, at, id = hash([job.id, job.revision, at]), manual = false) {
        const previous = this.db.run(id); if (previous) return previous;
        if (this.db.runCount() >= 10000) fail('Execution history capacity reached; scheduling is paused');
        if (this.db.activeRuns(job.id).length) {
            if (manual) fail('This task already has an unfinished run', 409);
            this.recordSkip(job, at, 'overlap'); return null;
        }
        const run = { id, jobId: job.id, scheduledAt: at, status: 'waiting', manual, job, createdAt: this.now() };
        this.db.saveRun(run); return run;
    }
    async tick() {
        if (this.running || this.mutating || this.stopping || this.isSuspended()) return;
        this.running = Promise.resolve().then(async () => {
            await this.ready; this.healthy();
            await this.reconcile();
            const now = this.now();
            for (const job of this.db.jobs()) if (job.enabled && job.nextAt !== null && job.nextAt <= now) {
                const at = job.misfire.policy === 'latest' ? latestTime(job.schedule, job.nextAt - 1, now, job.misfire.graceMinutes) : job.nextAt;
                const late = at === null ? Infinity : now - at;
                if (late > (job.misfire.policy === 'skip' ? 60000 : job.misfire.graceMinutes * 60000)) this.recordSkip(job, job.nextAt, 'expired');
                else this.enqueue(job, at);
                this.advance(job, now);
            }
            for (const run of this.db.activeRuns().filter(run => run.status === 'waiting')) {
                if (this.stopping || this.isSuspended() || this.mutating) break;
                if (this.db.activeRuns().filter(run => ['dispatching', 'running'].includes(run.status)).length >= 2) break;
                await this.dispatch(run);
            }
        }).catch(error => { this.lastError = error.message; }).finally(() => { this.running = null; });
        return this.running;
    }
    async dispatch(run) {
        let handedOff = false;
        try {
            const job = run.job, now = this.now();
            const grace = job.misfire.policy === 'skip' ? 60000 : job.misfire.graceMinutes * 60000;
            if (now - run.scheduledAt > grace) { this.db.saveRun({ ...run, status: 'skipped', reason: 'expired', completedAt: now }); return; }
            const session = await this.target(job.target);
            if (!this.supervisor.isSessionIdle(session.path)) return;
            const worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionId: session.id, sessionPath: session.path });
            if (session.agentProfile) {
                const profile = await this.profiles.getProfile(session.agentProfile.id);
                if (!worker.loadedAgentProfileConfirmed || worker.loadedAgentProfileId !== profile?.id
                    || worker.loadedAgentProfileRevision !== require('./pi-profile-registry').profileRevision(profile)) fail('Reopen the idle target thread to load its saved profile');
            }
            await worker.exclusive(async (_rpc, runtime) => {
                if (this.stopping || this.isSuspended() || this.mutating || this.db.run(run.id)?.status !== 'waiting') return;
                const day = new Date(now).toISOString().slice(0, 10);
                let pricing = runtime.model?.cost;
                if (job.model && (runtime.model?.provider !== job.model.provider || runtime.model?.id !== job.model.modelId)) {
                    const runtimeCatalog = await worker.client.request('get_available_models');
                    pricing = runtimeCatalog.models?.find(model => model.provider === job.model.provider && model.id === job.model.modelId)?.cost;
                }
                const rates = ['input', 'output', 'cacheRead', 'cacheWrite'].map(key => pricing?.[key]);
                const reservedCost = rates.every(rate => Number.isFinite(rate) && rate >= 0) && Math.max(...rates) > 0
                    ? Math.max(...rates) * job.execution.maxTokens / 1000000 : null;
                for (const [limit, usage] of [[this.db.limits(), this.db.usage(day)], [job.budget, this.db.usage(day, job.id)]]) {
                    if (usage.runs >= limit.maxRunsPerDay || usage.tokens + job.execution.maxTokens > limit.maxTokensPerDay)
                        fail('Daily execution or token budget exhausted');
                    if (limit.maxCostPerDay !== null && (reservedCost === null || usage.unknownCost || usage.cost + reservedCost > limit.maxCostPerDay))
                        fail('Daily money budget exhausted or model pricing is unknown');
                }
                if (this.stopping || this.isSuspended() || this.mutating || this.db.run(run.id)?.status !== 'waiting') return;
                if (job.target.kind === 'profile') {
                    const home = this.db.home(job.target.profileId);
                    if (home?.status !== 'ready' || home.sessionId !== session.id || home.cwd !== session.cwd) return;
                }
                run = { ...run, status: 'dispatching', target: { cwd: session.cwd, sessionId: session.id, name: session.name },
                    budgetDay: day, reservedTokens: job.execution.maxTokens, reservedCost, startedAt: now };
                this.db.saveRun(run); handedOff = true;
            });
            if (!handedOff) return;
            const result = await worker.cron({ action: 'start', runId: run.id, jobId: job.id, sessionId: session.id,
                name: job.name, prompt: job.prompt, scheduledAt: run.scheduledAt, timeZone: job.schedule.timeZone,
                profile: session.agentProfile ? { id: worker.loadedAgentProfileId, revision: worker.loadedAgentProfileRevision } : null,
                mode: job.mode, condition: job.condition, model: job.model, ...job.execution });
            this.applyResult(run, result);
        } catch (error) {
            if (error.code === 'SESSION_BUSY' && !handedOff) return;
            const status = handedOff ? 'uncertain' : 'failed';
            this.db.saveRun({ ...run, status, reason: error.message, completedAt: status === 'failed' ? this.now() : undefined });
        }
    }
    applyResult(run, result) {
        if (!result) return;
        const status = result.status === 'prepared' ? 'uncertain' : result.status === 'settled' ? 'running' : result.status;
        const complete = ['completed', 'silent', 'skipped', 'stopped', 'error'].includes(status);
        this.db.saveRun({ ...run, status, reason: result.reason, model: result.model, thinkingLevel: result.thinkingLevel,
            usage: result.usage, replyEntryId: result.replyEntryId, ...(complete ? { completedAt: result.completedAt || this.now() } : {}) });
        if (complete && status !== 'silent' && status !== 'skipped' && run.status !== status) {
            this.supervisor.emit('completion', { cwd: run.target.cwd, sessionId: run.target.sessionId,
                completionId: run.id, completedAt: new Date(this.now()).toISOString() });
        }
    }
    async reconcile() {
        for (const run of this.db.activeRuns().filter(run => ['running', 'dispatching', 'uncertain'].includes(run.status))) {
            if (!run.target) continue;
            try {
                const session = await this.store.getSession(run.target.cwd, run.target.sessionId);
                const worker = this.supervisor.getActiveWorker(session.path);
                if (!worker) {
                    if (run.status !== 'uncertain') this.db.saveRun({ ...run, status: 'uncertain', reason: 'worker-exited' });
                    continue;
                }
                const result = await worker.cron({ action: 'finish', runId: run.id });
                if (result && !(run.status === 'uncertain' && ['running', 'prepared'].includes(result.status))) this.applyResult(run, result);
            } catch (error) {
                if (error.code !== 'SESSION_BUSY' && run.status !== 'uncertain') this.db.saveRun({ ...run, status: 'uncertain', reason: error.message });
            }
        }
    }
    async removing(session) {
        await this.ready; this.healthy();
        for (const home of this.db.homes()) if (home.sessionId === session.id && home.cwd === session.cwd)
            this.db.saveHome(home.profileId, { ...home, status: 'missing', revision: home.revision + 1 });
        for (const job of this.db.jobs()) if (job.target.kind === 'thread' && job.target.cwd === session.cwd && job.target.sessionId === session.id
            || job.target.kind === 'profile' && this.db.home(job.target.profileId)?.sessionId === session.id) {
            this.db.saveJob({ ...job, enabled: false, fingerprint: null, revision: job.revision + 1 });
            for (const run of this.db.activeRuns(job.id)) if (run.status === 'waiting') this.db.saveRun({ ...run, status: 'cancelled', reason: 'target-deleted', completedAt: this.now() });
        }
    }
    async dispose() {
        this.stopping = true; clearInterval(this.timer);
        await this.ready; await this.running; await this.mutating?.catch(() => {});
        this.db?.close();
    }
}
function mountCron(router, service) {
    const route = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await action(req)); } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    };
    router.get('/cron', route(() => service.snapshot()));
    router.put('/cron/jobs', route(req => service.save(req.body)));
    router.post('/cron/jobs/:id/actions', route(req => service.action(req.params.id, req.body)));
    router.get('/cron/jobs/:id/runs', route(async req => { await service.ready; service.healthy(); return { runs: service.db.runs(req.params.id).slice(0, 100) }; }));
    router.post('/cron/preview', route(req => {
        const startsAt = req.body.startsAt ?? 0;
        if (!Number.isFinite(startsAt) || startsAt < 0 || startsAt > service.now() + 8 * 366 * 86400000) fail('Invalid task start time');
        return { times: nextTimes(req.body.schedule, Math.max(service.now(), startsAt - 1)) };
    }));
    router.put('/cron/limits', route(req => service.reserve(() => {
        const previous = service.db.limits();
        if (hash(previous) !== req.body.revision) fail('Budget changed; reload first', 409);
        const result = limits(req.body.limits, previous); service.db.setMeta('limits', result); return result;
    })));
    router.get('/cron/limits', route(async () => { await service.ready; service.healthy(); const result = service.db.limits(); return { limits: result, revision: hash(result) }; }));
    router.put('/cron/homes/:id', route(req => service.home(req.params.id, req.body)));
    router.get('/cron/models', route(req => service.catalog(service.store.resolveProject(req.query.cwd))));
}
module.exports = { CronService, mountCron, validateJob, limits };
