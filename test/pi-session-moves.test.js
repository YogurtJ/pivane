const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-moves-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'move-fixture';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { PiSessionMoves } = require('../server/pi-session-moves');
const { PiUsageService } = require('../server/pi-usage-service');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const { DeliverableStore, DeliverableService, ENTRY } = require('../server/pi-deliverables');
const tail = bytes => bytes.subarray(bytes.indexOf(10) + 1);
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(), stopReason: 'stop',
    provider: 'fixture', model: 'fixture', api: 'openai-completions', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
async function fixture(t) {
    const folder = path.join(root, randomUUID()), source = path.join(folder, '来源'), target = path.join(folder, '目标');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target);
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor(), usage = new PiUsageService(store);
    const preferences = new WorkspacePreferencesService({ filePath: path.join(folder, 'preferences.json') });
    const deferred = { jobs: [], list() { return this.jobs; } }, cron = { db: { homes: () => [], jobs: () => [] } };
    const moves = new PiSessionMoves({ store, supervisor, usage, preferences, deferred, cron });
    const session = await store.createSession(source, '迁移线程');
    const { SessionManager } = await getSdk(), manager = SessionManager.open(session.path);
    manager.appendMessage({ role: 'user', content: '保留旧路径 /original/project', timestamp: Date.now() });
    const branch = manager.appendMessage(assistant('分支点'));
    manager.appendMessage({ role: 'user', content: '被保留的另一分支', timestamp: Date.now() }); manager.appendMessage(assistant('另一回答'));
    manager.branch(branch); const user = manager.appendMessage({ role: 'user', content: '当前分支', timestamp: Date.now() });
    manager.appendMessage(assistant('当前回答')); manager.appendCompaction('保留摘要', user, 10000); manager.appendLabelChange(branch, '书签');
    const move = async (targetCwd = target, requestId = 'move-' + randomUUID()) => {
        const preview = await moves.preview(source, session.id, targetCwd);
        assert.equal(preview.canMove, true, JSON.stringify(preview.blockers));
        return moves.move(source, session.id, { cwd: source, targetCwd, requestId, expectedRevision: preview.revision });
    };
    t.after(async () => { await moves.dispose(); await supervisor.dispose(); await usage.dispose(); });
    return { source, target, store, supervisor, usage, preferences, deferred, cron, moves, session, manager, move, folder };
}

