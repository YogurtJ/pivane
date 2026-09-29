const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-cron-queue-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { CronService, validateJob } = require('../server/pi-cron-service');
const { CronStore } = require('../server/pi-cron-store');
const job = (extra = {}) => ({ id: randomUUID(), revision: 1, name: 'Greeting', prompt: 'Say hello', enabled: true, mode: 'text',
    target: { kind: 'thread', cwd: root, sessionId: randomUUID() }, schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC' },
    misfire: { policy: 'skip', graceMinutes: 30 }, execution: { maxCalls: 2, maxTokens: 10000, maxDurationSeconds: 60 },
    budget: { maxRunsPerDay: 8, maxTokensPerDay: 200000, maxCostPerDay: null }, ...extra });
function fixture(filename, clock) {
    const calls = []; let idle = false;
    const worker = { disposed: false, exclusive: async callback => {
        if (!idle) throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' });
        await callback(null, { model: { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } });
    }, cron: async input => { calls.push(input); return { status: 'running', model: { provider: 'fixture', modelId: 'model' } }; } };
    const service = new CronService({ filename, now: () => clock.value, profiles: {}, catalog: async () => ({ models: [] }),
        store: { getSession: async (cwd, id) => ({ cwd, id, path: path.join(root, id) }) },
        supervisor: { workers: new Map(), isSessionIdle: () => idle, getWorker: async () => worker, getActiveWorker: () => null, emit: () => {} } });
    clearInterval(service.timer);
    return { service, calls, setIdle: value => { idle = value; } };
}
test('offline greetings skip, catch-up collapses to the latest occurrence, and uncertain runs never replay', async () => {
    const clock = { value: Date.parse('2026-09-28T12:05:30Z') }, filename = path.join(root, 'offline.sqlite');
    const store = new CronStore(filename);
    const skip = job({ nextAt: clock.value - 5 * 60000 }), catchup = job({ nextAt: clock.value - 5 * 60000, misfire: { policy: 'latest', graceMinutes: 30 } });
    store.saveJob(skip); store.saveJob(catchup);
    const uncertain = job({ nextAt: clock.value + 60000 }); store.saveJob(uncertain);
    store.saveRun({ id: 'interrupted', jobId: uncertain.id, status: 'running', scheduledAt: clock.value - 60000, job: uncertain, target: uncertain.target, reservedTokens: 10000, budgetDay: '2026-09-28' });
    store.close();
    const { service, calls, setIdle } = fixture(filename, clock);
    try {
        await service.ready;
        assert.equal(service.db.runs(skip.id)[0].reason, 'offline');
        assert.equal(service.db.job(catchup.id).nextAt, Date.parse('2026-09-28T12:05:00Z'));
        assert.equal(service.db.run('interrupted').status, 'uncertain');
        await service.tick();
        assert.equal(calls.length, 0, 'busy threads wait');
        assert.equal(service.db.activeRuns(catchup.id).length, 1);
        clock.value += 2 * 60000; await service.tick();
        assert.equal(service.db.activeRuns(catchup.id).length, 1, 'only one waiting run per task');
        assert.equal(service.db.activeRuns(uncertain.id).length, 1, 'unknown results block future execution');
        setIdle(true); await service.tick();
        assert.equal(calls.filter(c => c.action === 'start').length, 1);
        assert.equal(calls[0].jobId, catchup.id);
        const dispatched = service.db.activeRuns(catchup.id)[0];
        service.db.saveRun({ ...dispatched, status: 'completed' });
        assert.equal(service.enqueue(catchup, dispatched.scheduledAt).status, 'completed', 'a consumed occurrence never becomes pending again');
    } finally { await service.dispose(); }
});
test('busy skip-policy greetings expire and pausing cancels only waiting work', async () => {
    const clock = { value: Date.parse('2026-09-28T12:00:00Z') }, fixtureState = fixture(path.join(root, 'busy.sqlite'), clock);
    const { service, calls } = fixtureState;
    try {
        await service.ready; const task = job({ nextAt: clock.value }); service.db.saveJob(task);
        await service.tick(); assert.equal(service.db.activeRuns(task.id).length, 1);
        clock.value += 61000; await service.tick();
        assert.equal(service.db.activeRuns(task.id).length, 0); assert.equal(calls.length, 0);
        const waiting = await service.action(task.id, { action: 'run', revision: 1, requestId: randomUUID() });
        await service.action(task.id, { action: 'pause', revision: 1 });
        assert.equal(service.db.run(waiting.id).status, 'cancelled');
        assert.equal(service.db.job(task.id).enabled, false);
    } finally { await service.dispose(); }
});
test('scheduler ownership rejects a second live owner and validation projects execution fields', () => {
    const filename = path.join(root, 'owner.sqlite'), store = new CronStore(filename);
    try { assert.throws(() => new CronStore(filename), /already has/); }
    finally { store.close(); }
    const input = job({ execution: { maxCalls: 2, maxTokens: 10000, maxDurationSeconds: 60, action: 'acknowledge', sessionId: 'foreign' } });
    assert.deepEqual(validateJob(input, Date.now()).execution, { maxCalls: 2, maxTokens: 10000, maxDurationSeconds: 60 });
    const now = Date.parse('2026-09-28T06:00:00Z');
    const future = job({ startsAt: Date.parse('2026-09-29T00:00:00Z') });
    assert.equal(validateJob(future, now).startsAt, future.startsAt);
    assert.throws(() => validateJob({ ...future, startsAt: -1 }, now), /start time/);
});
test('future start dates survive saving and resume, while manual runs stay explicit', async () => {
    const clock = { value: Date.parse('2026-09-28T06:00:00Z') };
    const { service } = fixture(path.join(root, 'future.sqlite'), clock);
    try {
        await service.ready;
        const startsAt = Date.parse('2026-09-29T00:00:00Z');
        const saved = await service.save({ ...job(), startsAt, enabled: false });
        assert.equal(saved.nextAt, startsAt);
        const enabled = await service.action(saved.id, { action: 'resume', revision: saved.revision });
        assert.equal(enabled.nextAt, startsAt);
        await service.tick(); assert.equal(service.db.activeRuns(saved.id).length, 0);
        const manual = await service.action(saved.id, { action: 'run', revision: enabled.revision, requestId: randomUUID() });
        assert.equal(manual.status, 'waiting');
    } finally { await service.dispose(); }
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
