const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PiDeferredMessages } = require('../server/pi-deferred-messages');

test('default port queue stays separate while explicit old ports and file overrides retain their queues', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-port-queue-'));
    const keys = ['PORT', 'PI_CODING_AGENT_DIR', 'PI_WEB_DEFERRED_FILE'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    t.after(() => {
        for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        fs.rmSync(root, { recursive: true, force: true });
    });
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_WEB_DEFERRED_FILE;
    const legacy = path.join(root, 'pi5-deferred-messages.json');
    const saved = JSON.stringify({ version: 1, jobs: [] });
    fs.writeFileSync(legacy, saved, { mode: 0o600 });
    for (const [port, expected] of [[undefined, 'pivane-deferred-messages-11408.json'], ['11408', 'pivane-deferred-messages-11408.json'], ['3001', 'pi5-deferred-messages.json'], ['3000', 'pivane-deferred-messages-3000.json']]) {
        if (port === undefined) delete process.env.PORT; else process.env.PORT = port;
        const service = new PiDeferredMessages({ store: {}, supervisor: {}, intervalMs: 1000000 });
        try { assert.equal(service.filePath, path.join(root, expected)); } finally { await service.dispose(); }
    }
    process.env.PORT = '11408';
    process.env.PI_WEB_DEFERRED_FILE = legacy;
    const service = new PiDeferredMessages({ store: {}, supervisor: {}, intervalMs: 1000000 });
    try { assert.equal(service.filePath, legacy); assert.equal(service.error, null); } finally { await service.dispose(); }
});

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

test('queue revisions change only after saved mutations and are renewed on restart', async t => {
    const f = fixture(t), service = f.create(), id = randomUUID();
    const before = service.summary().revision;
    assert.equal(typeof before, 'string');
    assert.equal(service.summary().revision, before);
    const input = { id, message: 'Private scheduled text', dueAt: 110000 };
    service.create(f.session, input);
    const created = service.summary().revision;
    assert.notEqual(created, before);
    service.create(f.session, input);
    assert.equal(service.summary().revision, created, 'idempotent creation does not invalidate readers');
    service.update(f.root, 'session', id, { action: 'save', revision: 1, message: 'Edited text', dueAt: 120000 });
    const edited = service.summary().revision;
    assert.notEqual(edited, created, 'same count/status with changed text still invalidates readers');
    assert.equal(JSON.stringify(service.summary()).includes('Edited text'), false);
    assert.throws(() => service.update(f.root, 'session', id, { action: 'cancel', revision: 1 }), /其他页面/);
    assert.equal(service.summary().revision, edited);
    const persist = service.persist;
    service.persist = () => { throw new Error('Synthetic disk failure'); };
    assert.throws(() => service.update(f.root, 'session', id, { action: 'cancel', revision: 2 }), /disk failure/);
    assert.equal(service.summary().revision, edited);
    assert.equal(service.jobs[0].status, 'scheduled');
    service.persist = persist;
    await service.dispose();
    const resumed = f.create();
    assert.notEqual(resumed.summary().revision, edited);
    assert.equal(resumed.jobs[0].payload.message, 'Edited text');
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
