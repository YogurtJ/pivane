const STATE = 'pivane-channel-turn';
const MESSAGE = 'pivane-channel-message';
const DELIVERABLE_ENTRY = 'pivane-deliverable';
const CRON_STATE = 'pivane-cron-run';
const CRON_MESSAGE = 'pivane-cron-message';
const TERMINAL = new Set(['completed', 'stopped', 'error']);

function stateFor(manager, id) {
    return manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === STATE
        && entry.data?.id === id && entry.data.sessionId === manager.getSessionId())?.data || null;
}
function markers(branch, type, key, id) {
    return branch.flatMap((entry, index) => entry.type === 'custom' && entry.customType === type && entry.data?.[key] === id
        ? [{ index, data: entry.data }] : []);
}
function empty(state) { return { ...state, body: '', deliverables: [], mediaPlans: [] }; }

// Native branch ancestry supplies both bounds. A receipt from another branch,
// an intervening prompt, or a missing settlement cannot authorize any content.
function ownedEntries(branch, start, end, messageType, key, id) {
    const entries = branch.slice(start + 1, end);
    let prompt = false;
    for (const entry of entries) {
        if (entry.type === 'custom_message') {
            if (prompt || entry.customType !== messageType || entry.details?.[key] !== id) return null;
            prompt = true;
        } else if (entry.type === 'message' && entry.message?.role === 'user') return null;
        if (!prompt && (entry.type === 'message' && ['assistant', 'toolResult'].includes(entry.message?.role)
            || entry.type === 'custom' && entry.customType === DELIVERABLE_ENTRY)) return null;
        if (entry.type === 'custom' && [STATE, CRON_STATE].includes(entry.customType)
            && (entry.customType !== (messageType === MESSAGE ? STATE : CRON_STATE)
                || (entry.customType === STATE ? entry.data?.id : entry.data?.runId) !== id)) return null;
    }
    return prompt ? entries : null;
}
function replyIn(entries, replyEntryId) {
    const last = entries.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant');
    return last && last.id === replyEntryId ? last : null;
}
function collect(state, entries, reply) {
    if (!reply) return empty(state);
    if (state.status === 'completed' && ['aborted', 'error'].includes(reply.message.stopReason)) return null;
    const body = (Array.isArray(reply.message.content) ? reply.message.content : [])
        .filter(block => block.type === 'text').map(block => block.text).join('\n');
    const deliverables = [], mediaPlans = [], seen = new Set(), seenPlans = new Set();
    for (const item of entries) {
        if (item.type === 'custom' && item.customType === DELIVERABLE_ENTRY && item.data?.id && item.data.manifestRevision) {
            const key = `${item.data.id}:${item.data.manifestRevision}`;
            if (!seen.has(key)) { seen.add(key); deliverables.push({ id: item.data.id, manifestRevision: item.data.manifestRevision }); }
        }
        if (item.type === 'message' && item.message?.role === 'toolResult' && !item.message.isError
            && ['media_generate', 'media_plan_request'].includes(item.message.toolName)) {
            const plan = item.message.details?.plan;
            if (typeof plan?.id === 'string' && /^plan-[0-9a-f-]{36}$/.test(plan.id) && !seenPlans.has(plan.id)) {
                seenPlans.add(plan.id);
                mediaPlans.push({ id: plan.id, kind: plan.kind || '', modelId: plan.modelId || '', summary: String(plan.summary || '').slice(0, 200),
                    prompt: String(plan.parameters?.prompt || plan.parameters?.text || '').slice(0, 300) });
            }
        }
    }
    return { ...state, deliverables, mediaPlans,
        body: body.length > 60000 ? body.slice(0, 60000) + '\n\n[回复较长，请在 Pivane 网页查看完整内容。]' : body };
}
function channelMarkers(manager, branch, id) {
    const rows = markers(branch, STATE, 'id', id);
    return rows.length && rows.every(row => row.data.sessionId === manager.getSessionId()) ? rows : null;
}
function channelReply(manager, id) {
    const branch = manager.getBranch(), rows = channelMarkers(manager, branch, id);
    if (!rows || rows.length !== 1 || rows[0].data.status !== 'running') return null;
    const entries = ownedEntries(branch, rows[0].index, branch.length, MESSAGE, 'messageId', id);
    return entries?.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant') || null;
}
function outcome(manager, id) {
    const branch = manager.getBranch(), rows = channelMarkers(manager, branch, id);
    if (!rows) return null;
    const state = rows.at(-1).data;
    if (rows.length === 1 && state.status === 'running') return empty(state);
    if (rows.length !== 2 || rows[0].data.status !== 'running' || !TERMINAL.has(state.status)) return null;
    const entries = ownedEntries(branch, rows[0].index, rows[1].index, MESSAGE, 'messageId', id);
    if (!entries) return null;
    const reply = replyIn(entries, state.replyEntryId);
    if (!reply && (state.replyEntryId || state.status === 'completed')) return null;
    return collect(state, entries, reply);
}
function scheduledOutcome(manager, event) {
    if (!event?.runId || event.target?.sessionId !== manager.getSessionId() || !TERMINAL.has(event.status)) return null;
    const branch = manager.getBranch(), rows = markers(branch, CRON_STATE, 'runId', event.runId);
    if (!rows.length || rows.some(row => row.data.sessionId !== manager.getSessionId())) return null;
    const terminal = rows.at(-1), state = terminal.data;
    if (state.status !== event.status || (state.replyEntryId || null) !== (event.replyEntryId || null)) return null;
    const start = rows.findIndex(row => row.data.status === 'running');
    const settled = rows.findIndex(row => row.data.status === 'settled');
    // Cron persists running for every request/budget update. Only its first
    // running marker starts the interval; settled closes it before restore.
    if (start < 0 || settled <= start || settled !== rows.length - 2
        || rows.slice(0, start).some(row => row.data.status !== 'prepared')
        || rows.slice(start, settled).some(row => row.data.status !== 'running')
        || (rows[settled].data.replyEntryId || null) !== (state.replyEntryId || null)) return null;
    const entries = ownedEntries(branch, rows[start].index, rows[settled].index, CRON_MESSAGE, 'runId', event.runId);
    if (!entries) return null;
    const reply = replyIn(entries, state.replyEntryId);
    if (!reply && (state.replyEntryId || state.status === 'completed')) return null;
    return collect(state, entries, reply);
}
module.exports = { STATE, MESSAGE, DELIVERABLE_ENTRY, stateFor, channelReply, outcome, scheduledOutcome };
