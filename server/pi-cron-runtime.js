const { Type } = require('typebox');
const { localParts, dayKey } = require('./pi-cron-schedule');
const STATE = 'pivane-cron-run';
const MESSAGE = 'pivane-cron-message';
function lastRun(manager, id) {
    return manager.getEntries().findLast(entry => entry.type === 'custom' && entry.customType === STATE
        && entry.data?.sessionId === manager.getSessionId() && (!id || entry.data.runId === id))?.data || null;
}
function usageSince(manager, state) {
    const entries = manager.getEntries(), start = entries.findIndex(entry => entry.type === 'custom' && entry.customType === STATE
        && entry.data?.runId === state.runId && entry.data.status === 'prepared');
    const after = entries.slice(start + 1);
    const rows = after.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant');
    const charged = after.filter(entry => entry.type === 'compaction' || entry.type === 'branch_summary'
        || entry.type === 'message' && (entry.message?.role === 'assistant' || entry.message?.usage));
    const usage = { tokens: 0, cost: 0, calls: state.requests || rows.length };
    let known = true;
    for (const row of charged) {
        const u = row.message?.usage || row.usage;
        if (!u) { known = false; continue; }
        usage.tokens += ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, key) => n + (Number(u[key]) || 0), 0);
        if (typeof u.cost?.total === 'number' && u.cost.total > 0) usage.cost += u.cost.total; else known = false;
    }
    if (!known || !rows.length) usage.cost = null;
    if (usage.calls > 0 && usage.tokens === 0) usage.tokens = null;
    const last = rows.at(-1);
    return { usage, replyEntryId: last?.id || null, stopReason: last?.message.stopReason };
}
function registerCron(pi) {
    let active = null, timer = null;
    const report = ctx => ctx.ui.notify(JSON.stringify({ pivaneCron: { sessionId: ctx.sessionManager.getSessionId(),
        runId: active?.runId, active: Boolean(active && !['completed', 'silent', 'skipped', 'error', 'stopped'].includes(active.status)),
        status: active?.status, silent: active?.silent === true } }));
    const persist = (ctx, changes) => {
        active = { ...active, ...changes };
        pi.appendEntry(STATE, { ...active, sessionId: ctx.sessionManager.getSessionId() });
        report(ctx);
    };
    pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'rpc' || !ctx.sessionManager.getSessionFile() || !process.env.PI_WEB_NAVIGATION_TOKEN) return;
        const state = lastRun(ctx.sessionManager);
        active = state && !['completed', 'silent', 'skipped', 'error', 'stopped'].includes(state.status) ? state : null;
        report(ctx);
        pi.registerTool({ name: 'cron_silent', label: 'Finish scheduled task silently',
            description: 'During a scheduled task only: finish without a greeting or notification when there is nothing useful to send. Do not output a final reply afterward.',
            parameters: Type.Object({ reason: Type.String({ maxLength: 200 }) }),
            execute: async (_id, params, _signal, _update, context) => {
                if (!active || active.status !== 'running') throw new Error('No scheduled task is active');
                persist(context, { silent: true, reason: params.reason });
                return { content: [{ type: 'text', text: 'Scheduled task finished silently.' }], details: { silent: true }, terminate: true };
            } });
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'cron_silent'));
    });
    pi.on('before_agent_start', (event) => {
        if (!active || active.status !== 'running') return;
        return { systemPrompt: event.systemPrompt + '\n\nThis turn is a user-configured scheduled task. Perform only its saved instructions within existing permissions. '
            + 'Its scheduled timestamp is context, not the current clock. Do not create other tasks, delegate, send messages to other threads, or generate media. '
            + 'If no message is appropriate, use cron_silent and finish. Do not send acknowledgements for a silent run.' };
    });
    pi.on('tool_call', event => {
        if (!active || active.status !== 'running') return;
        if (active.mode === 'text' && event.toolName !== 'cron_silent'
            || /^(agent_thread|agent_message|subagent|agent_message|media_|image_generate|video_generate)/.test(event.toolName))
            return { block: true, reason: 'This scheduled run does not allow delegation, cross-thread messaging or media execution.' };
    });
    pi.on('cache_warming_decision', () => active ? { action: 'stop' } : undefined);
    pi.on('before_provider_request', (_event, ctx) => {
        if (!active || active.status !== 'running') return;
        if ((active.requests || 0) >= active.maxCalls || Date.now() >= active.deadline) {
            persist(ctx, { reason: 'run-limit' }); ctx.abort(); return;
        }
        persist(ctx, { requests: (active.requests || 0) + 1 });
    });
    pi.on('turn_start', (_event, ctx) => {
        if (!active || active.status !== 'running') return;
        const usage = usageSince(ctx.sessionManager, active).usage;
        if (usage.calls >= active.maxCalls || usage.tokens >= active.maxTokens || Date.now() >= active.deadline) {
            persist(ctx, { reason: 'run-limit' }); ctx.abort();
        }
    });
    pi.on('agent_before_settle', (event, ctx) => {
        if (active?.status === 'running') persist(ctx, { outcome: event.outcome });
    });
    pi.on('agent_settled', (_event, ctx) => {
        clearTimeout(timer); timer = null;
        if (!active || active.status !== 'running') return;
        const result = usageSince(ctx.sessionManager, active);
        persist(ctx, { status: 'settled', ...result, settledAt: Date.now() });
    });
    pi.on('session_shutdown', () => { clearTimeout(timer); });
    async function restore(ctx, state) {
        if (state.originalModel) {
            const model = ctx.modelRegistry.find(state.originalModel.provider, state.originalModel.id);
            if (!model || !await pi.setModel(model)) throw new Error('Original model could not be restored');
        }
        if (state.originalThinking) pi.setThinkingLevel(state.originalThinking);
        if (state.originalTools) pi.setActiveTools(state.originalTools);
    }
    return async (ctx, input) => {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Scheduled target is busy');
        if (input.action === 'status' || input.action === 'finish') {
            const state = lastRun(ctx.sessionManager, input.runId);
            if (!state || input.action === 'status') return state;
            if (state.status === 'settled') {
                await restore(ctx, state);
                active = state;
                persist(ctx, { status: state.silent ? 'silent' : state.outcome === 'aborted' || ['run-limit', 'time-limit'].includes(state.reason) ? 'stopped'
                    : state.stopReason === 'stop' ? 'completed' : state.stopReason === 'aborted' ? 'stopped' : 'error', completedAt: Date.now() });
                const result = active; active = null; return result;
            }
            return state;
        }
        if (input.action === 'acknowledge') {
            const state = lastRun(ctx.sessionManager, input.runId);
            if (!state) return null;
            await restore(ctx, state);
            active = state; persist(ctx, { status: 'stopped', reason: 'reviewed-uncertain', completedAt: Date.now() });
            const result = active; active = null; return result;
        }
        if (input.action !== 'start' || !/^[a-f0-9]{64}$/.test(input.runId) || input.sessionId !== ctx.sessionManager.getSessionId()
            || typeof input.prompt !== 'string' || input.prompt.length > 40000) throw new Error('Invalid scheduled task');
        const previous = lastRun(ctx.sessionManager, input.runId);
        if (previous) return previous;
        const unfinished = lastRun(ctx.sessionManager);
        if (unfinished && !['completed', 'silent', 'skipped', 'error', 'stopped'].includes(unfinished.status)) throw new Error('A previous scheduled run needs review');
        if (input.condition?.kind === 'no-user-since') {
            const today = dayKey(Date.now(), input.timeZone), [hour, minute] = input.condition.time.split(':').map(Number);
            const appeared = ctx.sessionManager.getBranch().some(entry => {
                if (entry.type !== 'message' || entry.message?.role !== 'user') return false;
                const timestamp = Date.parse(entry.timestamp);
                const p = localParts(timestamp, input.timeZone);
                return dayKey(timestamp, input.timeZone) === today && p.hour * 60 + p.minute >= hour * 60 + minute;
            });
            if (appeared) {
                const skipped = { version: 1, runId: input.runId, sessionId: input.sessionId, status: 'skipped', reason: 'user-active', completedAt: Date.now(), usage: { tokens: 0, cost: 0, calls: 0 } };
                pi.appendEntry(STATE, skipped); return skipped;
            }
        }
        let model = ctx.model;
        if (input.model) {
            model = ctx.modelRegistry.find(input.model.provider, input.model.modelId);
            if (!model) throw new Error('Scheduled model is unavailable');
            const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
            if (!getSupportedThinkingLevels(model).includes(input.model.thinkingLevel)) throw new Error('Unsupported thinking level');
        }
        if (!model) throw new Error('Configure a model for the target thread');
        active = { version: 1, runId: input.runId, sessionId: input.sessionId, status: 'prepared', mode: input.mode,
            maxCalls: input.maxCalls, maxTokens: input.maxTokens, deadline: Date.now() + input.maxDurationSeconds * 1000,
            originalModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
            originalThinking: pi.getThinkingLevel(), originalTools: pi.getActiveTools(),
            model: { provider: model.provider, modelId: model.id }, startedAt: Date.now() };
        persist(ctx, {});
        if (input.model) {
            if (!await pi.setModel(model)) throw new Error('Scheduled model is unavailable');
            pi.setThinkingLevel(input.model.thinkingLevel);
        }
        pi.setActiveTools(input.mode === 'text' ? ['cron_silent'] : [...active.originalTools, 'cron_silent']);
        if (input.profile) {
            const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
            const root = getAgentDir();
            const runtime = require('./pi-profile-runtime').readProfileRuntime(ctx.sessionManager, ctx.cwd, root,
                require('node:path').join(require('node:fs').realpathSync.native(root), 'sessions'));
            if (!runtime || runtime.context.profileId !== input.profile.id || runtime.revision !== input.profile.revision)
                throw new Error('Saved profile changed before scheduled execution');
        }
        persist(ctx, { status: 'running', thinkingLevel: pi.getThinkingLevel() });
        const header = `[User-configured scheduled task: ${input.name}; scheduled ${new Date(input.scheduledAt).toISOString()}; timezone ${input.timeZone}. Execute within the saved task scope.]`;
        pi.sendMessage({ customType: MESSAGE, content: `${header}\n\n${input.prompt}`, display: true,
            details: { runId: input.runId, jobId: input.jobId, name: input.name, scheduledAt: input.scheduledAt, bodyOffset: header.length + 2 } }, { triggerTurn: true });
        timer = setTimeout(() => { if (active?.runId === input.runId && active.status === 'running') { persist(ctx, { reason: 'time-limit' }); ctx.abort(); } }, input.maxDurationSeconds * 1000);
        timer.unref?.();
        return active;
    };
}
module.exports = { registerCron, lastRun, STATE, MESSAGE, usageSince };
