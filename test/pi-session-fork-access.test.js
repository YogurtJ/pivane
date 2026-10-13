const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-fork-access-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'fork-access-fixture';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { PiSessionMoves } = require('../server/pi-session-moves');
const { PiUsageService } = require('../server/pi-usage-service');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const { DeliverableStore, DeliverableService, ENTRY } = require('../server/pi-deliverables');
const { DocumentUploads } = require('../server/pi-document-uploads');
const { readForkAccess, ENTRY: ACCESS_ENTRY } = require('../server/pi-session-fork-access');
const { hash } = require('../server/pi-maintenance-files');
const { zip, docxFiles } = require('./document-fixtures.cjs');
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }], timestamp: 2, stopReason: 'stop',
    provider: 'fixture', model: 'fixture', api: 'openai-completions', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
async function fixture(t) {
    const folder = path.join(root, randomUUID()), source = path.join(folder, 'source'), target = path.join(folder, 'target');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target);
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor(), usage = new PiUsageService(store);
    const preferences = new WorkspacePreferencesService({ filePath: path.join(folder, 'preferences.json') });
    const moves = new PiSessionMoves({ store, supervisor, usage, preferences, deferred: { list: () => [] }, cron: { db: { homes: () => [], jobs: () => [] } } });
    t.after(async () => { await moves.dispose(); await supervisor.dispose(); await usage.dispose(); });
    const { SessionManager } = await getSdk();
    const fork = async (session, entryId, position) => {
        const manager = SessionManager.open(session.path);
        return store.forkSession(session, { entries: manager.getEntries(), leafId: manager.getLeafId() }, entryId, position);
    };
    const move = async (session, cwd) => {
        const preview = await moves.preview(session.cwd, session.id, cwd); assert.equal(preview.canMove, true, JSON.stringify(preview.blockers));
        return (await moves.move(session.cwd, session.id, { cwd: session.cwd, targetCwd: cwd, expectedRevision: preview.revision, requestId: 'test-' + randomUUID() })).session;
    };
    return { folder, source, target, store, supervisor, moves, fork, move, SessionManager };
}

