'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-profile-draft-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent;
const { mountProfileAuthoringRoutes, profileAuthoringEnvironment, readProfileAuthoring, DRAFT_ENTRY } = require('../server/pi-profile-authoring');
const { PROFILE_ENTRY } = require('../server/pi-profile-state');
const { profileRevision } = require('../server/pi-profile-registry');

test('native helper only drafts on current session ID; forks and ordinary workers remain ineligible', async t => {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const profile = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Existing' };
    const profiles = { getProfile: async id => id === profile.id ? profile : null,
        reserve: action => Promise.resolve().then(action) };
    const sessions = new Map();
    // Narrow stand-in for A's synchronous initializeSession seam, after header/binding.
    const store = { defaultProject: () => cwd, resolveProject: value => value === cwd ? value : (() => { throw Error('Invalid cwd'); })(),
        profileManager: (session, SessionManager) => SessionManager.open(session.path),
        async createSession(project, name, { agentProfileId, initializeSession }) {
            assert.equal(project, cwd); assert.equal(agentProfileId, null);
            const manager = SessionManager.create(project), file = manager.getSessionFile();
            fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
            const persisted = SessionManager.open(file, undefined, project);
            persisted.appendCustomEntry(PROFILE_ENTRY, { version: 1, sessionId: persisted.getSessionId(), profileId: null });
            initializeSession(persisted);
            const session = { id: persisted.getSessionId(), path: file, cwd: project, name }; sessions.set(session.id, session);
            return session;
        },
        async getSession(project, id) { assert.equal(project, cwd); const value = sessions.get(id); if (!value) throw Error('Session missing'); return value; } };
    const routes = new Map(), router = { post(key, fn) { routes.set(`POST ${key}`, fn); }, get(key, fn) { routes.set(`GET ${key}`, fn); } };
    mountProfileAuthoringRoutes(router, { store, profiles });
    async function call(method, route, { params = {}, body, query = {} } = {}) {
        const res = { statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
        await routes.get(`${method} ${route}`)({ params, body, query }, res); return res;
    }
    const created = await call('POST', '/profiles/authoring-sessions', { body: { profileId: profile.id, language: 'en', draft: { soul: 'Synthetic initial draft' } } });
    assert.equal(created.statusCode, 201, JSON.stringify(created.data));
    assert.match(created.data.prompt, /Synthetic initial draft/);
    const session = created.data.session, manager = SessionManager.open(session.path);
    assert.deepEqual(readProfileAuthoring(manager), { sessionId: session.id, profileId: profile.id, profileRevision: profileRevision(profile), language: 'en' });
    assert.equal((await profileAuthoringEnvironment({ store, cwd, sessionId: session.id })).PIVANE_PROFILE_AUTHORING_CONTEXT !== undefined, true);
    const draftRoute = '/profiles/authoring-sessions/:id/draft';
    const missing = await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } });
    assert.equal(missing.data.status, 'missing');
    manager.appendCustomEntry(DRAFT_ENTRY, { version: 1, sessionId: session.id, proposal: { name: 'Refined' } });
    const ready = await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } });
    assert.equal(ready.statusCode, 200, JSON.stringify(ready.data));
    assert.equal(ready.data.status, 'ready'); assert.deepEqual(ready.data.proposal, { name: 'Refined' });
    assert.equal(ready.data.profileRevision, profileRevision(profile));
    const priorEnv = process.env.PIVANE_PROFILE_AUTHORING_CONTEXT, priorToken = process.env.PI_WEB_NAVIGATION_TOKEN;
    t.after(() => {
        if (priorEnv === undefined) delete process.env.PIVANE_PROFILE_AUTHORING_CONTEXT; else process.env.PIVANE_PROFILE_AUTHORING_CONTEXT = priorEnv;
        if (priorToken === undefined) delete process.env.PI_WEB_NAVIGATION_TOKEN; else process.env.PI_WEB_NAVIGATION_TOKEN = priorToken;
    });
    const jitiPath = process.env.PIVANE_TEST_PI_JITI;
    if (jitiPath) {
        process.env.PIVANE_PROFILE_AUTHORING_CONTEXT = (await profileAuthoringEnvironment({ store, cwd, sessionId: session.id })).PIVANE_PROFILE_AUTHORING_CONTEXT;
        process.env.PI_WEB_NAVIGATION_TOKEN = 'synthetic-navigation';
        const { registerProfileAuthoring } = require(jitiPath).createJiti(path.join(__dirname, '../server/pi-profile-authoring-extension.ts'))(
            path.join(__dirname, '../server/pi-profile-authoring-extension.ts'));
        const handlers = new Map(), tools = new Map();
        const pi = { on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); },
            appendEntry(type, data) { manager.appendCustomEntry(type, data); } };
        registerProfileAuthoring(pi, () => agent);
        const context = { mode: 'rpc', cwd, sessionManager: manager };
        handlers.get('session_start')({}, context);
        assert.ok(tools.has('profile_draft'));
        await assert.rejects(tools.get('profile_draft').execute('call', { name: 'Test' }, undefined, undefined,
            { ...context, sessionManager: { ...manager, getSessionId: () => 'foreign' } }), /unavailable/);
        const toolResult = await tools.get('profile_draft').execute('call', { name: 'Native proposal' }, undefined, undefined, context);
        assert.match(toolResult.content[0].text, /No profile changes/);
        assert.deepEqual((await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } })).data.proposal, { name: 'Native proposal' });
        assert.equal(tools.size, 1, 'only the planning tool is registered');
    }
    manager.appendCustomEntry('synthetic-bounded-proposal', { text: 'p'.repeat(128 * 1024) });
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }], timestamp: Date.now() });
    assert.ok(fs.statSync(session.path).size > 8 * 1024 * 1024);
    const largeDraft = await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } });
    assert.equal(largeDraft.statusCode, 200, JSON.stringify(largeDraft.data));
    assert.equal(largeDraft.data.proposal.name, jitiPath ? 'Native proposal' : 'Refined');
    assert.ok((await profileAuthoringEnvironment({ store, cwd, sessionId: session.id })).PIVANE_PROFILE_AUTHORING_CONTEXT);
    if (jitiPath) {
        process.env.PIVANE_PROFILE_AUTHORING_CONTEXT = (await profileAuthoringEnvironment({ store, cwd, sessionId: session.id })).PIVANE_PROFILE_AUTHORING_CONTEXT;
        const { registerProfileAuthoring } = require(jitiPath).createJiti(path.join(__dirname, '../server/pi-profile-authoring-extension.ts'))(
            path.join(__dirname, '../server/pi-profile-authoring-extension.ts'));
        const handlers = new Map(), tools = new Map();
        registerProfileAuthoring({ on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); } }, () => agent);
        handlers.get('session_start')({}, { mode: 'rpc', cwd, sessionManager: SessionManager.open(session.path) });
        assert.ok(tools.has('profile_draft'), 'reopened large helper retains its planning tool');
    }
    const originalProfileManager = store.profileManager;
    store.profileManager = (candidate, SDK) => {
        const parsed = originalProfileManager(candidate, SDK);
        manager.appendCustomEntry('synthetic-concurrent-append', { version: 1 });
        return parsed;
    };
    try { assert.equal((await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } })).statusCode, 409); }
    finally { store.profileManager = originalProfileManager; }
    const foreign = { getSessionId: () => 'foreign', getSessionFile: () => session.path, getEntries: () => manager.getEntries() };
    assert.equal(readProfileAuthoring(foreign), null);
    manager.appendCustomEntry('pivane-profile-authoring', { version: 1, sessionId: session.id, profileId: null, profileRevision: null, language: 'en' });
    assert.equal(readProfileAuthoring(manager), null, 'duplicate current-ID markers fail closed');
    assert.deepEqual(await profileAuthoringEnvironment({ store, cwd, sessionId: session.id }), {});
    assert.equal((await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } })).statusCode, 404);
});

