// Native HTTP/WS ownership regressions use only an isolated identity and local RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const express = require('express'), { WebSocket } = require('ws');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-session-ownership-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_WEB_TOKEN = 'session-ownership-fixture';
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false }));
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic-fixture',
    models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }]
} } }));
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { getSdk } = require('../server/pi-session-store');
let gateway, server, wss, base;
const waitFor = async check => {
    const until = Date.now() + 15000;
    while (!await check()) {
        assert.ok(Date.now() < until, 'ownership fixture did not reach its observed boundary');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
test.before(async () => {
    gateway = createPiAgentGateway();
    const app = express(); app.use(express.json()); gateway.mount(app);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    wss = gateway.attachWebSocket(server); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
    for (const ws of wss?.clients || []) ws.terminate();
    const workers = gateway ? [...gateway.supervisor.workers.values(), ...gateway.supervisor.ephemeralWorkers] : [];
    const processes = workers.map(worker => worker.client.processChild).filter(Boolean);
    await gateway?.dispose(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(gateway.supervisor.workers.size, 0); assert.equal(gateway.supervisor.ephemeralWorkers.size, 0);
    assert.ok(workers.every(worker => worker.subscribers.size === 0));
    assert.ok(processes.every(child => child.exitCode !== null || child.signalCode !== null), 'all owned native processes actually exited before fixture removal');
    fs.rmSync(root, { recursive: true, force: true });
});
async function api(tail, method = 'GET', body) {
    const response = await fetch(base + '/api/pi' + tail, { method, headers: {
        Authorization: 'Bearer session-ownership-fixture', 'Content-Type': 'application/json'
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
}
async function session(name = '') {
    const value = await gateway.store.createSession(root, name, { autoTitle: true });
    const { SessionManager } = await getSdk(), manager = SessionManager.open(value.path);
    manager.appendMessage({ role: 'user', content: 'QUESTION:' + value.id, timestamp: 1 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ANSWER:' + value.id }], stopReason: 'stop', timestamp: 2,
        api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
            totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    return value;
}
const target = value => ({ cwd: value.cwd, sessionId: value.id, sessionPath: value.path });
async function socket(t) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/pi/ws'), pending = new Map();
    let next = 0;
    ws.on('message', raw => {
        const event = JSON.parse(raw);
        if (event.type === 'response' && pending.has(event.id)) {
            const { resolve, timer } = pending.get(event.id); clearTimeout(timer); pending.delete(event.id); resolve(event);
        }
    });
    ws.on('close', () => {
        for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ closed: true }); }
        pending.clear();
    });
    ws.call = (type, payload = {}) => new Promise((resolve, reject) => {
        const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(new Error('WS response not observed: ' + type)); }, 15000);
        timer.unref?.(); pending.set(id, { resolve, timer });
        ws.send(JSON.stringify({ id, type, token: 'session-ownership-fixture', ...payload }));
    });
    await once(ws, 'open');
    t.after(async () => { if (ws.readyState !== WebSocket.CLOSED) { const closed = once(ws, 'close'); ws.terminate(); await closed; } });
    return ws;
}
function holdRequest(t, worker, command) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), original = worker.request;
    let first = true;
    worker.request = async function(type, ...args) {
        if (type === command && first) { first = false; entered.resolve(); await release.promise; }
        return original.call(this, type, ...args);
    };
    t.after(() => { release.resolve(); worker.request = original; });
    return { entered: entered.promise, release: () => release.resolve() };
}
function consistent(snapshot, value) {
    assert.equal(snapshot.session.id, value.id);
    assert.equal(snapshot.state.sessionId, value.id);
    assert.equal(snapshot.state.sessionFile, value.path);
    assert.match(JSON.stringify(snapshot.messages), new RegExp('QUESTION:' + value.id));
}

