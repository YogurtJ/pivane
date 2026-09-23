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
    const profiles = { getProfile: async id => id === profile.id ? profile : null };
    const sessions = new Map();
    // Narrow stand-in for A's synchronous initializeSession seam, after header/binding.
    const store = { defaultProject: () => cwd, resolveProject: value => value === cwd ? value : (() => { throw Error('Invalid cwd'); })(),
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
    const foreign = { getSessionId: () => 'foreign', getSessionFile: () => session.path, getEntries: () => manager.getEntries() };
    assert.equal(readProfileAuthoring(foreign), null);
    manager.appendCustomEntry('pivane-profile-authoring', { version: 1, sessionId: session.id, profileId: null, profileRevision: null, language: 'en' });
    assert.equal(readProfileAuthoring(manager), null, 'duplicate current-ID markers fail closed');
    assert.deepEqual(await profileAuthoringEnvironment({ store, cwd, sessionId: session.id }), {});
    assert.equal((await call('GET', draftRoute, { params: { id: session.id }, query: { cwd } })).statusCode, 404);
});