test('move preserves exact native history, identity, mtime, preferences, usage and deliverables; old references survive restart and repeated moves', async t => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.source, '成果.md'), '# Original delivery');
    const objects = new DeliverableStore(f.store);
    const delivery = await objects.publish({ cwd: f.source, sessionId: f.session.id }, { requestId: 'move-file', title: '成果', files: ['成果.md'] });
    f.manager.appendCustomEntry(ENTRY, delivery.reference);
    f.preferences.setArchived(f.source, f.session.id, true);
    f.preferences.recordReplyNotice({ cwd: f.source, sessionId: f.session.id, completionId: 'completion', completedAt: new Date().toISOString() });
    f.preferences.writeDocument({ ...f.preferences.readDocument(), unrelated: { keep: true } });
    await f.usage.preserveSession(f.session.path);
    const filter = { from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), timeZone: 'UTC' };
    const beforeUsage = await f.usage.report(filter);
    const before = fs.readFileSync(f.session.path), modified = fs.statSync(f.session.path).mtime.getTime();
    const preview = await f.moves.preview(f.source, f.session.id, f.target), requestId = 'move-' + randomUUID();
    const input = { cwd: f.source, targetCwd: f.target, requestId, expectedRevision: preview.revision };
    const result = await f.moves.move(f.source, f.session.id, input);
    assert.equal(result.session.id, f.session.id); assert.equal(result.session.cwd, f.target);
    assert.equal(fs.existsSync(f.session.path), false); assert.equal(fs.statSync(result.session.path).mtime.getTime(), modified);
    assert.deepEqual(tail(fs.readFileSync(result.session.path)), tail(before));
    const { SessionManager } = await getSdk(), moved = SessionManager.open(result.session.path);
    assert.equal(moved.getHeader().timestamp, f.manager.getHeader().timestamp);
    assert.deepEqual(moved.getEntries(), JSON.parse(JSON.stringify(f.manager.getEntries()))); assert.equal(moved.getLeafId(), f.manager.getLeafId());
    assert.equal((await f.store.listSessions(f.source)).length, 0); assert.equal((await f.store.listSessions(f.target)).length, 1);
    assert.equal(f.preferences.getArchives().sessions[0].cwd, f.target); assert.equal(f.preferences.getReplyNotices()[0].cwd, f.target);
    assert.deepEqual(f.preferences.readDocument().unrelated, { keep: true });
    const afterUsage = await f.usage.report(filter);
    assert.deepEqual(afterUsage.total, beforeUsage.total); assert.equal(afterUsage.sessions.find(row => row.id === f.session.id).cwd, f.target);
    assert.equal(afterUsage.projects.some(row => row.cwd === f.source), false);
    const service = new DeliverableService({ store: f.store, supervisor: f.supervisor });
    assert.equal((await service.request({ cwd: f.target, sessionId: f.session.id, id: delivery.reference.id, index: '0' })).content, '# Original delivery');
    const retry = await f.moves.move(f.source, f.session.id, input); assert.equal(retry.session.id, f.session.id);
    await assert.rejects(f.moves.move(f.source, f.session.id, { ...input, targetCwd: f.folder }), /其他参数/);
    const restarted = new PiSessionMoves(f.moves);
    assert.equal((await restarted.resolve(f.source, f.session.id)).session.cwd, f.target);
    moved.appendMessage({ role: 'user', content: '移动后新增', timestamp: Date.now() });
    assert.equal((await restarted.resolve(f.source, f.session.id)).session.cwd, f.target);
    const back = await restarted.preview(f.target, f.session.id, f.source);
    await restarted.move(f.target, f.session.id, { cwd: f.target, targetCwd: f.source, expectedRevision: back.revision, requestId: 'move-' + randomUUID() });
    assert.equal((await restarted.resolve(f.target, f.session.id)).session.cwd, f.source);
    assert.equal((await service.request({ cwd: f.source, sessionId: f.session.id, id: delivery.reference.id, index: '0' })).content, '# Original delivery');
});

test('large unrelated history does not block ordinary moves, while references after that history are still detected', async t => {
    const f = await fixture(t), legacyCwd = path.join(f.folder, 'large-unrelated'); fs.mkdirSync(legacyCwd);
    const other = await f.store.createSession(legacyCwd, 'Large unrelated history');
    t.after(() => fs.unlinkSync(other.path));
    const fd = fs.openSync(other.path, 'a'), chunk = Buffer.alloc(1024 * 1024, 120);
    try {
        fs.writeSync(fd, JSON.stringify({ type: 'message', id: randomUUID(), parentId: null, timestamp: new Date().toISOString() }).slice(0, -1) + ',"message":{"role":"user","content":"');
        for (let index = 0; index < 260; index++) fs.writeSync(fd, chunk);
        fs.writeSync(fd, '","timestamp":1}}\n');
    } finally { fs.closeSync(fd); }
    const unchangedSize = fs.statSync(other.path).size;
    assert.equal((await f.moves.preview(f.source, f.session.id, f.target)).canMove, true);
    fs.appendFileSync(other.path, JSON.stringify({ data: { source: { cwd: f.source, sessionId: f.session.id } }, customType: 'pivane-agent-task', type: 'custom' }) + '\n');
    assert.match((await f.moves.preview(f.source, f.session.id, f.target)).blockers.join(), /其他线程/);
    fs.truncateSync(other.path, unchangedSize);
    const result = await f.move(); assert.equal(result.session.cwd, f.target);
    assert.equal(fs.statSync(other.path).size, unchangedSize);
});

