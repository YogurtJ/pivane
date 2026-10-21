const { randomBytes } = require('node:crypto');
const { collect, MESSAGE, CRON_MESSAGE, isTurnNotice } = require('./turn-results');
const THREAD_STATE = 'pivane-thread-turn';
const terminal = new Set(['completed', 'stopped', 'error']);
function sourceFor(entries) {
    const input = entries.find(e => e.type === 'message' && e.message?.role === 'user'
        || e.type === 'custom_message' && !isTurnNotice(e));
    return input?.customType === MESSAGE ? { kind: 'channel', id: input.details?.messageId }
        : input?.customType === CRON_MESSAGE ? { kind: 'cron', id: input.details?.runId } : { kind: 'thread' };
}

function bindingBoundary(manager) {
    const last = manager.getBranch().findLast(e => e.type === 'custom' && e.customType === THREAD_STATE && terminal.has(e.data?.status));
    return { boundAt: Date.now(), excludedTurnId: last?.data?.id || null };
}
function threadOutcome(manager, id) {
    const branch = manager.getBranch();
    const rows = branch.flatMap((entry, index) => entry.type === 'custom' && entry.customType === THREAD_STATE && entry.data?.id === id ? [{ entry, index }] : []);
    if (rows.length !== 2 || rows.some(row => row.entry.data.sessionId !== manager.getSessionId())) return null;
    const start = rows[0], end = rows[1], state = end.entry.data;
    if (start.entry.data.status !== 'running' || !terminal.has(state.status)) return null;
    const entries = branch.slice(start.index + 1, end.index);
    if (JSON.stringify(sourceFor(entries)) !== JSON.stringify(state.source)) return null;
    if (entries.some(e => e.type === 'custom' && e.customType === THREAD_STATE)) return null;
    const reply = entries.findLast(e => e.type === 'message' && e.message?.role === 'assistant');
    if ((reply?.id || null) !== state.replyEntryId || state.status === 'completed' && !reply) return null;
    return collect(state, entries, reply);
}
function registerThreadResults(pi) {
    let active = null;
    pi.on('agent_start', (_event, ctx) => {
        if (ctx.mode !== 'rpc' || !process.env.PI_WEB_NAVIGATION_TOKEN || !ctx.sessionManager.getSessionFile()) return;
        // agent_start precedes persistence of this run's input; identify its
        // source only from the bounded native entries after settlement.
        active = { version: 1, id: randomBytes(32).toString('hex'), sessionId: ctx.sessionManager.getSessionId(),
            status: 'running', startedAt: Date.now() };
        pi.appendEntry(THREAD_STATE, active);
    });
    pi.on('agent_settled', (event, ctx) => {
        if (!active) return;
        const branch = ctx.sessionManager.getBranch();
        const start = branch.findLastIndex(e => e.type === 'custom' && e.customType === THREAD_STATE && e.data?.id === active.id);
        if (start < 0) { active = null; return; }
        const entries = branch.slice(start + 1);
        const reply = entries.findLast(e => e.type === 'message' && e.message?.role === 'assistant');
        const state = { ...active, source: sourceFor(entries), status: event.aborted || reply?.message.stopReason === 'aborted' ? 'stopped'
            : !reply || reply.message.stopReason === 'error' ? 'error' : 'completed',
            replyEntryId: reply?.id || null, completedAt: Date.now() };
        pi.appendEntry(THREAD_STATE, state);
        active = null;
        ctx.ui.notify(JSON.stringify({ pivaneThreadResult: state, token: process.env.PI_WEB_NAVIGATION_TOKEN }));
    });
}
module.exports = { THREAD_STATE, bindingBoundary, threadOutcome, registerThreadResults };
