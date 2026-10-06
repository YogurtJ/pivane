const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-documents-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { DocumentUploads, mountDocumentUploads, MAX_BYTES } = require('../server/pi-document-uploads');
const refs = require('../public/pi-document-references');
const attachments = require('../public/pi-attachments');
const { zip, docxFiles } = require('./document-fixtures.cjs');
const store = new PiSessionStore();
const supervisor = { removing: new Set(), moving: new Set(), getActiveWorker: () => null };
const service = new DocumentUploads({ store, supervisor });
const bytes = zip(docxFiles());
test.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

test('uploads preserve exact bytes and private permissions with idempotent request identity and branch-scoped reads', async () => {
    const session = await store.createSession(cwd, 'Office'), input = { cwd, sessionId: session.id, requestId: 'original', name: '合同 & "样本".docx' };
    const upload = await service.upload(input, bytes); assert.equal(upload.reference.size, bytes.length);
    const object = await service.object(upload.reference.id); assert.deepEqual(await service.bytes(object), bytes);
    assert.equal((await service.upload(input, bytes)).reused, true);
    await assert.rejects(service.upload({ ...input, name: 'different.docx' }, bytes), { code: 'DOCUMENT_CONFLICT' });
    require('./private-file-helper.cjs').assertPrivateFile(path.join(object.folder, 'original'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(object.folder).mode & 0o777, 0o700);
    const { SessionManager } = await getSdk(), manager = SessionManager.open(session.path);
    const prior = manager.appendMessage({ role: 'user', content: 'Earlier', timestamp: 1 });
    await assert.rejects(service.authorized({ cwd, sessionId: session.id, id: upload.reference.id }), { code: 'DOCUMENT_SCOPE' });
    assert.deepEqual((await service.authorized({ cwd, sessionId: session.id, id: upload.reference.id }, { draft: true })).bytes, bytes);
    const attached = manager.appendMessage({ role: 'user', content: 'Summarize\n' + upload.marker, timestamp: 2 });
    assert.deepEqual((await service.authorized({ cwd, sessionId: session.id, id: upload.reference.id })).bytes, bytes);
    const reply = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Complete' }], timestamp: 3, stopReason: 'stop', api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const snapshot = { entries: manager.getEntries(), leafId: manager.getLeafId() }, fork = (await store.forkSession(session, snapshot, reply, 'at')).session;
    assert.deepEqual((await service.authorized({ cwd, sessionId: fork.id, id: upload.reference.id })).bytes, bytes);
    const kept = manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 3 }); manager.appendCompaction('Summary', kept, 1000);
    assert.equal((await service.branch({ cwd, sessionId: session.id })).references.length, 1);
    manager.branch(prior); manager.appendMessage({ role: 'user', content: 'Other branch', timestamp: 4 });
    await assert.rejects(service.authorized({ cwd, sessionId: session.id, id: upload.reference.id }), { code: 'DOCUMENT_SCOPE' });
    fs.writeFileSync(path.join(object.folder, 'original'), 'tampered');
    await assert.rejects(service.authorized({ cwd, sessionId: fork.id, id: upload.reference.id }), { code: 'DOCUMENT_CHANGED' });
});

