const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentMessages } = require('../server/pi-agent-messages');
const { sendingContext, outboundMessage, receiveAgentMessages, MESSAGE_IN, MESSAGE_WAKE, messageIdFor } = require('../server/pi-agent-message-format');

function fixture({ complete = true } = {}) {
    const rows = ['a', 'b', 'c', 'x'].map(id => ({ id, cwd: '/p', path: `/p/${id}.jsonl`, name: id.toUpperCase(), preview: '', modified: '2026-01-01T00:00:00.000Z',
        special: id === 'x' ? 'pivane-extension-assistant' : null, task: null, outbox: [], inbox: new Set() }));
    const catalog = { refresh: async () => ({ complete, coverage: { files: 4, checked: complete ? 4 : 1 } }), project: async () => ({}), threads: () => rows };
    const workers = new Map(), started = [];
    const worker = (id, { idle = true } = {}) => {
        const w = { cwd: '/p', sessionId: id, idle, delivered: [], fail: null, isIdle: () => w.idle, activity: { snapshot: () => ({ busy: !w.idle, phase: w.idle ? 'idle' : 'running' }) },
            agentMessages: async ({ messages }) => {
                if (w.fail) throw w.fail;
                w.delivered.push(...messages.map(m => m.messageId));
                for (const message of messages) rows.find(row => row.id === id).inbox.add(message.messageId);
                return { woke: messages.some(m => m.wake) };
            } };
        workers.set(`/p/${id}.jsonl`, w); return w;
    };
    const supervisor = { workers, getActiveWorker: file => workers.get(file),
        getWorker: async ({ sessionPath, sessionId }) => { started.push(sessionId); return worker(sessionId); } };
    const source = { cwd: '/p', sessionId: 'a' };
    const service = new AgentMessages({ catalog, supervisor, limits: { pumpMs: 1e9, sendsPerWindow: 4, wakesPerWindow: 2, pendingPerTarget: 3 } });
    return { rows, catalog, service, supervisor, worker, started, source };
}
const send = async (f, requestId, extra = {}) => {
    const prepared = await f.service.send(f.source, { phase: 'prepare', requestId, to: 'b', message: `text ${requestId}`, hop: 0, ...extra });
    if (prepared.status !== 'prepared') return prepared;
    if (!f.rows[0].outbox.some(message => message.messageId === prepared.messageId)) f.rows[0].outbox.push(JSON.parse(JSON.stringify(prepared.record)));
    return f.service.send(f.source, { phase: 'publish', messageId: prepared.messageId });
};

test('message preparation never queues or wakes before a verified native outbound intent exists', async () => {
    const f = fixture(); const b = f.worker('b');
    try {
        const input = { phase: 'prepare', requestId: 'two-phase', to: 'b', message: 'durable intent', hop: 0 };
        const prepared = await f.service.send(f.source, input);
        assert.equal(prepared.status, 'prepared');
        assert.equal(f.service.queue.size, 0); assert.deepEqual(b.delivered, []);
        await assert.rejects(f.service.send(f.source, { phase: 'publish', messageId: prepared.messageId }), /native outbound|Native outbound/);
        const duplicate = await f.service.send(f.source, input);
        assert.deepEqual(duplicate.record, prepared.record);
        await assert.rejects(f.service.send(f.source, { ...input, message: 'changed' }), /different message/);
        f.rows[0].outbox.push(prepared.record); // Synthetic source manager's committed custom entry.
        const published = await f.service.send(f.source, { phase: 'publish', messageId: prepared.messageId });
        assert.equal(published.status, 'delivered'); assert.deepEqual(b.delivered, [prepared.messageId]);
        await f.service.send(f.source, { phase: 'publish', messageId: prepared.messageId });
        assert.deepEqual(b.delivered, [prepared.messageId], 'same publication cannot deliver or wake twice');
    } finally { await f.service.dispose(); }
});

test('a committed intent survives interruption before publication; preparation without persistence has no recovery effect', async () => {
    const f = fixture(); f.worker('a');
    let restarted;
    try {
        const prepare = requestId => f.service.send(f.source, { phase: 'prepare', requestId, to: 'b', message: requestId, hop: 0, wake: false });
        const abandoned = await prepare('lost-prepare-response');
        const committed = await prepare('lost-publish-response');
        f.rows[0].outbox.push(committed.record);
        assert.equal(f.service.queue.size, 0);
        await f.service.dispose();
        restarted = new AgentMessages({ catalog: f.catalog, supervisor: f.supervisor, limits: { pumpMs: 1e9, recoveryMs: 0 } });
        await restarted.recover();
        assert.deepEqual([...restarted.queue.keys()], [committed.messageId]);
        assert.equal(restarted.queue.has(abandoned.messageId), false);
        const b = f.worker('b'); await restarted.pump();
        assert.deepEqual(b.delivered, [committed.messageId]);
    } finally { await f.service.dispose(); await restarted?.dispose(); }
});

