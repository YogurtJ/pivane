const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-storage-')));
process.env.PI_CODING_AGENT_DIR = root; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { DocumentUploads, mountDocumentUploads } = require('../server/pi-document-uploads');
const { scanReferences } = require('../server/pi-document-storage-references');
const { zip, docxFiles } = require('./document-fixtures.cjs');
const bytes = zip(docxFiles());
let number = 0;
async function fixture(t, options = {}) {
    const base = path.join(root, String(++number)), agent = path.join(base, 'agent'), cwd = path.join(base, 'project');
    fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(cwd); process.env.PI_CODING_AGENT_DIR = agent;
    const store = new PiSessionStore(), supervisor = { removing: new Set(), moving: new Set(), getActiveWorker: () => null };
    const state = { revision: '1', ids: [], complete: true, leased: false, revoked: false, hook: null };
    const storageGuard = { acquire() {
        if (state.leased) throw new Error('Already leased'); state.leased = true;
        return { check() { if (state.revoked) throw Object.assign(new Error('Competing mutation'), { status: 409, code: 'GUARD_CHANGED' }); }, release() { state.leased = false; } };
    } };
    const service = new DocumentUploads({ store, supervisor, storageGuard, protectedDocuments: async () => {
        if (state.hook) await state.hook(); return { complete: state.complete, revision: state.revision, ids: state.ids };
    }, ...options });
    const session = await store.createSession(cwd, 'Storage fixture');
    const upload = requestId => service.upload({ cwd, sessionId: session.id, name: `${requestId}.docx`, requestId }, bytes);
    t.after(async () => { await service.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
    return { base, cwd, agent, store, session, service, state, upload, storage: service.storage };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const cleanupInput = (cwd, preview, extra = {}) => ({ cwd, ticket: preview.ticket, revision: preview.revision, requestId: 'cleanup', confirmed: true, externalWritersStopped: true, draftIds: [], ...extra });

test('one-file cleanup frees capacity, persists receipt, rejects request replay/resurrection and protects new page drafts', async t => {
    const f = await fixture(t), uploaded = await f.upload('unused'), id = uploaded.reference.id;
    const before = await f.storage.usage({ cwd: f.cwd }); assert.equal(before.count, 1); assert.equal(before.totalBytes, bytes.length); assert.equal(before.items[0].savedReference, 'not-found');
    const preview = await f.storage.preview({ cwd: f.cwd, id });
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview, { confirmed: false })), { code: 'DOCUMENT_INPUT' });
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview, { externalWritersStopped: false })), { code: 'DOCUMENT_INPUT' });
    assert.equal(fs.existsSync((await f.service.object(id)).folder), true);
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview, { draftIds: [id] })), { code: 'DOCUMENT_PROTECTED' });
    const receipt = await f.storage.cleanup(cleanupInput(f.cwd, preview)); assert.equal(receipt.state, 'deleted');
    assert.deepEqual(await f.storage.status({ cwd: f.cwd, requestId: 'cleanup' }), receipt);
    assert.deepEqual(await f.storage.cleanup(cleanupInput(f.cwd, preview)), receipt);
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview, { ticket: 'different' })), { code: 'DOCUMENT_CONFLICT' });
    await assert.rejects(f.upload('unused'), { code: 'DOCUMENT_DELETED' });
    const after = await f.storage.usage({ cwd: f.cwd }); assert.equal(after.count, 0); assert.equal(after.totalBytes, 0);
    await f.upload('new-id'); assert.equal((await f.storage.usage({ cwd: f.cwd })).count, 1);
    const restarted = new DocumentUploads({ store: f.store, supervisor: f.service.supervisor, storageGuard: f.service.storage.storageGuard, protectedDocuments: f.service.storage.protectedDocuments });
    try { assert.deepEqual(await restarted.storage.status({ cwd: f.cwd, requestId: 'cleanup' }), receipt); await assert.rejects(restarted.upload({ cwd: f.cwd, sessionId: f.session.id, name: 'unused.docx', requestId: 'unused' }, bytes), { code: 'DOCUMENT_DELETED' }); }
    finally { await restarted.dispose(); }
});

