'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ProfileLearningService } = require('../server/profile-memory/learning-service');
const history = require('../server/profile-memory/learning-history');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = value => createHash('sha256').update(value).digest('hex');
const nativeText = e => e.message.content.map(p => p.text).join(' ');
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-forks-'));
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_PROJECT_ROOTS = root;
    const { PiSessionStore, getSdk } = require('../server/pi-session-store');
    const { SessionManager } = await getSdk();
    const store = new PiSessionStore();
    const profile = { id: profileId, enabled: true, memory: { enabled: true } };
    const profiles = { state: async () => ({ state: { profiles: [profile] } }), getProfile: async () => profile,
        select: async () => profileId, describe: async () => ({ id: profileId }),
        context: async (manager, currentCwd) => ({ version: 1, profileId, sessionId: manager.getSessionId(), cwd: currentCwd,
            sessionPath: manager.getSessionFile(), profileRoot: path.join(agentDir, 'pivane-profiles', 'data', profileId),
            sessionsRoot: path.join(agentDir, 'sessions'), memory: { enabled: true } }) };
    store.profiles = profiles;
    const raw = await store.createSession(cwd, 'synthetic', { agentProfileId: profileId });
    const ref = session => ({ ...session, sessionId: session.id, sessionPath: session.path });
    const session = ref(raw);
    const model = { provider: 'fixture', id: 'cheap', input: ['text'], maxTokens: 1024 };
    const preferences = new WorkspacePreferencesService({ filePath: path.join(agentDir, 'preferences.json') });
    preferences.writeDocument({ memoryModels: Object.fromEntries(['correction', 'review', 'extraction']
        .map(k => [`memory-${k}`, { provider: 'fixture', modelId: 'cheap' }])) });
    let calls = 0;
    const runtime = { getModel: () => model, getAvailable: async () => [model], completeSimple: async () => {
        calls++; return { stopReason: 'stop', usage: { input: 30, output: 5 },
            content: [{ type: 'text', text: JSON.stringify({ action: 'skip', reason: 'no-durable-fact' }) }] };
    } };
    const knowledge = { snapshot: async () => ({ status: 'ready', revision: 'a'.repeat(64), items: [], capabilities: { memory: true } }),
        mutateFromNative: async () => { throw new Error('skip fixture must not write'); } };
    const services = [];
    function service() {
        const value = new ProfileLearningService({ profiles, store, preferences, knowledge, getAgentDir: async () => agentDir,
            createModelRuntime: async () => runtime });
        services.push(value); return value;
    }
    t.after(async () => { await Promise.all(services.map(s => s.dispose())); fs.rmSync(root, { recursive: true, force: true }); });
    const learning = service();
    await learning.save(profileId, { expectedRevision: 0, changes: { enabled: true, reviewEnabled: true } });
    function append(target, user = '合成流程结果已确认。', assistant = '合成回复。') {
        const manager = SessionManager.open(target.path);
        const userId = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: user }], timestamp: Date.now() });
        const assistantId = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: assistant }], timestamp: Date.now(),
            api: 'openai-completions', provider: 'fixture', model: 'cheap', stopReason: 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        return { userId, assistantId };
    }
    async function fork(target, { legacy = false, leafId } = {}) {
        const manager = SessionManager.open(target.path);
        if (legacy) {
            manager.createBranchedSession(leafId || manager.getLeafId());
            manager.appendCustomEntry('pivane-agent-profile', { version: 1, sessionId: manager.getSessionId(), profileId });
            return ref(await store.getSession(cwd, manager.getSessionId()));
        }
        const snapshot = { entries: manager.getEntries(), leafId: manager.getLeafId() };
        return ref((await store.forkSession(target, snapshot, leafId, leafId ? 'at' : 'before')).session);
    }
    async function settle(count, s = learning) {
        for (let i = 0; i < 200; i++) {
            if ((await s.snapshot(profileId)).recentRuns.length === count && !s.active.size) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('learning did not settle');
    }
    return { learning, service, session, store, profiles, preferences, SessionManager, cwd, agentDir, append, fork, settle, calls: () => calls };
}

