const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auxiliary-models-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_TOKEN = 'auxiliary-fixture-token';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_OFFLINE = '1';
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const { PiAuxiliaryModelsService } = require('../server/pi-auxiliary-models-service');
const { MediaAgentService } = require('../server/media-agent-service');
const modelA = { provider: 'fixture', id: 'main', name: 'Main', input: ['text'], reasoning: false, contextWindow: 16000, maxTokens: 1024 };
const modelB = { ...modelA, id: 'cheap/title', name: 'Cheap helper' };
const reference = model => ({ provider: model.provider, modelId: model.id });
function fixture() {
    const preferences = new WorkspacePreferencesService({ filePath: path.join(root, `preferences-${Math.random()}.json`) });
    let changed = 0, reads = 0;
    const runtime = { getAvailable: async () => { reads++; return [modelA, modelB]; } };
    const service = new PiAuxiliaryModelsService({ preferences, titles: { settingsChanged: () => changed++ }, createModelRuntime: async () => runtime });
    return { preferences, service, runtime, changed: () => changed, reads: () => reads };
}

test('auxiliary registry reads existing preferences without migration and atomically saves/reset routes with unknown fields intact', async () => {
    const f = fixture();
    f.preferences.writeDocument({ custom: { preserved: true }, mediaAgent: { ...reference(modelA), custom: 'media' },
        sessionTitles: { ...reference(modelB), enabled: false, revision: 7, custom: 'titles' } });
    const before = fs.readFileSync(f.preferences.filePath);
    const initial = f.service.snapshot();
    assert.deepEqual(initial.purposes.map(purpose => purpose.id), ['session-title', 'media-planner']);
    assert.equal(initial.purposes[0].settings.modelId, modelB.id);
    assert.equal(initial.purposes[1].settings.modelId, modelA.id);
    assert.deepEqual(fs.readFileSync(f.preferences.filePath), before);
    let writes = 0; const write = f.preferences.writeDocument.bind(f.preferences);
    f.preferences.writeDocument = data => { writes++; write(data); };
    const saved = await f.service.save({ expectedRevision: initial.revision, changes: {
        'session-title': reference(modelA), 'media-planner': reference(modelB)
    } });
    assert.equal(writes, 1); assert.equal(f.reads(), 1); assert.equal(f.changed(), 1);
    assert.equal(f.preferences.getSessionTitles().enabled, false);
    assert.equal(f.preferences.getSessionTitles().revision, 8);
    assert.equal(f.preferences.readDocument().sessionTitles.custom, 'titles');
    assert.equal(f.preferences.readDocument().mediaAgent.custom, 'media');
    assert.deepEqual(f.preferences.readDocument().custom, { preserved: true });
    assert.notEqual(saved.revision, initial.revision);
    await f.service.save({ expectedRevision: saved.revision, changes: {
        'session-title': { provider: '', modelId: '' }, 'media-planner': { provider: '', modelId: '' }
    } });
    assert.equal(f.reads(), 1, 'restoring automatic routing makes no model/auth query');
    assert.equal(f.preferences.getSessionTitles().provider, ''); assert.equal(f.preferences.getSessionTitles().enabled, false);
    assert.deepEqual(f.preferences.getMediaAgent(), { provider: '', modelId: '' });
    assert.equal(writes, 2);
    await f.service.dispose();
});

test('invalid/unknown auxiliary consumers and unavailable models are rejected without partial writes or provider error disclosure', async () => {
    const f = fixture(), revision = f.service.snapshot().revision;
    for (const changes of [{ vision: reference(modelA) }, { packages: reference(modelA) }, { 'media-planner': { enabled: true } },
        { 'session-title': { provider: 'partial' } }, { 'session-title': { provider: '', modelId: 'partial' } },
        { 'session-title': { expectedRevision: 2, enabled: false } }, JSON.parse('{"__proto__":{"provider":"fixture","modelId":"main"}}')]) {
        assert.throws(() => f.service.save({ expectedRevision: revision, changes }));
    }
    await assert.rejects(f.service.save({ expectedRevision: revision, changes: {
        'session-title': reference(modelA), 'media-planner': { provider: 'missing', modelId: 'missing' }
    } }), /可用的文本模型/);
    assert.equal(fs.existsSync(f.preferences.filePath), false);
    f.runtime.getAvailable = async () => { throw new Error('PRIVATE_PROVIDER_PAYLOAD'); };
    await assert.rejects(f.service.save({ expectedRevision: revision, changes: { 'media-planner': reference(modelA) } }), error => !error.message.includes('PRIVATE') && /无法验证/.test(error.message));
    assert.equal(fs.existsSync(f.preferences.filePath), false);
    await f.service.dispose();
});

