const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentThreadsService } = require('../server/pi-agent-threads');
const input = { requestId: 'stable', title: 'Task', message: 'Explain the interface.' };
const source = { cwd: '/fixture', sessionId: 'source' };

test('task launches reserve before await, status reports preparing, and duplicate calls do not launch', async () => {
    const service = new AgentThreadsService({ store: {}, supervisor: {}, settingsService: {} });
    let resolve; const gate = new Promise(done => { resolve = done; });
    let runs = 0;
    service._create = async () => { runs++; await gate; return { status: 'submitted' }; };
    const first = service.create(source, input);
    assert.throws(() => service.create(source, input), /in progress/);
    assert.equal((await service.lookup(source, 'stable')).status, 'preparing');
    assert.equal(runs, 1);
    resolve(); assert.equal((await first).status, 'submitted');
    assert.equal(service.jobs.size, 0);
});

test('task slots count saved launches once and recheck request identity after model discovery', async t => {
    const { createHash } = require('node:crypto'); let created = 0, scans = 0;
    const service = new AgentThreadsService({ store: { createSession() { created++; } }, supervisor: { getActiveWorker: () => null }, settingsService: {} });
    t.after(() => service.dispose());
    const records = [{ session: { id: 'child', cwd: source.cwd }, task: { requestId: 'same', source }, state: { status: 'submitted' } }];
    service.jobs.set('source:same', true); service.jobs.set('source:second', true); service.jobs.set('source:third', true);
    assert.equal(service.checkScope(records, source), 1);
    service.jobs.clear();
    const fingerprint = createHash('sha256').update(JSON.stringify([input.title, input.message, null, null, null])).digest('hex');
    service.records = async () => ++scans === 1 ? [] : [{ session: { id: 'existing', cwd: source.cwd }, task: { source, requestId: input.requestId, fingerprint } }];
    service.catalog = async () => ({ defaults: { provider: 'fixture', modelId: 'model', thinkingLevel: 'off' }, models: [{ provider: 'fixture', modelId: 'model', thinkingLevels: ['off'] }] });
    const result = await service.create(source, input);
    assert.equal(created, 0); assert.equal(result.reused, true); assert.equal(result.session.id, 'existing');
});

test('task preflight rejects unknown fields, nesting, and concurrent siblings before creating sessions', async () => {
    let creates = 0;
    const service = new AgentThreadsService({ store: { createSession: async () => { creates++; } }, supervisor: {}, settingsService: {} });
    assert.throws(() => service.create(source, { ...input, cwd: '/outside' }), /Invalid/);
    assert.throws(() => service.create(source, { ...input, provider: 'alone' }), /together/);
    assert.throws(() => service.create(source, { ...input, requestId: '../unsafe' }), /requestId/);
    service.records = async () => [{ session: { id: source.sessionId }, task: { depth: 3, source: { sessionId: 'ancestor' } } }];
    await assert.rejects(service.create(source, input), /three levels/);
    service.records = async () => Array.from({ length: 2 }, (_, index) => ({ session: { id: `sibling-${index}` }, task: { source: { sessionId: source.sessionId } } }));
    service.jobs.set('source:other-launch', true);
    await assert.rejects(service.create(source, input), /three unfinished/);
    assert.equal(creates, 0);
    service.jobs.clear(); service.isSuspended = () => true;
    assert.throws(() => service.create(source, input), /stopping/);
});