test('generic attachment references receive the same native-branch protection and explicit cleanup', async t => {
    const f = await fixture(t), original = Buffer.from([0, 255, 1]);
    const upload = requestId => f.service.upload({ cwd: f.cwd, sessionId: f.session.id, name: requestId + '.zip', requestId }, original);
    const saved = await upload('generic-saved'), unused = await upload('generic-unused');
    const { SessionManager } = await getSdk();
    SessionManager.open(f.session.path).appendMessage({ role: 'user', content: saved.marker, timestamp: 1 });
    const usage = await f.storage.usage({ cwd: f.cwd });
    assert.equal(usage.totalBytes, original.length * 2);
    assert.equal(usage.items.find(item => item.id === saved.reference.id).savedReference, 'protected');
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: saved.reference.id }), { code: 'DOCUMENT_PROTECTED' });
    const preview = await f.storage.preview({ cwd: f.cwd, id: unused.reference.id });
    assert.equal((await f.storage.cleanup(cleanupInput(f.cwd, preview))).state, 'deleted');
    assert.deepEqual(await f.service.bytes(await f.service.object(saved.reference.id)), original);
});

test('all native branches, fork drafts, scheduled/unknown queue intents and current drafts protect documents', async t => {
    const f = await fixture(t), uploaded = await f.upload('saved'), id = uploaded.reference.id;
    const { SessionManager } = await getSdk(), manager = SessionManager.open(f.session.path);
    const first = manager.appendMessage({ role: 'user', content: 'Before', timestamp: 1 });
    const question = manager.appendMessage({ role: 'user', content: uploaded.marker, timestamp: 2 });
    manager.branch(first); manager.appendMessage({ role: 'user', content: 'Other branch', timestamp: 3 });
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_PROTECTED' });
    assert.equal((await f.storage.usage({ cwd: f.cwd })).items[0].savedReference, 'protected');
    const draftUpload = await f.upload('fork-draft'); manager.branch(question);
    const draftQuestion = manager.appendMessage({ role: 'user', content: draftUpload.marker, timestamp: 4 });
    const fork = (await f.store.forkSession(f.session, { entries: manager.getEntries(), leafId: manager.getLeafId() }, draftQuestion, 'before')).session;
    // Even if the original session is absent, the saved fork receipt protects
    // the unsubmitted question's document outside the fork's native branch.
    fs.unlinkSync(f.session.path);
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: draftUpload.reference.id }), { code: 'DOCUMENT_PROTECTED' });
    assert.ok(fs.existsSync(fork.path));
    const queued = await f.service.upload({ cwd: f.cwd, sessionId: fork.id, name: 'queued.docx', requestId: 'queued' }, bytes);
    f.state.ids = [queued.reference.id]; f.state.revision = 'schedule-and-queue-2';
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: queued.reference.id }), { code: 'DOCUMENT_PROTECTED' });
    f.state.ids = []; f.state.revision = '3';
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: queued.reference.id, draftIds: [queued.reference.id] }), { code: 'DOCUMENT_PROTECTED' });
});

test('managed artifacts do not disable cleanup or hide nested native child references', async t => {
    const f = await fixture(t), childDocument = await f.upload('child-saved'), unused = await f.upload('unused-with-artifacts');
    const projectSessions = path.dirname(f.session.path), stem = path.basename(f.session.path, '.jsonl');
    const artifacts = path.join(projectSessions, 'subagent-artifacts', 'outputs', 'fixture-run');
    fs.mkdirSync(artifacts, { recursive: true });
    // An ID in an arbitrary report body is not a saved native reference.
    fs.writeFileSync(path.join(artifacts, 'report.md'), '# Report\n' + unused.marker);
    fs.writeFileSync(path.join(artifacts, 'runner.log'), 'ordinary runner diagnostic');
    fs.writeFileSync(path.join(artifacts, 'image.png'), Buffer.from([137, 80, 78, 71, 0, 255]));
    fs.writeFileSync(path.join(artifacts, 'events.jsonl'), '{"type":"subagent.run.process_terminal","runId":"fixture-run"}\n');
    fs.writeFileSync(path.join(artifacts, 'fixture_meta.json'), '{"state":"completed"}');
    const { SessionManager } = await getSdk(), childDirectory = path.join(projectSessions, stem, 'fixture-run', 'run-0');
    fs.mkdirSync(childDirectory, { recursive: true });
    const child = SessionManager.open(path.join(childDirectory, 'session.jsonl'), undefined, f.cwd);
    child.appendMessage({ role: 'user', content: childDocument.marker, timestamp: 1 });
    const usage = await f.storage.usage({ cwd: f.cwd }); assert.equal(usage.complete, true);
    assert.equal(usage.items.find(item => item.id === childDocument.reference.id).savedReference, 'protected');
    assert.equal(usage.items.find(item => item.id === unused.reference.id).savedReference, 'not-found');
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: childDocument.reference.id }), { code: 'DOCUMENT_PROTECTED' });
    let preview = await f.storage.preview({ cwd: f.cwd, id: unused.reference.id });
    f.state.hook = async () => fs.appendFileSync(path.join(artifacts, 'report.md'), '\nchanged output');
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'DOCUMENT_STORAGE_CHANGED' });
    f.state.hook = null;
    preview = await f.storage.preview({ cwd: f.cwd, id: unused.reference.id });
    const deleted = await f.storage.cleanup(cleanupInput(f.cwd, preview)); assert.equal(deleted.state, 'deleted');
    assert.deepEqual(await f.service.bytes(await f.service.object(childDocument.reference.id)), bytes);
    assert.equal(fs.existsSync(path.join(artifacts, 'report.md')), true);
    // Every nested JSONL candidate is still validated; best-effort SDK omission
    // must not turn a damaged native child into an apparent absence of refs.
    const malformed = path.join(childDirectory, 'bad-child.jsonl');
    fs.writeFileSync(malformed, '{"type":"message","message":{"role":"user","content":"unknown native shape"}}\n');
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: childDocument.reference.id }), { code: 'DOCUMENT_SCAN_INCOMPLETE' });
    fs.unlinkSync(malformed);
    const artifactNative = path.join(artifacts, 'session.jsonl');
    fs.renameSync(child.getSessionFile(), artifactNative);
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: childDocument.reference.id }), { code: 'DOCUMENT_PROTECTED' });
    fs.writeFileSync(artifactNative, '{"type":"session"}\n');
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id: childDocument.reference.id }), { code: 'DOCUMENT_SCAN_INCOMPLETE' });
    fs.unlinkSync(artifactNative);
    fs.writeFileSync(malformed, '{"type":"session","id":"damaged-child"}\n{"type":"message",broken}\n');
    assert.equal((await f.storage.usage({ cwd: f.cwd })).complete, false);
});

