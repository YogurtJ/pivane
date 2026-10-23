const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-downloads-')));
const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
fs.mkdirSync(cwd); fs.mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_TOKEN = 'synthetic-download-token';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { PiFileService } = require('../server/pi-file-service');
const { DeliverableStore, ENTRY } = require('../server/pi-deliverables');
const { fileLimits } = require('../server/pi-file-limits');
const { withVerifiedFile } = require('../server/pi-file-bytes');
const { classify } = require('../server/pi-file-types');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const io = require('../server/pi-file-io');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function deferred() {
    let resolve; const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('download and publication quotas are separate from previews and MP4 requires a recognized signature', () => {
    assert.equal(fileLimits({}).downloadBytes, 512 * 1024 * 1024);
    assert.equal(fileLimits({ PIVANE_DELIVERY_FILE_MAX_MIB: '64', PIVANE_DELIVERY_TOTAL_MAX_MIB: '128' }).deliveryTotalBytes, 128 * 1024 * 1024);
    for (const value of ['0', '-1', 'NaN', '1.5', '2049']) assert.throws(() => fileLimits({ PIVANE_FILE_DOWNLOAD_MAX_MIB: value }));
    const mp4 = fs.readFileSync(path.join(__dirname, 'fixtures/release-video.mp4'));
    assert.equal(classify(mp4, 'video.mp4').kind, 'video');
    assert.notEqual(classify(Buffer.from('<script>bad()</script>'), 'fake.mp4').kind, 'video');
});

test('authenticated project and native-branch downloads preserve large bytes, forbid private paths and do not start workers', async t => {
    const store = new PiSessionStore(), files = new PiFileService(store), objects = new DeliverableStore(store);
    const bytes = Buffer.alloc(22300079, 7); fs.writeFileSync(path.join(cwd, '视频.mp4'), bytes);
    const session = await store.createSession(cwd, 'Large delivery');
    const receipt = await objects.publish({ cwd, sessionId: session.id }, { requestId: 'large', title: 'Video', files: ['视频.mp4'] });
    const { SessionManager } = await getSdk(), manager = SessionManager.open(session.path);
    const branchPoint = manager.appendMessage({ role: 'user', content: 'Generate video', timestamp: 1 });
    manager.appendCustomEntry(ENTRY, receipt.reference);
    assert.deepEqual(await objects.publish({ cwd, sessionId: session.id }, { requestId: 'large', title: 'Video', files: ['视频.mp4'] }), receipt);
    await assert.rejects(files.preview({ cwd, path: '视频.mp4' }), { code: 'FILE_SIZE' });
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), express = require('express');
    const access = new WorkspaceAccessService(), app = express(), router = express.Router();
    access.mount(app); app.use(access.middleware());
    let workerLookups = 0;
    require('../server/pi-file-routes').mountFilePreviews(router, { files, store, access, supervisor: { getActiveWorker: () => { workerLookups++; return null; } } });
    app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: 'Bearer synthetic-download-token', Origin: base };
    const projectUrl = base + '/api/pi/files/download?' + new URLSearchParams({ cwd, path: '视频.mp4' });
    const deliveryUrl = base + '/api/pi/deliverables/download?' + new URLSearchParams({ cwd, sessionId: session.id, id: receipt.reference.id, index: '0' });
    assert.equal((await fetch(projectUrl)).status, 401);
    assert.equal((await fetch(projectUrl, { headers: { ...headers, Origin: 'https://other.test' } })).status, 403);
    for (const url of [projectUrl, deliveryUrl]) {
        const head = await fetch(url, { method: 'HEAD', headers }); assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-length'), String(bytes.length));
        assert.match(head.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8/);
        const response = await fetch(url, { headers }); assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/octet-stream');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(bytes));
    }
    const login = await fetch(base + '/api/access/login', { method: 'POST', headers: { Origin: base, 'X-Pi-Access': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'synthetic-download-token' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const cookieRead = await fetch(projectUrl, { method: 'HEAD', headers: { Cookie: cookie, Origin: base } }); assert.equal(cookieRead.status, 200);
    fs.writeFileSync(path.join(cwd, '.env'), 'private'); fs.symlinkSync('.env', path.join(cwd, 'disguised.txt'));
    for (const filename of ['.env', 'disguised.txt']) {
        const response = await fetch(base + '/api/pi/files/download?' + new URLSearchParams({ cwd, path: filename }), { headers });
        assert.equal(response.status, 403); assert.equal((await response.json()).code, 'FILE_PRIVATE');
    }
    files.limits.downloadBytes = 1024;
    const tooLarge = await fetch(projectUrl, { headers }); assert.equal(tooLarge.status, 413); assert.equal((await tooLarge.json()).code, 'FILE_SIZE');
    files.limits.downloadBytes = 32 * 1024 * 1024;
    const validIdentity = access.validIdentity.bind(access); let authorizationChecks = 0;
    access.validIdentity = identity => ++authorizationChecks < 2 && validIdentity(identity);
    try {
        await assert.rejects(async () => { const response = await fetch(projectUrl, { headers }); await response.arrayBuffer(); }, /fetch failed|terminated|aborted|closed|reset/i);
        assert.ok(authorizationChecks >= 2, 'access is checked again before the final chunk');
    } finally { access.validIdentity = validIdentity; }
    const snapshotPath = path.join(await objects.root(), receipt.reference.id, '0.bin');
    const original = fs.openSync(snapshotPath, 'r+'); fs.writeSync(original, Buffer.from([8]), 0, 1, 0); fs.closeSync(original);
    const tampered = await fetch(deliveryUrl, { headers }); assert.equal(tampered.status, 409);
    assert.equal((await tampered.json()).code, 'FILE_CHANGED');
    manager.branch(branchPoint);
    manager.appendMessage({ role: 'user', content: 'Different branch', timestamp: Date.now() });
    const hidden = await fetch(deliveryUrl, { headers }); assert.equal(hidden.status, 403); assert.equal((await hidden.json()).code, 'DELIVERY_SCOPE');
    assert.ok(workerLookups > 0);
});

test('publication applies configurable per-file and group quotas before publishing a manifest', async () => {
    const objects = new DeliverableStore(new PiSessionStore());
    fs.writeFileSync(path.join(cwd, 'quota-a.bin'), Buffer.alloc(2 * 1024 * 1024));
    fs.writeFileSync(path.join(cwd, 'quota-b.bin'), Buffer.alloc(2 * 1024 * 1024));
    objects.limits.deliveryFileBytes = 1024 * 1024;
    await assert.rejects(objects.publish({ cwd, sessionId: 'quota' }, { requestId: 'file-limit', title: 'File limit', files: ['quota-a.bin'] }), { code: 'FILE_SIZE' });
    objects.limits.deliveryFileBytes = 3 * 1024 * 1024; objects.limits.deliveryTotalBytes = 3 * 1024 * 1024;
    await assert.rejects(objects.publish({ cwd, sessionId: 'quota' }, { requestId: 'group-limit', title: 'Group limit', files: ['quota-a.bin', 'quota-b.bin'] }), { code: 'DELIVERY_LIMIT' });
});

test('streaming withholds completion when a source changes or cancellation arrives during transfer', async () => {
    const filename = path.join(cwd, 'changing.bin'); fs.writeFileSync(filename, Buffer.alloc(900000, 1));
    let sent = 0;
    await assert.rejects(withVerifiedFile(filename, { maxBytes: 1000000, check: actual => assert.equal(actual, filename) }, async file => {
        await file.transfer(async chunk => { sent += chunk.length; fs.appendFileSync(filename, 'change'); });
    }), { code: 'FILE_CHANGED' });
    assert.ok(sent < 900000, 'no complete response can be delivered after a change');
    const controller = new AbortController();
    await assert.rejects(withVerifiedFile(filename, { maxBytes: 1000000, signal: controller.signal, check: () => {} }, file => file.transfer(() => controller.abort())), { name: 'AbortError' });
});

test('HTTP downloads retain admission until descriptor cleanup and release it after every outcome', async t => {
    for (const outcome of ['disconnect', 'read failure', 'HEAD', 'GET']) await t.test(outcome, async t => {
        const source = path.join(cwd, `lease-${outcome.replaceAll(' ', '-')}.bin`);
        const size = 8 * 1024 * 1024; fs.writeFileSync(source, Buffer.alloc(size, 42));
        const closing = deferred(), allowClose = deferred(), handlerSettled = deferred();
        let descriptorClosed = false, transferError, serverResponse;
        const openRead = io.openRead;
        t.mock.method(io, 'openRead', async filename => {
            const handle = await openRead(filename);
            if (filename !== source) return handle;
            const close = handle.close.bind(handle);
            handle.close = async () => {
                closing.resolve(); await allowClose.promise;
                await close(); descriptorClosed = true;
            };
            if (outcome === 'read failure') handle.read = async () => { throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' }); };
            return handle;
        });
        const maintenance = new MaintenanceClient({ managed: false });
        const store = new PiSessionStore(), files = new PiFileService(store);
        const download = files.download.bind(files);
        files.download = async (...args) => {
            try { return await download(...args); }
            catch (error) { transferError = error; throw error; }
        };
        const express = require('express'), app = express(), router = express.Router();
        // Match application and gateway admission of the same native request.
        app.use((req, res, next) => maintenance.http(req, res, next));
        router.use((req, res, next) => maintenance.http(req, res, next));
        const get = router.get.bind(router);
        t.mock.method(router, 'get', (pathname, handler) => get(pathname, pathname === '/files/download' ? async (req, res) => {
            serverResponse = res;
            try { await handler(req, res); } finally { handlerSettled.resolve(); }
        } : handler));
        require('../server/pi-file-routes').mountFilePreviews(router, { files, store, supervisor: {} });
        app.use('/api/pi', router);
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        t.after(async () => {
            allowClose.resolve(); server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        });
        const url = `http://127.0.0.1:${server.address().port}/api/pi/files/download?` + new URLSearchParams({ cwd, path: path.basename(source) });
        let status, received = 0, body = '';
        const responseDone = new Promise((resolve, reject) => {
            const request = http.request(url, { method: outcome === 'HEAD' ? 'HEAD' : 'GET' }, response => {
                status = response.statusCode;
                response.on('data', bytes => {
                    received += bytes.length;
                    if (outcome === 'read failure') body += bytes;
                    if (outcome === 'disconnect') { response.destroy(); resolve(); }
                });
                response.once('end', resolve); response.once('error', reject);
            });
            request.once('error', reject); request.end();
        });
        try {
            if (outcome === 'disconnect') await responseDone;
            await closing.promise;
            assert.equal(descriptorClosed, false);
            assert.equal(maintenance.active, 1, 'end, finish and disconnect must not release a handler still closing its descriptor');
            assert.throws(() => maintenance.acquireReferenceLease(() => true), { code: 'DOCUMENT_STORAGE_BUSY' });
        } finally { allowClose.resolve(); await handlerSettled.promise; }
        await responseDone;
        assert.equal(descriptorClosed, true);
        assert.equal(files.reading, 0);
        assert.equal(maintenance.active, 0, 'the actual completed handler must release its original request admission');
        const lease = maintenance.acquireReferenceLease(() => true); lease.check(); lease.release();
        if (outcome === 'disconnect') {
            assert.ok(received > 0 && received < size, 'client disconnects after receiving data and before EOF');
            assert.equal(serverResponse.destroyed, true); assert.ok(transferError);
        } else if (outcome === 'read failure') {
            assert.equal(status, 500); assert.equal(JSON.parse(body).code, 'FILE_READ'); assert.ok(transferError);
        } else {
            assert.equal(status, 200); assert.equal(received, outcome === 'HEAD' ? 0 : size); assert.equal(transferError, undefined);
        }
    });
});
