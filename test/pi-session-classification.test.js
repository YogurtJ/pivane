const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-classification-')));
const cwd = path.join(root, 'work'), other = path.join(root, 'other');
for (const dir of [cwd, other]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { PiAssistantProjectRegistry } = require('../server/pi-assistant-project-registry');
const { PiSessionClassification } = require('../server/pi-session-classification');
const { readProjectBinding, readProjectAssignment, PROJECT_ENTRY, PROJECT_CHANGE_ENTRY } = require('../server/pi-assistant-project-state');
const { readProfileBinding } = require('../server/pi-profile-state');

test('classification changes preserve native history and identity, enforce ownership/CAS, and forks inherit the effective category', async t => {
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor(), profiles = new PiProfileRegistry(store);
    const projects = new PiAssistantProjectRegistry(store, profiles); store.profiles = profiles; store.projects = projects;
    const service = new PiSessionClassification({ store, supervisor, profiles, projects });
    let server, gateway; const clients = [];
    t.after(async () => { for (const client of clients) client.terminate(); await gateway?.dispose(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await profiles.dispose(); await supervisor.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const saveProfile = async name => (await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name, description: '', soul: '', enabled: true, memory: { enabled: false }, skills: { learnedEnabled: true } } })).profile;
    const profile = await saveProfile('Assistant'), foreign = await saveProfile('Other assistant');
    const saveProject = async (name, profileId = profile.id, location = cwd, archived = false) => (await projects.save({ expectedRevision: (await projects.state()).revision,
        project: { name, cwd: location, description: '', instructions: 'Instructions for ' + name, profileIds: [profileId], archived } })).project;
    const a = await saveProject('Data structures'), b = await saveProject('Networks');
    const archived = await saveProject('Archived', profile.id, cwd, true), wrongProfile = await saveProject('Foreign', foreign.id), wrongDirectory = await saveProject('Different folder', profile.id, other);
    const original = await projects.createSession(cwd, 'Original', { agentProfileId: profile.id, assistantProjectId: a.id });
    const { SessionManager } = await getSdk(), manager = SessionManager.open(original.path);
    const user = manager.appendMessage({ role: 'user', content: 'Keep this history', timestamp: 10 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Keep this answer' }], stopReason: 'stop', timestamp: 20 });
    manager.appendLabelChange(user, 'bookmark');
    const header = manager.getHeader(), history = manager.getEntries();
    const snapshot = await service.inspect(cwd, original.id);
    assert.deepEqual(snapshot.projects.map(project => project.id), [a.id, b.id]);
    const input = (state, target) => ({ cwd, projectId: target, expectedRevision: state.revision, expectedProjectsRevision: state.projectsRevision });
    for (const target of [archived.id, wrongProfile.id, wrongDirectory.id, randomUUID()])
        await assert.rejects(service.change(cwd, original.id, input(snapshot, target)), /目标分类不可用/);
    const ordinary = await store.createSession(cwd, 'Ordinary', { agentProfileId: null });
    await assert.rejects(service.inspect(cwd, ordinary.id), /不支持/);
    await assert.rejects(service.change(cwd, original.id, { ...input(snapshot, b.id), profileId: foreign.id }), /参数无效/);
    let events = 0; supervisor.on('sessionClassification', () => events++);
    const changed = await service.change(cwd, original.id, input(snapshot, b.id));
    assert.equal(changed.session.assistantProject.id, b.id); assert.equal(events, 1);
    let saved = SessionManager.open(original.path);
    assert.deepEqual(saved.getHeader(), header);
    assert.deepEqual(saved.getEntries().slice(0, history.length), history);
    assert.equal(readProfileBinding(saved).profileId, profile.id);
    assert.equal(readProjectBinding(saved).projectId, b.id);
    const runtime = require('../server/pi-assistant-project-runtime').readProjectRuntime(saved, cwd, (await getSdk()).getAgentDir(),
        JSON.stringify(await projects.context(saved, cwd)));
    assert.equal(runtime.instructions, b.instructions);
    assert.equal((await store.listSessions(cwd)).find(session => session.id === original.id).assistantProject.id, b.id);
    await assert.rejects(service.change(cwd, original.id, input(snapshot, a.id)), /分类已变化/);
    const fork = await store.forkSession(changed.session, { entries: saved.getEntries(), leafId: saved.getLeafId() });
    assert.equal(fork.session.assistantProject.id, b.id);
    const cleared = await service.change(cwd, original.id, input(await service.inspect(cwd, original.id), null));
    assert.equal(cleared.session.assistantProject, null);
    saved = SessionManager.open(original.path);
    const clearedFork = await store.forkSession(cleared.session, { entries: saved.getEntries(), leafId: saved.getLeafId() });
    assert.equal(clearedFork.session.assistantProject, null); assert.equal(clearedFork.session.agentProfile.id, profile.id);
    const current = await service.inspect(cwd, original.id);
    assert.equal((await service.change(cwd, original.id, input(current, null))).changed, false);
    const unclassified = await store.createSession(cwd, 'Unclassified', { agentProfileId: profile.id });
    assert.equal((await service.change(cwd, unclassified.id, input(await service.inspect(cwd, unclassified.id), a.id))).session.assistantProject.id, a.id);
    await saveProject('Registry changed');
    await assert.rejects(service.change(cwd, original.id, input(current, a.id)), /分类已变化/);

    let disposed = false;
    const worker = { isIdle: () => false, retainsBackgroundWork: () => false, exclusive: async operation => operation(), dispose: async () => { disposed = true; } };
    supervisor.workers.set(original.path, worker);
    const fresh = await service.inspect(cwd, original.id);
    await assert.rejects(service.change(cwd, original.id, input(fresh, a.id)), /空闲/); assert.equal(disposed, false);
    worker.isIdle = () => true;
    assert.equal((await service.change(cwd, original.id, input(fresh, a.id))).session.assistantProject.id, a.id);
    assert.equal(disposed, true); assert.equal(supervisor.getActiveWorker(original.path), undefined);
    saved = SessionManager.open(original.path); saved.branch(user);
    assert.equal(readProjectBinding(saved).projectId, a.id, 'tree navigation never reverts session-wide classification');

    // A second legacy binding still fails closed; it is not a reclassification.
    saved.appendCustomEntry(PROJECT_ENTRY, { version: 1, sessionId: original.id, projectId: b.id, cwd });
    assert.equal(readProjectAssignment(saved).valid, false);
    await assert.rejects(service.inspect(cwd, original.id), /冲突/);
    const unclassifiedManager = SessionManager.open(clearedFork.session.path);
    unclassifiedManager.appendCustomEntry(PROJECT_CHANGE_ENTRY, { version: 1, sessionId: clearedFork.session.id, cwd, previousRevision: 'forged', previousProjectId: null, projectId: a.id });
    assert.equal(readProjectBinding(unclassifiedManager), null);
    assert.equal(readProjectAssignment(unclassifiedManager).valid, false);

    gateway = require('../server/pi-agent-routes').createPiAgentGateway({
        accessService: new (require('../server/workspace-access-service').WorkspaceAccessService)({ envToken: () => 'classification-fixture' }),
        deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    server = require('node:http').createServer(app); gateway.attachWebSocket(server);
    server.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/pi`, url = base + `/sessions/${unclassified.id}/classification`;
    const headers = { Authorization: 'Bearer classification-fixture', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '?cwd=' + encodeURIComponent(cwd))).status, 401);
    assert.equal((await (await fetch(base + '/status', { headers })).json()).sessionClassification, true);
    const get = await fetch(url + '?cwd=' + encodeURIComponent(cwd), { headers }); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store');
    const state = await get.json(), eventsByClient = [[], []];
    const { WebSocket } = require('ws');
    const rpc = (client, type, params = {}) => new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => { client.off('message', onMessage); reject(new Error('Fixture RPC timeout: ' + type)); }, 20000);
        const onMessage = raw => { const event = JSON.parse(raw); if (event.id !== requestId) return;
            clearTimeout(timer); client.off('message', onMessage); event.success ? resolve(event.data) : reject(new Error(event.error)); };
        client.on('message', onMessage); client.send(JSON.stringify({ id: requestId, type, token: 'classification-fixture', ...params }));
    });
    for (let i = 0; i < 2; i++) {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws'); clients.push(ws);
        await require('node:events').once(ws, 'open'); ws.on('message', raw => eventsByClient[i].push(JSON.parse(raw)));
        await rpc(ws, 'open_session', { cwd, sessionId: unclassified.id });
    }
    const previousWorker = gateway.supervisor.getActiveWorker(unclassified.path);
    assert.equal(previousWorker.loadedAssistantProjectId, a.id);
    const closed = clients.map(client => require('node:events').once(client, 'close'));
    const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(input(state, b.id)) });
    assert.equal(put.status, 200); assert.equal((await put.json()).session.assistantProject.id, b.id);
    for (const closing of closed) assert.equal((await closing)[0], 1012);
    assert.equal(previousWorker.disposed, true);
    for (const events of eventsByClient) assert.equal(events.find(event => event.type === 'gateway_session_classified').session.assistantProject.id, b.id);
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws'); clients.push(ws); await require('node:events').once(ws, 'open');
    const reopened = await rpc(ws, 'open_session', { cwd, sessionId: unclassified.id });
    assert.equal(reopened.session.assistantProject.id, b.id);
    const configuration = await rpc(ws, 'get_runtime_configuration');
    assert.equal(configuration.assistantProject.loadedProjectId, b.id);
    assert.equal(configuration.assistantProject.matchesSavedProject, true);
    assert.notEqual(gateway.supervisor.getActiveWorker(unclassified.path), previousWorker);
    const stale = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(input(state, a.id)) });
    assert.equal(stale.status, 409);
});

test('metadata edit reservation blocks reconnection/removal/move and maintenance until the operation settles', async t => {
    const supervisor = new PiAgentSupervisor(); t.after(() => supervisor.dispose());
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const operation = supervisor.withSessionEdit('synthetic', async () => { entered(); await new Promise(resolve => { release = resolve; }); return 'saved'; });
    await ready;
    assert.equal(supervisor.isIdle(), false); assert.equal(supervisor.isSessionIdle('synthetic'), false);
    await assert.rejects(supervisor.getWorker({ sessionPath: 'synthetic' }), /metadata/);
    await assert.rejects(supervisor.withSessionRemoval('synthetic', () => {}), /metadata/);
    await assert.rejects(supervisor.withSessionMove('synthetic', 'target', () => {}), /already in progress/);
    await assert.rejects(supervisor.withSessionEdit('synthetic', () => {}), /其他操作/);
    release(); assert.equal(await operation, 'saved'); assert.equal(supervisor.isIdle(), true);
});