test('missing/incomplete providers disable cleanup, and a competing mutation invalidates awaited proof', async t => {
    const f = await fixture(t), uploaded = await f.upload('race'), id = uploaded.reference.id;
    f.state.complete = false;
    assert.equal((await f.storage.usage({ cwd: f.cwd })).complete, false);
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_SCAN_INCOMPLETE' });
    f.state.complete = true;
    const preview = await f.storage.preview({ cwd: f.cwd, id });
    f.state.hook = async () => { await new Promise(r => setImmediate(r)); f.state.revoked = true; };
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'GUARD_CHANGED' }); assert.equal(f.state.leased, false);
    f.state.revoked = false; f.state.hook = null;
    f.state.ids = [id]; f.state.revision = '2';
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'DOCUMENT_STORAGE_CHANGED' });
    const noGuard = new DocumentUploads({ store: f.store, supervisor: f.service.supervisor });
    try { assert.equal((await noGuard.storage.usage({ cwd: f.cwd })).complete, false); await assert.rejects(noGuard.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_SCAN_INCOMPLETE' }); }
    finally { await noGuard.dispose(); }
    assert.ok(await f.service.object(id));
});

test('activity reservations and shutdown exclude cleanup throughout async scans', async t => {
    const f = await fixture(t), uploaded = await f.upload('active'), id = uploaded.reference.id;
    const leave = f.service.reserve();
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_BUSY' }); leave();
    let entered, release; const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
    f.state.hook = async () => { entered(); await gate; };
    const previewing = f.storage.preview({ cwd: f.cwd, id }); await ready;
    assert.equal(f.service.active, 1); assert.throws(() => f.service.reserve(), { code: 'DOCUMENT_BUSY' });
    await assert.rejects(f.upload('blocked'), { code: 'DOCUMENT_BUSY' });
    let disposed = false; const stop = f.service.dispose().then(() => disposed = true);
    assert.equal(disposed, false); release(); await previewing; await stop; assert.equal(disposed, true);
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_BUSY' });
});

test('native file growth, original replacement, symlinks, malformed history and scan budgets fail closed', async t => {
    const f = await fixture(t), uploaded = await f.upload('changed'), id = uploaded.reference.id;
    const preview = await f.storage.preview({ cwd: f.cwd, id });
    const { SessionManager } = await getSdk(); SessionManager.open(f.session.path).appendMessage({ role: 'user', content: uploaded.marker, timestamp: 1 });
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'DOCUMENT_STORAGE_CHANGED' });
    const object = await f.service.object(id), original = path.join(object.folder, 'original');
    fs.renameSync(original, original + '.saved'); fs.symlinkSync(original + '.saved', original);
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_STORAGE_CHANGED' });
    fs.unlinkSync(original); fs.renameSync(original + '.saved', original);
    fs.appendFileSync(f.session.path, '{"broken":true,}\n');
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_SCAN_INCOMPLETE' });
    f.storage.scanMaxBytes = 1;
    assert.equal((await f.storage.usage({ cwd: f.cwd })).complete, false);
    assert.equal((await f.storage.usage({ cwd: f.cwd })).items[0].savedReference, 'unverified');
});