for (const secondType of ['open_session', 'open_ephemeral']) test('same WS rejects concurrent ' + secondType + ' without changing the admitted snapshot', { timeout: 60000 }, async t => {
    const a = await session('A'), b = await session('B'), worker = await gateway.supervisor.getWorker(target(a));
    const hold = holdRequest(t, worker, 'get_state'), ws = await socket(t);
    const opening = ws.call('open_session', { cwd: root, sessionId: a.id });
    await hold.entered;
    const rejected = await ws.call(secondType, { cwd: root, sessionId: b.id });
    hold.release(); const opened = await opening;
    assert.equal(rejected.success, false);
    assert.equal(rejected.errorCode, 'SESSION_OPEN_PENDING');
    assert.equal(opened.success, true); consistent(opened.data, a);
    assert.equal((await ws.call('get_state')).data.sessionId, a.id);
    const switched = await ws.call('open_session', { cwd: root, sessionId: b.id });
    assert.equal(switched.success, true); consistent(switched.data, b);
    assert.equal(worker.subscribers.size, 0);
});

test('opening rejects commands and side claims while a main worker is still being acquired', { timeout: 60000 }, async t => {
    const a = await session('main'), original = gateway.supervisor.getWorker.bind(gateway.supervisor);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    gateway.supervisor.getWorker = async input => { entered.resolve(); await release.promise; return original(input); };
    t.after(() => { release.resolve(); gateway.supervisor.getWorker = original; });
    const ws = await socket(t), opening = ws.call('open_session', { cwd: root, sessionId: a.id });
    await entered.promise;
    const side = await ws.call('open_side_chat', { ticket: 'invalid-fixture-ticket' });
    const command = await ws.call('get_state');
    release.resolve(); const opened = await opening;
    assert.equal(side.errorCode, 'SESSION_OPEN_PENDING');
    assert.equal(command.errorCode, 'SESSION_OPEN_PENDING');
    assert.equal(opened.success, true); consistent(opened.data, a);
    assert.equal((await ws.call('get_state')).data.sessionId, a.id);
});

test('a side connection keeps its identity when a main open races or follows its startup', async t => {
    const ready = Promise.withResolvers(), claimed = Promise.withResolvers(), original = gateway.sideChat.claim;
    let disposals = 0;
    gateway.sideChat.claim = () => { claimed.resolve(); return { ready: ready.promise, dispose: async () => { disposals++; }, handle: async () => ({ side: true }) }; };
    t.after(() => { ready.resolve({ side: true }); gateway.sideChat.claim = original; });
    const ws = await socket(t), opening = ws.call('open_side_chat', { ticket: 'synthetic-side' });
    await claimed.promise;
    const main = await ws.call('open_ephemeral', { cwd: root });
    ready.resolve({ side: true });
    assert.equal((await opening).success, true);
    assert.equal(main.success, false); assert.equal(main.errorCode, 'SESSION_OPEN_PENDING');
    assert.equal((await ws.call('get_state')).data.side, true);
    assert.equal((await ws.call('open_session', { cwd: root, sessionId: 'unused' })).success, false);
    assert.equal(disposals, 0, 'rejected main open must preserve the valid side connection');
});

test('ephemeral snapshot failure releases its owner and permits a clean subsequent open', { timeout: 60000 }, async t => {
    const original = gateway.supervisor.createEphemeralWorker.bind(gateway.supervisor); let failedWorker;
    gateway.supervisor.createEphemeralWorker = async (...args) => {
        const worker = await original(...args); failedWorker = worker;
        const request = worker.request.bind(worker);
        worker.request = (type, ...rest) => type === 'get_session_stats' ? Promise.reject(new Error('synthetic snapshot failure')) : request(type, ...rest);
        return worker;
    };
    t.after(() => { gateway.supervisor.createEphemeralWorker = original; });
    const ws = await socket(t), failed = await ws.call('open_ephemeral', { cwd: root });
    gateway.supervisor.createEphemeralWorker = original;
    assert.equal(failed.success, false); assert.match(failed.error, /synthetic snapshot failure/);
    assert.equal(failedWorker.disposed, true);
    assert.equal(gateway.supervisor.ephemeralWorkers.size, 0);
    assert.equal((await ws.call('open_ephemeral', { cwd: root })).success, true);
    const first = [...gateway.supervisor.ephemeralWorkers][0];
    assert.equal((await ws.call('open_ephemeral', { cwd: root })).success, true);
    assert.equal(first.disposed, true); assert.equal(gateway.supervisor.ephemeralWorkers.size, 1);
    ws.terminate(); await once(ws, 'close');
    await waitFor(() => gateway.supervisor.ephemeralWorkers.size === 0);
});

