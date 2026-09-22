const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskReturns, receiveTaskReturn } = require('../server/pi-task-returns');

test('result delivery waits for the source, never starts a worker, and recovers a lost acknowledgement without duplicates', async t => {
    const parent = { receipts: new Set(), read: new Set(), path: '/parent' };
    const child = { sourceMatches: true, session: { id: 'child', cwd: '/fixture', name: 'Task' },
        task: { requestId: 'one', source: { sessionId: 'parent' }, returnResults: true },
        results: [{ resultId: 'run', outcome: 'completed', completedAt: '2026-01-01', preview: 'Reported result' }] };
    let idle = false, calls = 0;
    const worker = { cwd: '/fixture', sessionId: 'parent', isIdle: () => idle, async taskReturn({ result }) {
        calls++; parent.receipts.add(result.deliveryId); throw new Error('Lost acknowledgement after persistence');
    } };
    const supervisor = { workers: new Map(), getActiveWorker: () => worker };
    const service = new TaskReturns({ catalog: { refresh: async () => ({ complete: true, records: [child] }), source: async () => parent }, supervisor, isSuspended: () => false });
    t.after(() => service.dispose());
    await service.pump(); assert.equal(calls, 0, 'closed source is not started');
    supervisor.workers.set('/parent', worker);
    await service.pump(); assert.equal(calls, 0, 'busy source is not interrupted');
    idle = true; await service.pump(); await service.pump(); assert.equal(calls, 1);
    child.results.push({ resultId: 'second-run', outcome: 'stopped', completedAt: '2026-01-02', preview: '' });
    await service.pump(); assert.equal(calls, 2, 'another real run has its own receipt');
    child.task.returnResults = undefined;
    assert.equal((await service.list('/fixture', 'parent')).results.length, 0, 'old tasks are not flooded into the new inbox');
});

test('managed receipt append is idle-only, deduplicated, Agent-origin, and does not trigger a turn', async t => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.inMemory('/fixture'); let idle = true, starts = 0, sends = 0;
    const ctx = { cwd: '/fixture', isIdle: () => idle, hasPendingMessages: () => false, sessionManager: manager };
    const pi = { sendMessage(message, options) { sends++; if (options.triggerTurn) starts++; manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
        appendEntry(type, data) { manager.appendCustomEntry(type, data); } };
    const result = { sourceSessionId: manager.getSessionId(), deliveryId: 'a'.repeat(64), session: { cwd: '/fixture', id: 'child', name: '<script>unsafe()</script>' }, requestId: 'one', preview: 'A result', status: 'completed' };
    idle = false; assert.throws(() => receiveTaskReturn(pi, ctx, { result }), /busy/); assert.equal(sends, 0);
    idle = true; receiveTaskReturn(pi, ctx, { result }); receiveTaskReturn(pi, ctx, { result, read: true });
    assert.equal(sends, 1); assert.equal(starts, 0);
    assert.equal(manager.getEntries().filter(e => e.customType === 'pivane-agent-task-read').length, 1);
    assert.match(manager.getEntries().find(e => e.customType === 'pivane-agent-task-result').content, /not a new user instruction/);
    assert.throws(() => receiveTaskReturn(pi, ctx, { result: { ...result, sourceSessionId: 'other' } }), /identity/);
    assert.throws(() => receiveTaskReturn(pi, ctx, { result: { ...result, session: { ...result.session, cwd: '/other' } } }), /identity/);
});