test('moved deliveries survive Web forks, nested copies, parent removal, restart and another move without granting later foreign refs', async t => {
    const f = await fixture(t), original = await f.store.createSession(f.source, 'Original');
    const manager = f.SessionManager.open(original.path);
    const question = manager.appendMessage({ role: 'user', content: 'PRIVATE QUESTION NOT STORED IN RECEIPT', timestamp: 1 });
    manager.appendMessage(assistant);
    fs.writeFileSync(path.join(f.source, 'snapshot.txt'), 'Immutable delivery');
    const objects = new DeliverableStore(f.store);
    const receipt = await objects.publish({ cwd: f.source, sessionId: original.id }, { requestId: 'original', title: 'Snapshot', files: ['snapshot.txt'] });
    manager.appendCustomEntry(ENTRY, receipt.reference);
    const hidden = await objects.publish({ cwd: f.source, sessionId: original.id }, { requestId: 'not-in-branch', title: 'Hidden', files: ['snapshot.txt'] });
    const moved = await f.move(original, f.target), originalBytes = fs.readFileSync(moved.path);
    const copy = (await f.fork(moved)).session;
    assert.deepEqual(fs.readFileSync(moved.path), originalBytes, 'fork never writes the source');
    const service = () => new DeliverableService({ store: f.store, supervisor: f.supervisor });
    const read = session => service().request({ cwd: session.cwd, sessionId: session.id, id: receipt.reference.id, index: '0' });
    assert.equal((await read(copy)).content, 'Immutable delivery');
    assert.equal((await service().request({ cwd: copy.cwd, sessionId: copy.id })).items[0].id, receipt.reference.id);
    assert.equal((await service().request({ cwd: copy.cwd, sessionId: copy.id, path: path.join(f.source, 'snapshot.txt') })).items[0].id, receipt.reference.id);
    const accessFile = path.join(process.env.PI_CODING_AGENT_DIR, 'pivane-session-moves', 'forks', hash(copy.id) + '.json');
    require('./private-file-helper.cjs').assertPrivateFile(accessFile);
    assert.ok(!fs.readFileSync(accessFile, 'utf8').includes('PRIVATE QUESTION'));
    const early = (await f.fork(copy, question, 'before')).session;
    await assert.rejects(read(early), { code: 'DELIVERY_SCOPE' });
    const nested = (await f.fork(copy)).session;
    fs.unlinkSync(moved.path); fs.unlinkSync(copy.path);
    assert.equal((await read(nested)).content, 'Immutable delivery', 'no parent file is needed');
    const nestedReceipt = path.join(path.dirname(accessFile), hash(nested.id) + '.json'), backup = path.join(f.folder, 'fork-backup');
    const { backupRoots, copySafe } = require('../server/pi-maintenance-files');
    backupRoots([nested.path, nestedReceipt], backup);
    const saved = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    fs.unlinkSync(nested.path); fs.unlinkSync(nestedReceipt);
    const budget = { bytes: 0, files: 0, maxBytes: 64 * 1024 * 1024, maxFiles: 2 };
    for (const entry of saved.entries) {
        const restored = copySafe(path.join(backup, 'files', entry.object), entry.path, budget);
        assert.equal(restored.sha256, entry.sha256);
    }
    assert.equal((await read(nested)).content, 'Immutable delivery', 'native history and receipt restore at their original paths');
    const restartedStore = new PiSessionStore();
    new PiSessionMoves({ ...f.moves, store: restartedStore });
    assert.equal((await new DeliverableService({ store: restartedStore, supervisor: f.supervisor }).request({ cwd: nested.cwd, sessionId: nested.id, id: receipt.reference.id, index: '0' })).content, 'Immutable delivery');
    const nextProject = path.join(f.folder, 'next'); fs.mkdirSync(nextProject);
    const again = await f.move(nested, nextProject);
    fs.rmdirSync(f.target);
    assert.equal((await read(again)).content, 'Immutable delivery', 'the old project directory may also disappear');
    f.SessionManager.open(again.path).appendCustomEntry(ENTRY, hidden.reference);
    const final = (await f.fork(again)).session;
    assert.equal((await read(final)).content, 'Immutable delivery');
    await assert.rejects(service().request({ cwd: final.cwd, sessionId: final.id, id: hidden.reference.id, index: '0' }), { code: 'DELIVERY_SCOPE' });
});

test('forked office drafts download before sending but do not become model-readable; exact refs survive source deletion and cannot bind an import', async t => {
    const f = await fixture(t), service = new DocumentUploads({ store: f.store, supervisor: f.supervisor });
    t.after(() => service.dispose());
    const session = await f.store.createSession(f.source, 'Documents');
    const upload = await service.upload({ cwd: f.source, sessionId: session.id, requestId: 'original', name: 'sample.docx' }, zip(docxFiles()));
    const other = await service.upload({ cwd: f.source, sessionId: session.id, requestId: 'other', name: 'other.docx' }, zip(docxFiles()));
    const manager = f.SessionManager.open(session.path);
    const question = manager.appendMessage({ role: 'user', content: 'Read this\n' + upload.marker, timestamp: 1 }); manager.appendMessage(assistant);
    const fork = await f.fork(session, question, 'before');
    const input = { cwd: f.source, sessionId: fork.session.id, id: upload.reference.id };
    const before = await service.authorized(input, { draft: true });
    assert.equal(before.reference.id, upload.reference.id); await service.checkCurrent(input, before);
    assert.equal((await service.branch(input)).references.length, 0, 'draft proof is not a model reference');
    await assert.rejects(service.authorized(input), { code: 'DOCUMENT_SCOPE' });
    await assert.rejects(service.authorized({ ...input, id: other.reference.id }, { draft: true }), { code: 'DOCUMENT_SCOPE' });
    const cloneOfEmpty = (await f.fork(fork.session)).session;
    await assert.rejects(service.authorized({ ...input, sessionId: cloneOfEmpty.id }, { draft: true }), { code: 'DOCUMENT_SCOPE' });
    const imported = await f.store.createSession(f.source, 'Copied metadata');
    const accessEntry = f.SessionManager.open(fork.session.path).getEntries().find(entry => entry.customType === ACCESS_ENTRY);
    f.SessionManager.open(imported.path).appendCustomEntry(ACCESS_ENTRY, { ...accessEntry.data, sessionId: imported.id });
    await assert.rejects(service.authorized({ ...input, sessionId: imported.id }, { draft: true }), { code: 'DOCUMENT_SCOPE' });
    fs.unlinkSync(session.path);
    assert.equal((await service.authorized(input, { draft: true })).reference.id, upload.reference.id);
    const child = f.SessionManager.open(fork.session.path);
    child.appendMessage({ role: 'user', content: fork.draft.message, timestamp: 3 }); child.appendMessage(assistant);
    assert.equal((await service.authorized(input)).reference.id, upload.reference.id);
});