test('disconnect during ephemeral creation waits for cleanup and leaves no worker or subscription', { timeout: 60000 }, async t => {
    const original = gateway.supervisor.createEphemeralWorker.bind(gateway.supervisor);
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); let owner;
    gateway.supervisor.createEphemeralWorker = async (...args) => { owner = await original(...args); entered.resolve(); await release.promise; return owner; };
    t.after(() => { release.resolve(); gateway.supervisor.createEphemeralWorker = original; });
    const ws = await socket(t); void ws.call('open_ephemeral', { cwd: root }); await entered.promise;
    ws.terminate(); await once(ws, 'close'); release.resolve();
    await waitFor(() => gateway.supervisor.ephemeralWorkers.size === 0);
    assert.equal(owner.disposed, true); assert.equal(owner.subscribers.size, 0);
});

test('HTTP offline rename owns metadata before its re-read and blocks concurrent startup', { timeout: 60000 }, async t => {
    const value = await session('before'), original = gateway.store.withSessionRead.bind(gateway.store);
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); let reads = 0;
    gateway.store.withSessionRead = async (...args) => {
        if (args[1] === value.id && ++reads === 2) { entered.resolve(); await release.promise; }
        return original(...args);
    };
    t.after(() => { release.resolve(); gateway.store.withSessionRead = original; });
    const renaming = api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'manual offline' });
    await entered.promise;
    const observed = gateway.supervisor.getWorker(target(value)).then(() => null, error => error);
    release.resolve(); const result = await renaming;
    assert.match((await observed)?.message || '', /metadata is being changed/);
    assert.equal(result.status, 200); assert.equal(result.data.name, 'manual offline');
    const worker = await gateway.supervisor.getWorker(target(value));
    assert.equal((await worker.request('get_state')).sessionName, 'manual offline');
    assert.equal((await gateway.store.getSession(root, value.id)).name, 'manual offline');
});

test('HTTP rename waits for startup, uses that worker, and invalidates automatic title CAS', { timeout: 60000 }, async t => {
    const value = await session(), { PiRpcClient } = require('../server/pi-rpc-client'), originalStart = PiRpcClient.prototype.start;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    PiRpcClient.prototype.start = async function(...args) {
        await originalStart.apply(this, args);
        if (this.sessionPath === value.path) { entered.resolve(); await release.promise; }
    };
    t.after(() => { release.resolve(); PiRpcClient.prototype.start = originalStart; });
    const starting = gateway.supervisor.getWorker(target(value)); await entered.promise;
    let renameCompleted = false;
    const renaming = api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'manual during startup' }).then(result => { renameCompleted = true; return result; });
    await waitFor(() => gateway.supervisor.editing.has(value.path) || renameCompleted);
    assert.equal(gateway.supervisor.isSessionIdle(value.path), false);
    release.resolve(); const worker = await starting, result = await renaming;
    assert.equal(result.status, 200);
    assert.equal((await worker.request('get_state')).sessionName, 'manual during startup');
    assert.equal((await gateway.store.getSession(root, value.id)).name, 'manual during startup');
    assert.equal(gateway.supervisor.workers.get(value.path), worker);
    assert.equal((await worker.titleRequest({ action: 'snapshot' })).eligible, false);
    await gateway.supervisor.stopSession(value.path);
    const reopened = await gateway.supervisor.getWorker(target(value));
    assert.equal((await reopened.request('get_state')).sessionName, 'manual during startup');
});