test('concurrent preparations reserve policy once per stable request and cannot exceed pending capacity', async () => {
    const f = fixture();
    try {
        const input = { phase: 'prepare', requestId: 'concurrent', to: 'b', message: 'one intent', hop: 0 };
        const same = await Promise.all(Array.from({ length: 8 }, () => f.service.send(f.source, input)));
        assert.ok(same.every(result => JSON.stringify(result.record) === JSON.stringify(same[0].record)));
        assert.equal(f.service.prepared.size, 1); assert.equal(f.service.sends.get('a').length, 1); assert.equal(f.service.queue.size, 0);
        const more = await Promise.allSettled(['second', 'third', 'fourth'].map(requestId => f.service.send(f.source, { ...input, requestId })));
        assert.equal(more.filter(result => result.status === 'fulfilled').length, 2);
        assert.match(more.find(result => result.status === 'rejected').reason.message, /too many undelivered/);
        assert.equal(f.service.prepared.size, 3); assert.equal(f.service.queue.size, 0);
    } finally { await f.service.dispose(); }
});

for (const large of [false, true]) test(`preparation storage enforces its ${large ? 'byte' : 'count'} budget without publishing`, async () => {
    const f = fixture(); Object.assign(f.service.limits, { sendsPerWindow: 1000, pendingPerTarget: 1000 });
    try {
        let accepted = 0, rejected;
        for (let i = 0; i < 201; i++) {
            try { await f.service.send(f.source, { phase: 'prepare', requestId: `capacity-${i}`, to: 'b', message: large ? '字'.repeat(16000) : 'small', hop: 0, wake: false }); accepted++; }
            catch (error) { rejected = error; break; }
        }
        assert.match(rejected?.message || '', /preparation capacity/);
        if (large) assert.ok(accepted > 0 && accepted < 200); else assert.equal(accepted, 200);
        assert.ok([...f.service.prepared.values()].reduce((total, item) => total + item.bytes, 0) <= 4 * 1024 * 1024);
        assert.equal(f.service.queue.size, 0);
    } finally { await f.service.dispose(); }
});

test('legacy send prepares only and the old source append is sufficient for native recovery', async () => {
    const f = fixture(); f.worker('a'); const b = f.worker('b');
    try {
        const prepared = await f.service.send(f.source, { requestId: 'legacy', to: 'b', message: 'legacy intent', hop: 0, wake: false });
        assert.equal(prepared.status, 'prepared'); assert.equal(f.service.queue.size, 0); assert.deepEqual(b.delivered, []);
        f.rows[0].outbox.push(prepared.record);
        await f.service.recover(); await f.service.pump();
        assert.deepEqual(b.delivered, [prepared.messageId]); assert.equal(f.service.prepared.size, 0);
    } finally { await f.service.dispose(); }
});

test('queue waits for an idle recipient, retries busy and bounded failures, and wakes closed threads with limited concurrency', async () => {
    const f = fixture(); const b = f.worker('b', { idle: false });
    try {
        const first = await send(f, 'one');
        assert.equal(first.status, 'queued'); assert.deepEqual(b.delivered, []);
        b.idle = true; await f.service.pump();
        assert.equal(f.service.queue.get(first.messageId).status, 'delivered'); assert.equal(b.delivered.length, 1);
        b.fail = Object.assign(new Error('会话正在运行或处理其他操作，请等待空闲'), { code: 'SESSION_BUSY' });
        const second = await send(f, 'two');
        assert.equal(f.service.queue.get(second.messageId).status, 'queued', 'busy is not counted as a failed attempt');
        assert.equal(f.service.queue.get(second.messageId).attempts, 0);
        b.fail = new Error('bridge broken');
        for (let i = 0; i < 5; i++) await f.service.pump();
        assert.equal(f.service.queue.get(second.messageId).status, 'failed');
        b.fail = null;
        // Closed recipient with wake: started once, then delivered on the next pass.
        f.supervisor.workers.delete('/p/b.jsonl');
        const third = await send(f, 'three', { to: 'c', message: 'wake c' });
        await new Promise(resolve => setImmediate(resolve)); await f.service.pump();
        assert.deepEqual(f.started, ['c']);
        assert.equal(f.service.queue.get(third.messageId).status, 'delivered');
    } finally { await f.service.dispose(); }
});

