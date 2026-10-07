const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-artifacts-')));
const cwd = path.join(root, 'project'), other = path.join(root, 'other'), agent = path.join(root, 'agent'), mediaRoot = path.join(root, 'media');
for (const p of [cwd, other, agent, path.join(mediaRoot, 'public/images')]) fs.mkdirSync(p, { recursive: true });
process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'artifact-fixture';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { DeliverableStore, ENTRY } = require('../server/pi-deliverables');
const { ArtifactsService } = require('../server/pi-artifacts');
const { discover, LIMITS } = require('../server/pi-artifacts-discovery');
const store = new PiSessionStore(), objects = new DeliverableStore(store);
let hidden = [], activeWorker = null, suspended = false;
const supervisor = { getActiveWorker: () => activeWorker, start: () => { throw new Error('must not start a worker'); } };
const options = { store, supervisor, preferences: { getHiddenProjects: () => hidden }, mediaRoot, isSuspended: () => suspended };
const service = new ArtifactsService(options);
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Fixture' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 2, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
fs.writeFileSync(path.join(cwd, 'report.md'), '# Private task output\n');
fs.writeFileSync(path.join(cwd, 'report.html'), '<script>parent.bad=true</script><h1>Report</h1>');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const history = [{ id: 7, filename: 'saved.png', prompt: '/private/prompt-not-a-source', parameters: { secret: 'never return' }, taskId: 'not-a-session', createdAt: new Date(0).toISOString() }];
fs.writeFileSync(path.join(mediaRoot, 'public/images/saved.png'), png);
fs.writeFileSync(path.join(mediaRoot, 'generation_history.json'), JSON.stringify(history));
let session, manager, receipt, before;
test.before(async () => {
    const { SessionManager } = await getSdk(); session = await store.createSession(cwd, 'Artifacts'); manager = SessionManager.open(session.path);
    before = manager.appendMessage({ role: 'user', content: 'Task', timestamp: 1 }); manager.appendMessage(assistant);
    receipt = await objects.publish({ cwd, sessionId: session.id }, { requestId: 'artifact-fixture', title: 'Report bundle', files: ['report.md', 'report.html'] });
    manager.appendCustomEntry(ENTRY, receipt.reference); manager.appendMessage({ ...assistant, timestamp: 3 });
});
test.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

test('discovers native deliveries and unknown media, groups formats and never scans via listSessions or launches', async () => {
    const oldProjects = store.listProjects, oldSessions = store.listSessions, oldGet = store.getSession;
    store.listProjects = store.listSessions = store.getSession = () => { throw new Error('unbounded discovery forbidden'); };
    try {
        const data = await service.list({});
        assert.equal(data.items.length, 2); assert.equal(data.partial, false);
        const delivered = data.items.find(i => i.source === 'delivery'), media = data.items.find(i => i.source === 'media');
        assert.equal(delivered.files.length, 2); assert.deepEqual(delivered.types, ['document', 'web']);
        assert.equal(delivered.project.name, 'project'); assert.equal(delivered.origin.sessionId, session.id);
        assert.equal(media.project, null); assert.equal(media.origin, null); assert.equal(media.title, 'saved.png');
        const serial = JSON.stringify(data.items);
        for (const privateValue of [agent, cwd, '/private/', 'parameters', 'sourcePath', 'absolutePath', 'requestHash', 'not-a-session']) assert.ok(!serial.includes(privateValue), privateValue);
        const preview = await service.preview(delivered.key); assert.equal(preview.content, '# Private task output\n'); assert.ok(!JSON.stringify(preview).includes(root));
        assert.equal((await service.preview(media.key)).mime, 'image/png');
        assert.equal((await service.preview(media.key, undefined, true)).mime, 'image/png');
        await assert.rejects(service.preview(delivered.key, undefined, true), { code: 'ARTIFACT_COVER' });
        assert.deepEqual(await service.origin(delivered.key), { cwd, sessionId: session.id });
        await assert.rejects(service.origin(media.key), { code: 'ARTIFACT_ORIGIN' });
        const again = await service.list({ cwd }); assert.equal(again.items.length, 1); assert.equal(again.items[0].key, delivered.key);
    } finally { store.listProjects = oldProjects; store.listSessions = oldSessions; store.getSession = oldGet; }
});

