const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MaintenanceClient } = require('../server/pi-maintenance-client');

function response() {
    const res = new EventEmitter();
    res.end = () => { res.ended = true; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; res.end(); return res; };
    return res;
}
function request(client, next, req = { method: 'POST', path: '/api/pi/uploads/storage/cleanup' }) {
    const res = response(); let result;
    client.http(req, res, () => { result = next(req, res); });
    return { req, res, result };
}
function deferred() {
    let resolve; const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('reference cleanup excludes only its admitted HTTP request and blocks competing admissions', async () => {
    const client = new MaintenanceClient({ managed: false });
    const start = deferred(); let lease;
    const first = request(client, async (req, res) => {
        // The gateway may apply admission again after the application middleware.
        client.http(req, res, () => assert.equal(client.active, 1));
        await start.promise;
        lease = client.acquireReferenceLease(() => true);
        await Promise.resolve(); lease.check();
        assert.throws(() => client.enter(), { code: 'DOCUMENT_STORAGE_BUSY' });
        const competing = request(client, () => assert.fail('cleanup must block this request'));
        assert.equal(competing.res.statusCode, 503);
        assert.equal(competing.res.body.errorCode, 'DOCUMENT_STORAGE_BUSY');
        lease.release(); res.end();
    });
    assert.equal(client.active, 1);
    // An unrelated caller cannot just subtract the one visible request.
    assert.throws(() => client.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
    const other = client.enter();
    assert.equal(client.active, 2);
    other(); start.resolve(); await first.result;
    assert.equal(client.active, 0); assert.equal(client.referenceLocked, false);
    assert.throws(() => lease.check(), { code: 'DOCUMENT_STORAGE_BUSY' });
});

test('already admitted work prevents cleanup until its asynchronous handler finishes, even after disconnect', async () => {
    const client = new MaintenanceClient({ managed: false });
    const ready = deferred(), complete = deferred();
    const writer = request(client, async (_req, res) => { await complete.promise; res.end(); });
    writer.res.emit('close');
    assert.equal(client.active, 1);
    const cleaner = request(client, async (_req, res) => {
        assert.throws(() => client.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
        ready.resolve(); await complete.promise; await writer.result;
        const lease = client.acquireReferenceLease(() => true);
        lease.check(); lease.release(); res.end();
    });
    await ready.promise; complete.resolve(); await Promise.all([writer.result, cleaner.result]);
    assert.equal(client.active, 0);
});

test('a stale asynchronous request context cannot borrow a newer active request identity', async () => {
    const client = new MaintenanceClient({ managed: false }); const later = deferred();
    const old = request(client, async () => {
        await later.promise;
        assert.throws(() => client.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
    });
    old.res.end(); const leaveNew = client.enter(); later.resolve(); await old.result;
    leaveNew(); assert.equal(client.active, 0);
});

test('reference lease rechecks external activity and remains independent of maintenance IPC', () => {
    const client = new MaintenanceClient({ managed: true, nonce: 'fixture', send() {} });
    client.receive({ nonce: 'fixture', type: 'maintenance-status', status: { supported: true, busy: false } });
    client.receive({ nonce: 'fixture', type: 'maintenance-activate' });
    let idle = true;
    const lease = client.acquireReferenceLease(() => idle);
    client.receive({ nonce: 'fixture', type: 'maintenance-activate' });
    assert.equal(client.referenceLocked, true); assert.equal(client.status().busy, true);
    assert.throws(() => client.enter(), { code: 'DOCUMENT_STORAGE_BUSY' });
    assert.throws(() => client.review({ action: 'backup' }, () => true), /正在处理/);
    idle = false; assert.throws(() => lease.check(), { code: 'DOCUMENT_STORAGE_BUSY' });
    lease.release(); idle = true;
    const second = client.acquireReferenceLease(() => idle);
    lease.release(); assert.equal(client.referenceLocked, true); second.check(); second.release();
    assert.equal(client.status().busy, false);
    assert.throws(() => client.acquireReferenceLease(async () => true), { code: 'DOCUMENT_STORAGE_BUSY' });
});