test('ordinary and nested web forks skip inherited pairs but learn each new pair once, including after restart', async t => {
    const f = await fixture(t); f.append(f.session);
    await f.learning.register(f.session); await f.settle(1);
    const fork = await f.fork(f.session);
    await f.learning.register(fork); await f.learning.flushRegistrations();
    assert.equal(f.calls(), 1);
    f.append(fork, '分叉后的合成结果已确认。');
    await f.learning.register(fork); await f.settle(2);
    const nested = await f.fork(fork);
    await f.learning.register(nested, 'exit');
    assert.equal(f.calls(), 2);
    f.append(nested, '嵌套分叉后的合成结果已确认。');
    await f.learning.register(nested); await f.settle(3);
    await f.learning.dispose(); const restarted = f.service();
    await restarted.resume(); await restarted.register(nested); assert.equal(f.calls(), 3);
    f.append(nested, '重启后的合成结果已确认。');
    await restarted.register(nested); await f.settle(4, restarted);
    assert.deepEqual((await restarted.snapshot(profileId)).health.today, { runs: 4, maxRuns: 20, reservedTokens: 24000, maxTokens: 200000 });
});

test('fork before a reply completes the inherited user with a new reply rather than dropping that new pair', async t => {
    const f = await fixture(t); const pair = f.append(f.session);
    const manager = f.SessionManager.open(f.session.path);
    const fork = await f.fork(f.session, { legacy: true, leafId: pair.userId });
    const newManager = f.SessionManager.open(fork.path);
    const assistant = manager.getEntries().find(e => e.id === pair.assistantId).message;
    newManager.appendMessage({ ...assistant, content: [{ type: 'text', text: '新的合成回复。' }] });
    await f.learning.register(fork); await f.settle(1);
    assert.equal(f.calls(), 1);
});

test('legacy forks derive a persistent native prefix, even after the parent disappears, and do not backfill unlearned inherited history', async t => {
    const f = await fixture(t);
    for (let i = 0; i < 12; i++) f.append(f.session, `旧合成结果 ${i} 已确认。`);
    const fork = await f.fork(f.session, { legacy: true });
    f.append(fork, '旧分叉的新合成结果。');
    await f.learning.register(fork); await f.settle(1); assert.equal(f.calls(), 1);
    fs.unlinkSync(f.session.path);
    await f.learning.dispose(); const restarted = f.service();
    await restarted.resume(); f.append(fork, '父文件移除后新的合成结果。');
    await restarted.register(fork); await f.settle(2, restarted); assert.equal(f.calls(), 2);
});

test('branch switch and context edits retain durable pair coverage beyond the old eight-pair window and learn new continuations', async t => {
    const f = await fixture(t); const rows = [];
    for (let i = 0; i < 10; i++) rows.push(f.append(f.session, `合成结果 ${i} 已确认。`));
    await f.learning.register(f.session); await f.settle(10);
    let manager = f.SessionManager.open(f.session.path);
    manager.appendContextEdit(rows[0].userId, { content: [{ type: 'text', text: '历史合成文本修改。' }] });
    await f.learning.register(f.session); assert.equal(f.calls(), 10);
    manager = f.SessionManager.open(f.session.path);
    manager.appendContextEdit(rows[0].userId, { content: '纠正一下：不是旧流程，而是新流程，以后保持。' });
    await f.learning.register(f.session); assert.equal(f.calls(), 10, 'an edit changing the purpose must not charge the same pair again');
    manager = f.SessionManager.open(f.session.path); manager.branch(rows[2].assistantId);
    f.append(f.session, '旁支新增合成结果。');
    await f.learning.register(f.session); await f.settle(11);
    manager = f.SessionManager.open(f.session.path); manager.branch(rows[9].assistantId);
    f.append(f.session, '原分支新增合成结果。');
    await f.learning.register(f.session); await f.settle(12);
    const snap = await f.learning.snapshot(profileId); assert.equal(snap.capabilities.capacity.blockedBranches, 0);
    assert.equal(snap.health.today.reservedTokens, 72000);
});

test('fork branch navigation and historical edits never turn inherited pairs into fresh work', async t => {
    const f = await fixture(t); const a = f.append(f.session), b = f.append(f.session);
    const fork = await f.fork(f.session);
    let manager = f.SessionManager.open(fork.path);
    manager.appendContextEdit(a.userId, { content: [{ type: 'text', text: '请记住以后使用更新的合成流程。' }] });
    await f.learning.register(fork); assert.equal(f.calls(), 0);
    manager = f.SessionManager.open(fork.path); manager.branch(a.assistantId);
    f.append(fork); await f.learning.register(fork); await f.settle(1);
    manager = f.SessionManager.open(fork.path); manager.branch(b.assistantId);
    f.append(fork); await f.learning.register(fork); await f.settle(2);
    assert.equal(f.calls(), 2);
});