test('altered native prefixes, marker revisions, private receipts and unrecorded relocation invalidate fork access', async t => {
    const f = await fixture(t), service = new DocumentUploads({ store: f.store, supervisor: f.supervisor }); t.after(() => service.dispose());
    const session = await f.store.createSession(f.source, 'Proof checks');
    const upload = await service.upload({ cwd: f.source, sessionId: session.id, requestId: 'doc', name: 'sample.docx' }, zip(docxFiles()));
    const manager = f.SessionManager.open(session.path);
    const q = manager.appendMessage({ role: 'user', content: upload.marker, timestamp: 1 }); manager.appendMessage(assistant);
    const child = (await f.fork(session, q, 'before')).session;
    const native = fs.readFileSync(child.path), access = await readForkAccess(f.store, child);
    const receiptFile = path.join(process.env.PI_CODING_AGENT_DIR, 'pivane-session-moves', 'forks', hash(child.id) + '.json');
    const receipt = fs.readFileSync(receiptFile);
    fs.writeFileSync(child.path, native.toString().replace(access.revision, '0'.repeat(64)));
    await assert.rejects(readForkAccess(f.store, child), { code: 'FORK_ACCESS_CHANGED' }); fs.writeFileSync(child.path, native);
    fs.writeFileSync(receiptFile, receipt.toString().replace('sample.docx', 'forged.docx'));
    await assert.rejects(readForkAccess(f.store, child), { code: 'FORK_ACCESS_CHANGED' }); fs.writeFileSync(receiptFile, receipt);
    // Same header identity with a changed native prefix is not the original grant.
    fs.writeFileSync(child.path, native.toString().replace('pivane-web-fork-origin', 'pivane-web-fork-forged'));
    await assert.rejects(readForkAccess(f.store, child), { code: 'FORK_ACCESS_CHANGED' }); fs.writeFileSync(child.path, native);
    const otherPath = path.join(path.dirname(child.path), 'unrecorded.jsonl'); fs.copyFileSync(child.path, otherPath);
    await assert.rejects(readForkAccess({ ...f.store, sessionMoves: null }, { ...child, path: otherPath }), { code: 'FORK_ACCESS_CHANGED' });
    fs.unlinkSync(otherPath);
    const authorized = await service.authorized({ cwd: child.cwd, sessionId: child.id, id: upload.reference.id }, { draft: true });
    fs.unlinkSync(receiptFile);
    await assert.rejects(service.checkCurrent({ cwd: child.cwd, sessionId: child.id, id: upload.reference.id }, authorized), { code: 'DOCUMENT_CONTEXT' });
});