test('helper creation reserves maintenance activity before awaits and disposal waits for native creation', async () => {
    const { PiProfileRegistry } = require('../server/pi-profile-registry');
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    let creations = 0;
    const store = { defaultProject: () => cwd, resolveProject: value => value,
        profileManager: (session, SessionManager) => SessionManager.open(session.path),
        async createSession() { creations++; started(); await hold; return { id: 'synthetic-session', cwd }; },
        async getSession() {} };
    const profiles = new PiProfileRegistry(store);
    profiles.nativeService = { busy: false };
    const router = { post(_path, fn) { this.postHandler = fn; }, get() {} };
    mountProfileAuthoringRoutes(router, { store, profiles });
    const post = async () => { const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
        json(data) { this.data = data; return this; } };
        await router.postHandler({ body: { profileId: null, language: 'en' } }, res); return res; };
    profiles.maintenance = { locked: true };
    assert.equal((await post()).code, 409);
    assert.equal(creations, 0, 'maintenance rejects before creating a native session');
    profiles.maintenance.locked = false;
    const pending = post();
    assert.equal(profiles.busy, true, 'reservation is synchronous before the first await');
    assert.equal(profiles.nativeService.busy, true);
    await entered;
    let disposed = false;
    const shutdown = profiles.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    assert.equal((await post()).code, 409, 'stopping rejects new creations');
    assert.equal(creations, 1);
    release();
    assert.equal((await pending).code, 201);
    await shutdown;
    assert.equal(disposed, true);
    assert.equal(profiles.nativeService.busy, false);
});

test('oversize helper sessions return 413 before native parsing', async t => {
    fs.mkdirSync(path.join(agent, 'sessions', 'synthetic'), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(agent, 'sessions', 'synthetic', 'large.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'synthetic', cwd, timestamp: new Date().toISOString() }) + '\n');
    fs.truncateSync(file, require('../server/pi-profile-authoring').MAX_AUTHORING_SESSION_BYTES + 1);
    const session = { id: 'synthetic', cwd, path: file };
    const store = { defaultProject: () => cwd, resolveProject: value => value,
        async getSession() { return session; }, async createSession() {},
        profileManager() { throw Error('Oversize session must be rejected before parsing'); } };
    const router = { post() {}, get(_path, handler) { this.handler = handler; } };
    mountProfileAuthoringRoutes(router, { store, profiles: { getProfile: async () => null, reserve: action => action() } });
    const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
        json(data) { this.data = data; return this; } };
    await router.handler({ params: { id: session.id }, query: { cwd } }, res);
    assert.equal(res.code, 413);
    assert.match(res.data.error, /64 MiB/);
    assert.deepEqual(await profileAuthoringEnvironment({ store, cwd, sessionId: session.id }), {});
});
