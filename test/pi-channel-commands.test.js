const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-channel-commands-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { ChannelsService, parseSlash } = require('../server/channels/service');
const { ChannelStore } = require('../server/channels/store');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(5); } throw Error('Fixture timed out'); };
function fixture(t, text) {
    const cwd = path.join(root, String(Math.random())); fs.mkdirSync(cwd);
    const db = new ChannelStore(path.join(cwd, 'channel')); db.claim(); t.after(() => db.close());
    const sessions = new Map(['a', 'b', 'c'].map(id => [id, { id, cwd, path: path.join(cwd, id + '.jsonl'), name: id.toUpperCase() }]));
    const job = { id: 'job', accountId: 'bot', peerId: 'owner', bindingId: 'binding', target: { cwd, sessionId: 'a' }, status: 'queued', text };
    db.change(v => Object.assign(v, { accounts: [{ id: 'bot', userId: 'owner', allowedUsers: ['owner'], enabled: true, token: 'fixture', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: '' }],
        bindings: [{ id: 'binding', accountId: 'bot', peerId: 'owner', cwd, sessionId: 'a' }],
        peers: [{ accountId: 'bot', peerId: 'owner', contextToken: 'fixture' }], jobs: [job] }));
    const s = Object.create(ChannelsService.prototype), calls = [], sends = [];
    const state = { model: { provider: 'first', id: 'common' }, thinkingLevel: 'off' };
    const worker = { operation: false, channelCommandId: null, isIdle() { return !this.operation; },
        async request(type, payload, timeout, beforeSend) {
            await s.beforeRpc?.(type);
            beforeSend?.(); calls.push({ type, payload, timeout, commandStatus: s.job('job').status });
            if (type === 'get_state') return structuredClone(state);
            if (type === 'get_available_models') return { models: [{ provider: 'first', id: 'common' }, { provider: 'second', id: 'common' }] };
            if (type === 'get_available_thinking_levels') return { levels: ['off', 'high'] };
            if (type === 'compact') { await s.compact?.(); state.webCompaction = s.compactionResult; }
            if (type === 'set_model') state.model = { provider: payload.provider, id: payload.modelId };
            if (type === 'set_thinking_level') state.thinkingLevel = payload.level;
            return {};
        },
        async exclusive(callback) {
            if (this.operation) throw Object.assign(Error('busy'), { code: 'SESSION_BUSY' });
            this.operation = true;
            try { return await callback(this.request.bind(this), state); }
            finally { this.operation = false; }
        },
        async channelTurn(input, hooks) { calls.push({ type: 'channel', input }); if (!hooks.admit()) return { cancelled: true }; hooks.accepted(); return { status: 'completed' }; }
    };
    Object.assign(s, { ready: Promise.resolve(), db, runs: new Map(), operations: new Set(), pollers: new Map(), connections: new Map(), stopping: false, mutating: false, error: null, isSuspended: () => false,
        stopController: new AbortController(), sent: sends, adapter: { send: async (_a, _p, body) => { sends.push(body); return {}; } },
        store: { sessionLists: new Map(),
            getSession: async (_cwd, id) => { if (!sessions.has(id)) throw Error('missing'); return sessions.get(id); },
            listSessions: async () => [...sessions.values()],
            withSessionRead: async (dir, id, fn) => fn(await s.store.getSession(dir, id), { manager: () => ({ getEntries: () => sessions.get(id).entries || [], getBranch: () => sessions.get(id).entries || [] }), validate() {} }),
            createSession: async () => { const created = { id: 'new', cwd, path: path.join(cwd, 'new.jsonl'), name: 'New' }; sessions.set('new', created); return created; }
        }, supervisor: { getActiveWorker: () => worker, getWorker: async () => worker },
        collectDeliverables: async () => [], collectMediaAssets: async () => [], readOutcome: async () => ({ status: 'completed', body: 'reply', deliverables: [] }) });
    return { s, db, job, worker, calls, sends, state, sessions, cwd };
}

test('mutating command is durably dispatching before native submission and restart cannot requeue it', async t => {
    const { s, db, calls, cwd } = fixture(t, '/compact'); const started = deferred(), release = deferred();
    s.compactionResult = { status: 'success', tokensBefore: 1000, estimatedTokensAfter: 100 };
    s.compact = async () => { started.resolve(); await release.promise; };
    const work = s.run('job', {}); await started.promise;
    const saved = JSON.parse(fs.readFileSync(db.file));
    assert.equal(saved.jobs[0].status, 'dispatching'); assert.equal(saved.jobs[0].commandSubmitted, true);
    const directory = path.join(cwd, 'restart'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(saved), { mode: 0o600 });
    const reopened = new ChannelStore(directory); reopened.claim();
    assert.equal(reopened.value.jobs[0].status, 'uncertain'); reopened.close();
    release.resolve(); await work;
    assert.equal(calls.filter(c => c.type === 'compact').length, 1); assert.equal(s.job('job').status, 'delivered');
});