test('fork preparation rejects a changed source before publishing a new session', async t => {
    const f = await fixture(t), source = await f.store.createSession(f.source, 'Changing source');
    const manager = f.SessionManager.open(source.path);
    manager.appendMessage({ role: 'user', content: 'Source', timestamp: 1 }); manager.appendMessage(assistant);
    fs.writeFileSync(path.join(f.source, 'result.txt'), 'snapshot');
    const published = await new DeliverableStore(f.store).publish({ cwd: f.source, sessionId: source.id }, { requestId: 'race', title: 'Race', files: ['result.txt'] });
    manager.appendCustomEntry(ENTRY, published.reference);
    const moved = await f.move(source, f.target), count = (await f.store.listSessions(f.target)).length;
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const original = f.moves.deliveryProof.bind(f.moves);
    f.moves.deliveryProof = async session => { const proof = await original(session); entered(); await gate; return proof; };
    const pending = f.fork(moved);
    const rejected = assert.rejects(pending, /会话已变化/);
    await started;
    f.SessionManager.open(moved.path).appendCustomEntry('fixture-concurrent-write', { preserved: true });
    release(); await rejected;
    assert.equal((await f.store.listSessions(f.target)).length, count);
    assert.ok(f.SessionManager.open(moved.path).getEntries().some(entry => entry.customType === 'fixture-concurrent-write'));
});

