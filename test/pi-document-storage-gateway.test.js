const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-storage-gateway-')));
process.env.PI_CODING_AGENT_DIR = root; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const { zip, docxFiles } = require('./document-fixtures.cjs');
let number = 0;
async function fixture(t) {
    const base = path.join(root, String(++number)), agent = path.join(base, 'agent'), cwd = path.join(base, 'project');
    fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agent;
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    const maintenance = new MaintenanceClient({ managed: false });
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-storage-token' });
    const gateway = createPiAgentGateway({ accessService: access, maintenance, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); app.use((req, res, next) => maintenance.http(req, res, next));
    access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { await gateway.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(base, { recursive: true, force: true }); });
    await gateway.cron.ready; await gateway.learning.resumePromise;
    const session = await gateway.store.createSession(cwd, 'Storage integration');
    const request = async (route, body, method = 'POST') => {
        const response = await fetch(origin + '/api/pi' + route, { method, headers: { Authorization: 'Bearer synthetic-storage-token', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
    };
    const upload = id => gateway.documents.upload({ cwd, sessionId: session.id, requestId: id, name: id + '.docx' }, zip(docxFiles()));
    return { gateway, cwd, agent, session, request, upload, maintenance };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('real gateway cleanup excludes only its own admitted request and never starts a worker', { timeout: 60000 }, async t => {
    const f = await fixture(t), uploaded = await f.upload('unused');
    const usage = await f.request('/uploads/storage/usage', { cwd: f.cwd });
    assert.equal(usage.status, 200); assert.equal(usage.body.complete, true, JSON.stringify(usage.body));
    const preview = await f.request('/uploads/storage/preview', { cwd: f.cwd, id: uploaded.reference.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const input = { cwd: f.cwd, ticket: preview.body.ticket, revision: preview.body.revision, requestId: 'confirmed-cleanup', confirmed: true, externalWritersStopped: true, draftIds: [] };
    const result = await f.request('/uploads/storage/cleanup', input);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.state, 'deleted');
    const status = await f.request('/uploads/storage/status?' + new URLSearchParams({ cwd: f.cwd, requestId: input.requestId }), undefined, 'GET');
    assert.deepEqual(status.body, result.body);
    assert.equal(f.gateway.supervisor.workers.size, 0); assert.equal(f.maintenance.referenceLocked, false); assert.equal(f.maintenance.active, 0);
});

test('an active cleanup scan blocks HTTP/native admission and queue mutations, then releases on failure', { timeout: 60000 }, async t => {
    const f = await fixture(t), uploaded = await f.upload('held');
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const storage = f.gateway.documents.storage, original = storage.protectedDocuments;
    storage.protectedDocuments = async input => { const result = await original(input); entered.resolve(); await release.promise; return result; };
    const preview = f.request('/uploads/storage/preview', { cwd: f.cwd, id: uploaded.reference.id });
    await Promise.race([entered.promise, preview.then(result => { throw new Error('Scan did not acquire lease: ' + JSON.stringify(result)); })]);
    try {
        assert.equal(f.maintenance.referenceLocked, true);
        const create = await f.request('/sessions', { cwd: f.cwd, name: 'must not create' }); assert.equal(create.status, 503);
        await assert.rejects(f.gateway.supervisor.getWorker({ cwd: f.cwd, sessionId: f.session.id, sessionPath: f.session.path }), { code: 'DOCUMENT_STORAGE_BUSY' });
        assert.throws(() => f.gateway.supervisor.queueStore.beginOperation(), /附件/);
        // An out-of-band settings change invalidates the retained identity proof.
        fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never', change: true }));
    } finally { release.resolve(); }
    assert.equal((await preview).status, 409);
    assert.equal(f.maintenance.referenceLocked, false); assert.equal(f.gateway.supervisor.queueStore.leased, false);
    assert.equal(f.gateway.supervisor.workers.size, 0); assert.ok(await f.gateway.documents.object(uploaded.reference.id));
});

test('existing-worker readiness closes the preflight gap and does not mistake an idle projection for native idleness', { timeout: 60000 }, async t => {
    const f = await fixture(t), uploaded = await f.upload('barrier'); let queried = 0;
    const worker = { sessionPath: f.session.path, isIdle: () => true, retainsBackgroundWork: () => false,
        request: async type => { assert.equal(type, 'get_state'); queried++; return { isStreaming: true, isCompacting: false, pendingMessageCount: 0 }; } };
    f.gateway.supervisor.workers.set(f.session.path, worker);
    try {
        const result = await f.request('/uploads/storage/preview', { cwd: f.cwd, id: uploaded.reference.id });
        assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(queried, 1);
        worker.request = async () => { queried++; return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }; };
        const idleProcess = await f.request('/uploads/storage/preview', { cwd: f.cwd, id: uploaded.reference.id });
        assert.equal(idleProcess.status, 409); assert.equal(idleProcess.body.code, 'DOCUMENT_STORAGE_BUSY');
        assert.match(idleProcess.body.error, /退出/); assert.equal(queried, 2);
        const usage = await f.request('/uploads/storage/usage', { cwd: f.cwd });
        assert.equal(usage.status, 200); assert.equal(usage.body.count, 1);
    } finally { f.gateway.supervisor.workers.delete(f.session.path); }
    assert.equal(f.maintenance.referenceLocked, false); assert.ok(await f.gateway.documents.object(uploaded.reference.id));
});

test('real deferred, durable queue and recurring-job records protect uploaded originals; external native scope disables cleanup', { timeout: 60000 }, async t => {
    const f = await fixture(t), scheduled = await f.upload('scheduled'), queued = await f.upload('queued'), recurring = await f.upload('recurring');
    f.gateway.deferred.create(f.session, { id: randomUUID(), dueAt: Date.now() + 3600000, message: scheduled.marker, images: [] });
    const queue = await f.gateway.supervisor.getQueueStore(), owner = { cwd: f.cwd, sessionId: f.session.id, sessionPath: f.session.path, controls: { runtimeId: randomUUID() } };
    const payload = { message: queued.marker, images: [] }, id = queue.reserve(owner, 'followUp', payload); queue.update(owner, id, 'queued', payload);
    f.gateway.cron.db.saveJob({ id: 'retained-disabled-job', prompt: recurring.marker, enabled: false, deleted: true });
    for (const document of [scheduled, queued, recurring]) {
        const preview = await f.request('/uploads/storage/preview', { cwd: f.cwd, id: document.reference.id });
        assert.equal(preview.status, 409); assert.equal(preview.body.code, 'DOCUMENT_PROTECTED', JSON.stringify(preview.body));
        assert.ok(await f.gateway.documents.object(document.reference.id));
    }
    fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ subagents: { defaultSessionDir: path.join(f.agent, 'external-sessions') } }));
    const usage = await f.request('/uploads/storage/usage', { cwd: f.cwd });
    assert.equal(usage.status, 200); assert.equal(usage.body.complete, false); assert.equal(usage.body.count, 3);
});

test('session deletion preserves recoveries on failure and removes them only after confirmed native removal', { timeout: 60000 }, async t => {
    const f = await fixture(t), queue = await f.gateway.supervisor.getQueueStore();
    const owner = { cwd: f.cwd, sessionId: f.session.id, sessionPath: f.session.path, controls: { runtimeId: randomUUID() } };
    queue.reserve(owner, 'followUp', { message: 'Recover after failed deletion', images: [] });
    f.gateway.store.deleteSession = async () => { throw new Error('synthetic trash refusal'); };
    const endpoint = '/sessions/' + f.session.id + '?' + new URLSearchParams({ cwd: f.cwd });
    const failed = await f.request(endpoint, undefined, 'DELETE');
    assert.notEqual(failed.status, 200); assert.equal(queue.summaries(owner).length, 1); assert.equal(fs.existsSync(f.session.path), true);
    // The existing trash implementation is tested separately. Exercise its
    // successful completion boundary without using the operator's actual trash.
    f.gateway.store.deleteSession = async () => { fs.unlinkSync(f.session.path); return { deleted: true, method: 'fixture' }; };
    const removed = await f.request(endpoint, undefined, 'DELETE');
    assert.equal(removed.status, 200, JSON.stringify(removed.body)); assert.equal(queue.summaries(owner).length, 0);
});
