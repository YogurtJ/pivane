const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-deliverables-')));
const cwd = path.join(root, 'project'), outside = path.join(root, 'outputs'), agent = path.join(root, 'private-agent');
for (const dir of [cwd, outside, agent]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'delivery-fixture';
process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { PiFileService } = require('../server/pi-file-service');
const { DeliverableStore, DeliverableService, ENTRY, validate } = require('../server/pi-deliverables');
const { classify } = require('../server/pi-file-types');
const store = new PiSessionStore(), objects = new DeliverableStore(store), files = new PiFileService(store);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(outside, '方案.md'), '\ufeff# Delivery\r\nExact bytes\n');
fs.writeFileSync(path.join(outside, 'preview.html'), '<!doctype html><button onclick="this.textContent=\'done\'">Click</button>');
fs.writeFileSync(path.join(cwd, 'image.png'), png);
const input = { requestId: 'first', title: '成果', sourceRoot: outside, files: ['方案.md', 'preview.html'] };
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Fixture' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 2, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('typed project reads preserve text API, signature recognition, bounds and scope', async () => {
    const image = await files.preview({ cwd, path: 'image.png' });
    assert.equal(image.kind, 'image'); assert.equal(image.mime, 'image/png'); assert.equal(image.width, 1);
    assert.deepEqual(Buffer.from(image.base64, 'base64'), png);
    await assert.rejects(files.content({ cwd, path: 'image.png' }), { code: 'FILE_ENCODING' });
    await assert.rejects(files.preview({ cwd, path: path.join(outside, 'preview.html') }), { code: 'FILE_OUTSIDE' });
    fs.writeFileSync(path.join(cwd, 'fake.png'), '<script>alert(1)</script>');
    assert.equal((await files.preview({ cwd, path: 'fake.png' })).kind, 'binary');
    const huge = Buffer.from(png); huge.writeUInt32BE(99999, 16);
    assert.equal(classify(huge, 'huge.png').kind, 'binary');
    fs.writeFileSync(path.join(cwd, 'page.html'), '<!doctype html><script>parent.bad=true</script>');
    assert.equal((await files.preview({ cwd, path: 'page.html' })).kind, 'html');
    fs.writeFileSync(path.join(cwd, 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(files.preview({ cwd, path: 'large.bin' }), { code: 'FILE_SIZE' });
});

test('explicit publication snapshots bytes, preserves originals, deduplicates and refuses private/outside files', async () => {
    const context = { cwd, sessionId: 'synthetic' }, first = await objects.publish(context, input);
    assert.match(first.files[0].href, /^#pi-delivery=[a-f0-9]{64}\/0$/);
    const before = await objects.content(first.reference, 0);
    assert.equal(before.content, '\ufeff# Delivery\r\nExact bytes\n');
    fs.writeFileSync(path.join(outside, '方案.md'), '# Changed');
    assert.deepEqual(await objects.publish(context, input), first);
    assert.equal((await objects.content(first.reference, 0)).content, before.content);
    await assert.rejects(objects.publish(context, { ...input, title: 'different' }), { code: 'DELIVERY_CONFLICT' });
    await assert.rejects(objects.publish(context, { requestId: 'outside', title: 'Denied', files: [path.join(outside, '方案.md')] }), { code: 'FILE_OUTSIDE' });
    fs.writeFileSync(path.join(outside, '.env'), 'secret'); fs.symlinkSync('.env', path.join(outside, 'alias.txt'));
    await assert.rejects(objects.publish(context, { ...input, requestId: 'private', files: ['alias.txt'] }), { code: 'FILE_PRIVATE' });
    fs.writeFileSync(path.join(agent, 'plain.txt'), 'private');
    await assert.rejects(objects.publish(context, { ...input, requestId: 'agent', sourceRoot: agent, files: ['plain.txt'] }), { code: 'FILE_PRIVATE' });
    assert.throws(() => validate({ ...input, files: Array(21).fill('a') }), { code: 'DELIVERY_INPUT' });
    if (process.platform !== 'win32') {
        const dir = await objects.root(); assert.equal(fs.statSync(path.join(dir, first.reference.id, '0.bin')).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(dir, first.reference.id)).mode & 0o777, 0o700);
    }
});