test('native forks retain inherited deliveries after moving but cannot append a new foreign delivery grant', async t => {
    const f = await fixture(t), objects = new DeliverableStore(f.store);
    fs.writeFileSync(path.join(f.source, 'shared.md'), 'Inherited snapshot');
    const inherited = await objects.publish({ cwd: f.source, sessionId: f.session.id }, { requestId: 'inherited', title: 'Inherited', files: ['shared.md'] });
    f.manager.appendCustomEntry(ENTRY, inherited.reference);
    const { SessionManager } = await getSdk(), fork = SessionManager.forkFrom(f.session.path, f.source);
    const hidden = await objects.publish({ cwd: f.source, sessionId: fork.getSessionId() }, { requestId: 'hidden', title: 'Not referenced before move', files: ['shared.md'] });
    const preview = await f.moves.preview(f.source, fork.getSessionId(), f.target);
    assert.equal(preview.canMove, true, JSON.stringify(preview.blockers));
    const result = await f.moves.move(f.source, fork.getSessionId(), { cwd: f.source, targetCwd: f.target, expectedRevision: preview.revision, requestId: 'move-' + randomUUID() });
    const service = new DeliverableService({ store: f.store, supervisor: f.supervisor });
    const request = { cwd: f.target, sessionId: result.session.id, id: inherited.reference.id, index: '0' };
    assert.equal((await service.request(request)).content, 'Inherited snapshot');
    SessionManager.open(result.session.path).appendCustomEntry(ENTRY, hidden.reference);
    await assert.rejects(service.request({ ...request, id: hidden.reference.id }), { code: 'DELIVERY_SCOPE' });
});

test('preview rejects related threads, pending messages, unsafe targets and native ID/file collisions without moving data', async t => {
    const f = await fixture(t), before = fs.readFileSync(f.session.path);
    await assert.rejects(f.moves.preview(f.source, f.session.id, f.source), /不同/);
    await assert.rejects(f.moves.preview(f.source, f.session.id, '/etc'), /outside/);
    f.deferred.jobs = [{ status: 'scheduled' }];
    assert.match((await f.moves.preview(f.source, f.session.id, f.target)).blockers.join(), /预约/); f.deferred.jobs = [];
    f.cron.db.homes = () => [{ cwd: f.source, sessionId: f.session.id }];
    assert.match((await f.moves.preview(f.source, f.session.id, f.target)).blockers.join(), /定时/); f.cron.db.homes = () => [];
    const { SessionManager } = await getSdk();
    f.manager.appendCustomEntry('pivane-agent-profile', { version: 1, sessionId: f.session.id, profileId: randomUUID() });
    assert.match((await f.moves.preview(f.source, f.session.id, f.target)).blockers.join(), /档案/);
    fs.writeFileSync(f.session.path, before);
    const other = await f.store.createSession(f.source, 'Other');
    SessionManager.open(other.path).appendCustomEntry('pivane-agent-task', { version: 1, sessionId: other.id, source: { cwd: f.source, sessionId: f.session.id } });
    assert.match((await f.moves.preview(f.source, f.session.id, f.target)).blockers.join(), /其他线程/);
    fs.unlinkSync(other.path);
    const cloned = path.join(SessionManager.create(f.target).getSessionDir(), path.basename(f.session.path));
    fs.writeFileSync(cloned, before);
    assert.match((await f.moves.preview(f.source, f.session.id, f.target)).blockers.join(), /已存在/); fs.unlinkSync(cloned);
    const preview = await f.moves.preview(f.source, f.session.id, f.target);
    SessionManager.open(f.session.path).appendSessionInfo('Changed after preview');
    await assert.rejects(f.moves.move(f.source, f.session.id, { cwd: f.source, targetCwd: f.target, expectedRevision: preview.revision, requestId: 'move-' + randomUUID() }), /已变化/);
    assert.ok(fs.existsSync(f.session.path));
});