test('auxiliary saves reserve before await, reject changes from legacy clients, and preserve unrelated concurrent preferences', async () => {
    const f = fixture(); let release;
    f.runtime.getAvailable = () => new Promise(resolve => { release = resolve; });
    const first = f.service.save({ expectedRevision: f.service.snapshot().revision, changes: { 'session-title': reference(modelA), 'media-planner': reference(modelB) } });
    assert.equal(f.service.busy, true);
    assert.throws(() => f.service.save({ expectedRevision: f.service.snapshot().revision, changes: { 'session-title': { enabled: false } } }), /正在保存/);
    await new Promise(resolve => setImmediate(resolve));
    f.preferences.setMediaAgent(reference(modelA));
    const rejected = assert.rejects(first, /已变化/); release([modelA, modelB]); await rejected;
    assert.equal(f.preferences.getSessionTitles().provider, '');
    const next = f.service.save({ expectedRevision: f.service.snapshot().revision, changes: { 'session-title': reference(modelB) } });
    await new Promise(resolve => setImmediate(resolve));
    f.preferences.writeDocument({ ...f.preferences.readDocument(), unrelated: { kept: true } });
    release([modelA, modelB]); await next;
    assert.deepEqual(f.preferences.readDocument().unrelated, { kept: true });
    const stale = f.service.snapshot().revision;
    f.preferences.setSessionTitles({ enabled: false });
    assert.throws(() => f.service.save({ expectedRevision: stale, changes: { 'media-planner': reference(modelB) } }), /已变化/);
    await f.service.dispose();
});

test('shutdown waits for validation and blocks late persistence', async () => {
    const f = fixture(); let release;
    f.runtime.getAvailable = () => new Promise(resolve => { release = resolve; });
    const pending = f.service.save({ expectedRevision: f.service.snapshot().revision, changes: { 'session-title': reference(modelB) } });
    await new Promise(resolve => setImmediate(resolve));
    const closed = f.service.dispose();
    assert.equal(f.service.busy, true);
    const rejected = assert.rejects(pending, /正在关闭/); release([modelB]); await rejected; await closed;
    assert.equal(fs.existsSync(f.preferences.filePath), false); assert.equal(f.service.busy, false);
});

test('media planner honors explicit helper models without fallback and keeps automatic defaults when no helper is selected', async () => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key', models: [modelA, modelB]
    } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'main' }));
    const f = fixture();
    const planner = new MediaAgentService({ rootDir: root, workspacePreferencesService: f.preferences });
    f.preferences.setMediaAgent(reference(modelB));
    assert.deepEqual((await planner.getPlannerCandidates({})).map(candidate => candidate.modelId), [modelB.id]);
    assert.deepEqual((await planner.getPlannerCandidates(reference(modelA))).map(candidate => candidate.modelId), [modelA.id]);
    f.preferences.setMediaAgent({ provider: 'fixture', modelId: 'removed' });
    await assert.rejects(planner.getPlannerCandidates({}), /不会自动更换模型/);
    await assert.rejects(planner.getPlannerCandidates({ provider: 'fixture', modelId: 'unknown' }), /不会自动更换模型/);
    f.preferences.setMediaAgent({ provider: '', modelId: '' });
    assert.equal((await planner.getPlannerCandidates({}))[0].modelId, modelA.id);
    await f.service.dispose();
});

test('unified settings API is authenticated, revision-protected, private and starts no workers', async t => {
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway();
    gateway.auxiliaryModels.createModelRuntime = async () => ({ getAvailable: async () => [modelA, modelB] });
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}/api/pi/settings/auxiliary-models`;
    const headers = { Authorization: 'Bearer auxiliary-fixture-token', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'http://untrusted.invalid' } })).status, 403);
    const read = await fetch(url, { headers }); assert.equal(read.headers.get('cache-control'), 'no-store');
    const initial = await read.json();
    const body = { expectedRevision: initial.revision, changes: { 'session-title': { ...reference(modelB), enabled: false }, 'media-planner': reference(modelA) } };
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 200);
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 409);
    const snapshot = await (await fetch(url.replace('/auxiliary-models', '/models'), { headers })).json();
    assert.equal(snapshot.auxiliaryModels.version, 1);
    assert.equal(snapshot.preferences.sessionTitles.modelId, modelB.id);
    assert.equal(snapshot.preferences.mediaAgent.modelId, modelA.id);
    assert.equal(gateway.supervisor.workers.size, 0);
});