test('active HTTP and WS rename are visible to native automatic-title CAS and reopen', { timeout: 60000 }, async t => {
    const value = await session(), ws = await socket(t);
    assert.equal((await ws.call('open_session', { cwd: root, sessionId: value.id })).success, true, 'valid native snapshot must open');
    const worker = gateway.supervisor.getActiveWorker(value.path), before = await worker.titleRequest({ action: 'snapshot' });
    const attemptId = 'synthetic-attempt';
    assert.equal((await worker.titleRequest({ action: 'claim', nameRevision: before.nameRevision, contextRevision: before.contextRevision, attemptId })).claimed, true);
    assert.equal((await api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'HTTP manual' })).status, 200);
    await assert.rejects(worker.titleRequest({ action: 'commit', name: 'late automatic', nameRevision: before.nameRevision, contextRevision: before.contextRevision, attemptId }), /已变化|已失效/);
    assert.equal((await ws.call('get_state')).data.sessionName, 'HTTP manual');
    assert.equal((await ws.call('set_session_name', { name: 'RPC manual' })).success, true);
    assert.equal((await gateway.store.getSession(root, value.id)).name, 'RPC manual');
    await gateway.supervisor.stopSession(value.path);
    assert.equal((await (await gateway.supervisor.getWorker(target(value))).request('get_state')).sessionName, 'RPC manual');
});

test('ephemeral cleanup retains open admission until process exit and a replacement cannot race it', { timeout: 60000 }, async t => {
    const ws = await socket(t);
    assert.equal((await ws.call('open_ephemeral', { cwd: root })).success, true);
    const owner = [...gateway.supervisor.ephemeralWorkers][0], originalDispose = owner.shell.dispose.bind(owner.shell);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    owner.shell.dispose = async () => { entered.resolve(); await release.promise; return originalDispose(); };
    t.after(() => release.resolve());
    const replacing = ws.call('open_ephemeral', { cwd: root }); await entered.promise;
    const rejected = await ws.call('open_ephemeral', { cwd: root });
    assert.equal(rejected.errorCode, 'SESSION_OPEN_PENDING');
    assert.equal(gateway.supervisor.ephemeralWorkers.size, 1, 'retiring temporary process still owns its slot');
    release.resolve(); assert.equal((await replacing).success, true);
    assert.equal(gateway.supervisor.ephemeralWorkers.has(owner), false);
    assert.equal(gateway.supervisor.ephemeralWorkers.size, 1);
    ws.terminate(); await once(ws, 'close'); await waitFor(() => gateway.supervisor.ephemeralWorkers.size === 0);
});

test('persistent snapshot failure and disconnect detach subscribers while keeping the unique shared worker', { timeout: 60000 }, async t => {
    const value = await session('shared'), worker = await gateway.supervisor.getWorker(target(value)), original = worker.request;
    let failSnapshot = true;
    worker.request = function(type, ...args) {
        return type === 'get_session_stats' && failSnapshot ? Promise.reject(new Error('persistent snapshot failure')) : original.call(this, type, ...args);
    };
    t.after(() => { worker.request = original; });
    const ws = await socket(t);
    assert.equal((await ws.call('open_session', { cwd: root, sessionId: value.id })).success, false);
    assert.equal(worker.subscribers.size, 0); assert.equal(worker.disposed, false);
    failSnapshot = false;
    const hold = holdRequest(t, worker, 'get_session_stats'), opening = ws.call('open_session', { cwd: root, sessionId: value.id });
    await hold.entered; ws.terminate(); await once(ws, 'close'); hold.release(); await opening;
    await waitFor(() => worker.subscribers.size === 0);
    assert.equal(worker.disposed, false); assert.equal(gateway.supervisor.getActiveWorker(value.path), worker);
});