test('per-read native branch revocation and worker replacement are enforced without altering session bytes', async () => {
    const list = await service.list({ cwd }), key = list.items[0].key, raw = fs.readFileSync(session.path);
    activeWorker = { cwd, sessionId: session.id, request: async () => ({ entries: [], leafId: null }) };
    await assert.rejects(service.preview(key), { code: 'DELIVERY_SCOPE' });
    await assert.rejects(service.origin(key), { code: 'ARTIFACT_SCOPE' });
    activeWorker = { cwd, sessionId: session.id, request: async () => { activeWorker = null; return { entries: manager.getEntries(), leafId: manager.getLeafId() }; } };
    await assert.rejects(service.preview(key), { code: 'DELIVERY_CONTEXT' });
    activeWorker = null;
    assert.deepEqual(fs.readFileSync(session.path), raw);
    const list2 = await service.list({ cwd });
    manager.branch(before); manager.appendMessage({ role: 'user', content: 'New branch', timestamp: 5 });
    await assert.rejects(service.preview(list2.items[0].key), { code: 'DELIVERY_SCOPE' });
    assert.equal((await service.list({ cwd })).items.length, 0);
    manager.appendCustomEntry(ENTRY, receipt.reference); manager.appendMessage({ ...assistant, timestamp: 6 });
});

test('cross-project copied references, hidden sources, relocation and tampered snapshots fail closed', async () => {
    const { SessionManager } = await getSdk(), wrong = await store.createSession(other, 'Wrong ref'), m = SessionManager.open(wrong.path);
    m.appendMessage({ role: 'user', content: 'No grant', timestamp: 1 }); m.appendMessage(assistant); m.appendCustomEntry(ENTRY, receipt.reference); m.appendMessage(assistant);
    assert.equal((await service.list({ cwd: other })).items.length, 0);
    const listed = await service.list({ cwd }), key = listed.items[0].key;
    hidden = [cwd]; await assert.rejects(service.preview(key), { code: 'ARTIFACT_SCOPE' }); assert.equal((await service.list({})).items.some(i => i.source === 'delivery'), false); hidden = [];
    store.sessionMoves = { assertAvailable: async () => { throw Object.assign(new Error('moving'), { status: 409 }); } };
    await assert.rejects(service.preview(key)); store.sessionMoves = null;
    const file = path.join(await objects.root(), receipt.reference.id, '0.bin'), original = fs.readFileSync(file);
    fs.writeFileSync(file, 'tamper'); await assert.rejects(service.preview(key), { code: 'DELIVERY_CHANGED' }); fs.writeFileSync(file, original);
});

test('media must still match history; duplicate IDs, unsafe names and redirected files are never adopted', async () => {
    const list = await service.list({}), key = list.items.find(i => i.source === 'media').key;
    const historyFile = path.join(mediaRoot, 'generation_history.json');
    fs.writeFileSync(historyFile, JSON.stringify([...history, history[0]]));
    await assert.rejects(service.preview(key), { code: 'ARTIFACT_SOURCE' });
    assert.equal((await service.list({})).items.some(i => i.source === 'media'), false);
    fs.writeFileSync(historyFile, JSON.stringify([...history, { id: 'bad', filename: '../escape.png' }, { id: 'external', imageUrl: 'https://bad.test/a.png' }]));
    assert.equal((await service.list({})).items.filter(i => i.source === 'media').length, 1);
    fs.writeFileSync(historyFile, '[]'); await assert.rejects(service.preview(key), { code: 'ARTIFACT_SOURCE' });
    fs.writeFileSync(historyFile, JSON.stringify(history));
    const imageFile = path.join(mediaRoot, 'public/images/saved.png'); fs.unlinkSync(imageFile); fs.writeFileSync(path.join(cwd, 'outside.png'), png); fs.symlinkSync(path.join(cwd, 'outside.png'), imageFile);
    await assert.rejects(service.preview(key), { code: 'ARTIFACT_SOURCE' }); fs.unlinkSync(imageFile); fs.writeFileSync(imageFile, png);
});

test('discovery is bounded, reports incomplete coverage and never initializes empty/malformed native files', async () => {
    const inputs = { sessionRoot: path.join(agent, 'sessions'), roots: [root], hidden: [], mediaRoot };
    const bounded = discover(inputs, { ...LIMITS, files: 1 }); assert.equal(bounded.coverage.limited, true); assert.ok(bounded.coverage.scannedSessions <= 1);
    const empty = path.join(path.dirname(session.path), 'empty.jsonl'); fs.writeFileSync(empty, '');
    const result = discover(inputs); assert.ok(result.coverage.skippedSources > 0); assert.equal(fs.statSync(empty).size, 0);
    await assert.rejects(service.session({ cwd, id: session.id, path: empty, size: 0 })); assert.equal(fs.statSync(empty).size, 0);
    fs.unlinkSync(empty);
});