test('failed accounting rolls back raw history and scoped preferences; interrupted journal blocks both projects after restart', async t => {
    const f = await fixture(t), before = fs.readFileSync(f.session.path);
    f.preferences.setArchived(f.source, f.session.id, true);
    const exclusive = f.usage.withSessionRelocation.bind(f.usage);
    f.usage.withSessionRelocation = operation => exclusive(async usage => {
        let first = true;
        return operation({ ...usage, relocate: async (...args) => {
            const result = await usage.relocate(...args);
            if (first) { first = false; throw Error('fixture after committed ledger'); }
            return result;
        } });
    });
    await assert.rejects(f.move(), /fixture after committed ledger/);
    assert.deepEqual(fs.readFileSync(f.session.path), before);
    assert.equal((await f.store.listSessions(f.target)).length, 0);
    assert.equal(f.preferences.getArchives().sessions[0].cwd, f.source);
    const journal = await f.moves.journal(), record = journal.document.records.at(-1);
    assert.equal(record.status, 'rolled_back');
    f.manager.appendSessionInfo('Continue after rollback');
    assert.deepEqual(fs.readFileSync(record.backup), before, 'backup must not share a mutable inode with the restored thread');
    record.status = 'prepared'; require('../server/pi-maintenance-files').atomicJson(journal.file, journal.document);
    const restarted = new PiSessionMoves(f.moves);
    await assert.rejects(f.store.getSession(f.source, f.session.id), { code: 'SESSION_MOVE_RECOVERY' });
    await assert.rejects(restarted.assertAvailable(f.target, f.session.id), { code: 'SESSION_MOVE_RECOVERY' });
    record.status = 'rolled_back'; require('../server/pi-maintenance-files').atomicJson(journal.file, journal.document);
});

test('supervisor reserves both paths before await, rejects busy/background workers and participates in shutdown', async t => {
    const f = await fixture(t);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const targetPath = path.join(f.target, 'synthetic.jsonl');
    const moving = f.supervisor.withSessionMove(f.session.path, targetPath, () => gate);
    assert.equal(f.supervisor.isIdle(), false); assert.equal(f.supervisor.isSessionIdle(f.session.path), false);
    await assert.rejects(f.supervisor.getWorker({ sessionPath: f.session.path }), /being moved/);
    await assert.rejects(f.supervisor.getWorker({ sessionPath: targetPath }), /being moved/);
    await assert.rejects(f.supervisor.withSessionRemoval(f.session.path, () => {}), /being moved/);
    release(); await moving;
    f.supervisor.workers.set(f.session.path, { retainsBackgroundWork: () => true, dispose: async () => {} });
    await assert.rejects(f.supervisor.withSessionMove(f.session.path, targetPath, () => assert.fail()), { code: 'SESSION_BUSY' });
    f.supervisor.workers.delete(f.session.path);
});

test('in-flight moves block source mutations and target startup, and old addresses work after the source directory is removed', async t => {
    const f = await fixture(t), preview = await f.moves.preview(f.source, f.session.id, f.target);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const exclusive = f.usage.withSessionRelocation.bind(f.usage);
    f.usage.withSessionRelocation = operation => exclusive(usage => operation({ ...usage, preserve: async file => {
        entered(); await gate; return usage.preserve(file);
    } }));
    const request = { cwd: f.source, targetCwd: f.target, expectedRevision: preview.revision, requestId: 'move-' + randomUUID() };
    const moving = f.moves.move(f.source, f.session.id, request);
    await started;
    try {
        await assert.rejects(f.store.renameSession(f.source, f.session.id, 'Must not write'), { code: 'SESSION_BUSY' });
        await assert.rejects(f.supervisor.getWorker({ sessionPath: f.session.path }), /being moved/);
        assert.equal(f.supervisor.isIdle(), false);
    } finally { release(); }
    const result = await moving;
    fs.rmdirSync(f.source);
    assert.equal((await f.moves.resolve(f.source, f.session.id)).session.cwd, f.target);
    assert.equal((await f.moves.move(f.source, f.session.id, request)).session.cwd, f.target);
    const bytes = fs.readFileSync(result.session.path);
    fs.writeFileSync(result.session.path, bytes.toString('utf8').replace('当前回答', '篡改回答'));
    await assert.rejects(f.moves.resolve(f.source, f.session.id), /无法证明/);
    fs.writeFileSync(result.session.path, bytes);
});