test('rate, wake budget, pending cap, special and incomplete directories are enforced before queueing', async () => {
    const f = fixture(); f.worker('b', { idle: false });
    try {
        const r1 = await send(f, 'r1'), r2 = await send(f, 'r2'), r3 = await send(f, 'r3');
        assert.deepEqual([r1.wake, r2.wake, r3.wake], [true, true, false]);
        assert.equal(r3.wakeSuppressed, 'rate-limit');
        await assert.rejects(send(f, 'r4'), /too many undelivered/);
        for (const result of [r1, r2, r3]) f.rows[1].inbox.add(result.messageId);
        f.service.queue.clear();
        await send(f, 'r5');
        await assert.rejects(send(f, 'r6'), /rate limit/);
        await assert.rejects(f.service.send({ ...f.source, sessionId: 'b' }, { requestId: 'z', to: 'x', message: 'no', hop: 0 }), /cannot receive/);
        await assert.rejects(f.service.send({ ...f.source, sessionId: 'b' }, { requestId: 'z', to: 'b', message: 'no', hop: 0 }), /itself/);
        await assert.rejects(f.service.send(f.source, { requestId: 'bad', to: 'b', message: 'x', hop: 0, path: '/etc' }), /Invalid Agent message request/);
        const listed = await f.service.threads(f.source, {});
        assert.ok(!listed.threads.some(row => row.id === 'x'), 'special threads are not addressable');
        assert.equal(listed.threads.at(-1).relation, 'self');
        const g = fixture({ complete: false });
        await assert.rejects(g.service.send(g.source, { requestId: 'i', to: 'b', message: 'x', hop: 0 }), error => error.code === 'TASK_INDEXING');
        await g.service.dispose();
    } finally { await f.service.dispose(); }
});

test('recovery requeues only undelivered native outbound records and keeps the recipient receipt authoritative', async () => {
    const f = fixture();
    try {
        f.worker('a');
        const record = id => outboundMessage({ version: 1, messageId: messageIdFor('a', id), requestId: id, from: { sessionId: 'a', cwd: '/p', name: 'A' },
            to: { sessionId: 'b', cwd: '/p', name: 'B' }, text: `body ${id}`, wake: false, wakeSuppressed: null, hop: 0,
            conversationId: messageIdFor('a', id), replyTo: null, sentAt: new Date().toISOString() });
        const pending = record('pending'), delivered = record('delivered'), old = { ...record('old'), sentAt: '2020-01-01T00:00:00.000Z' };
        f.rows[0].outbox.push(pending, delivered, old); f.rows[1].inbox.add(delivered.messageId);
        await f.service.recover();
        assert.deepEqual([...f.service.queue.keys()], [pending.messageId]);
        const b = f.worker('b'); await f.service.pump();
        assert.deepEqual(b.delivered, [pending.messageId]);
    } finally { await f.service.dispose(); }
});

test('sending context: user turns start at zero, woken turns continue the chain, recipient persists before waking', () => {
    const conv = 'c'.repeat(64);
    assert.deepEqual(sendingContext([{ type: 'message', message: { role: 'user' } }]), { hop: 0, conversationId: null });
    assert.deepEqual(sendingContext([{ type: 'message', message: { role: 'user' } }, { type: 'custom_message', customType: MESSAGE_WAKE, details: { hop: 2, conversationId: conv } },
        { type: 'message', message: { role: 'assistant' } }]), { hop: 3, conversationId: conv });
    assert.equal(sendingContext([{ type: 'custom_message', customType: 'pivane-agent-task-start' }]).hop, 1);
    const entries = [], sent = [];
    const pi = { sendMessage: (message, options) => { sent.push([message, options]); if (!options.triggerTurn) entries.push({ type: 'custom_message', ...message }); } };
    const ctx = { cwd: '/p', isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => 'b', getEntries: () => entries } };
    const message = outboundMessage({ version: 1, messageId: 'a'.repeat(64), from: { sessionId: 'a', cwd: '/p', name: 'A "quoted"' }, to: { sessionId: 'b', cwd: '/p' },
        text: 'hello <b>x</b>', wake: true, hop: 0, conversationId: conv, replyTo: null, sentAt: new Date().toISOString() });
    assert.deepEqual(receiveAgentMessages(pi, ctx, { messages: [message] }), { delivered: [{ messageId: message.messageId, duplicate: false }], woke: true });
    assert.equal(entries[0].customType, MESSAGE_IN);
    assert.equal(entries[0].content.slice(entries[0].details.bodyOffset), 'hello <b>x</b>');
    assert.equal(sent.at(-1)[0].customType, MESSAGE_WAKE); assert.equal(sent.at(-1)[1].triggerTurn, true);
    assert.equal(receiveAgentMessages(pi, ctx, { messages: [message] }).woke, false, 'duplicate delivery neither persists nor wakes');
    assert.equal(entries.length, 1);
    assert.throws(() => receiveAgentMessages(pi, { ...ctx, cwd: '/other' }, { messages: [message] }), /identity/);
    assert.throws(() => receiveAgentMessages(pi, { ...ctx, isIdle: () => false }, { messages: [message] }), /busy/);
});
