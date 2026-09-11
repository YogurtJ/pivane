const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PiDeferredMessages } = require('../server/pi-deferred-messages');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-deferred-'));
    let now = 100000, busy = false, sendError = null;
    const calls = [];
    const session = { cwd: root, id: 'session', path: path.join(root, 'session.jsonl') };
    const store = { resolveProject: cwd => cwd, getSession: async (cwd, id) => {
        if (cwd !== session.cwd || id !== session.id) throw new Error('Missing session');
        return session;
    } };
    const worker = { exclusive: async callback => {
        if (busy) throw Object.assign(new Error('Busy'), { code: 'SESSION_BUSY' });
        busy = true;
        try { return await callback(async (type, payload) => { calls.push({ type, payload }); if (sendError) throw sendError; }, { model: { input: ['text', 'image'] } }); }
        finally { busy = false; }
    } };
    const supervisor = { getWorker: async () => worker };
    const options = { store, supervisor, filePath: path.join(root, 'deferred.json'), now: () => now, intervalMs: 1000000 };
    const services = [];
    const create = () => { const service = new PiDeferredMessages(options); services.push(service); return service; };
    t.after(async () => { for (const service of services) await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, session, options, worker, create, calls, setNow: value => { now = value; }, setBusy: value => { busy = value; }, setError: value => { sendError = value; } };
}

test('deferred messages persist once, wait for idle, clear sent payload and reject stale edits', async t => {
    const f = fixture(t), service = f.create(), id = randomUUID();
    const input = { id, message: 'Preserve exactly\u2028this', dueAt: 110000 };
    service.create(f.session, input);
    service.create(f.session, input);
    assert.equal(service.jobs.length, 1);
    require('./private-file-helper.cjs').assertPrivateFile(f.options.filePath);
    assert.equal(service.summary().sessions[0].count, 1);
    assert.equal(JSON.stringify(service.summary()).includes('Preserve exactly'), false);
    await service.tick(); assert.equal(f.calls.length, 0);
    f.setNow(110000); f.setBusy(true); await service.tick();
    assert.equal(service.jobs[0].status, 'waiting');
    assert.throws(() => service.update(f.root, 'session', id, { revision: 1, action: 'cancel' }), /其他页面/);
    f.setBusy(false); await service.tick(); await service.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].payload.message, input.message);
    assert.equal(service.jobs[0].status, 'sent');
    assert.equal(fs.readFileSync(f.options.filePath, 'utf8').includes('Preserve exactly'), false);
    assert.throws(() => service.update(f.root, 'session', id, { revision: 3, action: 'cancel' }));
});

test('deferred restart expires overdue jobs and quarantines uncertain handoff without retries', async t => {
    const f = fixture(t), service = f.create();
    service.create(f.session, { id: randomUUID(), message: 'Overdue', dueAt: 110000 });
    const future = randomUUID();
    service.create(f.session, { id: future, message: 'Future', dueAt: 130000 });
    f.setNow(120000);
    await service.dispose();
    const resumed = f.create();
    assert.equal(resumed.jobs[0].status, 'expired');
    assert.equal(resumed.jobs[1].status, 'scheduled');
    await resumed.tick(); assert.equal(f.calls.length, 0);
    resumed.update(f.root, 'session', future, { revision: 1, action: 'send' });
    f.setError(Object.assign(new Error('Timeout'), { code: 'RPC_TIMEOUT' }));
    await resumed.tick(); await resumed.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(resumed.jobs[1].status, 'uncertain');
    assert.throws(() => resumed.update(f.root, 'session', future, { revision: resumed.jobs[1].revision, action: 'send' }), /重复执行/);
    resumed.change(() => { resumed.jobs[1].status = 'dispatching'; });
    await resumed.dispose();
    const recovered = f.create();
    assert.equal(recovered.jobs[1].status, 'uncertain');
    await recovered.tick(); assert.equal(f.calls.length, 1);
});

test('deferred pause, cancel, validation and failed acknowledgements never generate automatically', async t => {
    const f = fixture(t), service = f.create();
    const id = randomUUID();
    assert.throws(() => service.create(f.session, { id, message: '/compact', dueAt: 120000 }), /斜杠/);
    assert.throws(() => service.create(f.session, { id, message: 'x', dueAt: NaN }), /发送时间/);
    assert.throws(() => service.create(f.session, { id, message: 'x', dueAt: 120000, images: [{}] }), /附件/);
    service.create(f.session, { id, message: 'x', dueAt: 120000 });
    service.pauseSession(f.root, 'session');
    f.setNow(130000); await service.tick(); assert.equal(f.calls.length, 0);
    service.update(f.root, 'session', id, { action: 'send', revision: service.jobs[0].revision });
    f.setError(Object.assign(new Error('Rejected'), { code: 'RPC_REJECTED' }));
    await service.tick(); await service.tick();
    assert.equal(service.jobs[0].status, 'failed'); assert.equal(f.calls.length, 1);
    service.cancelSession(f.root, 'session');
    assert.equal(service.jobs[0].status, 'cancelled');
    assert.equal(service.jobs[0].payload, undefined);
});

test('an unrelated rejected edit cannot lose an in-flight delivery acknowledgement', async t => {
    const f = fixture(t), service = f.create();
    const id = randomUUID();
    service.create(f.session, { id, message: 'Deliver exactly once', dueAt: 110000 });
    f.setNow(120000);
    let accept;
    f.worker.exclusive = callback => callback(() => new Promise(resolve => { accept = resolve; }), { model: { input: ['text'] } });
    const sending = service.tick();
    while (!accept) await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.jobs[0].status, 'dispatching');
    assert.throws(() => service.update(f.root, 'session', id, { action: 'cancel', revision: 0 }), /其他页面/);
    accept(); await sending;
    assert.equal(service.jobs[0].status, 'sent');
    assert.equal(service.jobs[0].payload, undefined);
});

test('deferred persistence failure cannot dispatch; corrupt stores are not overwritten', async t => {
    const f = fixture(t), service = f.create();
    service.create(f.session, { id: randomUUID(), message: 'x', dueAt: 110000 });
    f.setNow(120000);
    service.persist = () => { throw new Error('Disk failure'); };
    await assert.rejects(service.tick(), /Disk failure/);
    assert.equal(f.calls.length, 0);
    await service.dispose();
    fs.writeFileSync(f.options.filePath, 'invalid JSON');
    const corrupt = f.create();
    assert.ok(corrupt.summary().error);
    await corrupt.tick(); assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(f.options.filePath, 'utf8'), 'invalid JSON');
});
