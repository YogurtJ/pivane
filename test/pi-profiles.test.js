const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-profiles-test-')));
const agentDir = path.join(root, 'agent');
const first = path.join(root, 'a', 'same');
const second = path.join(root, 'b', 'same');
for (const dir of [agentDir, first, second]) fs.mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { PROFILE_ENTRY, readProfileBinding } = require('../server/pi-profile-state');
const { readProfileRuntime, registerAgentProfile } = require('../server/pi-profile-runtime');
const { profileRevision } = require('../server/pi-profile-registry');
const { PiSessionTransfer } = require('../server/pi-session-transfer');

test('revisioned HTTP, native immutable bindings, fork/import, and verified runtime context', { timeout: 30000 }, async t => {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const legacyStore = new (require('../server/pi-session-store').PiSessionStore)();
    const old = await legacyStore.createSession(first, 'Before profiles');
    const access = new WorkspaceAccessService({ envToken: () => 'synthetic-test-token' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const express = require('express'), app = express(); app.use(express.json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`;
    const call = async (method, url, body, headers = {}) => {
        const response = await fetch(base + url, { method, headers: { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
    };
    const { SessionManager, getAgentDir } = await import('@earendil-works/pi-coding-agent');
    const sessionsRoot = path.join(fs.realpathSync.native(getAgentDir()), 'sessions');
    assert.equal(readProfileBinding(SessionManager.open(old.path)), null);
    const start = await call('GET', '/profiles');
    assert.equal(start.status, 200); assert.equal(start.data.cwd, null); assert.equal(start.data.defaultProfileId, null);
    assert.equal((await call('GET', '/status')).data.agentProfiles, true);
    const body = { expectedRevision: start.data.revision, profile: { name: 'Study', description: '', soul: 'Synthetic study guidance', enabled: true,
        memory: { enabled: false, autoLearn: false }, skills: { learnedEnabled: true } } };
    assert.equal((await call('PUT', '/profiles', body, { Origin: 'https://evil.invalid' })).status, 403);
    const saved = await call('PUT', '/profiles', body);
    assert.equal(saved.status, 200); assert.equal(saved.cache, 'no-store');
    const id = saved.data.profile.id;
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal((await call('PUT', '/profiles', body)).status, 409);
    assert.equal((await call('PUT', '/profiles/default', { cwd: first, profileId: id, expectedRevision: saved.data.revision })).status, 200);
    const state = await call('GET', '/profiles?cwd=' + encodeURIComponent(first));
    assert.equal(state.data.defaultProfileId, id);
    const empty = await call('POST', '/sessions', { cwd: first, name: 'none', profileId: null });
    assert.equal(empty.data.agentProfile, null);
    assert.equal(readProfileBinding(SessionManager.open(empty.data.path)).profileId, null);
    const selected = await call('POST', '/sessions', { cwd: first, name: 'selected' });
    assert.equal(selected.data.agentProfile.id, id);
    assert.equal((await gateway.store.getSession(first, old.id)).agentProfile, null, 'old sessions never adopt a default');
    let bound = SessionManager.open(selected.data.path);
    assert.deepEqual(readProfileBinding(bound), { sessionId: selected.data.id, profileId: id });
    assert.equal(readProfileBinding({ getSessionId: () => old.id, getEntries: () => bound.getEntries() }), null);
    const context = JSON.parse((await gateway.supervisor.workerEnvironment({ cwd: first, sessionId: selected.data.id, sessionPath: selected.data.path })).PIVANE_AGENT_PROFILE_CONTEXT);
    assert.equal(context.profileId, id); assert.equal(context.memory.enabled, false);
    assert.equal(context.sessionsRoot, sessionsRoot);
    assert.equal(readProfileRuntime(bound, first, getAgentDir(), sessionsRoot, JSON.stringify(context)).soul, body.profile.soul);
    assert.equal(readProfileRuntime(bound, second, getAgentDir(), sessionsRoot, JSON.stringify(context)), null);
    assert.equal(readProfileRuntime(bound, first, getAgentDir(), sessionsRoot, JSON.stringify({ ...context, profileId: '00000000-0000-0000-0000-000000000000' })), null);
    const handlers = new Map();
    registerAgentProfile({ on: (event, handler) => handlers.set(event, handler) }, getAgentDir);
    process.env.PI_WEB_NAVIGATION_TOKEN = 'synthetic-runtime-token';
    process.env.PIVANE_AGENT_PROFILE_CONTEXT = JSON.stringify(context);
    try {
        const notices = [];
        const ui = { notify: message => notices.push(JSON.parse(message)) };
        handlers.get('session_start')({}, { mode: 'rpc', sessionManager: bound, cwd: first, ui });
        assert.deepEqual(notices[0], { pivaneAgentProfileLoaded: id,
            profileRevision: profileRevision(saved.data.profile), sessionId: selected.data.id });
        const appended = handlers.get('before_agent_start')({ systemPrompt: 'Pi base prompt and project instructions' },
            { mode: 'rpc', sessionManager: bound, cwd: first });
        assert.match(appended.systemPrompt, /Pi base prompt and project instructions/);
        assert.match(appended.systemPrompt, /Synthetic study guidance/);
        handlers.get('session_start')({}, { mode: 'rpc', sessionManager: SessionManager.open(old.path), cwd: first, ui });
        assert.equal(handlers.get('before_agent_start')({ systemPrompt: 'Base' },
            { mode: 'rpc', sessionManager: SessionManager.open(old.path), cwd: first }), undefined);
    } finally { delete process.env.PI_WEB_NAVIGATION_TOKEN; delete process.env.PIVANE_AGENT_PROFILE_CONTEXT; }
    assert.equal((await gateway.supervisor.workerEnvironment({ cwd: first, sessionId: old.id, sessionPath: old.path })).PIVANE_AGENT_PROFILE_CONTEXT, undefined);
    const requests = [];
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part;
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const worker = await gateway.supervisor.getWorker({ cwd: first, sessionId: selected.data.id, sessionPath: selected.data.path });
    assert.equal(worker.loadedAgentProfileId, id);
    assert.equal(worker.loadedAgentProfileRevision, profileRevision(saved.data.profile));
    assert.equal(worker.loadedAgentProfileConfirmed, true);
    const finished = new Promise(resolve => { const unsubscribe = worker.subscribe(event => { if (event.type === 'agent_settled') { unsubscribe(); resolve(); } }); });
    await worker.request('prompt', { message: 'Synthetic test only' });
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('Synthetic provider did not settle')), 12000))]);
    assert.match(JSON.stringify(requests[0]?.messages), /Synthetic study guidance/);
    assert.match(JSON.stringify(requests[0]?.messages), /Synthetic test only/);
    const originalWorker = await gateway.supervisor.getWorker({ cwd: first, sessionId: old.id, sessionPath: old.path });
    assert.equal(originalWorker.loadedAgentProfileId, null);
    assert.equal(originalWorker.loadedAgentProfileConfirmed, true);
    assert.equal(originalWorker.client.env.PIVANE_AGENT_PROFILE_CONTEXT, undefined);
    await gateway.supervisor.stopSession(selected.data.path);
    bound = SessionManager.open(selected.data.path);
    const secondSession = (await call('POST', '/sessions', { cwd: second, profileId: id })).data;
    assert.equal(secondSession.agentProfile.id, id, 'profile spans projects with identical basenames');
    const secondWorker = await gateway.supervisor.getWorker({ cwd: second, sessionId: secondSession.id, sessionPath: secondSession.path });
    assert.equal(secondWorker.loadedAgentProfileId, id);
    assert.equal((await call('POST', '/sessions', { cwd: first, profileId: 'absent' })).status, 400);
    assert.equal((await call('PUT', '/profiles/default', { cwd: second, profileId: 'absent', expectedRevision: state.data.revision })).status, 400);

    // Both native branching paths need one marker under the NEW session ID.
    const branchPoint = bound.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user').id;
    const snapshot = { entries: bound.getEntries(), leafId: bound.getLeafId() };
    const early = await gateway.store.forkSession(selected.data, snapshot, branchPoint, 'at').catch(() => null);
    // The workflow requires a completed reply for 'at'; fork before the user message instead.
    assert.equal(early, null);
    const fork = await gateway.store.forkSession(selected.data, snapshot, branchPoint, 'before');
    const forkManager = SessionManager.open(fork.session.path);
    assert.equal(readProfileBinding(forkManager).profileId, id);
    assert.equal(readProfileBinding(forkManager).sessionId, fork.session.id);
    const replyPoint = snapshot.entries.find(entry => entry.type === 'message' && entry.message.role === 'assistant').id;
    const late = await gateway.store.forkSession(selected.data, snapshot, replyPoint, 'at');
    assert.deepEqual(readProfileBinding(SessionManager.open(late.session.path)), { sessionId: late.session.id, profileId: id });
    const transfer = new PiSessionTransfer({ store: gateway.store, supervisor: { getWorker() { throw Error('no worker'); } } });
    const copied = await transfer.import(second, fs.readFileSync(selected.data.path, 'utf8'), 'profile-import-request-0001');
    assert.equal(readProfileBinding(SessionManager.open(copied.session.path)), null, 'copied marker must not bind imported new ID');
    assert.equal(copied.session.agentProfile, null);
    bound.appendCustomEntry(PROFILE_ENTRY, { version: 1, sessionId: bound.getSessionId(), profileId: null });
    assert.equal(readProfileBinding(bound), null, 'conflicting markers fail closed');
    assert.equal((await gateway.supervisor.workerEnvironment({ cwd: first, sessionId: selected.data.id, sessionPath: selected.data.path })).PIVANE_AGENT_PROFILE_CONTEXT, undefined);
    assert.equal((await call('PUT', '/profiles/default', { cwd: first, profileId: null, expectedRevision: state.data.revision })).status, 200);
    const updated = await call('GET', '/profiles');
    const flagsChanged = await call('PUT', '/profiles', { expectedRevision: updated.data.revision,
        profile: { ...saved.data.profile, memory: { enabled: true, autoLearn: false } } });
    assert.equal(flagsChanged.status, 200);
    assert.equal(secondWorker.loadedAgentProfileId, id, 'saving flags does not reconfigure a running worker');
    assert.notEqual(secondWorker.loadedAgentProfileRevision, profileRevision(flagsChanged.data.profile));
    assert.equal(readProfileRuntime(forkManager, first, getAgentDir(), sessionsRoot,
        JSON.stringify({ ...context, sessionId: fork.session.id })), null, 'stale environment flags fail closed on a fresh load');
    const disabled = await call('PUT', '/profiles', { expectedRevision: flagsChanged.data.revision, profile: { ...flagsChanged.data.profile, enabled: false } });
    assert.equal(disabled.status, 200);
    assert.equal(secondWorker.loadedAgentProfileId, id, 'saving a disabled profile does not reconfigure an existing worker');
    assert.notEqual(secondWorker.loadedAgentProfileRevision, profileRevision(disabled.data.profile));
    assert.equal((await gateway.store.getSession(first, fork.session.id)).agentProfile.available, false);
    assert.equal((await gateway.supervisor.workerEnvironment({ cwd: first, sessionId: fork.session.id, sessionPath: fork.session.path })).PIVANE_AGENT_PROFILE_CONTEXT, undefined);
    assert.equal(readProfileRuntime(forkManager, first, getAgentDir(), sessionsRoot, JSON.stringify({ ...context, sessionId: fork.session.id })), null);
    assert.equal((await call('POST', '/sessions', { cwd: first, profileId: id })).status, 400);
    assert.equal((await call('GET', '/profiles')).data.profiles[0].soul, body.profile.soul, 'disabled profile data is retained');
    const current = await call('GET', '/profiles');
    const minimal = { name: 'Development', description: '', soul: '', enabled: true };
    const writes = await Promise.all([call('PUT', '/profiles', { expectedRevision: current.data.revision, profile: minimal }),
        call('PUT', '/profiles', { expectedRevision: current.data.revision, profile: minimal })]);
    assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
    const created = writes.find(result => result.status === 200).data.profile;
    assert.deepEqual(created.memory, { enabled: false, autoLearn: false });
    assert.deepEqual(created.skills, { learnedEnabled: true });
    assert.equal((await call('GET', '/profiles')).data.profiles.length, 2);
    assert.equal((await gateway.store.profiles.getProfile(id)).enabled, false);
    assert.equal(await gateway.store.profiles.getProfile('not-an-id'), null);
    assert.equal(await gateway.store.profiles.getProfile('00000000-0000-0000-0000-000000000000'), null);
    const registryService = gateway.store.profiles;
    const originalPaths = registryService.paths.bind(registryService);
    let releasePaths;
    registryService.paths = create => create ? new Promise(resolve => { releasePaths = () => resolve(originalPaths(create)); }) : originalPaths(create);
    const mutation = registryService.save({ expectedRevision: (await registryService.state()).revision, profile: minimal });
    try {
        assert.equal(registryService.busy, true, 'mutation reserves before the first await');
        assert.equal((await call('GET', '/activity')).data.profilesBusy, true);
        assert.equal((await call('GET', '/activity')).data.nativeSettingsBusy, true);
        assert.equal((await call('PUT', '/settings/native', { cwd: first, scope: 'global', expectedRevision: 'stale', values: {} })).status, 409);
        assert.throws(() => registryService.saveDefault({ cwd: first, profileId: null, expectedRevision: 'stale' }), error => error.status === 409);
        const blocked = gateway.store.profiles.maintenance;
        blocked.managed = true; blocked.state.supported = true;
        assert.throws(() => blocked.assertAvailable('backup', () => !registryService.busy), /任务|busy/i);
        blocked.managed = false; blocked.state.supported = false;
    } finally { releasePaths?.(); registryService.paths = originalPaths; }
    await mutation;
    assert.equal(registryService.busy, false);
    const blocked = gateway.store.profiles.maintenance;
    blocked.locked = true;
    const lockedRevision = (await registryService.state()).revision;
    assert.throws(() => registryService.save({ expectedRevision: lockedRevision, profile: minimal }), error => error.status === 409);
    blocked.locked = false;
    const missingNative = await legacyStore.createSession(first, 'missing binding');
    SessionManager.open(missingNative.path).appendCustomEntry(PROFILE_ENTRY,
        { version: 1, sessionId: missingNative.id, profileId: '00000000-0000-0000-0000-000000000000' });
    const missing = SessionManager.open(missingNative.path);
    assert.equal((await registryService.describe(missing)).available, false);
    assert.equal((await gateway.store.getSession(first, missingNative.id)).agentProfile.available, false);
    assert.equal(await registryService.context(missing, first), null);
    const malformed = SessionManager.open(fork.session.path);
    malformed.appendCustomEntry(PROFILE_ENTRY, { version: 2, sessionId: malformed.getSessionId(), profileId: id });
    assert.equal(readProfileBinding(malformed), null);
    assert.equal((await registryService.describe(malformed)), null);
    if (process.platform !== 'win32') {
        const registry = path.join(agentDir, 'pivane-profiles', 'profiles.json');
        const directory = path.dirname(registry), moved = registry + '.synthetic';
        const originalRead = fs.readSync;
        let switched = false;
        fs.readSync = (...args) => {
            const result = originalRead(...args);
            if (!switched && require('../server/pi-file-descriptor').descriptorPathSync(args[0]) === registry) {
                switched = true;
                fs.renameSync(registry, moved);
                fs.copyFileSync(moved, registry);
            }
            return result;
        };
        try { assert.throws(() => require('../server/pi-profile-registry').readRegistry(registry), error => error.status === 409); }
        finally { fs.readSync = originalRead; fs.unlinkSync(registry); fs.renameSync(moved, registry); }
        assert.equal(switched, true);
        let removed = false;
        fs.readSync = (...args) => {
            const result = originalRead(...args);
            if (!removed && require('../server/pi-file-descriptor').descriptorPathSync(args[0]) === registry) {
                removed = true;
                fs.renameSync(registry, moved);
            }
            return result;
        };
        try { assert.throws(() => require('../server/pi-profile-registry').readRegistry(registry), error => error.status === 409); }
        finally { fs.readSync = originalRead; fs.renameSync(moved, registry); }
        assert.equal(removed, true);
        const privateFiles = require('../server/pi-private-files');
        const originalWrite = privateFiles.writePrivateFileSync;
        const movedDirectory = directory + '.moved';
        let parentSwitched = false;
        privateFiles.writePrivateFileSync = (...args) => {
            originalWrite(...args);
            if (!parentSwitched && args[0].startsWith(registry + '.') && args[0].endsWith('.tmp')) {
                parentSwitched = true;
                fs.renameSync(directory, movedDirectory);
                fs.mkdirSync(directory, { mode: 0o700 });
                fs.copyFileSync(path.join(movedDirectory, 'profiles.json'), registry);
            }
        };
        try {
            await assert.rejects(registryService.save({ expectedRevision: (await registryService.state()).revision, profile: minimal }), error => error.status === 409);
        } finally {
            privateFiles.writePrivateFileSync = originalWrite;
            fs.rmSync(directory, { recursive: true, force: true });
            fs.rmSync(path.join(movedDirectory, 'profiles.lock'), { recursive: true, force: true });
            fs.renameSync(movedDirectory, directory);
        }
        assert.equal(parentSwitched, true);
        assert.equal((await registryService.state()).state.profiles.length, 3, 'parent replacement did not publish a fourth profile');
        const movedSession = empty.data.path + '.synthetic';
        fs.renameSync(empty.data.path, movedSession);
        fs.symlinkSync(movedSession, empty.data.path);
        try { await assert.rejects(gateway.store.getSession(first, empty.data.id), /Session file changed|Session not found/); }
        finally { fs.unlinkSync(empty.data.path); fs.renameSync(movedSession, empty.data.path); }
        const movedFile = registry + '.synthetic';
        fs.renameSync(registry, movedFile);
        fs.symlinkSync(movedFile, registry);
        assert.notEqual((await call('GET', '/profiles')).status, 200, 'symlink registry must not be followed');
        fs.unlinkSync(registry); fs.renameSync(movedFile, registry);
    }
    let releaseShutdown;
    registryService.paths = create => create ? new Promise(resolve => { releaseShutdown = () => resolve(originalPaths(create)); }) : originalPaths(create);
    const finishing = registryService.save({ expectedRevision: (await registryService.state()).revision, profile: minimal });
    let stopped = false;
    const shutdown = registryService.dispose().then(() => { stopped = true; });
    try {
        await Promise.resolve();
        assert.equal(stopped, false, 'shutdown waits for a reserved mutation');
        assert.throws(() => registryService.save({ expectedRevision: 'stale', profile: minimal }), error => error.status === 409);
    } finally { releaseShutdown?.(); registryService.paths = originalPaths; }
    await finishing;
    await shutdown;
    assert.equal(stopped, true);
});
