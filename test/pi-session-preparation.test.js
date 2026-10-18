'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-session-preparation-')));
const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
for (const dir of [cwd, agent]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const crypto = require('node:crypto'), originalHash = crypto.createHash;
let authoringHashes = 0;
crypto.createHash = function (...args) {
    if (new Error().stack.includes('sessionProof')) authoringHashes++;
    return originalHash.apply(this, args);
};
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { getSdk } = require('../server/pi-session-store');
const { ENTRY, profileAuthoringEnvironment, mountProfileAuthoringRoutes } = require('../server/pi-profile-authoring');
const access = new WorkspaceAccessService({ envToken: () => 'synthetic-preparation-token' });
const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(root, 'deferred.json') });
test.after(async () => {
    crypto.createHash = originalHash;
    await gateway.dispose(); access.dispose(); fs.rmSync(root, { recursive: true, force: true });
});
const environment = session => gateway.supervisor.workerEnvironment({ cwd, sessionId: session.id, sessionPath: session.path });

test('startup shares one parse, skips ordinary authoring hashes, and expires its async read scope', async t => {
    const { SessionManager } = await getSdk();
    const session = await gateway.store.createSession(cwd, 'Large ordinary', { agentProfileId: null });
    SessionManager.open(session.path).appendCustomEntry('synthetic-large-body', { text: 'x'.repeat(8 * 1024 * 1024) });
    await gateway.store.getSession(cwd, session.id); // Warm disposable metadata, not a manager/body cache.
    const originalOpen = SessionManager.open;
    let opens = 0, read;
    SessionManager.open = function (...args) { opens++; return originalOpen.apply(this, args); };
    t.after(() => { SessionManager.open = originalOpen; });
    // Reproduce the previous route -> assistant -> profile -> authoring read
    // sequence against this checkout and fixture; no production directory is read.
    const baselineStart = performance.now();
    for (let index = 0; index < 3; index++) await gateway.store.getSession(cwd, session.id);
    SessionManager.open(session.path);
    await profileAuthoringEnvironment({ store: {
        getSession: gateway.store.getSession.bind(gateway.store),
        profileManager: gateway.store.profileManager.bind(gateway.store),
    }, cwd, sessionId: session.id });
    const baselineElapsed = performance.now() - baselineStart;
    assert.equal(opens, 6);
    assert.equal(authoringHashes, 1, 'the previous path hashes even an ordinary session');
    opens = 0; authoringHashes = 0;
    const start = performance.now();
    await gateway.store.withSessionRead(cwd, session.id, async (prepared, checked) => {
        read = checked;
        prepared.profileAuthoring = { sessionId: session.id }; // Metadata cannot authorize the helper.
        assert.equal((await environment(session)).PIVANE_PROFILE_AUTHORING_CONTEXT, undefined);
        assert.equal((await gateway.store.getSession(cwd, session.id)).profileAuthoring, null);
    });
    const elapsed = performance.now() - start;
    assert.equal(opens, 1);
    assert.equal(authoringHashes, 0);
    assert.throws(() => read.manager(), /expired/);
    assert.equal((await environment(session)).PIVANE_PROFILE_AUTHORING_CONTEXT, undefined);
    assert.equal(opens, 2, 'a later standalone environment starts a fresh read');
    let release, detached;
    const gate = new Promise(resolve => { release = resolve; });
    await gateway.store.withSessionRead(cwd, session.id, () => {
        detached = gate.then(() => gateway.store.getSession(cwd, session.id));
    });
    release(); await detached;
    assert.equal(opens, 4, 'an async descendant cannot revive a completed callback');
    t.diagnostic(JSON.stringify({ cwd: process.cwd(), bytes: fs.statSync(session.path).size,
        baselineSequenceOpens: 6, baselineAuthoringHashes: 1, baselineElapsedMs: +baselineElapsed.toFixed(2),
        startupPreparationOpens: 1, authoringHashes: 0, elapsedMs: +elapsed.toFixed(2) }));
});

test('startup rejects appends and same-content file replacements across awaited context loading', async t => {
    const original = gateway.store.profiles.context;
    t.after(() => { gateway.store.profiles.context = original; });
    for (const replacement of [false, true]) {
        const session = await gateway.store.createSession(cwd, replacement ? 'Replace' : 'Append', { agentProfileId: null });
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        gateway.store.profiles.context = async () => { entered(); await gate; return null; };
        const pending = environment(session);
        await started;
        if (replacement) {
            const bytes = fs.readFileSync(session.path);
            fs.renameSync(session.path, session.path + '.old');
            fs.writeFileSync(session.path, bytes, { mode: 0o600 });
        } else fs.appendFileSync(session.path, '\n');
        release();
        await assert.rejects(pending, /Session file changed/);
    }
});