test('rename waits for actual retirement and owns maintenance, move, removal and replacement admission', { timeout: 60000 }, async t => {
    const value = await session('retiring'), worker = await gateway.supervisor.getWorker(target(value)), original = worker.shell.dispose.bind(worker.shell);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    worker.shell.dispose = async () => { entered.resolve(); await release.promise; return original(); };
    t.after(() => release.resolve());
    const stopping = gateway.supervisor.stopSession(value.path); await entered.promise;
    const renaming = api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'after actual exit' });
    await waitFor(() => gateway.supervisor.editing.has(value.path));
    assert.equal(gateway.supervisor.isIdle(), false); assert.equal(gateway.supervisor.isSessionIdle(value.path), false);
    await assert.rejects(gateway.supervisor.acquireQueueReferenceLease(), /会话正在执行/);
    await assert.rejects(gateway.supervisor.getWorker(target(value)), /metadata is being changed/);
    await assert.rejects(gateway.supervisor.withSessionMove(value.path, value.path + '.target', () => assert.fail('must not move')), /operation is already/);
    await assert.rejects(gateway.supervisor.withSessionRemoval(value.path, () => assert.fail('must not remove')), /metadata is being changed/);
    let saved = false; renaming.then(() => { saved = true; });
    await gateway.supervisor._sweep(); assert.equal(saved, false);
    release.resolve(); await stopping;
    assert.equal((await renaming).status, 200);
    assert.equal(gateway.supervisor.editing.has(value.path), false);
    assert.equal((await gateway.store.getSession(root, value.id)).name, 'after actual exit');
    assert.equal((await (await gateway.supervisor.getWorker(target(value))).request('get_state')).sessionName, 'after actual exit');
});

test('unknown active rename blocks replay, late responses, cleanup and idle until explicit quit', { timeout: 60000 }, async t => {
    const value = await session('unchanged'), worker = await gateway.supervisor.getWorker(target(value)), original = worker.client.request;
    const bytes = fs.readFileSync(value.path); let attempts = 0;
    worker.client.request = function(type, ...args) {
        if (type === 'set_session_name') { attempts++; return Promise.reject(Object.assign(new Error('synthetic unknown rename'), { code: 'RPC_TIMEOUT' })); }
        return original.call(this, type, ...args);
    };
    t.after(() => { worker.client.request = original; });
    const renamed = await api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'must not append offline' });
    assert.equal(renamed.status, 400); assert.match(renamed.data.error, /命名结果不确定.*重新打开/);
    assert.equal(attempts, 1); assert.deepEqual(fs.readFileSync(value.path), bytes);
    assert.equal(gateway.supervisor.getActiveWorker(value.path), worker); assert.equal(worker.disposed, false);
    assert.equal((await worker.request('get_state')).sessionName, 'unchanged');
    worker.client._handleLine(JSON.stringify({ type: 'response', id: 'late-name-fixture', command: 'set_session_name', success: true, data: {} }));
    assert.equal(worker.isIdle(), false); assert.ok(worker.lifecycle().blockers.includes('session-name-uncertain'));
    assert.equal(gateway.supervisor.isSessionIdle(value.path), false);
    await assert.rejects(gateway.supervisor.acquireQueueReferenceLease(), /会话正在执行/);
    assert.equal((await api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'must not replay' })).status, 400);
    assert.equal((await api('/sessions/' + value.id + '?cwd=' + encodeURIComponent(root), 'DELETE')).status, 400);
    await assert.rejects(worker.request('set_session_name', { name: 'must not bypass' }), { code: 'SESSION_NAME_UNCERTAIN' });
    await assert.rejects(worker.titleRequest({ action: 'snapshot' }), { code: 'SESSION_NAME_UNCERTAIN' });
    assert.equal(attempts, 1); await gateway.supervisor._sweep(); assert.equal(worker.disposed, false);
    await worker.shutdown(() => gateway.supervisor.stopSession(value.path));
    const reopened = await gateway.supervisor.getWorker(target(value));
    assert.equal(reopened.sessionNameUncertain, false);
    assert.equal((await reopened.request('get_state')).sessionName, 'unchanged');
});