test('exact file/directory identity is rechecked after asynchronous provider work', async t => {
    const f = await fixture(t), uploaded = await f.upload('identity'), id = uploaded.reference.id;
    let preview = await f.storage.preview({ cwd: f.cwd, id });
    const object = await f.service.object(id), original = path.join(object.folder, 'original'), held = path.join(f.base, 'held-original');
    f.state.hook = async () => { fs.renameSync(original, held); fs.writeFileSync(original, bytes); };
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'DOCUMENT_STORAGE_CHANGED' });
    f.state.hook = null; fs.unlinkSync(original); fs.renameSync(held, original);
    preview = await f.storage.preview({ cwd: f.cwd, id });
    const receiptDirectory = path.join(await f.service.root(), '.storage-receipts'), heldDirectory = path.join(f.base, 'held-receipts');
    f.state.hook = async () => { fs.renameSync(receiptDirectory, heldDirectory); fs.symlinkSync(heldDirectory, receiptDirectory, 'dir'); };
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'DOCUMENT_STORAGE_CHANGED' });
    f.state.hook = null; fs.unlinkSync(receiptDirectory); fs.renameSync(heldDirectory, receiptDirectory);
    preview = await f.storage.preview({ cwd: f.cwd, id });
    const { SessionManager } = await getSdk();
    f.state.hook = async () => { SessionManager.open(f.session.path).appendMessage({ role: 'user', content: uploaded.marker, timestamp: 1 }); };
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'DOCUMENT_STORAGE_CHANGED' });
    assert.deepEqual(await f.service.bytes(await f.service.object(id)), bytes);
});

test('an interrupted deletion persists uncertain intent and cannot replay or revive its upload ID', async t => {
    const f = await fixture(t), uploaded = await f.upload('partial'), id = uploaded.reference.id;
    const preview = await f.storage.preview({ cwd: f.cwd, id }), object = await f.service.object(id), originalUnlink = fs.unlinkSync;
    fs.unlinkSync = function(file) { if (file === path.join(object.folder, 'manifest.json')) throw Object.assign(new Error('Synthetic unlink failure'), { code: 'EIO' }); return originalUnlink(file); };
    try { await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview)), { code: 'EIO' }); }
    finally { fs.unlinkSync = originalUnlink; }
    const receipt = await f.storage.status({ cwd: f.cwd, requestId: 'cleanup' }); assert.equal(receipt.state, 'uncertain');
    assert.equal(fs.existsSync(path.join(object.folder, 'original')), false); assert.equal(fs.existsSync(path.join(object.folder, 'manifest.json')), true);
    assert.deepEqual(await f.storage.cleanup(cleanupInput(f.cwd, preview)), receipt);
    assert.equal(fs.existsSync(path.join(object.folder, 'manifest.json')), true);
    await assert.rejects(f.storage.cleanup(cleanupInput(f.cwd, preview, { requestId: 'retry-new-id' })), { code: 'DOCUMENT_STORAGE_CHANGED' });
    await assert.rejects(f.upload('partial'), { code: 'DOCUMENT_DELETED' });
});

test('streamed reference proof accepts over-64MiB images and decodes escaped/chunk-boundary IDs', async t => {
    const f = await fixture(t), uploaded = await f.upload('long'), id = uploaded.reference.id;
    const fd = fs.openSync(f.session.path, 'a');
    try {
        fs.writeSync(fd, '{"type":"message","message":{"role":"user","content":[{"type":"image","data":"');
        const chunk = 'Z'.repeat(1024 * 1024); for (let i = 0; i < 65; i++) fs.writeSync(fd, chunk);
        const escaped = [...id].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
        fs.writeSync(fd, '"},{"type":"text","text":"' + escaped + '"}]}}\n');
    } finally { fs.closeSync(fd); }
    const result = await scanReferences(f.agent, new Set([id])); assert.equal(result.found.has(id), true);
    await assert.rejects(f.storage.preview({ cwd: f.cwd, id }), { code: 'DOCUMENT_PROTECTED' });
    fs.appendFileSync(f.session.path, '{"type":"custom","data":{"id":"' + id + '"}}\n');
    assert.equal((await scanReferences(f.agent, new Set([id]))).found.has(id), true);
});