test('reusing preparation rechecks move admission and native nanosecond revisions', async () => {
    const session = await gateway.store.createSession(cwd, 'Admission', { agentProfileId: null });
    const moves = gateway.store.sessionMoves;
    let blocked = false;
    gateway.store.sessionMoves = { async assertAvailable() { if (blocked) throw Error('Synthetic move reservation'); } };
    try {
        await gateway.store.withSessionRead(cwd, session.id, async (_session, read) => {
            blocked = true;
            await assert.rejects(gateway.store.getSession(cwd, session.id), /move reservation/);
            blocked = false;
            const before = fs.statSync(session.path);
            const bytes = fs.readFileSync(session.path, 'utf8');
            fs.writeFileSync(session.path, bytes.replace('Admission', 'admission'));
            fs.utimesSync(session.path, before.atime, before.mtime);
            assert.throws(() => read.manager(), /Session file changed/);
        });
    } finally { gateway.store.sessionMoves = moves; }
});

test('cold WebSocket open parses once and accepts native startup appends', { timeout: 30000 }, async t => {
    const express = require('express'), { once } = require('node:events'), { WebSocket } = require('ws');
    const extensionDir = path.join(agent, 'extensions'); fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'startup.ts'), `export default function(pi) {
        pi.on('session_start', (_event, ctx) => pi.appendEntry('synthetic-cold-open', { sessionId: ctx.sessionManager.getSessionId() }));
    }`);
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture',
        models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }));
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const sockets = gateway.attachWebSocket(server);
    t.after(async () => {
        for (const socket of sockets.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
    });
    const session = await gateway.store.createSession(cwd, 'Cold socket', { agentProfileId: null });
    assert.equal(gateway.supervisor.getActiveWorker(session.path), undefined);
    const { SessionManager } = await getSdk(), original = SessionManager.open;
    let opens = 0;
    SessionManager.open = function(...args) { if (args[0] === session.path) opens++; return original.apply(this, args); };
    t.after(() => { SessionManager.open = original; });
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/pi/ws`);
    await once(ws, 'open');
    const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cold session did not open')), 20000);
        ws.on('message', raw => {
            const value = JSON.parse(raw);
            if (value.type === 'response' && value.id === 'cold') { clearTimeout(timer); resolve(value); }
        });
        ws.once('error', error => { clearTimeout(timer); reject(error); });
    });
    ws.send(JSON.stringify({ id: 'cold', type: 'open_session', token: 'synthetic-preparation-token', cwd, sessionId: session.id }));
    const result = await response;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.session.id, session.id);
    assert.equal(opens, 1, 'the route and the actual worker environment share one gateway parse');
    assert.match(fs.readFileSync(session.path, 'utf8'), /synthetic-cold-open/, 'native startup may append after environment preparation');
    assert.equal(gateway.supervisor.workers.size, 1);
    ws.terminate();
});

test('authoring startup and draft route reuse one parse while retaining dedicated identity proofs', async t => {
    const { SessionManager } = await getSdk();
    const session = await gateway.store.createSession(cwd, 'Draft helper', { agentProfileId: null,
        initializeSession(manager) { manager.appendCustomEntry(ENTRY, { version: 1, sessionId: manager.getSessionId(),
            profileId: null, profileRevision: null, language: 'en' }); } });
    const original = SessionManager.open;
    let opens = 0;
    SessionManager.open = function (...args) { opens++; return original.apply(this, args); };
    t.after(() => { SessionManager.open = original; });
    authoringHashes = 0;
    await gateway.store.withSessionRead(cwd, session.id, async () => {
        assert.ok((await environment(session)).PIVANE_PROFILE_AUTHORING_CONTEXT);
    });
    assert.equal(opens, 1);
    assert.equal(authoringHashes, 2, 'eligible helpers retain both full-file hash proofs');
    const routes = new Map();
    mountProfileAuthoringRoutes({ post() {}, get(route, handler) { routes.set(route, handler); } },
        { store: gateway.store, profiles: gateway.store.profiles });
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(value) { this.data = value; } };
    await routes.get('/profiles/authoring-sessions/:id/draft')({ params: { id: session.id }, query: { cwd } }, res);
    assert.equal(res.code, 200); assert.equal(res.data.status, 'missing');
    assert.equal(opens, 2, 'draft endpoint also needs only one native open');
    const manager = original.call(SessionManager, session.path);
    manager.appendCustomEntry(ENTRY, { version: 1, sessionId: session.id, profileId: null, profileRevision: null, language: 'en' });
    assert.deepEqual(await profileAuthoringEnvironment({ store: gateway.store, cwd, sessionId: session.id }), {},
        'duplicate current-ID authoring markers cannot grant the planning tool');
});
