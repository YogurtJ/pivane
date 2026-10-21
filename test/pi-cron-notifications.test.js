const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-cron-notifications-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { CronService } = require('../server/pi-cron-service');
const { CronStore } = require('../server/pi-cron-store');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
async function fixture(t, options = {}) {
    const clock = options.clock || { value: Date.parse('2026-10-20T12:00:00Z') };
    const recipients = [{ bindingId: 'original-binding', cwd: root, sessionId: 'original-session', accountId: 'fixture-account', peerId: 'fixture-peer' }];
    const completions = [], admissions = [];
    let suspended = false;
    const service = new CronService({ filename: options.filename || path.join(root, `${randomUUID()}.sqlite`),
        now: () => clock.value, isSuspended: () => suspended, profiles: {}, catalog: async () => ({ models: [] }),
        store: { getSession: async (cwd, id) => ({ cwd, id, path: path.join(cwd, id) }) },
        supervisor: { workers: new Map(), getWorker: async () => { throw new Error('Model execution forbidden in notification fixture'); },
            getActiveWorker: () => null, emit: (kind, event) => completions.push({ kind, event }) },
        captureChannelNotify: () => recipients,
        onChannelNotify: event => { admissions.push(event); return { status: 'accepted' }; }, ...options });
    clearInterval(service.timer);
    await service.ready; service.healthy();
    t.after(() => service.dispose());
    const job = { id: randomUUID(), revision: 1, name: 'Original task', enabled: false, notifyWeixin: true,
        target: { kind: 'thread', cwd: root, sessionId: randomUUID() }, nextAt: null };
    const run = { id: randomUUID(), jobId: job.id, job, target: { cwd: root, sessionId: job.target.sessionId },
        status: 'running', scheduledAt: clock.value - 10000 };
    service.db.saveJob(job); service.db.saveRun(run);
    const complete = (status = 'completed') => service.applyResult(run, { status, replyEntryId: 'native-reply', completedAt: clock.value });
    return { service, clock, recipients, completions, admissions, job, run, complete, suspend: value => { suspended = value; } };
}
test('terminal result and bounded recipient intent commit together; failed writes roll back both', async t => {
    const f = await fixture(t), { service, run, complete } = f;
    const save = service.db.saveRun.bind(service.db);
    service.db.saveRun = value => { save(value); throw new Error('fixture write failure'); };
    assert.throws(() => complete(), /fixture write failure/);
    assert.equal(service.db.run(run.id).status, 'running');
    assert.equal(service.db.run(run.id).channelNotify, undefined);
    assert.equal(f.completions.length, 0);
    service.db.saveRun = save;
    complete();
    const stored = service.db.run(run.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.job, undefined, 'terminal runs do not retain the prompt/config snapshot');
    assert.equal(stored.channelNotify.status, 'pending');
    assert.deepEqual(stored.channelNotify.event.recipients, f.recipients);
    assert.equal(f.admissions.length, 0, 'applyResult performs no untracked asynchronous admission');
    assert.equal(f.completions.length, 1);
});
test('throwing, unknown and retry admission results stay observable with bounded backoff', async t => {
    const f = await fixture(t), { service, clock, run } = f;
    let calls = 0;
    service.onChannelNotify = () => {
        calls++;
        if (calls === 1) throw new Error('fixture local write failed');
        if (calls === 2) return undefined;
        return { status: 'retry', reason: 'queue-full' };
    };
    f.complete(); await service.tick();
    let intent = service.db.run(run.id).channelNotify;
    assert.equal(intent.status, 'pending');
    assert.match(intent.lastError, /fixture local write failed/);
    assert.equal(intent.attempts, 1);
    assert.equal(intent.nextAttemptAt - clock.value, 1000);
    await service.tick(); assert.equal(calls, 1);
    clock.value = intent.nextAttemptAt; await service.tick();
    intent = service.db.run(run.id).channelNotify;
    assert.match(intent.lastError, /Unrecognized/);
    assert.equal(intent.nextAttemptAt - clock.value, 2000);
    for (let i = 0; i < 9; i++) {
        clock.value = intent.nextAttemptAt; await service.tick();
        intent = service.db.run(run.id).channelNotify;
        assert.equal(intent.status, 'pending');
        assert.equal(intent.reason, 'queue-full');
        assert.ok(intent.nextAttemptAt - clock.value <= 60000);
    }
    assert.equal(intent.nextAttemptAt - clock.value, 60000);
    service.onChannelNotify = () => ({ status: 'accepted' });
    clock.value = intent.nextAttemptAt; await service.tick();
    assert.equal(service.db.run(run.id).channelNotify.status, 'accepted');
    assert.equal(service.db.pendingChannelNotifications().length, 0);
});
test('restart retries only stable local admission with original recipients, name, target and native reply', async t => {
    const admitted = new Map(), seen = [];
    const f = await fixture(t), { service, clock, run, job } = f;
    service.onChannelNotify = event => {
        admitted.set(event.runId, event);
        throw new Error('fixture lost local acknowledgement');
    };
    f.complete(); await service.tick();
    const original = service.db.run(run.id).channelNotify.event;
    f.recipients[0].bindingId = 'replacement-binding';
    service.db.saveJob({ ...job, name: 'Renamed task', revision: 2, target: { kind: 'thread', cwd: '/replacement', sessionId: randomUUID() } });
    const filename = service.db.filename;
    clock.value = service.db.run(run.id).channelNotify.nextAttemptAt;
    await service.dispose();
    const reopened = await fixture(t, { filename, clock,
        captureChannelNotify: () => { throw new Error('Must never recapture after restart'); },
        onChannelNotify: event => { seen.push(event); if (!admitted.has(event.runId)) admitted.set(event.runId, event); return { status: 'accepted' }; } });
    await reopened.service.tick();
    assert.equal(admitted.size, 1, 'local admission deduplicates using the persisted runId');
    assert.deepEqual(seen, [original]);
    assert.equal(seen[0].recipients[0].bindingId, 'original-binding');
    assert.equal(seen[0].name, 'Original task');
    assert.equal(seen[0].replyEntryId, 'native-reply');
    assert.equal(reopened.service.db.run(run.id).channelNotify.status, 'accepted');
    assert.equal(reopened.completions.length, 0, 'no model execution or completion replay');
});
test('stale duplicate results neither recreate an acknowledged intent nor emit duplicate completion', async t => {
    const f = await fixture(t);
    let captures = 0;
    f.service.captureChannelNotify = () => { captures++; return f.recipients; };
    f.complete(); f.complete();
    await f.service.tick();
    f.complete();
    f.service.applyResult(f.run, { status: 'running' });
    await f.service.tick();
    assert.equal(captures, 1); assert.equal(f.completions.length, 1); assert.equal(f.admissions.length, 1);
    assert.equal(f.service.db.run(f.run.id).status, 'completed');
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'accepted');
});
test('admission acknowledgement merges with the latest run and stale run saves preserve its receipt', async t => {
    const entered = deferred(), outcome = deferred();
    const f = await fixture(t, { onChannelNotify: async event => { entered.resolve(event); return outcome.promise; } });
    f.complete();
    const draining = f.service.tick(); await entered.promise;
    assert.equal(f.service.busy, true);
    f.service.db.saveRun({ ...f.run, status: 'completed', reason: 'latest-reason' });
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'pending');
    outcome.resolve({ status: 'accepted' }); await draining;
    assert.equal(f.service.db.run(f.run.id).reason, 'latest-reason');
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'accepted');
    f.service.db.saveRun({ ...f.run, status: 'completed' });
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'accepted');
});
test('uncertain-run acknowledgement cannot overwrite a completion that arrives during its worker await', async t => {
    const entered = deferred(), release = deferred(), f = await fixture(t);
    f.service.db.saveRun({ ...f.run, status: 'uncertain' });
    f.service.supervisor.getWorker = async () => ({ cron: async () => { entered.resolve(); await release.promise; } });
    const acknowledging = f.service.action(f.job.id, { action: 'acknowledge', revision: 1, runId: f.run.id });
    await entered.promise;
    f.complete(); release.resolve();
    const result = await acknowledging;
    assert.equal(result.status, 'completed');
    assert.equal(result.channelNotify.status, 'pending');
    await f.service.tick();
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'accepted');
});
test('shutdown waits for in-flight local admission, stops further admission, and preserves unresolved intents', async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { onChannelNotify: async () => { entered.resolve(); return release.promise; } });
    f.complete();
    const second = { ...f.run, id: randomUUID(), scheduledAt: f.run.scheduledAt + 1 };
    f.service.db.saveRun(second); f.service.applyResult(second, { status: 'completed', replyEntryId: 'second-reply' });
    const draining = f.service.reconcileChannelNotifications(); await entered.promise;
    let closed = false;
    const closing = f.service.dispose().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false); assert.equal(f.service.busy, true);
    release.resolve({ status: 'retry', reason: 'fixture interrupted admission' });
    await draining; await closing;
    const reopened = new CronStore(f.service.filename);
    try {
        assert.equal(reopened.run(f.run.id).channelNotify.status, 'pending');
        assert.equal(reopened.run(second.id).channelNotify.attempts, 0);
    } finally { reopened.close(); }
});
test('suspension prevents admission without losing intents and local admission is single-flight', async t => {
    const entered = deferred(), release = deferred(); let calls = 0;
    const f = await fixture(t, { onChannelNotify: async () => { calls++; entered.resolve(); return release.promise; } });
    f.complete(); f.suspend(true); await f.service.tick();
    assert.equal(calls, 0); assert.equal(f.service.busy, false);
    f.suspend(false);
    const first = f.service.reconcileChannelNotifications(); await entered.promise;
    const second = f.service.reconcileChannelNotifications();
    assert.equal(calls, 1);
    release.resolve({ status: 'skipped', reason: 'binding-revoked' }); await first; await second;
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'skipped');
    await f.service.tick(); assert.equal(calls, 1);
});
test('silent, skipped and opt-out completions never capture or admit notifications', async t => {
    for (const status of ['silent', 'skipped', 'completed']) {
        const f = await fixture(t, { captureChannelNotify: () => { throw new Error('must not capture'); } });
        if (status === 'completed') {
            f.run.job.weixinNotification = 'off';
            f.service.db.saveRun(f.run);
        }
        f.complete(status); await f.service.tick();
        assert.equal(f.service.db.run(f.run.id).channelNotify, undefined);
        assert.equal(f.admissions.length, 0);
    }
});
test('legacy default-false jobs inherit thread delivery while explicit new opt-out remains off', async t => {
    const f = await fixture(t);
    f.run.job.notifyWeixin = false;
    f.service.db.saveRun(f.run);
    f.service.db.saveJob(f.run.job);
    f.complete(); await f.service.tick();
    assert.equal(f.admissions.length, 1);
    assert.equal(f.admissions[0].notificationMode, 'inherit');
});
test('explicit notification opt-out or deletion revokes pending admission; disabled one-shot tasks still notify', async t => {
    for (const change of [{ weixinNotification: 'off' }, { deleted: true }, { enabled: false }]) {
        const f = await fixture(t);
        f.complete(); f.service.db.saveJob({ ...f.job, ...change }); await f.service.tick();
        const notification = f.service.db.run(f.run.id).channelNotify;
        const revoked = change.weixinNotification === 'off' || change.deleted;
        assert.equal(notification.status, revoked ? 'skipped' : 'accepted');
        assert.equal(f.admissions.length, revoked ? 0 : 1);
        if (revoked) assert.equal(notification.reason, 'configuration-revoked');
    }
});
test('capture absence, errors, asynchronous results and excess snapshots fail closed permanently', async t => {
    for (const capture of [undefined, () => { throw new Error('fixture capture failure'); },
        async () => [], async () => { throw new Error('fixture async capture failure'); },
        () => Array.from({ length: 201 }, () => ({ bindingId: 'fixture' })),
        () => [{ bindingId: 'x'.repeat(65536) }]]) {
        const f = await fixture(t, { captureChannelNotify: capture });
        f.complete();
        let intent = f.service.db.run(f.run.id).channelNotify;
        assert.equal(intent.status, 'skipped'); assert.equal(intent.reason, 'capture-error'); assert.ok(intent.lastError);
        f.service.captureChannelNotify = () => f.recipients;
        f.complete(); await f.service.tick();
        intent = f.service.db.run(f.run.id).channelNotify;
        assert.equal(intent.status, 'skipped'); assert.equal(f.admissions.length, 0);
    }
});
test('missing admission hook leaves a durable observable pending intent', async t => {
    const f = await fixture(t, { onChannelNotify: undefined });
    f.complete(); await f.service.tick();
    const intent = f.service.db.run(f.run.id).channelNotify;
    assert.equal(intent.status, 'pending'); assert.match(intent.lastError, /unavailable/);
});
test('history list limits and stale updates cannot prune or erase older pending notifications', async t => {
    const f = await fixture(t); f.complete();
    for (let i = 0; i < 110; i++) f.service.db.saveRun({ id: randomUUID(), jobId: f.job.id, scheduledAt: f.clock.value + i, status: 'skipped' });
    assert.equal(f.service.db.runs(f.job.id).some(run => run.id === f.run.id), false);
    assert.equal(f.service.db.pendingChannelNotifications().length, 1);
    assert.deepEqual((await f.service.snapshot()).channelNotifications, { pending: 1, failed: 0, lastError: null });
    await f.service.tick();
    assert.equal(f.service.db.run(f.run.id).channelNotify.status, 'accepted');
    assert.equal(f.admissions.length, 1);
});
test('snapshot reports old backlog and capture failures using bounded categories without callback details', async t => {
    const f = await fixture(t, { onChannelNotify: async () => { throw 'fixture-sensitive-peer-or-token'; } });
    f.complete(); await f.service.tick();
    const failed = { ...f.run, id: randomUUID() };
    f.service.db.saveRun(failed);
    f.service.captureChannelNotify = () => { throw null; };
    f.service.applyResult(failed, { status: 'completed' });
    assert.deepEqual((await f.service.snapshot()).channelNotifications,
        { pending: 1, failed: 1, lastError: 'channel-admission-pending' });
    f.service.onChannelNotify = () => ({ status: 'accepted' });
    f.clock.value = f.service.db.run(f.run.id).channelNotify.nextAttemptAt;
    await f.service.tick();
    assert.deepEqual((await f.service.snapshot()).channelNotifications,
        { pending: 0, failed: 1, lastError: 'channel-capture-failed' });
});
test('admission mutations cannot change the frozen event on a later attempt', async t => {
    const f = await fixture(t); let calls = 0;
    f.service.captureChannelNotify = event => {
        event.name = 'modified capture name'; event.target.cwd = '/modified'; return f.recipients;
    };
    f.service.onChannelNotify = event => {
        calls++;
        assert.equal(event.name, 'Original task'); assert.equal(event.target.cwd, root);
        assert.equal(event.recipients[0].bindingId, 'original-binding');
        event.name = 'modified admission name'; event.recipients[0].bindingId = 'modified-binding';
        return { status: calls === 1 ? 'retry' : 'accepted' };
    };
    f.complete(); await f.service.tick();
    f.clock.value = f.service.db.run(f.run.id).channelNotify.nextAttemptAt;
    await f.service.tick(); assert.equal(calls, 2);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