test('revocation during worker startup cancels a command without changing the model', async t => {
    const { s, db, worker, state, calls } = fixture(t, '/model second/common'); const started = deferred(), release = deferred();
    s.supervisor.getWorker = async () => { started.resolve(); await release.promise; return worker; };
    const work = s.run('job', {}); await started.promise;
    db.change(v => { v.accounts[0].enabled = false; v.jobs[0].status = 'cancelled'; }); release.resolve(); await work;
    assert.equal(state.model.provider, 'first'); assert.equal(s.job('job').status, 'cancelled');
    assert.equal(calls.some(c => c.type === 'set_model'), false);
});

test('permission is rechecked immediately before RPC submission, after readiness waits', async t => {
    const { s, db, calls } = fixture(t, '/thinking high');
    s.beforeRpc = async type => { if (type === 'set_thinking_level') db.change(v => { v.accounts[0].allowedUsers = []; }); };
    await s.run('job', {});
    assert.equal(calls.some(c => c.type === 'set_thinking_level'), false); assert.equal(s.job('job').status, 'cancelled');
});

test('model reads and mutation reserve the worker against an overlapping web turn', async t => {
    const { s, worker, calls } = fixture(t, '/model second/common'); let blocked = false;
    s.beforeRpc = async type => {
        if (type === 'get_available_models') { await assert.rejects(worker.exclusive(() => {}), /busy/); blocked = true; }
    };
    await s.run('job', {}); assert.ok(blocked);
    assert.equal(calls.find(c => c.type === 'set_model').timeout, null, 'mutating RPC retains operation until response/process exit');
    assert.equal(worker.channelCommandId, null);
});

test('ambiguous bare model ID requests disambiguation; full provider ID is exact', async t => {
    const { s, calls, sends } = fixture(t, '/model common'); await s.run('job', {});
    assert.equal(calls.some(c => c.type === 'set_model'), false); assert.match(sends[0], /多个匹配/);
});

test('resume keeps original indices after an earlier candidate is deleted', async t => {
    const { s, db, sessions, cwd } = fixture(t, '/resume 2');
    db.change(v => Object.assign(v.peers[0], { resumeCandidates: ['deleted', 'b', 'c'], resumeCwd: cwd, resumeListedAt: Date.now() }));
    sessions.delete('deleted'); await s.run('job', {}); assert.equal(db.value.bindings[0].sessionId, 'b');
});

test('resume deleted candidate refuses to shift its number', async t => {
    const { s, db, sends, cwd } = fixture(t, '/resume 1');
    db.change(v => Object.assign(v.peers[0], { resumeCandidates: ['deleted', 'b'], resumeCwd: cwd, resumeListedAt: Date.now() }));
    await s.run('job', {}); assert.equal(db.value.bindings[0].sessionId, 'a'); assert.match(sends[0], /已不存在/);
});

for (const kind of ['missing', 'stale', 'other-project']) test(`resume ${kind} numbered list requires a fresh list`, async t => {
    const { s, db, cwd, sends } = fixture(t, '/resume 2');
    if (kind !== 'missing') db.change(v => Object.assign(v.peers[0], { resumeCandidates: ['a', 'b'], resumeCwd: kind === 'other-project' ? '/elsewhere' : cwd, resumeListedAt: kind === 'stale' ? 1 : Date.now() }));
    await s.run('job', {}); assert.equal(db.value.bindings[0].sessionId, 'a'); assert.match(sends[0], /列表已失效/);
});

for (const marker of ['pivane-extension-assistant', 'pivane-profile-authoring']) test(`resume rejects ${marker} management target`, async t => {
    const { s, db, sessions, sends } = fixture(t, '/resume b');
    sessions.get('b').entries = [{ type: 'custom', customType: marker }];
    await s.run('job', {}); assert.equal(db.value.bindings[0].sessionId, 'a'); assert.match(sends[0], /管理助手/);
});

test('new then an already queued message preserves peer order and targets the new thread', async t => {
    const { s, db, job, calls } = fixture(t, '/new');
    db.change(v => v.jobs.push({ ...job, id: 'follow', text: 'Continue in the new thread' }));
    await s.run('job', {}); assert.equal(s.job('follow').target.sessionId, 'new');
    await s.run('follow', {}); assert.equal(s.job('follow').status, 'delivered');
    assert.equal(calls.filter(c => c.type === 'channel').length, 1);
});

test('a changed binding returns an explicit cancellation notice without running the input', async t => {
    const { s, db, calls, sends } = fixture(t, 'Do not execute in a different thread');
    db.change(v => { v.bindings[0].id = 'replacement'; v.bindings[0].sessionId = 'b'; });
    await s.run('job', {}); assert.equal(calls.length, 0); assert.match(sends[0], /尚未执行/);
});

for (const [status, text] of [['success', /压缩完成.*1\.0k.*100/], ['unchanged', /无需压缩/], ['cancelled', /已取消/], ['error', /未完成/]]) {
    test(`compact reports proven ${status}`, async t => {
        const { s, sends } = fixture(t, '/compact'); s.compactionResult = { status, tokensBefore: 1000, estimatedTokensAfter: 100 };
        await s.run('job', {}); assert.match(sends[0], text);
    });
}
test('compact without completion proof becomes uncertain rather than claiming success', async t => {
    const { s, sends } = fixture(t, '/compact'); s.compactionResult = null;
    s.pump(); await until(() => s.runs.size === 0);
    assert.equal(s.job('job').status, 'uncertain'); assert.equal(sends.length, 0);
});
