// Isolated HTTP/RPC regressions for workflow boundary cases.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { randomUUID } = require('node:crypto'), { performance } = require('node:perf_hooks');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-followup-audit-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'audit-fixture';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { workflowSnapshot } = require('../server/pi-session-workflows');
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }], timestamp: 2, stopReason: 'stop',
    provider: 'fixture', model: 'fixture', api: 'openai-completions', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('unanswered-leaf retry replaces the old question and restores it exactly', { timeout: 60000 }, async t => {
    const outgoing = [];
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk; outgoing.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic reply' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }])
            res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000, reasoning: false }]
    } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes'), express = require('express');
    const gateway = createPiAgentGateway(), app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`, cwd = path.join(root, 'partial'); fs.mkdirSync(cwd);
    const api = async (tail, data) => { const res = await fetch(base + tail, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer audit-fixture', 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify({ cwd, ...data }) } : {}) });
        const value = await res.json(); assert.equal(res.ok, true, JSON.stringify(value)); return value; };
    const source = await gateway.store.createSession(cwd, 'Unanswered question'), { SessionManager } = await getSdk();
    const manager = SessionManager.open(source.path); manager.appendModelChange('fixture', 'fixture'); manager.appendThinkingLevelChange('off');
    const question = manager.appendMessage({ role: 'user', content: 'ORIGINAL_UNANSWERED_REQUEST', timestamp: 1 });
    const prefix = `/sessions/${source.id}`, view = await api(prefix + '/workflow?cwd=' + encodeURIComponent(cwd));
    const worker = gateway.supervisor.getActiveWorker(source.path);
    assert.equal(view.leafId, question, 'fixture must end exactly at the user entry');
    await api(prefix + '/retry', { expectedLeafId: view.leafId, entryId: question, message: 'REPLACEMENT_REQUEST', images: [] });
    const deadline = Date.now() + 10000;
    while ((await worker.request('get_state')).isStreaming) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 20)); }
    const sent = JSON.stringify(outgoing[0].messages);
    assert.ok(!sent.includes('ORIGINAL_UNANSWERED_REQUEST') && sent.includes('REPLACEMENT_REQUEST'));
    const after = await api(prefix + '/workflow?cwd=' + encodeURIComponent(cwd));
    assert.ok(after.versions.some(item => item.entryId === question));
    await api(prefix + '/restore', { expectedLeafId: after.leafId, entryId: question });
    const restored = JSON.stringify((await worker.request('get_messages')).messages);
    assert.equal(restored.includes('ORIGINAL_UNANSWERED_REQUEST'), true);
    assert.equal(restored.includes('REPLACEMENT_REQUEST'), false);
    await gateway.supervisor.stopSession(source.path);
    const resumed = await gateway.supervisor.getWorker({ cwd, sessionId: source.id, sessionPath: source.path });
    assert.ok(JSON.stringify((await resumed.request('get_messages')).messages).includes('ORIGINAL_UNANSWERED_REQUEST'));

    const current = await api(prefix + '/workflow?cwd=' + encodeURIComponent(cwd));
    const command = { requestId: randomUUID(), expectedLeafId: current.leafId, entryId: question };
    const [first, second] = await Promise.all([api(prefix + '/fork', command), api(prefix + '/fork', command)]);
    assert.equal(first.session.id, second.session.id, 'concurrent identical requests create once');
    assert.equal(first.draft.message, 'ORIGINAL_UNANSWERED_REQUEST');
    const statusPath = prefix + '/forks/' + command.requestId + '?cwd=' + encodeURIComponent(cwd);
    assert.equal((await api(statusPath)).result.session.id, first.session.id);
    await resumed.request('prompt', { message: 'LATER_SOURCE_CHANGE' });
    while ((await resumed.request('get_state')).isStreaming) await new Promise(r => setTimeout(r, 20));
    assert.equal((await api(prefix + '/fork', command)).session.id, first.session.id, 'completed request survives source branch changes');
    const { ForkRequests } = require('../server/pi-session-fork-requests');
    const restarted = new ForkRequests(gateway.store), latestSource = await gateway.store.getSession(cwd, source.id);
    assert.equal((await restarted.run(latestSource, command, () => assert.fail('must not create again'))).session.id, first.session.id);
    await assert.rejects(restarted.run(latestSource, { ...command, entryId: undefined }, () => assert.fail('conflict cannot create')), { code: 'FORK_REQUEST_CONFLICT' });
    fs.unlinkSync(first.session.path);
    assert.equal((await api(statusPath)).status, 'unavailable');
    await assert.rejects(restarted.run(latestSource, command, () => assert.fail('deleted result cannot recreate')), { code: 'FORK_RESULT_UNAVAILABLE' });

    for (const kind of ['user', 'custom']) {
        const legacy = await gateway.store.createSession(cwd, 'Legacy ' + kind), m = SessionManager.open(legacy.path);
        m.appendModelChange('fixture', 'fixture'); const before = m.appendThinkingLevelChange('off');
        const old = kind === 'user' ? m.appendMessage({ role: 'user', content: 'LEGACY_ORIGINAL', timestamp: 1 })
            : m.appendCustomMessageEntry('fixture-result', 'LEGACY_ORIGINAL', true);
        m.branch(before); m.appendCustomEntry('pivane-web-navigation', { fromLeafId: old });
        m.appendMessage({ ...assistant, content: [{ type: 'text', text: 'LATER_UNWANTED' }] });
        const address = `/sessions/${legacy.id}`, oldView = await api(address + '/workflow?cwd=' + encodeURIComponent(cwd));
        await api(address + '/restore', { expectedLeafId: oldView.leafId, entryId: old });
        const context = JSON.stringify((await gateway.supervisor.getActiveWorker(legacy.path).request('get_messages')).messages);
        assert.ok(context.includes('LEGACY_ORIGINAL')); assert.ok(!context.includes('LATER_UNWANTED'));
    }
});

test('repeated moves grant only actual delivery origins within the unique-reference budget', { timeout: 60000 }, async t => {
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor'), { PiUsageService } = require('../server/pi-usage-service');
    const { PiSessionMoves } = require('../server/pi-session-moves'), { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
    const { DeliverableStore, DeliverableService, ENTRY, references } = require('../server/pi-deliverables');
    const dirs = ['a', 'b', 'c'].map(name => path.join(root, 'many-' + name)); dirs.forEach(dir => fs.mkdirSync(dir));
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor(), usage = new PiUsageService(store);
    const moves = new PiSessionMoves({ store, supervisor, usage, preferences: new WorkspacePreferencesService({ filePath: path.join(root, 'many-prefs.json') }), deferred: { list: () => [] }, cron: { db: { homes: () => [], jobs: () => [] } } });
    t.after(async () => { await moves.dispose(); await supervisor.dispose(); await usage.dispose(); });
    const original = await store.createSession(dirs[0], 'Many deliveries'), { SessionManager } = await getSdk();
    const manager = SessionManager.open(original.path); manager.appendMessage({ role: 'user', content: 'Synthetic request', timestamp: 1 }); manager.appendMessage(assistant);
    fs.writeFileSync(path.join(dirs[0], 'tiny.txt'), 'x'); const objects = new DeliverableStore(store); let first;
    for (let index = 0; index < 251; index++) {
        const receipt = await objects.publish({ cwd: dirs[0], sessionId: original.id }, { requestId: 'item-' + index, title: 'Item', files: ['tiny.txt'] });
        first ||= receipt.reference; manager.appendCustomEntry(ENTRY, receipt.reference);
    }
    let session = original;
    for (const target of dirs.slice(1)) {
        const preview = await moves.preview(session.cwd, session.id, target); assert.equal(preview.canMove, true);
        session = (await moves.move(session.cwd, session.id, { cwd: session.cwd, targetCwd: target, expectedRevision: preview.revision, requestId: 'audit-' + randomUUID() })).session;
    }
    assert.equal((await new DeliverableService({ store, supervisor }).request({ cwd: session.cwd, sessionId: session.id, id: first.id, index: '0' })).content, 'x');
    const current = SessionManager.open(session.path), unique = references(current.getBranch()).length;
    const proof = await moves.deliveryProof(session), counted = [...proof.values()].filter(Boolean).reduce((sum, refs) => sum + refs.size, 0);
    assert.equal(unique, 251); assert.equal(counted, 502);
    const fork = await store.forkSession(session, { entries: current.getEntries(), leafId: current.getLeafId() });
    const receipt = await require('../server/pi-session-fork-access').readForkAccess(store, fork.session);
    assert.equal(receipt.deliveries.length, 251);
    assert.ok(receipt.deliveries.every(ref => ref.cwd === dirs[0]));
    assert.equal((await new DeliverableService({ store, supervisor }).request({ cwd: fork.session.cwd, sessionId: fork.session.id, id: first.id, index: '0' })).content, 'x');
});

test('workflow previews resolve out-of-order ancestry, skip absent fork versions and reject broken referenced paths', () => {
    const user = (id, parentId, text) => ({ id, parentId, type: 'message', message: { role: 'user', content: text, timestamp: 1 } });
    const marker = (id, parentId, fromLeafId) => ({ id, parentId, type: 'custom', customType: 'pivane-web-navigation', data: { fromLeafId }, timestamp: '2026-01-01' });
    const entries = [marker('nav', 'new', 'old'), user('new', null, 'new question'), user('old', 'root', 'old question'),
        user('root', null, 'first question'), marker('missing', 'nav', 'foreign'), marker('duplicate', 'missing', 'old')];
    const view = workflowSnapshot({ entries, leafId: 'duplicate' });
    assert.equal(view.lastUserId, 'new');
    assert.deepEqual(view.versions.map(v => [v.entryId, v.text]), [['old', 'old question']]);
    assert.throws(() => workflowSnapshot({ entries: [user('loop', 'loop', 'question')], leafId: 'loop' }), /会话分支无效/);
    for (const parentId of ['old', 'absent']) {
        assert.throws(() => workflowSnapshot({ entries: [user('current', null, 'ok'), user('old', parentId, 'broken'), marker('nav', 'current', 'old')], leafId: 'nav' }), /会话分支无效/);
    }
});

test('long workflow snapshots visit ancestry linearly and preserve version previews', { timeout: 30000 }, () => {
    function fixture(count, versions) {
        const entries = [];
        for (let i = 0; i < count; i++) entries.push({ id: 'e' + i, parentId: i ? 'e' + (i-1) : null, type: 'message', timestamp: '2026-01-01T00:00:00Z',
            message: i % 2 ? { ...assistant, timestamp: i } : { role: 'user', content: 'Synthetic question ' + i, timestamp: i } });
        let leafId = 'e' + (count-1);
        for (let i = 0; i < versions; i++) { const id = 'v' + i; entries.push({ id, parentId: leafId, type: 'custom', customType: 'pivane-web-navigation', timestamp: '2026-01-01T00:00:00Z', data: { fromLeafId: 'e' + Math.floor(count/2 + i*count/(2*versions)), mode: 'retry' } }); leafId = id; }
        return { entries, leafId };
    }
    workflowSnapshot(fixture(500, 5));
    for (const [count, versions] of [[2000, 20], [8000, 80], [12000, 120]]) {
        const snapshot = fixture(count, versions), samples = [];
        let reads = 0;
        for (const entry of snapshot.entries) { const parentId = entry.parentId; Object.defineProperty(entry, 'parentId', { get() { reads++; return parentId; } }); }
        for (let repeat = 0; repeat < 3; repeat++) { const started = performance.now(); const result = workflowSnapshot(snapshot); samples.push(Math.round(performance.now()-started)); assert.equal(result.versions.length, versions); }
        assert.ok(reads <= snapshot.entries.length * 3, `ancestry visits ${reads} exceed one pass per sample`);
        console.log(JSON.stringify({ workflowEntries: snapshot.entries.length, versions, samplesMs: samples }));
    }
});