test('raw HTTP uploads require access and same Origin; only bound workers may invoke parser', async t => {
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'http-access.json'), envToken: () => 'synthetic-document-access' });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); const router = express.Router(); router.use(access.middleware()); mountDocumentUploads(router, service); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const session = await store.createSession(cwd, 'HTTP'), query = new URLSearchParams({ cwd, sessionId: session.id, requestId: 'http', name: 'sample.docx' });
    const headers = { Authorization: 'Bearer synthetic-document-access', 'Content-Type': 'application/octet-stream' };
    assert.equal((await fetch(`${origin}/api/pi/uploads?${query}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })).status, 401);
    assert.equal((await fetch(`${origin}/api/pi/uploads?${query}`, { method: 'POST', body: bytes, headers: { ...headers, Origin: 'https://invalid.example' } })).status, 403);
    const response = await fetch(`${origin}/api/pi/uploads?${query}`, { method: 'POST', body: bytes, headers }); assert.equal(response.status, 200); const uploaded = await response.json();
    const statusQuery = new URLSearchParams({ cwd, sessionId: session.id, requestId: 'http' });
    const status = await (await fetch(`${origin}/api/pi/uploads/status?${statusQuery}`, { headers })).json(); assert.deepEqual(status.reference, uploaded.reference);
    const downloadQuery = new URLSearchParams({ cwd, sessionId: session.id, id: uploaded.reference.id });
    const download = await fetch(`${origin}/api/pi/uploads?${downloadQuery}`, { headers }); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(`${origin}/api/pi/uploads/read`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: uploaded.reference.id }) })).status, 403);
    const other = await store.createSession(cwd, 'Other'); downloadQuery.set('sessionId', other.id);
    assert.equal((await fetch(`${origin}/api/pi/uploads?${downloadQuery}`, { headers })).status, 403);
    const leave1 = service.reserve(), leave2 = service.reserve();
    try { assert.equal((await fetch(`${origin}/api/pi/uploads?${query}`, { method: 'POST', body: bytes, headers })).status, 429); } finally { leave1(); leave2(); }
});

test('browser payload carries only validated metadata and enforces document and format limits', async () => {
    const reference = { id: 'a'.repeat(64), revision: 'b'.repeat(64), name: 'report.docx', format: 'docx', size: bytes.length };
    const file = new File([bytes], reference.name), document = await attachments.read(file, { upload: async () => ({ reference }) });
    assert.equal(document.kind, 'document'); assert.equal(document.data, undefined); assert.equal(document.text, undefined);
    const payload = attachments.payload('Summarize', [document]); assert.equal(payload.images.length, 0); assert.match(payload.message, /pivane_document/); assert.ok(!payload.message.includes('合同'));
    assert.throws(() => attachments.validateDraft('', Array(6).fill(document)), /5 个/);
    await assert.rejects(attachments.read({ name: 'large.xlsx', size: MAX_BYTES + 1, type: '' }, { upload: () => { throw new Error('must not upload'); } }), /20 MiB/);
    assert.throws(() => attachments.classify({ name: 'old.xls', type: '' }), /另存/);
    assert.deepEqual(refs.references([{ type: 'message', message: { role: 'assistant', content: refs.marker(reference) } }]), []);
    assert.equal(refs.split(refs.marker({ ...reference, name: '"<&样本.docx' }))[0].reference.name, '"<&样本.docx');
});

test('worker document reads retain lifecycle occupancy through asynchronous parsing and refuse stale branch results', async () => {
    const session = await store.createSession(cwd, 'Read race'), input = { cwd, sessionId: session.id, requestId: 'race', name: 'race.docx' }, uploaded = await service.upload(input, bytes);
    let attached = true, entered, release;
    const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
    const worker = { cwd, sessionId: session.id, disposed: false, restarting: false, request: async () => ({ entries: attached ? [{ id: 'u1', type: 'message', message: { role: 'user', content: uploaded.marker } }] : [], leafId: attached ? 'u1' : null }) };
    const supervisor = { removing: new Set(), moving: new Set(), getActiveWorker: () => worker }, pool = { jobs: new Set(), run: async () => { entered(); await gate; return { total: 3 }; }, dispose: async () => {} };
    const race = new DocumentUploads({ store, supervisor, pool });
    const reading = race.read(worker, { id: uploaded.reference.id }); await ready; assert.equal(worker.documentReads, 1); attached = false; release();
    await assert.rejects(reading, { code: 'DOCUMENT_CONTEXT' }); assert.equal(worker.documentReads, 0); await race.dispose();
    const releaseSlot = service.reserve(), stopping = service.dispose(); assert.equal(service.closed, true); assert.throws(() => service.reserve(), /维护/); releaseSlot(); await stopping;
});