test('per-thread quota rejects excess bytes and one confirmed cleanup releases the same quota', async t => {
    const pool = { jobs: new Set(), run: async () => ({}), dispose: async () => {} };
    const f = await fixture(t, { pool });
    const large = Buffer.alloc(20 * 1024 ** 2); bytes.copy(large);
    let first;
    const upload = requestId => f.service.upload({ cwd: f.cwd, sessionId: f.session.id, name: 'large.docx', requestId }, large);
    for (let i = 0; i < 12; i++) { const item = await upload('quota-' + i); first ||= item.reference.id; }
    await assert.rejects(upload('quota-excess'), { code: 'DOCUMENT_STORAGE' });
    const preview = await f.storage.preview({ cwd: f.cwd, id: first });
    await f.storage.cleanup(cleanupInput(f.cwd, preview));
    await upload('quota-excess');
    const usage = await f.storage.usage({ cwd: f.cwd }); assert.equal(usage.count, 12); assert.equal(usage.totalBytes, 240 * 1024 ** 2);
});

test('instance byte/item limits reject even incomplete stored objects without discarding them', async t => {
    const f = await fixture(t), storageRoot = await f.service.root(true);
    const { createHash } = require('node:crypto'), { atomicJson } = require('../server/pi-maintenance-files');
    for (let i = 0; i < 102; i++) {
        const id = createHash('sha256').update('quota-fixture-' + i).digest('hex'), folder = path.join(storageRoot, id); fs.mkdirSync(folder);
        atomicJson(path.join(folder, 'manifest.json'), { version: 1, cwd: f.cwd, sessionId: 'other-thread-' + i, requestId: 'fixture', reference: { id, revision: 'a'.repeat(64), name: 'fixture.docx', format: 'docx', size: 20 * 1024 ** 2 } });
    }
    const large = Buffer.alloc(20 * 1024 ** 2); bytes.copy(large);
    f.service.pool.run = async () => ({});
    await assert.rejects(f.service.upload({ cwd: f.cwd, sessionId: f.session.id, name: 'over-instance.docx', requestId: 'over-instance' }, large), { code: 'DOCUMENT_STORAGE' });
    for (let i = 102; i < 10000; i++) fs.mkdirSync(path.join(storageRoot, i.toString(16).padStart(64, '0')));
    await assert.rejects(f.upload('over-count'), { code: 'DOCUMENT_STORAGE' });
    assert.equal(fs.readdirSync(storageRoot).length, 10000);
});

test('isolated authenticated HTTP exposes authorized-project detail, global totals and one-shot deletion status', async t => {
    const f = await fixture(t), uploaded = await f.upload('http'), id = uploaded.reference.id;
    const otherCwd = path.join(f.base, 'other'); fs.mkdirSync(otherCwd);
    const other = await f.store.createSession(otherCwd, 'Other'); await f.service.upload({ cwd: otherCwd, sessionId: other.id, requestId: 'other', name: 'secret-name.docx' }, bytes);
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService({ filePath: path.join(f.agent, 'access.json'), envToken: () => 'synthetic-storage-token' });
    const app = express(); access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware()); mountDocumentUploads(router, f.service); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const post = (endpoint, body, authorized = true) => fetch(origin + '/api/pi/uploads/storage/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer synthetic-storage-token' } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('usage', { cwd: f.cwd }, false)).status, 401);
    const usage = await (await post('usage', { cwd: f.cwd })).json(); assert.equal(usage.totalBytes, 2 * bytes.length); assert.equal(usage.items.length, 1); assert.ok(!JSON.stringify(usage).includes('secret-name'));
    assert.equal((await post('preview', { cwd: f.cwd, id: (await f.storage.usage({ cwd: otherCwd })).items[0].id })).status, 403);
    const preview = await (await post('preview', { cwd: f.cwd, id })).json();
    const response = await post('cleanup', cleanupInput(f.cwd, preview)); assert.equal(response.status, 200); assert.equal((await response.json()).state, 'deleted');
    const status = await fetch(origin + '/api/pi/uploads/storage/status?' + new URLSearchParams({ cwd: f.cwd, requestId: 'cleanup' }), { headers: { Authorization: 'Bearer synthetic-storage-token' } });
    assert.equal(status.status, 200); assert.equal((await status.json()).state, 'deleted'); assert.equal(status.headers.get('cache-control'), 'no-store');
});