test('bounded pagination, expiry, suspension and concurrent discovery maintain operation ownership', async () => {
    const list = await service.list({ cwd });
    await assert.rejects(service.list({ snapshot: list.snapshot, cwd: other }), { code: 'ARTIFACT_EXPIRED' });
    await assert.rejects(service.list({ offset: '-1' }), { code: 'ARTIFACT_INPUT' });
    await assert.rejects(service.list({ prompt: 'not accepted' }), { code: 'ARTIFACT_INPUT' });
    service.snapshots.get(list.snapshot).at = 0; await assert.rejects(service.list({ snapshot: list.snapshot, cwd }), { code: 'ARTIFACT_EXPIRED' });
    suspended = true; await assert.rejects(service.list({}), { code: 'ARTIFACT_SUSPENDED' }); suspended = false;
    let release; const waiting = new Promise(r => release = r);
    const blocked = new ArtifactsService({ ...options, discovery: () => waiting });
    const a = blocked.list({}), b = blocked.list({}); await assert.rejects(blocked.list({}), { code: 'ARTIFACT_BUSY' }); assert.equal(blocked.busy, true);
    release({ sessions: [], media: [], coverage: { scannedSessions: 0, skippedSources: 0, limited: false } }); await Promise.all([a, b]); assert.equal(blocked.busy, false); await blocked.dispose();
});

test('each discovery page has a session budget and source-bound continuation without duplicate results', async () => {
    const { SessionManager } = await getSdk();
    const added = [];
    for (let i = 0; i < 10; i++) {
        const s = await store.createSession(cwd, 'Page fixture ' + i), m = SessionManager.open(s.path);
        m.appendMessage({ role: 'user', content: 'Fixture', timestamp: 1 }); m.appendMessage(assistant);
        m.appendCustomEntry(ENTRY, receipt.reference); m.appendMessage(assistant); added.push(s.path);
    }
    try {
        const first = await service.list({ cwd }); assert.equal(first.items.length, 8); assert.equal(first.nextOffset, 8);
        const second = await service.list({ cwd, snapshot: first.snapshot, offset: String(first.nextOffset) });
        assert.equal(second.items.length, 3); assert.equal(second.nextOffset, null);
        assert.equal(new Set([...first.items, ...second.items].map(i => i.key)).size, 11);
        await assert.rejects(service.list({ cwd: other, snapshot: first.snapshot, offset: '8' }), { code: 'ARTIFACT_EXPIRED' });
    } finally { for (const file of added) fs.unlinkSync(file); }
});

test('read-in-flight revocation and media-history changes discard already-read bytes', async () => {
    const list = await service.list({}), delivered = list.items.find(i => i.source === 'delivery'), media = list.items.find(i => i.source === 'media');
    const io = require('../server/pi-file-io'), original = io.openRead;
    let calls = 0;
    activeWorker = { cwd, sessionId: session.id, request: async () => ++calls === 1 ? { entries: manager.getEntries(), leafId: manager.getLeafId() } : { entries: [], leafId: null } };
    try { await assert.rejects(service.preview(delivered.key), { code: 'DELIVERY_CONTEXT' }); } finally { activeWorker = null; }
    io.openRead = async filename => {
        if (filename.endsWith('saved.png')) fs.writeFileSync(path.join(mediaRoot, 'generation_history.json'), '[]');
        return original(filename);
    };
    try { await assert.rejects(service.preview(media.key), { code: 'ARTIFACT_SOURCE' }); }
    finally { io.openRead = original; fs.writeFileSync(path.join(mediaRoot, 'generation_history.json'), JSON.stringify(history)); }
    service.locators.get(media.key).at = 0; await assert.rejects(service.preview(media.key), { code: 'ARTIFACT_EXPIRED' });
});

test('project revocation during the final branch RPC discards preview and origin results', async () => {
    const list = await service.list({ cwd }), key = list.items[0].key;
    for (const action of ['preview', 'origin']) {
        let calls = 0;
        activeWorker = { cwd, sessionId: session.id, request: async () => {
            if (++calls === 2) hidden = [cwd];
            return { entries: manager.getEntries(), leafId: manager.getLeafId() };
        } };
        try { await assert.rejects(service[action](key), { code: 'ARTIFACT_SCOPE' }); }
        finally { hidden = []; activeWorker = null; }
    }
});

