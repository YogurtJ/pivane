const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-channel-turn-results-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { STATE, MESSAGE, DELIVERABLE_ENTRY, registerChannelTurns, outcome, scheduledOutcome } = require('../server/channels/runtime');
const CRON_STATE = 'pivane-cron-run', CRON_MESSAGE = 'pivane-cron-message';
const turnId = 'a'.repeat(64), runId = 'b'.repeat(64);
let SessionManager;
test.before(async () => { ({ SessionManager } = await import('@earendil-works/pi-coding-agent')); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const manager = () => SessionManager.inMemory(root);
const assistant = (m, text = 'Own reply', stopReason = 'stop') => m.appendMessage({ role: 'assistant',
    content: [{ type: 'text', text }], stopReason, timestamp: Date.now() });
const file = (m, id = 'own-file', manifestRevision = 1) => m.appendCustomEntry(DELIVERABLE_ENTRY, { id, manifestRevision });
const planId = 'plan-11111111-1111-4111-8111-111111111111';
const plan = (m, id = planId, toolName = 'media_generate', isError = false) => m.appendMessage({ role: 'toolResult',
    toolCallId: 'synthetic-tool', toolName, isError, content: [], timestamp: Date.now(),
    details: { plan: { id, kind: 'image', modelId: 'synthetic-image', summary: 'Own media', parameters: { prompt: 'A fixture' } } } });
function channel(m, changes = {}) {
    const state = { version: 1, id: turnId, sessionId: m.getSessionId(), status: 'running', startedAt: 1, ...changes };
    m.appendCustomEntry(STATE, state);
    return state;
}
function channelPrompt(m, id = turnId) { m.appendCustomMessageEntry(MESSAGE, 'Synthetic channel input', true, { messageId: id }); }
function cron(m, status, changes = {}) {
    const state = { version: 1, runId, sessionId: m.getSessionId(), status, startedAt: 1, ...changes };
    m.appendCustomEntry(CRON_STATE, state);
    return state;
}
function cronPrompt(m, id = runId) { m.appendCustomMessageEntry(CRON_MESSAGE, 'Synthetic scheduled input', true, { runId: id }); }
function cronEvent(m, replyEntryId, status = 'completed', changes = {}) {
    return { runId, target: { cwd: root, sessionId: m.getSessionId() }, replyEntryId, status, ...changes };
}
function laterTurns(m) {
    m.appendMessage({ role: 'user', content: 'Later web input', timestamp: Date.now() });
    file(m, 'web-file'); plan(m, 'plan-22222222-2222-4222-8222-222222222222'); assistant(m, 'Web reply');
    const nextRun = 'c'.repeat(64);
    cron(m, 'running', { runId: nextRun }); cronPrompt(m, nextRun);
    file(m, 'cron-file'); plan(m, 'plan-33333333-3333-4333-8333-333333333333');
    const cronReply = assistant(m, 'Later scheduled reply');
    cron(m, 'settled', { runId: nextRun, replyEntryId: cronReply });
    cron(m, 'completed', { runId: nextRun, replyEntryId: cronReply });
    const nextTurn = 'd'.repeat(64);
    channel(m, { id: nextTurn }); channelPrompt(m, nextTurn);
    file(m, 'channel-file'); plan(m, 'plan-44444444-4444-4444-8444-444444444444');
    channel(m, { id: nextTurn, status: 'completed', replyEntryId: assistant(m, 'Later channel reply') });
}
function assertOwn(result) {
    assert.equal(result.body, 'Own reply');
    assert.deepEqual(result.deliverables, [{ id: 'own-file', manifestRevision: 1 }]);
    assert.deepEqual(result.mediaPlans, [{ id: planId, kind: 'image', modelId: 'synthetic-image', summary: 'Own media', prompt: 'A fixture' }]);
}

test('outcome bounds native channel files, media and reply before later web/cron/channel turns', () => {
    const m = SessionManager.create(root, path.join(root, 'sessions'));
    file(m, 'earlier-file'); assistant(m, 'Earlier reply');
    channel(m); channelPrompt(m); file(m); file(m); plan(m); plan(m); plan(m, 'invalid'); plan(m, planId, 'media_results');
    plan(m, 'plan-55555555-5555-4555-8555-555555555555', 'media_plan_request', true);
    channel(m, { status: 'completed', replyEntryId: assistant(m) });
    assertOwn(outcome(m, turnId));
    laterTurns(m);
    const before = fs.readFileSync(m.getSessionFile(), 'utf8');
    const reopened = SessionManager.open(m.getSessionFile());
    assertOwn(outcome(reopened, turnId));
    assert.equal(fs.readFileSync(m.getSessionFile(), 'utf8'), before, 'reading never rewrites native history');
});

test('scheduledOutcome keeps files before repeated running markers and stops at settled before terminal restore', () => {
    const m = manager();
    file(m, 'earlier-file'); assistant(m, 'Earlier reply');
    cron(m, 'prepared'); cron(m, 'running'); cronPrompt(m); file(m); plan(m, planId, 'media_plan_request');
    cron(m, 'running', { requests: 1 }); cron(m, 'running', { requests: 2, outcome: 'completed' });
    const replyEntryId = assistant(m);
    cron(m, 'settled', { replyEntryId });
    // Settings restore can finish later; only settled closes the model work.
    laterTurns(m);
    cron(m, 'completed', { replyEntryId });
    const event = cronEvent(m, replyEntryId);
    assertOwn(scheduledOutcome(m, event));
    laterTurns(m);
    assertOwn(scheduledOutcome(m, event));
});

test('running and interrupted duplicate receipts expose metadata without sweeping later content or restarting', () => {
    const m = manager(); channel(m); channelPrompt(m); file(m); plan(m); assistant(m);
    laterTurns(m);
    assert.deepEqual(outcome(m, turnId), { version: 1, id: turnId, sessionId: m.getSessionId(), status: 'running', startedAt: 1,
        body: '', deliverables: [], mediaPlans: [] });
    let sends = 0;
    const command = registerChannelTurns({ on: () => {}, sendMessage: () => { sends++; }, appendEntry: () => { throw Error('must not append'); } });
    const result = command({ sessionManager: m, isIdle: () => true, hasPendingMessages: () => false },
        { action: 'start', sessionId: m.getSessionId(), id: turnId });
    assert.equal(result.reused, true); assert.equal(result.status, 'running'); assert.equal(sends, 0);
    assert.deepEqual(result.deliverables, []); assert.deepEqual(result.mediaPlans, []);
});

test('channel outcome rejects missing or stale boundaries, foreign session, prompt and reply ownership', () => {
    const cases = [
        m => channel(m, { status: 'completed', replyEntryId: assistant(m) }),
        m => { channel(m); channelPrompt(m); channel(m, { status: 'running' }); channel(m, { status: 'completed', replyEntryId: assistant(m) }); },
        m => { channel(m, { sessionId: 'other' }); channelPrompt(m); channel(m, { status: 'completed', replyEntryId: assistant(m) }); },
        m => { channel(m); channelPrompt(m, 'wrong'); channel(m, { status: 'completed', replyEntryId: assistant(m) }); },
        m => { channel(m); channelPrompt(m); channel(m, { status: 'completed', replyEntryId: null }); },
        m => { const oldReply = assistant(m, 'Old reply'); channel(m); channelPrompt(m); channel(m, { status: 'completed', replyEntryId: oldReply }); },
        m => { channel(m); channelPrompt(m); const oldReply = assistant(m, 'Stale reply'); assistant(m); channel(m, { status: 'completed', replyEntryId: oldReply }); },
        m => { channel(m); channelPrompt(m); const replyEntryId = file(m); channel(m, { status: 'completed', replyEntryId }); },
        m => { channel(m); channelPrompt(m); m.appendMessage({ role: 'user', content: 'Web input', timestamp: Date.now() }); channel(m, { status: 'completed', replyEntryId: assistant(m) }); },
        m => { channel(m); channelPrompt(m); cron(m, 'running'); cronPrompt(m); channel(m, { status: 'completed', replyEntryId: assistant(m) }); },
        m => { channel(m); channelPrompt(m); m.appendCustomMessageEntry('foreign-context', 'Unowned prompt', true); channel(m, { status: 'completed', replyEntryId: assistant(m) }); },
        m => { channel(m); channelPrompt(m); channel(m, { status: 'completed', replyEntryId: 'missing' }); }
    ];
    for (const [index, build] of cases.entries()) { const m = manager(); build(m); assert.equal(outcome(m, turnId), null, `case ${index}`); }
});

test('channel results and settlement reject reply IDs on another native branch', () => {
    const m = manager(), start = channel(m);
    channelPrompt(m); const fork = m.getLeafId(), offBranchReply = assistant(m, 'Other branch');
    m.branch(fork); file(m); assistant(m);
    channel(m, { ...start, status: 'completed', replyEntryId: offBranchReply });
    assert.equal(outcome(m, turnId), null);
});

test('cron requires matching in-branch running, settled and terminal states, event and reply', () => {
    const cases = [
        ['prepared', 'completed'], ['running', 'completed'], ['settled', 'completed'],
        ['running', 'settled'], ['running', 'settled', 'running', 'completed'], ['running', 'settled', 'settled', 'completed']
    ];
    for (const statuses of cases) {
        const m = manager(); let replyEntryId;
        for (const status of statuses) {
            if (status === 'settled' && !replyEntryId) replyEntryId = assistant(m);
            cron(m, status, { replyEntryId });
            if (status === 'running') cronPrompt(m);
        }
        assert.equal(scheduledOutcome(m, cronEvent(m, replyEntryId)), null, statuses.join('/'));
    }
    const m = manager(); cron(m, 'running'); cronPrompt(m); file(m); plan(m); const replyEntryId = assistant(m);
    cron(m, 'settled', { replyEntryId }); cron(m, 'completed', { replyEntryId });
    for (const changes of [{ status: 'error' }, { replyEntryId: null }, { replyEntryId: 'wrong' }, { runId: 'wrong' },
        { target: { sessionId: 'other' } }, { target: undefined }]) {
        assert.equal(scheduledOutcome(m, cronEvent(m, replyEntryId, 'completed', changes)), null);
    }
    const fork = m.getBranch().find(e => e.type === 'custom_message').id;
    m.branch(fork); cron(m, 'settled', { replyEntryId }); cron(m, 'completed', { replyEntryId });
    assert.equal(scheduledOutcome(m, cronEvent(m, replyEntryId)), null, 'off-branch assistant is unowned');
});

test('cron rejects mismatched settled reply, foreign session, prompt and intervening web input', () => {
    for (const variation of ['settled-reply', 'session', 'prompt', 'web', 'old-reply', 'missing-reply']) {
        const m = manager(), oldReply = assistant(m, 'Earlier reply');
        cron(m, 'running', variation === 'session' ? { sessionId: 'other' } : {});
        cronPrompt(m, variation === 'prompt' ? 'other' : runId);
        if (variation === 'web') m.appendMessage({ role: 'user', content: 'Later web', timestamp: Date.now() });
        const replyEntryId = variation === 'missing-reply' ? null : variation === 'old-reply' ? oldReply : assistant(m);
        cron(m, 'settled', { replyEntryId: variation === 'settled-reply' ? oldReply : replyEntryId });
        cron(m, 'completed', { replyEntryId });
        assert.equal(scheduledOutcome(m, cronEvent(m, replyEntryId)), null, variation);
    }
});

for (const [status, stopReason] of [['error', 'error'], ['stopped', 'aborted']]) {
    test(`${status} preserves its owned native reply and artifacts but never unowned partial results`, () => {
        const m = manager(); channel(m); channelPrompt(m); file(m); plan(m);
        channel(m, { status, replyEntryId: assistant(m, 'Own reply', stopReason) });
        assertOwn(outcome(m, turnId));
        const noReply = manager(); channel(noReply); channelPrompt(noReply); file(noReply); plan(noReply);
        channel(noReply, { status, replyEntryId: null });
        const result = outcome(noReply, turnId);
        assert.equal(result.status, status); assert.equal(result.body, '');
        assert.deepEqual(result.deliverables, []); assert.deepEqual(result.mediaPlans, []);
        const ownedScheduled = manager(); cron(ownedScheduled, 'running'); cronPrompt(ownedScheduled); file(ownedScheduled); plan(ownedScheduled);
        const scheduledReply = assistant(ownedScheduled, 'Own reply', stopReason);
        cron(ownedScheduled, 'settled', { replyEntryId: scheduledReply }); cron(ownedScheduled, status, { replyEntryId: scheduledReply });
        assertOwn(scheduledOutcome(ownedScheduled, cronEvent(ownedScheduled, scheduledReply, status)));
        const scheduled = manager(); cron(scheduled, 'running'); cronPrompt(scheduled); file(scheduled); plan(scheduled);
        cron(scheduled, 'settled', { replyEntryId: null }); cron(scheduled, status, { replyEntryId: null });
        const empty = scheduledOutcome(scheduled, cronEvent(scheduled, null, status));
        assert.equal(empty.status, status); assert.equal(empty.body, '');
        assert.deepEqual(empty.deliverables, []); assert.deepEqual(empty.mediaPlans, []);
        const interrupted = manager(); cron(interrupted, 'running'); cronPrompt(interrupted); file(interrupted);
        cron(interrupted, status, { replyEntryId: null, reason: 'reviewed-uncertain' });
        assert.equal(scheduledOutcome(interrupted, cronEvent(interrupted, null, status)), null);
    });
}

test('completed rejects aborted/error replies and preserves length replies with the established body limit', () => {
    for (const stopReason of ['error', 'aborted']) {
        const m = manager(); channel(m); channelPrompt(m); channel(m, { status: 'completed', replyEntryId: assistant(m, 'Partial', stopReason) });
        assert.equal(outcome(m, turnId), null);
    }
    const m = manager(); channel(m); channelPrompt(m);
    channel(m, { status: 'completed', replyEntryId: assistant(m, 'x'.repeat(60001), 'length') });
    assert.equal(outcome(m, turnId).body, 'x'.repeat(60000) + '\n\n[回复较长，请在 Pivane 网页查看完整内容。]');
});

test('registerChannelTurns settles the owned reply and reuses completion without sending a second prompt', () => {
    const m = manager(), handlers = {}, sent = [];
    const command = registerChannelTurns({ on: (name, callback) => { handlers[name] = callback; },
        appendEntry: (type, data) => m.appendCustomEntry(type, data),
        sendMessage: message => { sent.push(message); m.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); } });
    const ctx = { sessionManager: m, isIdle: () => true, hasPendingMessages: () => false, model: { input: ['text'] } };
    const input = { action: 'start', id: turnId, sessionId: m.getSessionId(), peerId: 'synthetic-peer', text: 'Synthetic request' };
    command(ctx, input); file(m); plan(m); assistant(m); handlers.agent_settled({}, ctx);
    assertOwn(command(ctx, { ...input, action: 'status' }));
    laterTurns(m);
    assertOwn(command(ctx, input)); assert.equal(command(ctx, input).reused, true); assert.equal(sent.length, 1);
    assert.match(sent[0].content, /\/confirm/);
});

test('registerChannelTurns never selects a later web assistant after its running marker goes stale', () => {
    const m = manager(), handlers = {};
    const command = registerChannelTurns({ on: (name, callback) => { handlers[name] = callback; },
        appendEntry: (type, data) => m.appendCustomEntry(type, data),
        sendMessage: message => m.appendCustomMessageEntry(message.customType, message.content, message.display, message.details) });
    const ctx = { sessionManager: m, isIdle: () => true, hasPendingMessages: () => false, model: { input: ['text'] } };
    command(ctx, { action: 'start', id: turnId, sessionId: m.getSessionId(), peerId: 'synthetic-peer', text: 'Synthetic request' });
    m.appendMessage({ role: 'user', content: 'Foreign web prompt', timestamp: Date.now() }); assistant(m, 'Foreign web reply');
    handlers.agent_settled({}, ctx);
    const receipt = m.getBranch().at(-1).data;
    assert.equal(receipt.status, 'error'); assert.equal(receipt.replyEntryId, null); assert.equal(outcome(m, turnId), null);
});