test('real HTTP/RPC forks retain moved deliveries and permit document draft downloads without exposing them to the model before send', { timeout: 90000 }, async t => {
    let calls = 0;
    const provider = http.createServer(async (req, res) => {
        for await (const _ of req) {} calls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const delta of [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic reply' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }])
            res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...delta })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
        models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000, reasoning: false }]
    } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes'), gateway = createPiAgentGateway();
    const express = require('express'), app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`, headers = { Authorization: 'Bearer fork-access-fixture', 'Content-Type': 'application/json' };
    const api = async (url, body) => { const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json(); };
    const source = path.join(root, 'http-source'), target = path.join(root, 'http-target'); fs.mkdirSync(source); fs.mkdirSync(target);
    const original = await gateway.store.createSession(source, 'HTTP fork'), { SessionManager } = await getSdk();
    const bytes = zip(docxFiles());
    const uploadedResponse = await fetch(base + '/uploads?' + new URLSearchParams({ cwd: source, sessionId: original.id, requestId: 'http-doc', name: 'sample.docx' }),
        { method: 'POST', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' }, body: bytes });
    assert.equal(uploadedResponse.status, 200); const uploaded = await uploadedResponse.json();
    const manager = SessionManager.open(original.path); manager.appendModelChange('fixture', 'fixture');
    const question = manager.appendMessage({ role: 'user', content: 'Read this\n' + uploaded.marker, timestamp: 1 }); manager.appendMessage(assistant);
    fs.writeFileSync(path.join(source, 'snapshot.txt'), 'HTTP immutable snapshot');
    const delivered = await new DeliverableStore(gateway.store).publish({ cwd: source, sessionId: original.id }, { requestId: 'http-delivery', title: 'HTTP', files: ['snapshot.txt'] });
    manager.appendCustomEntry(ENTRY, delivered.reference);
    const preview = await api(`/sessions/${original.id}/move?` + new URLSearchParams({ cwd: source, targetCwd: target })); assert.equal(preview.canMove, true);
    const moved = (await api(`/sessions/${original.id}/move`, { cwd: source, targetCwd: target, expectedRevision: preview.revision, requestId: 'http-' + randomUUID() })).session;
    const snapshot = await api(`/sessions/${moved.id}/workflow?` + new URLSearchParams({ cwd: target }));
    const clone = await api(`/sessions/${moved.id}/fork`, { cwd: target, expectedLeafId: snapshot.leafId });
    assert.equal((await api('/deliverables?' + new URLSearchParams({ cwd: target, sessionId: clone.session.id, id: delivered.reference.id, index: '0' }))).content, 'HTTP immutable snapshot');
    const fork = await api(`/sessions/${moved.id}/fork`, { cwd: target, expectedLeafId: snapshot.leafId, entryId: question });
    const query = new URLSearchParams({ cwd: target, sessionId: fork.session.id, id: uploaded.reference.id });
    const download = await fetch(base + '/uploads?' + query, { headers }); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const worker = await gateway.supervisor.getWorker({ cwd: target, sessionId: fork.session.id, sessionPath: fork.session.path });
    await assert.rejects(gateway.documents.read(worker, { id: uploaded.reference.id, action: 'inspect' }), { code: 'DOCUMENT_SCOPE' });
    assert.equal(calls, 0, 'forking and downloading do not generate');
    await worker.request('prompt', fork.draft);
    const deadline = Date.now() + 10000;
    while ((await worker.request('get_state')).isStreaming) { if (Date.now() > deadline) throw new Error('Synthetic prompt did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(calls, 1);
    assert.equal((await gateway.documents.read(worker, { id: uploaded.reference.id, action: 'inspect' })).reference.id, uploaded.reference.id);
    assert.equal([...gateway.supervisor.workers.values()].filter(item => item.sessionPath === fork.session.path).length, 1);
});

// Native JSONL fixtures are written in chunks so test setup itself never builds
// a growing suffix as a single string. The native manager still owns fork creation.
function appendLargeNativeMessage(session, megabytes, parentId) {
    const fd = fs.openSync(session.path, 'a'), chunk = Buffer.alloc(256 * 1024, 120);
    try {
        // Native discovery builds lines; retain realistic bounded records in
        // end-to-end tests. The helper suite separately stresses one giant line.
        for (let index = 0; index < megabytes * 4; index++) {
            const id = randomUUID();
            fs.writeSync(fd, JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString() }).slice(0, -1) + ',"message":{"role":"user","content":"');
            fs.writeSync(fd, chunk);
            fs.writeSync(fd, '","timestamp":1}}\n');
            parentId = id;
        }
    } finally { fs.closeSync(fd); }
    return parentId;
}

// This is the original v1 publisher's byte/marker algorithm, using the original
// bounded decoder and the real native manager. It exercises actual old-format
// empty, reopened and conversational files rather than rewriting a v2 marker.
function publishV1(manager, source, document) {
    const { readSafe, privateDir } = require('../server/pi-maintenance-files');
    const { decodeSession } = require('../server/pi-session-relocation');
    const target = { id: manager.getSessionId(), cwd: manager.getCwd(), path: fs.realpathSync.native(manager.getSessionFile()) };
    const parsed = decodeSession(readSafe(target.path, 64 * 1024 ** 2));
    const receipt = { version: 1, target, created: parsed.header.timestamp,
        source: { id: source.id, cwd: source.cwd }, tailLength: parsed.tail.length, tailSha256: hash(parsed.tail), deliveries: [], documents: [document] };
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    const parent = privateDir(path.join(process.env.PI_CODING_AGENT_DIR, 'pivane-session-moves'));
    const folder = privateDir(path.join(parent, 'forks'));
    require('../server/pi-private-files').writePrivateFileSync(path.join(folder, hash(target.id) + '.json'), bytes, true);
    manager.appendCustomEntry(ACCESS_ENTRY, { version: 1, sessionId: target.id, revision: hash(bytes) });
    return receipt;
}

test('original v1 publisher receipts work for empty/reopened/native fork files, remain valid after 80MiB append, and reject a displaced marker', { timeout: 90000 }, async t => {
    const f = await fixture(t), service = new DocumentUploads({ store: f.store, supervisor: f.supervisor }); t.after(() => service.dispose());
    const source = await f.store.createSession(f.source, 'Legacy source');
    const upload = await service.upload({ cwd: f.source, sessionId: source.id, requestId: 'legacy', name: 'legacy.docx' }, zip(docxFiles()));
    const original = f.SessionManager.open(source.path);
    original.appendMessage({ role: 'user', content: 'Legacy question', timestamp: 1 }); original.appendMessage(assistant);
    for (const kind of ['empty', 'reopened', 'native-fork']) {
        let session, manager;
        if (kind === 'native-fork') {
            manager = f.SessionManager.forkFrom(source.path, f.source);
            session = { id: manager.getSessionId(), cwd: manager.getCwd(), path: manager.getSessionFile() };
        } else {
            session = await f.store.createSession(f.source);
            manager = f.SessionManager.open(session.path);
            if (kind === 'reopened') {
                manager.appendCustomEntry('pivane-web-fork-origin', { sessionId: source.id, entryId: null });
                manager = f.SessionManager.open(session.path);
            }
        }
        const receipt = publishV1(manager, source, upload.reference);
        assert.equal((await readForkAccess(f.store, session)).version, 1, kind);
        assert.equal((await service.authorized({ cwd: session.cwd, sessionId: session.id, id: upload.reference.id }, { draft: true })).reference.id, upload.reference.id);
        const size = fs.statSync(session.path).size;
        appendLargeNativeMessage(session, 80, manager.getLeafId());
        assert.equal((await readForkAccess(f.store, session)).tailSha256, receipt.tailSha256, kind + ' growth');
        fs.truncateSync(session.path, size);
        const bytes = fs.readFileSync(session.path), markerOffset = bytes.indexOf(10) + 1 + receipt.tailLength;
        const unrelated = Buffer.from(JSON.stringify({ type: 'custom', id: randomUUID(), parentId: manager.getLeafId(), customType: 'unrelated', data: {} }) + '\n');
        fs.writeFileSync(session.path, Buffer.concat([bytes.subarray(0, markerOffset), unrelated, bytes.subarray(markerOffset)]));
        await assert.rejects(readForkAccess(f.store, session), { code: 'FORK_ACCESS_CHANGED' }, 'does not search the suffix for a copied marker');
    }
});

test('a native fork can bind a 72MiB prefix and retain inherited delivery and document draft reads after growth to 112MiB', { timeout: 90000 }, async t => {
    const f = await fixture(t), documents = new DocumentUploads({ store: f.store, supervisor: f.supervisor }); t.after(() => documents.dispose());
    const source = await f.store.createSession(f.source, 'Large fork source'), manager = f.SessionManager.open(source.path);
    manager.appendMessage({ role: 'user', content: 'Source', timestamp: 1 }); manager.appendMessage(assistant);
    fs.writeFileSync(path.join(f.source, 'snapshot.txt'), 'Large fork immutable snapshot');
    const delivered = await new DeliverableStore(f.store).publish({ cwd: f.source, sessionId: source.id }, { requestId: 'large-delivery', title: 'Large fork', files: ['snapshot.txt'] });
    manager.appendCustomEntry(ENTRY, delivered.reference);
    const upload = await documents.upload({ cwd: f.source, sessionId: source.id, requestId: 'large-document', name: 'large.docx' }, zip(docxFiles()));
    const moved = await f.move(source, f.target);
    appendLargeNativeMessage(moved, 72, manager.getLeafId());
    const native = f.SessionManager.open(moved.path);
    native.appendMessage(assistant);
    const question = native.appendMessage({ role: 'user', content: upload.marker, timestamp: 3 });
    const fork = (await f.fork(moved, question, 'before')).session;
    const receipt = await readForkAccess(f.store, fork);
    assert.equal(receipt.version, 2); assert.ok(receipt.tailLength > 72 * 1024 ** 2);
    const deliveries = new DeliverableService({ store: f.store, supervisor: f.supervisor });
    const read = async () => {
        assert.equal((await deliveries.request({ cwd: fork.cwd, sessionId: fork.id, id: delivered.reference.id, index: '0' })).content, 'Large fork immutable snapshot');
        const input = { cwd: fork.cwd, sessionId: fork.id, id: upload.reference.id };
        const authorized = await documents.authorized(input, { draft: true });
        assert.deepEqual(authorized.bytes, zip(docxFiles())); await documents.checkCurrent(input, authorized);
        await assert.rejects(documents.authorized(input), { code: 'DOCUMENT_SCOPE' });
    };
    await read();
    const parent = f.SessionManager.open(fork.path).getLeafId();
    appendLargeNativeMessage(fork, 40, parent);
    assert.ok(fs.statSync(fork.path).size > 112 * 1024 ** 2);
    assert.equal((await readForkAccess(f.store, fork)).revision, receipt.revision);
    fs.unlinkSync(moved.path);
    await read();
    const restarted = new PiSessionStore(); new PiSessionMoves({ ...f.moves, store: restarted });
    assert.equal((await readForkAccess(restarted, fork)).revision, receipt.revision);
    const tampered = fs.openSync(fork.path, 'r+');
    try {
        const header = Buffer.alloc(4096), count = fs.readSync(tampered, header, 0, header.length, 0);
        const offset = header.subarray(0, count).indexOf(10) + 1 + receipt.tailLength - 32;
        fs.writeSync(tampered, Buffer.from('X'), 0, 1, offset);
    } finally { fs.closeSync(tampered); }
    await assert.rejects(readForkAccess(f.store, fork), { code: 'FORK_ACCESS_CHANGED' });
    fs.unlinkSync(fork.path); // Later move tests scan every surviving native file.
});

test('an already-moved Web fork keeps delivery and document draft access after growing beyond 64MiB and after another stable append', { timeout: 90000 }, async t => {
    const f = await fixture(t), documents = new DocumentUploads({ store: f.store, supervisor: f.supervisor }); t.after(() => documents.dispose());
    const source = await f.store.createSession(f.source, 'Moved fork growth'), manager = f.SessionManager.open(source.path);
    manager.appendMessage({ role: 'user', content: 'Source', timestamp: 1 }); manager.appendMessage(assistant);
    fs.writeFileSync(path.join(f.source, 'snapshot.txt'), 'Moved grown snapshot');
    const delivered = await new DeliverableStore(f.store).publish({ cwd: f.source, sessionId: source.id }, { requestId: 'moved-grown', title: 'Moved grown', files: ['snapshot.txt'] });
    manager.appendCustomEntry(ENTRY, delivered.reference);
    const upload = await documents.upload({ cwd: f.source, sessionId: source.id, requestId: 'moved-doc', name: 'moved.docx' }, zip(docxFiles()));
    const question = manager.appendMessage({ role: 'user', content: upload.marker, timestamp: 3 });
    const movedSource = await f.move(source, f.target), child = (await f.fork(movedSource, question, 'before')).session;
    const finalProject = path.join(f.folder, 'final'); fs.mkdirSync(finalProject);
    const movedFork = await f.move(child, finalProject), receipt = await readForkAccess(f.store, movedFork);
    let parent = f.SessionManager.open(movedFork.path).getLeafId();
    const input = { cwd: movedFork.cwd, sessionId: movedFork.id, id: upload.reference.id };
    for (const megabytes of [72, 24]) {
        parent = appendLargeNativeMessage(movedFork, megabytes, parent);
        assert.equal((await readForkAccess(f.store, movedFork)).revision, receipt.revision);
        assert.equal((await f.moves.resolve(child.cwd, child.id)).session.path, movedFork.path);
        assert.equal((await new DeliverableService({ store: f.store, supervisor: f.supervisor }).request({ cwd: movedFork.cwd, sessionId: movedFork.id, id: delivered.reference.id, index: '0' })).content, 'Moved grown snapshot');
        const authorized = await documents.authorized(input, { draft: true });
        assert.equal(authorized.reference.id, upload.reference.id); await documents.checkCurrent(input, authorized);
    }
});