test('queued edited or abandoned sources are skipped without spending quota and a fresh continuation is learned', async t => {
    const f = await fixture(t); f.learning.idle = () => false;
    const row = f.append(f.session); await f.learning.register(f.session);
    assert.equal((await f.learning.snapshot(profileId)).jobs.length, 1);
    let manager = f.SessionManager.open(f.session.path); manager.appendContextEdit(row.userId, null);
    f.learning.idle = () => true; f.learning.wake(profileId); await f.settle(1);
    assert.equal(f.calls(), 0); assert.equal((await f.learning.snapshot(profileId)).health.today.runs, 0);
    f.append(f.session); await f.learning.register(f.session); await f.settle(2); assert.equal(f.calls(), 1);
});

test('legacy unsafe or missing parents fail closed; new explicit boundaries need no parent read', async t => {
    const f = await fixture(t); f.append(f.session);
    const legacy = await f.fork(f.session, { legacy: true }), modern = await f.fork(f.session);
    fs.unlinkSync(f.session.path);
    f.append(legacy); await f.learning.register(legacy); assert.equal(f.calls(), 0);
    f.append(modern); await f.learning.register(modern); await f.settle(1); assert.equal(f.calls(), 1);
});

test('inherited queued jobs are discarded before quota reservation or a model call', async t => {
    const f = await fixture(t); const ids = f.append(f.session); const fork = await f.fork(f.session);
    await f.learning.change(profileId, s => { s.jobs.push({ id: 'b'.repeat(64), reason: 'review', status: 'queued',
        ...fork, ...ids, createdAt: new Date().toISOString() }); });
    f.learning.wake(profileId); await f.settle(1);
    assert.equal(f.calls(), 0); const snap = await f.learning.snapshot(profileId);
    assert.equal(snap.health.today.runs, 0); assert.equal(snap.recentRuns[0].error, 'source-changed');
});

test('refund proves each inherited pair, preserves real usage/cost and audit, is idempotent, and cannot refund a legitimate fork continuation', async t => {
    const f = await fixture(t); const ids = f.append(f.session); const fork = await f.fork(f.session);
    const manager = f.SessionManager.open(fork.path), entries = manager.getEntries();
    const user = entries.find(e => e.id === ids.userId), assistant = entries.find(e => e.id === ids.assistantId);
    const day = new Date().toISOString().slice(0, 10), at = new Date().toISOString();
    const original = { id: 'c'.repeat(64), reason: 'review', status: 'skipped', error: 'duplicate',
        cwd: fork.cwd, sessionId: fork.id, sessionPath: fork.path, ...ids, createdAt: at, startedAt: at, endedAt: at,
        reservedTokens: 6000, model: { provider: 'fixture', modelId: 'cheap' }, usage: { input: 100, output: 5, totalTokens: 105, reportedCostUsd: 0.01 },
        costStatus: 'reported', receiptIds: [], sourceIdentity: hash(JSON.stringify([fork.path, ids.userId, ids.assistantId, nativeText(user), nativeText(assistant)])) };
    await f.learning.change(profileId, s => { s.recentRuns.push(original); });
    const input = { requestId: 'refund-inherited-01', day, runIds: [original.id], expectedRevision: (await f.learning.snapshot(profileId)).revision };
    await assert.rejects(f.learning.refundInherited(profileId, { ...input, day: '2000-01-01' }), /cannot be refunded/);
    const result = await f.learning.refundInherited(profileId, input);
    assert.deepEqual([result.receipt.runs, result.receipt.reservedTokens], [1, 6000]);
    let state = f.learning.read(await f.learning.location(profileId));
    const { quotaRefund, ...preserved } = state.recentRuns[0]; assert.deepEqual(preserved, original);
    assert.deepEqual(state.quotaReconciliations[input.requestId].originalRuns, [original]);
    assert.equal((await f.learning.snapshot(profileId)).health.today.runs, 0);
    await f.learning.refundInherited(profileId, input); assert.equal(f.learning.read(await f.learning.location(profileId)).revision, state.revision);
    await assert.rejects(f.learning.refundInherited(profileId, { ...input, runIds: ['d'.repeat(64)] }), /changed/);
    f.append(fork); await f.learning.register(fork); await f.settle(2); assert.equal(f.calls(), 1);
    state = f.learning.read(await f.learning.location(profileId));
    const genuine = state.recentRuns[1];
    await assert.rejects(f.learning.refundInherited(profileId, { requestId: 'refund-invalid-01', day, runIds: [genuine.id], expectedRevision: state.revision }), /not proven/);
    assert.equal((await f.learning.snapshot(profileId)).health.today.runs, 1);
    await f.learning.register(fork); assert.equal(f.calls(), 1);
});
