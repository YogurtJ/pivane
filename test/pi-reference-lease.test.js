const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { MaintenanceClient, takeHttpOperationCompletion } = require('../server/pi-maintenance-client');

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

test('handler completion keeps the original request identity across duplicate admission and response completion', async () => {
    const client = new MaintenanceClient({ managed: false });
    const finish = deferred(), later = deferred(); let complete;
    const owned = request(client, async (req, res) => {
        complete = takeHttpOperationCompletion(req);
        client.http(req, res, () => assert.equal(client.active, 1));
        res.end(); res.emit('finish'); res.emit('close');
        await finish.promise;
        const lease = client.acquireReferenceLease(() => true); lease.check(); lease.release();
        complete();
        await later.promise;
        assert.throws(() => client.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
    });
    assert.equal(client.active, 1);
    assert.throws(() => client.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
    finish.resolve(); await Promise.resolve();
    assert.equal(client.active, 0);
    const unrelated = request(client, () => {});
    complete(); owned.res.end(); owned.res.emit('finish');
    assert.equal(client.active, 1, 'repeated old completion cannot release an unrelated request');
    later.resolve(); await owned.result;
    unrelated.res.end(); assert.equal(client.active, 0);
});

test('a real disconnected HTTP writer blocks reference cleanup until its write actually completes', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-reference-write-'));
    const destination = path.join(root, 'synthetic.txt');
    const client = new MaintenanceClient({ managed: false });
    const admitted = deferred(), peerClosed = deferred(), allowWrite = deferred(), handlerSettled = deferred();
    const express = require('express'), app = express();
    app.use((req, res, next) => client.http(req, res, next));
    app.post('/api/pi/synthetic-write', async (_req, res) => {
        res.once('close', peerClosed.resolve); admitted.resolve();
        try { await allowWrite.promise; await fs.promises.writeFile(destination, 'completed after disconnect'); res.end(); }
        finally { handlerSettled.resolve(); }
    });
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
        allowWrite.resolve(); await handlerSettled.promise;
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    let requestError;
    const writer = http.request(`http://127.0.0.1:${server.address().port}/api/pi/synthetic-write`, { method: 'POST' });
    writer.on('error', error => { requestError = error; }); writer.end();
    await admitted.promise;
    const disconnected = new Promise(resolve => writer.once('close', resolve)); writer.destroy(); await disconnected; await peerClosed.promise;
    assert.equal(requestError?.code, 'ECONNRESET');
    assert.equal(client.active, 1);
    assert.equal(fs.existsSync(destination), false);
    assert.throws(() => client.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
    allowWrite.resolve(); await handlerSettled.promise;
    assert.equal(fs.readFileSync(destination, 'utf8'), 'completed after disconnect');
    assert.equal(client.active, 0);
    const lease = client.acquireReferenceLease(() => true); lease.check(); lease.release();
});