test('HTTP move routes enforce access, previews and persistent request identity without starting a closed worker', async t => {
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const folder = path.join(root, randomUUID()), target = path.join(folder, 'target'); fs.mkdirSync(target, { recursive: true });
    const gateway = createPiAgentGateway({ deferredFilePath: path.join(folder, 'queue.json'), cronFilePath: path.join(folder, 'cron.sqlite'),
        workspacePreferencesService: new WorkspacePreferencesService({ filePath: path.join(folder, 'prefs.json') }) });
    const express = require('express'), app = express(); app.use(express.json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`;
    const session = await gateway.store.createSession(folder, 'HTTP move', { agentProfileId: null });
    const call = (suffix, body, headers = {}) => fetch(base + suffix, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer move-fixture', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const endpoint = '/sessions/' + session.id + '/move', query = '?cwd=' + encodeURIComponent(folder) + '&targetCwd=' + encodeURIComponent(target);
    assert.equal((await call(endpoint + query, null, { Authorization: '' })).status, 401);
    assert.equal((await call(endpoint + query, null, { Origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await (await call('/status')).json()).sessionMoves, true);
    const preview = await (await call(endpoint + query)).json(); assert.equal(preview.canMove, true, JSON.stringify(preview));
    const result = await call(endpoint, { cwd: folder, targetCwd: target, expectedRevision: preview.revision, requestId: 'move-' + randomUUID() });
    assert.equal(result.status, 200, await result.clone().text()); assert.equal(result.headers.get('cache-control'), 'no-store');
    const moved = (await result.json()).session; assert.equal(moved.id, session.id); assert.equal(gateway.supervisor.workers.size, 0);
    assert.equal((await (await call('/sessions/' + session.id + '/resolve?cwd=' + encodeURIComponent(folder))).json()).session.cwd, target);
    // Real native runtime, two pages, no model requests: both subscriptions are
    // notified only after the original process has actually stopped.
    const live = await gateway.store.createSession(folder, 'Live move', { agentProfileId: null });
    const { WebSocket } = require('ws'), sockets = [], records = [];
    gateway.attachWebSocket(server);
    for (let index = 0; index < 2; index++) {
        const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws'); sockets.push(socket);
        socket.on('message', raw => records.push(JSON.parse(raw)));
        await once(socket, 'open'); socket.send(JSON.stringify({ type: 'open_session', id: 'open-' + index, token: 'move-fixture', cwd: folder, sessionId: live.id }));
        const deadline = Date.now() + 15000;
        while (!records.some(record => record.id === 'open-' + index)) {
            if (Date.now() > deadline) throw Error('Native move fixture startup did not complete');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(records.find(record => record.id === 'open-' + index).success, true);
    }
    const worker = gateway.supervisor.getActiveWorker(live.path);
    assert.ok(worker && !worker.disposed);
    const livePreview = await (await call('/sessions/' + live.id + '/move?cwd=' + encodeURIComponent(folder) + '&targetCwd=' + encodeURIComponent(target))).json();
    assert.equal(livePreview.canMove, true, JSON.stringify(livePreview));
    const closure = sockets.map(socket => once(socket, 'close'));
    const liveResult = await call('/sessions/' + live.id + '/move', { cwd: folder, targetCwd: target, expectedRevision: livePreview.revision, requestId: 'move-' + randomUUID() });
    assert.equal(liveResult.status, 200, await liveResult.clone().text());
    assert.equal(worker.disposed, true); assert.equal(gateway.supervisor.workers.size, 0);
    assert.deepEqual((await Promise.all(closure)).map(row => row[0]), [4005, 4005]);
    assert.equal(records.filter(record => record.type === 'gateway_session_moving').length, 2);
    assert.equal(records.filter(record => record.type === 'gateway_session_moved' && record.session.id === live.id).length, 2);
});
