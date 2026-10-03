const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-assistant-projects-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work'), other = path.join(root, 'elsewhere');
for (const dir of [agentDir, cwd, other]) fs.mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { PROJECT_ENTRY, readProjectBinding } = require('../server/pi-assistant-project-state');
const { readProfileBinding } = require('../server/pi-profile-state');
const { readProjectRuntime, registerAssistantProject } = require('../server/pi-assistant-project-runtime');
const { readProjectRegistry } = require('../server/pi-assistant-project-registry');

const profile = name => ({ name, description: '', soul: '', enabled: true, memory: { enabled: false, autoLearn: false }, skills: { learnedEnabled: true } });
const project = (name, profileIds, location = cwd) => ({ name, cwd: location, description: '', instructions: 'Synthetic group instruction', profileIds, archived: false });

test('logical projects: CAS, native binding, filtered sessions, runtime and lifecycle', { timeout: 30000 }, async t => {
    let gateway, server;
    t.after(async () => {
        await gateway?.dispose();
        server?.closeAllConnections();
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const old = await new (require('../server/pi-session-store').PiSessionStore)().createSession(cwd, 'Old unclassified');
    gateway = createPiAgentGateway({ accessService: new WorkspaceAccessService({ envToken: () => 'synthetic-test-token' }),
        deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/pi`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
    };
    const { SessionManager, getAgentDir } = await import('@earendil-works/pi-coding-agent');
    const initial = await call('GET', '/assistant-projects');
    assert.deepEqual(initial.data.projects, []);
    assert.equal((await call('GET', '/status')).data.assistantProjects, true);
    const savedProfile = await call('PUT', '/profiles', { expectedRevision: (await call('GET', '/profiles')).data.revision, profile: profile('Primary') });
    const firstProfile = savedProfile.data.profile.id;
    const secondProfile = (await call('PUT', '/profiles', { expectedRevision: savedProfile.data.revision, profile: profile('Secondary') })).data.profile.id;
    const one = await call('PUT', '/assistant-projects', { expectedRevision: initial.data.revision, project: project('One', [firstProfile]) });
    assert.equal(one.status, 200); assert.equal(one.cache, 'no-store');
    assert.equal((await call('PUT', '/assistant-projects', { expectedRevision: initial.data.revision, project: project('Stale', [firstProfile]) })).status, 409);
    const two = await call('PUT', '/assistant-projects', { expectedRevision: one.data.revision, project: project('Two', [secondProfile]) });
    const raced = await Promise.all([call('PUT', '/assistant-projects', { expectedRevision: two.data.revision,
        project: project('Concurrent A', [firstProfile]) }), call('PUT', '/assistant-projects', { expectedRevision: two.data.revision,
        project: project('Concurrent B', [firstProfile]) })]);
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
    const currentRevision = raced.find(result => result.status === 200).data.revision;
    const archived = await call('PUT', '/assistant-projects', { expectedRevision: currentRevision,
        project: { ...two.data.project, archived: true } });
    assert.equal(archived.status, 200);
    assert.equal((await call('POST', '/sessions', { cwd, profileId: secondProfile, assistantProjectId: two.data.project.id })).status, 400);
    assert.equal(two.status, 200); assert.equal(one.data.project.cwd, two.data.project.cwd);
    assert.deepEqual(new Set((await call('GET', `/assistant-projects?profileId=${firstProfile}`)).data.projects.map(p => p.id)),
        new Set([one.data.project.id, raced.find(result => result.status === 200).data.project.id]));
    assert.equal((await call('GET', '/assistant-projects?profileId=invalid')).status, 400);
    const count = () => SessionManager.list(cwd).then(sessions => sessions.length);
    const before = await count();
    for (const input of [
        { assistantProjectId: one.data.project.id },
        { assistantProjectId: one.data.project.id, profileId: null },
        { assistantProjectId: one.data.project.id, profileId: secondProfile },
        { assistantProjectId: randomUUID(), profileId: firstProfile },
        { assistantProjectId: one.data.project.id, profileId: firstProfile, cwd: other }
    ]) {
        assert.equal((await call('POST', '/sessions', { cwd, ...input })).status, 400);
    }
    assert.equal(await count(), before, 'all invalid grouped requests fail before creating a native session');
    const created = await call('POST', '/sessions', { cwd, profileId: firstProfile, assistantProjectId: one.data.project.id });
    assert.equal(created.status, 201);
    const source = SessionManager.open(created.data.path);
    assert.deepEqual(readProjectBinding(source), { sessionId: created.data.id, projectId: one.data.project.id, cwd });
    assert.equal(created.data.agentProfile.id, firstProfile);
    assert.equal(created.data.assistantProject.name, 'One');
    assert.equal((await gateway.store.getSession(cwd, old.id)).assistantProject, null);
    assert.deepEqual((await call('GET', `/assistant-projects/${one.data.project.id}/sessions?profileId=${firstProfile}`)).data.sessions.map(s => s.id), [created.data.id]);
    assert.deepEqual((await call('GET', `/assistant-projects/${two.data.project.id}/sessions?profileId=${firstProfile}`)).data.sessions, []);
    assert.deepEqual((await call('GET', `/assistant-projects/${one.data.project.id}/sessions?profileId=${secondProfile}`)).data.sessions, []);
    assert.equal((await call('GET', '/sessions?cwd=' + encodeURIComponent(cwd))).data.sessions.length, before + 1);
    const initialized = await gateway.store.createSession(cwd, 'Internal hook', { agentProfileId: null,
        initializeSession: manager => manager.appendCustomEntry('synthetic-internal', { sessionId: manager.getSessionId() }) });
    const initialEntries = SessionManager.open(initialized.path).getEntries();
    assert.equal(initialEntries.find(entry => entry.customType === 'synthetic-internal').data.sessionId, initialized.id);
    assert.equal(readProfileBinding(SessionManager.open(initialized.path)).profileId, null);
    assert.equal((await call('POST', '/sessions', { cwd, initializeSession: 'untrusted' })).data.assistantProject, null);
    const ctx = JSON.parse((await gateway.supervisor.workerEnvironment({ cwd, sessionId: created.data.id, sessionPath: created.data.path })).PIVANE_ASSISTANT_PROJECT_CONTEXT);
    assert.equal(ctx.instructions, one.data.project.instructions);
    assert.equal(readProjectRuntime(source, cwd, getAgentDir(), JSON.stringify(ctx)).instructions, ctx.instructions);
    assert.equal(readProjectRuntime(source, other, getAgentDir(), JSON.stringify(ctx)), null);
    const handlers = new Map();
    registerAssistantProject({ on: (name, handler) => handlers.set(name, handler) }, getAgentDir);
    process.env.PIVANE_ASSISTANT_PROJECT_CONTEXT = JSON.stringify(ctx);
    process.env.PI_WEB_NAVIGATION_TOKEN = 'synthetic-navigation-token';
    try {
        const notices = [];
        handlers.get('session_start')({}, { mode: 'rpc', sessionManager: source, cwd, ui: { notify: message => notices.push(JSON.parse(message)) } });
        assert.equal(notices[0].pivaneAssistantProjectLoaded, one.data.project.id);
        const prompt = handlers.get('before_agent_start')({ systemPrompt: 'Native base' }, { mode: 'rpc', sessionManager: source, cwd });
        assert.match(prompt.systemPrompt, /Native base/); assert.match(prompt.systemPrompt, /Synthetic group instruction/);
    } finally { delete process.env.PIVANE_ASSISTANT_PROJECT_CONTEXT; delete process.env.PI_WEB_NAVIGATION_TOKEN; }
    source.appendMessage({ role: 'user', content: 'Question', timestamp: 1 });
    const point = source.getEntries().at(-1).id;
    const early = await gateway.store.forkSession(created.data, { entries: source.getEntries(), leafId: source.getLeafId() }, undefined);
    assert.deepEqual(readProjectBinding(SessionManager.open(early.session.path)), { sessionId: early.session.id, projectId: one.data.project.id, cwd });
    const reply = source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Answer' }], api: 'openai-completions', provider: 'synthetic', model: 'synthetic', stopReason: 'stop', timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const late = await gateway.store.forkSession(created.data, { entries: source.getEntries(), leafId: source.getLeafId() }, reply, 'at');
    assert.deepEqual(readProjectBinding(SessionManager.open(late.session.path)), { sessionId: late.session.id, projectId: one.data.project.id, cwd });
    assert.equal(readProfileBinding(SessionManager.open(late.session.path)).profileId, firstProfile);
    const transfer = new (require('../server/pi-session-transfer').PiSessionTransfer)({ store: gateway.store,
        supervisor: { getWorker() { throw Error('unexpected worker'); } } });
    const imported = await transfer.import(other, fs.readFileSync(created.data.path, 'utf8'), 'projects-import-synthetic-0001');
    assert.equal(readProjectBinding(SessionManager.open(imported.session.path)), null);
    assert.equal(imported.session.assistantProject, null);
    const emptyFork = await gateway.store.forkSession(created.data, { entries: source.getEntries(), leafId: source.getLeafId() }, point, 'before');
    assert.equal(readProjectBinding(SessionManager.open(emptyFork.session.path)).projectId, one.data.project.id);
    const copied = { getSessionId: () => old.id, getCwd: () => cwd, getEntries: () => source.getEntries() };
    assert.equal(readProjectBinding(copied), null, 'copied foreign-ID markers are inert');
    source.appendCustomEntry(PROJECT_ENTRY, { version: 1, sessionId: source.getSessionId(), projectId: two.data.project.id, cwd });
    assert.equal(readProjectBinding(source), null, 'multiple current-ID markers fail closed');
    assert.equal((await gateway.store.getSession(cwd, created.data.id)).assistantProject, null);
    source.appendCustomEntry(PROJECT_ENTRY, { version: 2, sessionId: source.getSessionId(), projectId: one.data.project.id, cwd });
    assert.equal(readProjectBinding(source), null, 'malformed current-ID marker cannot restore a binding');
    const stored = path.join(agentDir, 'pivane-profiles', 'assistant-projects.json');
    const original = JSON.parse(fs.readFileSync(stored, 'utf8'));
    original.extra = { kept: true }; original.projects[0].otherField = 7;
    fs.writeFileSync(stored, JSON.stringify(original));
    const retained = await call('PUT', '/assistant-projects', { expectedRevision: (await call('GET', '/assistant-projects')).data.revision,
        project: { ...one.data.project, name: 'Renamed' } });
    assert.equal(retained.data.project.otherField, 7);
    assert.deepEqual(JSON.parse(fs.readFileSync(stored, 'utf8')).extra, { kept: true });
    assert.equal((await call('PUT', '/assistant-projects', { expectedRevision: retained.data.revision,
        project: { ...retained.data.project, cwd: other } })).status, 400);
    if (process.platform !== 'win32') {
        const moved = stored + '.moved';
        fs.renameSync(stored, moved); fs.symlinkSync(moved, stored);
        try { assert.notEqual((await call('GET', '/assistant-projects')).status, 200); }
        finally { fs.unlinkSync(stored); fs.renameSync(moved, stored); }
        const originalRead = fs.readSync;
        let switched = false;
        fs.readSync = (...args) => {
            const result = originalRead(...args);
            if (!switched && require('../server/pi-file-descriptor').descriptorPathSync(args[0]) === stored) {
                switched = true; fs.renameSync(stored, moved); fs.copyFileSync(moved, stored);
            }
            return result;
        };
        try { assert.throws(() => readProjectRegistry(stored), error => error.status === 409); }
        finally { fs.readSync = originalRead; fs.unlinkSync(stored); fs.renameSync(moved, stored); }
        assert.equal(switched, true);
        const privateFiles = require('../server/pi-private-files');
        const originalWrite = privateFiles.writePrivateFileSync;
        const directory = path.dirname(stored), movedDirectory = directory + '.moved';
        let parentSwitched = false;
        privateFiles.writePrivateFileSync = (...args) => {
            originalWrite(...args);
            if (!parentSwitched && args[0].startsWith(stored + '.') && args[0].endsWith('.tmp')) {
                parentSwitched = true;
                fs.renameSync(directory, movedDirectory);
                fs.mkdirSync(directory, { mode: 0o700 });
                fs.copyFileSync(path.join(movedDirectory, 'assistant-projects.json'), stored);
            }
        };
        try {
            await assert.rejects(gateway.store.projects.save({ expectedRevision: (await gateway.store.projects.state()).revision,
                project: project('Blocked replacement', [firstProfile]) }), error => error.status === 409);
        } finally {
            privateFiles.writePrivateFileSync = originalWrite;
            fs.rmSync(directory, { recursive: true, force: true });
            fs.rmSync(path.join(movedDirectory, 'assistant-projects.lock'), { recursive: true, force: true });
            fs.renameSync(movedDirectory, directory);
        }
        assert.equal(parentSwitched, true);
        assert.equal((await gateway.store.projects.list()).projects.some(p => p.name === 'Blocked replacement'), false);
    }
    const registry = gateway.store.projects;
    const originalPaths = registry.paths.bind(registry);
    let release;
    registry.paths = create => create ? new Promise(resolve => { release = () => resolve(originalPaths(create)); }) : originalPaths(create);
    const pending = registry.save({ expectedRevision: (await registry.state()).revision, project: project('Reserved', [firstProfile]) });
    assert.equal(gateway.store.profiles.busy, true);
    assert.equal((await call('GET', '/activity')).data.profilesBusy, true);
    assert.equal((await call('GET', '/activity')).data.nativeSettingsBusy, true);
    assert.equal((await call('PUT', '/profiles', { expectedRevision: savedProfile.data.revision, profile: profile('Blocked') })).status, 409);
    let disposed = false;
    const disposing = registry.profiles.dispose().then(() => { disposed = true; });
    await Promise.resolve(); assert.equal(disposed, false);
    release(); registry.paths = originalPaths;
    await pending; await disposing;
    assert.equal(disposed, true);
    assert.throws(() => registry.save({ expectedRevision: 'stale', project: project('Stopped', [firstProfile]) }), error => error.status === 409);
});