test('native branch authorization survives forks and compaction, rejects invisible refs and tampered bytes', async () => {
    const { SessionManager } = await getSdk();
    const session = await store.createSession(cwd, 'Deliveries');
    const manager = SessionManager.open(session.path);
    const before = manager.appendMessage({ role: 'user', content: 'Task', timestamp: 1 }); manager.appendMessage(assistant);
    const receipt = await objects.publish({ cwd, sessionId: session.id }, { ...input, requestId: 'branch' });
    manager.appendCustomEntry(ENTRY, receipt.reference);
    const reply = manager.appendMessage({ ...assistant, timestamp: 3 });
    const service = new DeliverableService({ store, supervisor: { getActiveWorker: () => null } });
    const request = { cwd, sessionId: session.id, id: receipt.reference.id, index: '0' };
    assert.equal((await service.request(request)).source, 'delivery');
    assert.equal((await service.request({ cwd, sessionId: session.id, path: path.join(outside, '方案.md') })).items.length, 1);
    const snapshot = { entries: manager.getEntries(), leafId: manager.getLeafId() };
    const fork = (await store.forkSession(session, snapshot, reply, 'at')).session;
    assert.equal((await service.request({ ...request, sessionId: fork.id })).deliveryId, receipt.reference.id);
    const early = (await store.forkSession(session, snapshot, before, 'before')).session;
    await assert.rejects(service.request({ ...request, sessionId: early.id }), { code: 'DELIVERY_SCOPE' });
    const kept = manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 4 });
    manager.appendCompaction('Fixture summary', kept, 10000);
    assert.equal((await service.request(request)).deliveryId, receipt.reference.id);
    manager.branch(before);
    // Branch is persisted by the following native entry, not an alternate ledger.
    manager.appendMessage({ role: 'user', content: 'Other branch', timestamp: 5 });
    await assert.rejects(service.request(request), { code: 'DELIVERY_SCOPE' });
    fs.writeFileSync(path.join(await objects.root(), receipt.reference.id, '0.bin'), 'tampered');
    await assert.rejects(service.request({ ...request, sessionId: fork.id }), { code: 'DELIVERY_CHANGED' });
});

test('publication reserves before await, retains incomplete evidence, rejects swaps and stale branch reads', async () => {
    const io = require('../server/pi-file-io');
    const original = io.openRead, context = { cwd, sessionId: 'race-fixture' };
    fs.writeFileSync(path.join(cwd, 'race.txt'), 'before');
    let entered, release;
    const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
    io.openRead = async (...args) => { if (args[0] === path.join(cwd, 'race.txt')) { entered(); await gate; } return original(...args); };
    try {
        const input = { requestId: 'concurrent', title: 'Race', files: ['race.txt'] };
        const first = objects.publish(context, input); await ready;
        await assert.rejects(objects.publish(context, input), { code: 'DELIVERY_BUSY' });
        release(); await first;
    } finally { io.openRead = original; release(); }
    const unsafe = path.join(cwd, 'swap.txt'); fs.writeFileSync(unsafe, 'before');
    io.openRead = async (...args) => { if (args[0] === unsafe) { fs.unlinkSync(unsafe); fs.symlinkSync(path.join(outside, '方案.md'), unsafe); } return original(...args); };
    try { await assert.rejects(objects.publish(context, { requestId: 'swap', title: 'Swap', files: ['swap.txt'] }), e => e.status === 403); }
    finally { io.openRead = original; }
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(objects.publish(context, { requestId: 'abort', title: 'Abort', files: ['race.txt'] }, aborted.signal));
    const incompleteId = require('node:crypto').createHash('sha256').update(JSON.stringify([cwd, context.sessionId, 'incomplete'])).digest('hex');
    fs.mkdirSync(path.join(await objects.root(), incompleteId));
    await assert.rejects(objects.publish(context, { requestId: 'incomplete', title: 'Partial', files: ['race.txt'] }), { code: 'DELIVERY_INCOMPLETE' });
    const receipt = await objects.publish(context, { requestId: 'stale', title: 'Stale', files: ['race.txt'] });
    const service = new DeliverableService({ store, supervisor: {} }); let reads = 0;
    service.branch = async () => ({ session: { cwd }, refs: ++reads === 1 ? [receipt.reference] : [] });
    await assert.rejects(service.request({ cwd, sessionId: context.sessionId, id: receipt.reference.id, index: '0' }), { code: 'DELIVERY_CONTEXT' });
});

test('authenticated routes return JSON only, deny other origins and do not launch workers', async t => {
    const express = require('express'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService(), app = express(); app.use(access.middleware());
    const router = express.Router();
    require('../server/pi-file-routes').mountFilePreviews(router, { files, store, supervisor: { getActiveWorker: () => null } }); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const base = `http://127.0.0.1:${server.address().port}`, url = base + '/api/pi/files/preview?' + new URLSearchParams({ cwd, path: 'page.html' });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer delivery-fixture', Origin: 'https://other.test' } })).status, 403);
    const response = await fetch(url, { headers: { Authorization: 'Bearer delivery-fixture', Origin: base } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await response.json()).kind, 'html');
});