test('offline rename revalidates the native descriptor when a file is replaced after parsing', { timeout: 60000 }, async t => {
    const value = await session('original identity'), original = gateway.store.withSessionRead.bind(gateway.store);
    let reads = 0, replacement;
    gateway.store.withSessionRead = (cwd, id, action) => original(cwd, id, async (session, read) => {
        if (id === value.id && ++reads === 2) {
            const moved = value.path + '.previous'; fs.renameSync(value.path, moved); fs.copyFileSync(moved, value.path);
            replacement = fs.readFileSync(value.path);
        }
        return action(session, read);
    });
    t.after(() => { gateway.store.withSessionRead = original; });
    const renamed = await api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'must not use old proof' });
    assert.equal(renamed.status, 400); assert.match(renamed.data.error, /Session file changed/);
    assert.ok(replacement); assert.deepEqual(fs.readFileSync(value.path), replacement);
    assert.equal(gateway.supervisor.editing.has(value.path), false);
});

test('Supervisor shutdown waits for an admitted metadata operation without admitting startup', async () => {
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor'), supervisor = new PiAgentSupervisor();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const editing = supervisor.withSessionEdit('synthetic-offline-path', async () => { entered.resolve(); await release.promise; return 'saved'; }, { idle: false });
    await entered.promise;
    const stopping = supervisor.dispose(); let stopped = false; stopping.then(() => { stopped = true; });
    await assert.rejects(supervisor.getWorker({ sessionPath: 'synthetic-offline-path' }), /shutting down/);
    assert.equal(stopped, false); release.resolve(); assert.equal(await editing, 'saved'); await stopping;
    assert.equal(supervisor.editing.size, 0);
});

test('definite rename refusal and pre-submit readiness timeout do not retain uncertain ownership', { timeout: 60000 }, async t => {
    const value = await session('confirmed original'), worker = await gateway.supervisor.getWorker(target(value));
    const originalReady = worker.ensureReady, originalRequest = worker.client.request;
    t.after(() => { worker.ensureReady = originalReady; worker.client.request = originalRequest; });
    worker.ensureReady = () => Promise.reject(Object.assign(new Error('readiness not reached'), { code: 'RPC_TIMEOUT' }));
    await assert.rejects(worker.request('set_session_name', { name: 'never submitted' }), { code: 'RPC_TIMEOUT' });
    assert.equal(worker.sessionNameUncertain, false);
    worker.ensureReady = originalReady;
    worker.client.request = function(type, ...args) {
        return type === 'set_session_name' ? Promise.reject(Object.assign(new Error('definite refusal'), { code: 'RPC_REJECTED' })) : originalRequest.call(this, type, ...args);
    };
    const refused = await api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'refused' });
    assert.equal(refused.status, 400); assert.match(refused.data.error, /definite refusal/);
    assert.equal(worker.sessionNameUncertain, false); assert.equal(worker.isIdle(), true);
    worker.client.request = originalRequest;
    worker.activity.handle({ type: 'agent_start' });
    const busyRename = await api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'confirmed while running' });
    worker.activity.handle({ type: 'agent_settled' });
    assert.equal(busyRename.status, 200, 'metadata rename retains its existing busy-turn behavior');
    assert.equal((await worker.request('get_state')).sessionName, 'confirmed while running');
});

test('startup failure aborts waiting rename without offline append or worker leakage', { timeout: 60000 }, async t => {
    const value = await session('before failed startup'), original = gateway.supervisor.workerEnvironment;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    gateway.supervisor.workerEnvironment = async input => {
        if (input.sessionId === value.id) { entered.resolve(); await release.promise; throw new Error('synthetic startup failure'); }
        return original(input);
    };
    t.after(() => { release.resolve(); gateway.supervisor.workerEnvironment = original; });
    const bytes = fs.readFileSync(value.path), starting = gateway.supervisor.getWorker(target(value)).then(() => null, error => error);
    await entered.promise;
    const renaming = api('/sessions/' + value.id, 'PATCH', { cwd: root, name: 'must not fall back' });
    await waitFor(() => gateway.supervisor.editing.has(value.path)); release.resolve();
    assert.match((await starting).message, /synthetic startup failure/);
    assert.equal((await renaming).status, 400); assert.deepEqual(fs.readFileSync(value.path), bytes);
    assert.equal(gateway.supervisor.starting.has(value.path), false);
    assert.equal(gateway.supervisor.editing.has(value.path), false);
    assert.equal(gateway.supervisor.workers.has(value.path), false);
});