test('actual opened bytes and both native proofs share the remaining budget, not stale candidate size', async () => {
    const candidate = { cwd, id: session.id, path: session.path, size: 1 }, actual = fs.statSync(session.path).size;
    const budget = { remaining: actual + 1 };
    await service.session(candidate, budget); assert.equal(budget.remaining, 0);
    await assert.rejects(service.session(candidate, budget), /source-size/);
    const original = fs.lstatSync;
    let checks = 0;
    fs.lstatSync = (filename, ...args) => {
        const stat = original(filename, ...args);
        if (filename === session.path && !args.length && checks++ === 0) return { ...stat, size: 0 };
        return stat;
    };
    try {
        const result = discover({ sessionRoot: path.join(agent, 'sessions'), roots: [root], hidden: [], cwd }, { ...LIMITS, bytes: actual - 1 });
        assert.equal(result.sessions.some(s => s.id === session.id), false); assert.ok(result.coverage.skippedSources > 0);
    } finally { fs.lstatSync = original; }
});

test('post-read identity failures consume reservations and cannot repeatedly spend the same byte budget', async () => {
    const io = require('../server/pi-file-io'), original = io.sameIdentityAtPath, read = fs.readSync;
    const actual = fs.statSync(session.path).size, budget = { remaining: actual + 1 }; let readBytes = 0;
    const candidate = { cwd, id: session.id, path: session.path, size: 1 };
    fs.readSync = (...args) => { const count = read(...args); readBytes += count; return count; };
    io.sameIdentityAtPath = (filename, identity) => filename === session.path ? false : original(filename, identity);
    try {
        await assert.rejects(service.session(candidate, budget), /source-changed/);
        assert.equal(budget.remaining, 0); const firstRead = readBytes; assert.equal(firstRead, actual);
        await assert.rejects(service.session(candidate, budget), /source-size/); assert.equal(readBytes, firstRead);
        const result = discover({ sessionRoot: path.join(agent, 'sessions'), roots: [root], hidden: [], cwd }, { ...LIMITS, bytes: actual + 1 });
        assert.equal(result.sessions.length, 0); assert.equal(result.coverage.limited, true);
    } finally { io.sameIdentityAtPath = original; fs.readSync = read; }
});

test('verified MP4 deliveries use the same video representation as historical media', async () => {
    const { SessionManager } = await getSdk(), s = await store.createSession(cwd, 'Video fixture'), m = SessionManager.open(s.path);
    m.appendMessage({ role: 'user', content: 'Video', timestamp: 1 }); m.appendMessage(assistant);
    const video = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0, ...Buffer.from('isommp42')]);
    fs.writeFileSync(path.join(cwd, 'video.mp4'), video);
    const delivery = await objects.publish({ cwd, sessionId: s.id }, { requestId: 'video-fixture', title: 'Video', files: ['video.mp4'] });
    m.appendCustomEntry(ENTRY, delivery.reference); m.appendMessage(assistant);
    try {
        const result = await service.list({ cwd, sessionId: s.id }), preview = await service.preview(result.items[0].key);
        assert.equal(preview.kind, 'video'); assert.equal(preview.mime, 'video/mp4'); assert.deepEqual(Buffer.from(preview.base64, 'base64'), video);
    } finally { fs.unlinkSync(s.path); }
});

test('native forks and committed relocation retain only valid inherited delivery references', async t => {
    const folder = path.join(root, 'move-fixture'), source = path.join(folder, 'source'), target = path.join(folder, 'target');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target);
    const localStore = new PiSessionStore(), { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const localSupervisor = new PiAgentSupervisor();
    const preferences = new (require('../server/workspace-preferences-service').WorkspacePreferencesService)({ filePath: path.join(folder, 'prefs.json') });
    const usage = new (require('../server/pi-usage-service').PiUsageService)(localStore);
    const moves = new (require('../server/pi-session-moves').PiSessionMoves)({ store: localStore, supervisor: localSupervisor, preferences, usage, deferred: { list: () => [] }, cron: { db: { homes: () => [], jobs: () => [] } } });
    const artifacts = new ArtifactsService({ store: localStore, supervisor: localSupervisor, preferences });
    t.after(async () => { await artifacts.dispose(); await moves.dispose(); await localSupervisor.dispose(); await usage.dispose(); });
    const s = await localStore.createSession(source, 'Move fixture'), { SessionManager } = await getSdk(), m = SessionManager.open(s.path);
    const early = m.appendMessage({ role: 'user', content: 'Task', timestamp: 1 }); m.appendMessage(assistant);
    fs.writeFileSync(path.join(source, 'result.md'), '# Move proof');
    const delivery = await new DeliverableStore(localStore).publish({ cwd: source, sessionId: s.id }, { requestId: 'move-result', title: 'Move result', files: ['result.md'] });
    m.appendCustomEntry(ENTRY, delivery.reference); const late = m.appendMessage(assistant);
    const snapshot = { entries: m.getEntries(), leafId: m.getLeafId() };
    const inherited = (await localStore.forkSession(s, snapshot, late, 'at')).session;
    const ungranted = (await localStore.forkSession(s, snapshot, early, 'before')).session;
    assert.equal((await artifacts.list({ cwd: source, sessionId: inherited.id })).items.length, 1);
    assert.equal((await artifacts.list({ cwd: source, sessionId: ungranted.id })).items.length, 0);
    // Fork lineage intentionally blocks moving a related live history. Remove
    // these synthetic fork fixtures after asserting their independent grants.
    fs.unlinkSync(inherited.path); fs.unlinkSync(ungranted.path);
    const pre = await artifacts.list({ cwd: source, sessionId: s.id }), preview = await moves.preview(source, s.id, target);
    assert.equal(preview.canMove, true, JSON.stringify(preview.blockers));
    await moves.move(source, s.id, { cwd: source, targetCwd: target, expectedRevision: preview.revision, requestId: 'artifact-' + require('node:crypto').randomUUID() });
    await assert.rejects(artifacts.preview(pre.items[0].key));
    const after = await artifacts.list({ cwd: target, sessionId: s.id }); assert.equal(after.items.length, 1);
    assert.equal((await artifacts.preview(after.items[0].key)).content, '# Move proof');
    assert.deepEqual(await artifacts.origin(after.items[0].key), { cwd: target, sessionId: s.id });
});

test('gateway wiring exposes artifacts, tracks activity, blocks moves and closes operations before worker shutdown', async t => {
    const express = require('express'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway({ artifactMediaRoot: mediaRoot }), app = express(); app.use(express.json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`, headers = { Authorization: 'Bearer artifact-fixture' };
    const status = await (await fetch(base + '/status', { headers })).json(); assert.equal(status.artifacts, true); assert.equal(status.fileRoots, true);
    const list = await (await fetch(base + '/artifacts', { headers })).json(); assert.ok(list.items.some(i => i.source === 'media'));
    assert.equal(gateway.supervisor.workers.size, 0);
    let release; const held = gateway.artifacts.job(() => new Promise(r => { release = r; }));
    const activity = await (await fetch(base + '/activity', { headers })).json(); assert.equal(activity.artifactOperations, 1); assert.equal(gateway.sessionMoves.busy(), true);
    let disposed = false; const closing = gateway.artifacts.dispose().then(() => { disposed = true; });
    assert.equal(disposed, false); release(); await held; await closing; assert.equal(disposed, true);
    assert.equal((await fetch(base + '/artifacts', { headers })).status, 503);
});

test('authenticated read-only artifact routes return JSON with no-store, deny foreign origin and hide internal failures', async t => {
    const express = require('express'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService(), app = express(); app.use(access.middleware());
    const router = express.Router(), routeService = require('../server/pi-artifacts-routes').mountArtifacts(router, options); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await routeService.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const base = `http://127.0.0.1:${server.address().port}`, url = base + '/api/pi/artifacts';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer artifact-fixture', Origin: 'https://bad.test' } })).status, 403);
    const headers = { Authorization: 'Bearer artifact-fixture', Origin: base }, response = await fetch(url, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-type'), /application\/json/);
    const data = await response.json(), key = data.items.find(i => i.title === 'Report bundle').files[1].key;
    const preview = await fetch(`${url}/${key}/preview`, { headers }); assert.match(preview.headers.get('content-security-policy'), /sandbox/); assert.equal((await preview.json()).kind, 'html');
    const bad = await fetch(url + '?cwd=' + encodeURIComponent('/not-authorized-project'), { headers }); assert.ok(!(await bad.text()).includes('/not-authorized-project'));
});
