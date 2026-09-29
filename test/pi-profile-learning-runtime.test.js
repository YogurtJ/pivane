'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileLearningService, correction, preference, temporary, lastMemoryRead } = require('../server/profile-memory/learning-service');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const model = { provider: 'fixture', id: 'cheap', input: ['text'], maxTokens: 1024 };
const answer = (content, usage = { input: 30, output: 15 }) => ({ stopReason: 'stop', usage, content: [{ type: 'text', text: JSON.stringify({ content }) }] });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (await check()) return; await pause(); }
    throw new Error('Learning job did not settle');
}
async function fixture(t, { delay, autoLearn = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-runtime-'));
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'workspace');
    fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_PROJECT_ROOTS = root;
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { PiSessionStore } = require('../server/pi-session-store');
    const store = new PiSessionStore();
    const profile = { id: profileId, enabled: true, memory: { enabled: true, autoLearn } };
    const profiles = {
        getProfile: async id => id === profileId ? profile : null,
        state: async () => ({ state: { profiles: [profile] } }),
        select: async () => profileId,
        describe: async () => ({ id: profileId }),
        context: async (manager, currentCwd) => ({ version: 1, profileId, sessionId: manager.getSessionId(), cwd: currentCwd,
            sessionPath: manager.getSessionFile(), profileRoot: path.join(agentDir, 'pivane-profiles', 'data', profileId),
            sessionsRoot: path.join(agentDir, 'sessions'), memory: { enabled: true, autoLearn: true,
                memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: false } })
    };
    store.profiles = profiles;
    const session = await store.createSession(cwd, 'synthetic', { agentProfileId: profileId });
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const append = (user, assistant = '我会按你刚才明确的说法处理。') => {
        const manager = SessionManager.open(session.path);
        manager.appendMessage({ role: 'user', content: [{ type: 'text', text: user }], timestamp: Date.now() });
        manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: assistant }], timestamp: Date.now(),
            api: 'openai-completions', provider: 'fixture', model: 'cheap', stopReason: 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    };
    const preferences = new WorkspacePreferencesService({ filePath: path.join(agentDir, 'pivane-workspace.json') });
    const models = Object.fromEntries(['memory-correction', 'memory-review', 'memory-extraction'].map(id => [id, { provider: 'fixture', modelId: 'cheap' }]));
    preferences.writeDocument({ memoryModels: models });
    let revision = 'a'.repeat(64), calls = 0, mutations = [], snapshotItems = [];
    const writeOptions = [];
    const knowledge = {
        snapshot: async () => ({ status: 'ready', revision, items: snapshotItems, hasMore: false, capabilities: { memory: true } }),
        mutateFromNative: async (_id, value, native, options) => { assert.equal(native.sessionId, session.id);
            assert.ok(native.entryId); mutations.push(value); writeOptions.push(options); revision = 'b'.repeat(64);
            return { receipt: { id: 'receipt-1', status: 'saved' } }; },
        mutate: async () => { throw new Error('Untrusted mutation path'); }
    };
    const runtime = { getModel: (provider, id) => provider === 'fixture' && id === 'cheap' ? model : null,
        getAvailable: async () => [model], completeSimple: async (_model, request, options) => {
            calls++; assert.equal(options.toolChoice, 'none'); assert.equal(options.maxRetries, 0);
            assert.equal(options.maxTokens, 320);
            assert.ok(request.messages[0].content.length <= 4000);
            if (delay) await delay(options);
            return answer('用户明确纠正：合成流程使用新版校验清单。');
        } };
    const service = new ProfileLearningService({ profiles, store, preferences, knowledge, getAgentDir: async () => agentDir,
        createModelRuntime: async () => runtime });
    t.after(async () => service.dispose());
    const enable = async changes => service.save(profileId, { expectedRevision: (await service.snapshot(profileId)).revision,
        changes: { enabled: true, ...changes } });
    return { service, profiles, store, session: { ...session, sessionId: session.id, sessionPath: session.path }, cwd, append, preferences, knowledge, runtime, enable,
        calls: () => calls, mutations, writeOptions, profile, revision: value => { revision = value; }, items: value => { snapshotItems = value; } };
}

test('Chinese corrections take priority, temporary instructions never persist, duplicate native events share a cursor', async t => {
    const f = await fixture(t); await f.enable({ reviewEnabled: true });
    f.append('仅本次纠正：不是旧清单而是新清单，下一轮不要记住。');
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 0);
    f.append('纠正一下：不是旧版校验清单，而是新版校验清单，以后都按新版。');
    const native = (await import('@earendil-works/pi-coding-agent')).SessionManager.open(f.session.path);
    const context = await f.profiles.context(native, f.cwd);
    const scope = require('../server/profile-memory/scope');
    assert.ok(scope.eligibleManager(native, context, f.cwd), 'native binding');
    assert.ok(scope.verifyNativeSession(context, native), 'native descriptor proof');
    await Promise.all([f.service.register(f.session), f.service.register(f.session)]);
    const enrolled = await f.service.snapshot(profileId);
    // The synthetic provider may finish between concurrent registration and this
    // snapshot; either queue presence or its completed receipt proves enrollment.
    assert.ok(enrolled.jobs.length || enrolled.recentRuns.length, 'verified native session should enqueue or already settle');
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.calls(), 1);
    assert.equal(f.mutations[0].category, 'correction');
    assert.equal(f.mutations[0].kind, 'memory');
    await f.service.register(f.session);
    assert.equal(f.calls(), 1);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[0].costStatus, 'unknown');
});

test('quoted examples and rhetorical questions do not create immediate preference work', async t => {
    const f = await fixture(t); await f.enable();
    f.append('引用：“请记住以后按旧流程执行。”');
    f.append('你之前说“不是旧规则而是新规则”吗？');
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 0);
    assert.equal(f.calls(), 0);
});

test('two service instances coordinate the same profile queue and budget through its journal lock', async t => {
    const f = await fixture(t); await f.enable({ reviewEnabled: true, maxRunsPerDay: 1, maxTokensPerDay: 6000 });
    const other = new ProfileLearningService({ profiles: f.profiles, store: f.store, preferences: f.preferences,
        knowledge: f.knowledge, getAgentDir: async () => process.env.PI_CODING_AGENT_DIR,
        createModelRuntime: async () => f.runtime });
    t.after(async () => other.dispose());
    f.append('下一轮稳定使用合成环境中的默认规则。');
    await Promise.all([f.service.register(f.session), other.register(f.session)]);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.calls(), 1);
    f.append('请继续稳定使用合成默认规则。');
    await other.register(f.session);
    assert.equal(f.calls(), 1);
    assert.equal((await f.service.snapshot(profileId)).jobs[0].status, 'queued');
});

test('missing dedicated model remains waiting, save alone does not execute, and hard run/token budgets cap reviews', async t => {
    const f = await fixture(t);
    f.preferences.writeDocument({ memoryModels: {} });
    await f.enable({ reviewEnabled: true, maxRunsPerDay: 1, maxTokensPerDay: 6000 });
    f.append('合成环境操作记录已更新。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).jobs[0]?.status === 'waiting-config');
    assert.equal(f.calls(), 0);
    f.preferences.writeDocument({ memoryModels: { 'memory-review': { provider: 'fixture', modelId: 'cheap' } } });
    f.service.wake(profileId);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    f.append('合成环境操作记录再次更新。');
    await f.service.register(f.session);
    assert.equal(f.calls(), 1);
    assert.equal((await f.service.snapshot(profileId)).jobs[0].status, 'queued');
});

test('late stale proposals and cancelled runs do not mutate knowledge; shutdown waits for provider settlement', async t => {
    let release;
    const f = await fixture(t, { delay: () => new Promise(resolve => { release = resolve; }) });
    await f.enable({ reviewEnabled: true });
    f.append('记住以后稳定采用合成流程。');
    await f.service.register(f.session);
    await waitFor(() => Boolean(release));
    f.revision('c'.repeat(64));
    release();
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.mutations.length, 0);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[0].error, 'knowledge-changed');
    f.append('纠正一下：不是旧流程而是新流程，以后保持。');
    await f.service.register(f.session);
    await waitFor(() => Boolean(release));
    const job = (await f.service.snapshot(profileId)).jobs[0];
    await f.service.action(profileId, { requestId: 'cancel-request-001', action: 'cancel', jobId: job.id });
    let finished = false;
    const closing = f.service.dispose().then(() => { finished = true; });
    await pause(); assert.equal(finished, false);
    release(); await closing;
    assert.equal(f.mutations.length, 0);
    assert.equal((await f.service.snapshot(profileId)).recentRuns.at(-1).status, 'cancelled');
});

test('an uncertain knowledge publication is never retried automatically', async t => {
    const f = await fixture(t); await f.enable({ reviewEnabled: true });
    f.knowledge.mutateFromNative = async () => { throw Object.assign(new Error('publication unknown'), { status: 503 }); };
    f.append('记住以后稳定采用合成流程。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[0].status, 'uncertain');
    await f.service.register(f.session);
    assert.equal(f.calls(), 1);
});

test('branch context edits suppress removed claims and manual actions are idempotent', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: true, reviewEnabled: false });
    f.append('纠正：不是旧记录而是新记录，今后保持。');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(f.session.path);
    const user = [...manager.getBranch()].reverse().find(entry => entry.type === 'message' && entry.message?.role === 'user');
    manager.appendContextEdit(user.id, null);
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 0);
    f.append('纠正：不是旧流程而是新流程，今后保持。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    const input = { requestId: 'manual-review-001', action: 'review-now' };
    const first = await f.service.action(profileId, input);
    const again = await f.service.action(profileId, input);
    assert.equal([...again.jobs, ...again.recentRuns].filter(job => job.reason === 'manual').length, 1);
    await assert.rejects(f.service.action(profileId, { ...input, action: 'cancel', jobId: 'f'.repeat(64) }),
        error => error.status === 409);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 2);
    assert.equal(f.calls(), 2);
});

test('recovered running work remains uncertain rather than replayed and compaction records a separate extraction', async t => {
    const f = await fixture(t); await f.enable({ extractionEnabled: true });
    f.append('以后请保持合成流程的明确步骤。');
    await f.service.register(f.session, 'compaction');
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    await f.service.change(profileId, state => { state.jobs.push({ id: 'f'.repeat(64), reason: 'extraction', status: 'running',
        createdAt: new Date().toISOString(), startedAt: new Date().toISOString() }); });
    await f.service.resume();
    assert.equal((await f.service.snapshot(profileId)).jobs.at(-1).status, 'uncertain');
    assert.equal(f.calls(), 1);
});

test('one native registration covers every completed pair and a restart does not repay the same range', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: false, reviewEnabled: true, maxRunsPerDay: 3, maxTokensPerDay: 18000 });
    for (let i = 0; i < 3; i++) f.append(`合成轮次 ${i} 的结果已确认。`);
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 3);
    assert.equal(f.calls(), 3);
    const other = new ProfileLearningService({ profiles: f.profiles, store: f.store, preferences: f.preferences,
        knowledge: f.knowledge, getAgentDir: async () => process.env.PI_CODING_AGENT_DIR,
        createModelRuntime: async () => f.runtime });
    t.after(async () => other.dispose());
    await other.resume();
    await other.register(f.session);
    assert.equal(f.calls(), 3);
});

test('legacy latest-pair cursor backfills earlier native turns without charging its old pair twice', async t => {
    const f = await fixture(t);
    await f.enable({ correctionEnabled: false, reviewEnabled: true });
    f.append('首轮合成记录。');
    f.append('次轮合成记录。');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(f.session.path);
    const branch = manager.getBranch();
    const user = branch.filter(entry => entry.message?.role === 'user').at(-1);
    const assistant = branch.filter(entry => entry.message?.role === 'assistant').at(-1);
    await f.service.change(profileId, state => {
        state.cursors[`${f.session.sessionId}:review`] = `${user.id}:${assistant.id}:${manager.getLeafId()}`;
    });
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.calls(), 1);
    await f.service.tick();
    assert.equal(f.calls(), 1);
});

test('sliding dedupe window does not stop ordinary append-only learning', async t => {
    const f = await fixture(t);
    f.preferences.writeDocument({ memoryModels: {} });
    await f.enable({ correctionEnabled: false, reviewEnabled: true });
    for (let i = 0; i < 12; i++) f.append(`合成记录 ${i} 已结束。`);
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 12);
    f.append('合成记录 12 已结束。');
    await f.service.register(f.session);
    const snap = await f.service.snapshot(profileId);
    assert.equal(snap.jobs.length, 13);
    assert.equal(snap.capabilities.capacity.blockedBranches, 0);
    assert.equal(f.calls(), 0);
});

test('full queue leaves the unreviewed cursor in place for a later scan', async t => {
    const f = await fixture(t);
    f.preferences.writeDocument({ memoryModels: {} });
    await f.enable({ correctionEnabled: false, reviewEnabled: true });
    f.append('合成容量检查已完成。');
    await f.service.change(profileId, state => {
        state.jobs = Array.from({ length: 64 }, (_, i) => ({ id: String(i).padStart(64, '0'),
            reason: 'review', status: 'waiting-config', createdAt: new Date().toISOString() }));
    });
    await f.service.register(f.session);
    const state = f.service.read(await f.service.location(profileId));
    assert.equal(Object.values(state.cursors)[0].index, 0);
    await f.service.change(profileId, current => { current.jobs = []; });
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 1);
    assert.equal(f.calls(), 0);
});

test('periodic scan recovers unregistered pairs without charging empty ticks', async t => {
    const f = await fixture(t);
    f.append('合成环境已完成首轮。');
    await f.service.register(f.session);
    await f.enable({ correctionEnabled: false, reviewEnabled: true, maxRunsPerDay: 2, maxTokensPerDay: 12000 });
    f.append('合成环境已完成次轮。');
    await f.service.tick();
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 2);
    await f.service.tick();
    assert.equal(f.calls(), 2);
});

test('explicit correction replaces a referenced old item through trusted native provenance', async t => {
    const f = await fixture(t); await f.enable();
    const row = { id: 'c'.repeat(64), revision: 'd'.repeat(64), kind: 'memory', scope: 'profile', target: 'memory',
        category: 'fact', state: 'active', content: '旧规则用于合成环境。' };
    f.items([row]);
    f.runtime.completeSimple = async (_model, request) => {
        assert.match(request.systemPrompt, /旧规则用于合成环境/);
        return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ content: '新规则用于合成环境。', replaceId: row.id }) }] };
    };
    f.append('纠正：不是旧规则，而是新规则，以后按新规则。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.mutations[0].operation, 'update');
    assert.equal(f.mutations[0].itemId, row.id);
    assert.equal(f.mutations[0].itemRevision, row.revision);
});

test('procedure proposal is stored as an inactive skill draft, never activated by the background model', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: false, reviewEnabled: true });
    const original = f.knowledge.snapshot;
    f.knowledge.snapshot = async (...args) => ({ ...await original(...args), capabilities: { memory: true, skill: true } });
    f.runtime.completeSimple = async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({
        skill: { name: 'synthetic-check', description: 'Synthetic verification', when_to_use: 'When checking a synthetic procedure',
            procedure_steps: ['Run isolated check'], verification_steps: ['Confirm result'] }
    }) }] });
    f.append('流程步骤：先运行隔离检查，再检查输出。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.mutations.length, 1);
    assert.deepEqual({ kind: f.mutations[0].kind, state: f.mutations[0].state, operation: f.mutations[0].operation },
        { kind: 'skill', state: 'draft', operation: 'create' });
    assert.equal((await f.service.snapshot(profileId)).capabilities.skillDrafts, true);
});

test('native edit or model routing change invalidates an in-flight proposal', async t => {
    let release;
    const f = await fixture(t, { delay: () => new Promise(resolve => { release = resolve; }) });
    await f.enable();
    f.append('请记住以后按合成流程执行。');
    await f.service.register(f.session);
    await waitFor(() => Boolean(release));
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(f.session.path);
    manager.appendContextEdit(manager.getBranch().find(entry => entry.message?.role === 'user').id, null);
    release();
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.mutations.length, 0);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[0].error, 'source-changed');
    release = undefined;
    f.append('请记住以后按另一合成流程执行。');
    await f.service.register(f.session);
    await waitFor(() => Boolean(release));
    f.preferences.writeDocument({ memoryModels: {} });
    release();
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 2);
    assert.equal(f.mutations.length, 0);
    assert.equal((await f.service.snapshot(profileId)).recentRuns.at(-1).error, 'configuration-changed');
});

test('real ModelRuntime calls only a local synthetic text provider with no tools', { timeout: 30000 }, async t => {
    const http = require('node:http');
    const { once } = require('node:events');
    const f = await fixture(t);
    const received = [];
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); received.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'cheap',
            choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ content: '合成偏好使用新清单。' }) },
                finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    const dir = process.env.PI_CODING_AGENT_DIR;
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture: {
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-local',
        models: [{ id: 'cheap', input: ['text'], contextWindow: 32000, maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }));
    const settings = new (require('../server/pi-settings-service').PiSettingsService)();
    f.service.createModelRuntime = () => settings.createModelRuntime();
    t.after(async () => settings.loginService.dispose());
    await f.enable();
    f.append('请记住以后使用新清单。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(received.length, 1);
    assert.ok(!received[0].tools?.length);
    assert.equal(f.mutations.length, 1);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[0].status, 'completed');
});

test('learning REST is authenticated, revisioned, bounded and does not start a worker on settings save', async t => {
    const express = require('express');
    const { once } = require('node:events');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-http-'));
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
    process.env.PI_PROJECT_ROOTS = root;
    process.env.PI_WEB_TOKEN = 'synthetic-learning-token';
    process.env.PI_OFFLINE = '1';
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway({ profileKnowledgeService: {
        snapshot: async () => ({ status: 'ready', revision: 'a'.repeat(64), items: [], capabilities: { memory: true } }),
        mutate: async () => { throw new Error('should not execute'); }
    } });
    gateway.learning.profiles.getProfile = async id => id === profileId ? { id, enabled: true, memory: { enabled: true } } : null;
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}/api/pi/profiles/${profileId}/learning`;
    const headers = { Authorization: 'Bearer synthetic-learning-token', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'http://untrusted.invalid' } })).status, 403);
    const initial = await (await fetch(url, { headers })).json();
    assert.equal(initial.settings.enabled, false);
    assert.equal(initial.capabilities.correction, false);
    assert.equal(initial.capabilities.settingsWrite, true);
    assert.ok(Array.isArray(initial.capabilities.actions));
    assert.equal(initial.capabilities.limits.maxRunsPerDay.max, 20);
    const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: initial.revision,
        changes: { enabled: true, correctionEnabled: true, maxRunsPerDay: 1 } }) });
    assert.equal(saved.status, 200);
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: initial.revision,
        changes: { enabled: true } }) })).status, 409);
    assert.equal(gateway.supervisor.workers.size, 0);
    assert.equal(initial.health.state, 'off');
    assert.equal(initial.legacy, null);
    const actions = `${url}/actions`;
    const enabled = await fetch(actions, { method: 'POST', headers, body: JSON.stringify({ requestId: 'http-enable-001', action: 'enable' }) });
    assert.equal(enabled.status, 200);
    assert.deepEqual((await enabled.json()).health.missingModels, ['memory-correction']);
    const adopt = await fetch(actions, { method: 'POST', headers, body: JSON.stringify({ requestId: 'http-adopt-001', action: 'adopt-legacy' }) });
    assert.equal(adopt.status, 409, 'a profile without legacy auto-learning has nothing to adopt');
    const activity = await (await fetch(url.replace(`/profiles/${profileId}/learning`, '/activity'), { headers })).json();
    assert.equal(typeof activity.learningBusy, 'boolean');
});

test('last provided memory generation is reported as historical metadata, not a compliance claim', async t => {
    const f = await fixture(t);
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(f.session.path);
    assert.equal((await lastMemoryRead(f.session, f.profiles)).status, 'not-recorded');
    const id = manager.appendCustomEntry('pivane-profile-memory-read', { version: 1, profileId,
        generation: 7, loadedAt: '2026-01-01T00:00:00.000Z', provided: true });
    const result = await lastMemoryRead(f.session, f.profiles);
    assert.deepEqual({ status: result.status, generation: result.adapterGeneration, entryId: result.entryId },
        { status: 'last-provided', generation: 7, entryId: id });
    assert.equal(result.provided, true);
});

test('learning service forwards custom phrases and exclusions to trigger classifiers', () => {
    // Phrase tables and language cases live in learning-safety; this only checks
    // the service wrapper forwards its configuration rather than using defaults.
    const phrases = { correction: ['fixture-correction'], preference: ['fixture-preference'],
        temporary: ['fixture-temporary'], ignore: ['fixture-ignore'] };
    for (const [classify, text] of [[correction, 'fixture-correction'], [preference, 'fixture-preference'],
        [temporary, 'fixture-temporary']]) {
        assert.equal(classify(text), false);
        assert.equal(classify(text, phrases), true);
        assert.equal(classify(`fixture-ignore ${text}`, phrases), classify === temporary,
            'temporary requests still suppress learning even when an ignore phrase is present');
    }
});

test('expired learning action request IDs refuse re-execution instead of filling the journal', async t => {
    const f = await fixture(t); await f.enable({ reviewEnabled: true });
    f.append('记住以后稳定采用合成流程。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    const input = { requestId: 'expiring-review-001', action: 'review-now' };
    const first = await f.service.action(profileId, input);
    assert.equal([...first.jobs, ...first.recentRuns].filter(job => job.reason === 'manual').length >= 1, true);
    await f.service.change(profileId, state => {
        state.actions[input.requestId].at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    });
    await assert.rejects(f.service.action(profileId, input), /expired/);
    // The expired ID is remembered, so a changed payload cannot re-execute either.
    await assert.rejects(f.service.action(profileId, { ...input, action: 'cancel', jobId: 'f'.repeat(64) }), /expired/);
    const after = await f.service.snapshot(profileId);
    assert.equal([...after.jobs, ...after.recentRuns].filter(job => job.reason === 'manual').length, 1);
    assert.equal(typeof after.capabilities.capacity.actionSlotsRemaining, 'number');
    const later = await f.service.action(profileId, { requestId: 'expiring-review-002', action: 'review-now' });
    assert.equal([...later.jobs, ...later.recentRuns].filter(job => job.reason === 'manual').length >= 2, true);
});

test('a deterministic source-proof rejection is recorded as skipped, not uncertain', async t => {
    const f = await fixture(t); await f.enable({ reviewEnabled: true });
    f.knowledge.mutateFromNative = async () => {
        throw Object.assign(new Error('session exceeds source proof limit'), { status: 413 });
    };
    f.append('记住以后稳定采用合成流程。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    const run = (await f.service.snapshot(profileId)).recentRuns[0];
    assert.equal(run.status, 'skipped');
    assert.equal(run.error, 'knowledge-rejected');
});

test('a correction registered while workers are still busy runs as soon as they become idle', async t => {
    const f = await fixture(t);
    let idle = false;
    f.service.idle = () => idle;
    await f.enable();
    f.append('纠正一下：不是旧版校验清单，而是新版校验清单，以后都按新版。');
    await f.service.register(f.session);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(f.calls(), 0, 'no model call while the supervisor is busy');
    assert.equal((await f.service.snapshot(profileId)).jobs[0]?.status, 'queued');
    idle = true;
    // Well inside the 60 s periodic tick: the busy retry picks the job up.
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1, 5000);
    assert.equal(f.calls(), 1);
});

// Mirrors the route wiring: idle(job) checks the source session and maintenance lock.
function sessionIdle(f, t) {
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const supervisor = new PiAgentSupervisor();
    t.after(() => supervisor.dispose());
    const maintenance = { locked: false };
    const busy = new Set();
    const worker = file => ({ isIdle: () => !busy.has(file), retainsBackgroundWork: () => false, dispose() {} });
    const other = path.join(path.dirname(f.session.sessionPath), 'other-session.jsonl');
    fs.writeFileSync(other, '');
    for (const file of [f.session.sessionPath, other]) supervisor.workers.set(fs.realpathSync.native(file), worker(file));
    f.service.idle = job => !maintenance.locked && (job ? supervisor.isSessionIdle(job.sessionPath) : supervisor.isIdle());
    return { maintenance, busy, other };
}

test('another busy session does not hold back this session correction', async t => {
    const f = await fixture(t); const idle = sessionIdle(f, t);
    idle.busy.add(idle.other);
    await f.enable();
    f.append('纠正一下：不是旧版校验清单，而是新版校验清单，以后都按新版。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.writeOptions[0], { origin: 'learning', reason: 'correction' });
});

test('a busy source session waits, then its correction runs about one second after it becomes idle', async t => {
    const f = await fixture(t); const idle = sessionIdle(f, t);
    idle.busy.add(f.session.sessionPath);
    await f.enable();
    f.append('纠正一下：不是旧版校验清单，而是新版校验清单，以后都按新版。');
    await f.service.register(f.session);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(f.calls(), 0, 'no model call while the source session is busy');
    assert.equal((await f.service.snapshot(profileId)).jobs[0]?.status, 'queued');
    const freed = Date.now();
    idle.busy.delete(f.session.sessionPath);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.ok(Date.now() - freed < 1800, 'the busy retry picks the job up well before the periodic tick');
    assert.equal(f.calls(), 1);
});

test('the maintenance lock blocks every learning job even when its session is idle', async t => {
    const f = await fixture(t); const idle = sessionIdle(f, t);
    idle.maintenance.locked = true;
    await f.enable();
    f.append('纠正一下：不是旧版校验清单，而是新版校验清单，以后都按新版。');
    await f.service.register(f.session);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(f.calls(), 0);
    assert.equal((await f.service.snapshot(profileId)).jobs[0]?.status, 'queued');
    idle.maintenance.locked = false;
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.calls(), 1);
});

test('a memory-full refusal is recorded as skipped memory-full, not a conflict', async t => {
    const f = await fixture(t); await f.enable({ reviewEnabled: true });
    const options = [];
    f.knowledge.mutateFromNative = async (_id, _value, _native, value) => {
        options.push(value);
        throw Object.assign(new Error('Memory limit reached'), { status: 409, code: 'memory-full',
            details: { target: 'memory', chars: 15990, limit: 16000, needed: 16030 } });
    };
    f.append('记住以后稳定采用合成流程。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    const snap = await f.service.snapshot(profileId);
    assert.deepEqual({ status: snap.recentRuns[0].status, error: snap.recentRuns[0].error }, { status: 'skipped', error: 'memory-full' });
    assert.deepEqual(options[0], { origin: 'learning', reason: 'correction' });
    assert.equal(snap.health.lastFailure, null, 'a skipped run is not a failure');
    f.knowledge.mutateFromNative = async () => { throw Object.assign(new Error('changed'), { status: 409 }); };
    f.append('记住以后稳定采用另一合成流程。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 2);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[1].status, 'conflict');
});

test('health reports off, unavailable, needs-model, quota, failing and ok in precedence order', async t => {
    const f = await fixture(t);
    let snap = await f.service.snapshot(profileId);
    assert.equal(snap.health.state, 'off');
    assert.deepEqual(snap.health.today, { runs: 0, maxRuns: 20, reservedTokens: 0, maxTokens: 200000 });
    await f.enable({ reviewEnabled: true, maxRunsPerDay: 4, maxTokensPerDay: 24000 });
    assert.equal((await f.service.snapshot(profileId)).health.state, 'ok');
    f.preferences.writeDocument({ memoryModels: { 'memory-correction': { provider: 'fixture', modelId: 'cheap' } } });
    snap = await f.service.snapshot(profileId);
    assert.deepEqual({ state: snap.health.state, missing: snap.health.missingModels }, { state: 'needs-model', missing: ['memory-review'] });
    const original = f.knowledge.snapshot;
    f.knowledge.snapshot = async () => ({ status: 'error' });
    assert.equal((await f.service.snapshot(profileId)).health.state, 'unavailable');
    f.knowledge.snapshot = original;
    f.preferences.writeDocument({ memoryModels: Object.fromEntries(['memory-correction', 'memory-review', 'memory-extraction']
        .map(id => [id, { provider: 'fixture', modelId: 'cheap' }])) });
    const now = new Date().toISOString();
    await f.service.change(profileId, state => {
        state.recentRuns = ['completed', 'failed', 'uncertain', 'conflict'].map((status, i) => ({ id: String(i).repeat(64),
            reason: 'review', status, error: status === 'completed' ? undefined : `${status}-error`,
            createdAt: now, startedAt: '2000-01-01T00:00:00.000Z', endedAt: `2000-01-01T00:00:0${i}.000Z` }));
    });
    snap = await f.service.snapshot(profileId);
    assert.equal(snap.health.state, 'failing');
    assert.deepEqual(snap.health.lastFailure, { at: '2000-01-01T00:00:03.000Z', reason: 'review', error: 'conflict-error' });
    await f.service.change(profileId, state => {
        state.recentRuns.push(...[0, 1, 2, 3].map(i => ({ id: String(i + 4).repeat(64), reason: 'review', status: 'completed',
            createdAt: now, startedAt: now, endedAt: now, reservedTokens: 6000 })));
    });
    snap = await f.service.snapshot(profileId);
    assert.equal(snap.health.state, 'quota-exhausted');
    assert.deepEqual(snap.health.today, { runs: 4, maxRuns: 4, reservedTokens: 24000, maxTokens: 24000 });
    assert.equal(snap.health.lastFailure.error, 'conflict-error');
});

test('enable action switches learning on atomically, keeps model routing and is idempotent', async t => {
    const f = await fixture(t);
    f.preferences.writeDocument({ memoryModels: {} });
    const before = f.preferences.readDocument();
    const input = { requestId: 'enable-request-001', action: 'enable', review: true };
    const snap = await f.service.action(profileId, input);
    assert.deepEqual([snap.settings.enabled, snap.settings.correctionEnabled, snap.settings.reviewEnabled, snap.settings.extractionEnabled],
        [true, true, true, false]);
    assert.equal(snap.health.state, 'needs-model');
    assert.deepEqual(snap.health.missingModels, ['memory-correction', 'memory-review']);
    assert.deepEqual(f.preferences.readDocument(), before, 'enable does not modify model settings');
    const again = await f.service.action(profileId, input);
    assert.equal(again.revision, snap.revision);
    await assert.rejects(f.service.action(profileId, { ...input, extraction: true }), error => error.status === 409);
    await assert.rejects(f.service.action(profileId, { requestId: 'enable-request-002', action: 'enable', review: 'yes' }),
        /Invalid learning action/);
    await assert.rejects(f.service.action(profileId, { requestId: 'enable-request-003', action: 'enable', jobId: 'f'.repeat(64) }),
        /Invalid learning action/);
    const extra = await f.service.action(profileId, { requestId: 'enable-request-004', action: 'enable', review: false, extraction: true });
    assert.deepEqual([extra.settings.reviewEnabled, extra.settings.extractionEnabled], [true, true], 'false leaves a switch unchanged');
});

function legacyFixture(f, reviewModel) {
    const { PiAuxiliaryModelsService } = require('../server/pi-auxiliary-models-service');
    f.service.auxiliaryModels = new PiAuxiliaryModelsService({ preferences: f.preferences, titles: { settingsChanged() {} },
        createModelRuntime: async () => f.runtime });
    f.service.legacyReviewModel = async () => reviewModel;
}

test('legacy auto-learning is adopted with its available old model, filling only unconfigured purposes', async t => {
    const f = await fixture(t);
    f.preferences.writeDocument({ memoryModels: { 'memory-correction': { provider: 'fixture', modelId: 'kept' } } });
    legacyFixture(f, { provider: 'fixture', modelId: 'cheap' });
    let snap = await f.service.snapshot(profileId);
    assert.deepEqual(snap.legacy, { autoLearn: true, reviewModel: { provider: 'fixture', modelId: 'cheap' },
        reviewModelAvailable: true, purposes: ['memory-review', 'memory-extraction'] });
    assert.ok(snap.capabilities.actions.includes('adopt-legacy'));
    assert.equal(snap.settings.enabled, false, 'nothing is enabled until the user adopts');
    const input = { requestId: 'adopt-legacy-0001', action: 'adopt-legacy' };
    snap = await f.service.action(profileId, input);
    assert.equal(snap.legacy, null);
    assert.deepEqual([snap.settings.enabled, snap.settings.correctionEnabled, snap.settings.reviewEnabled, snap.settings.extractionEnabled],
        [true, true, true, false]);
    assert.deepEqual(f.preferences.getMemoryModels(), { 'memory-correction': { provider: 'fixture', modelId: 'kept' },
        'memory-review': { provider: 'fixture', modelId: 'cheap' }, 'memory-extraction': { provider: 'fixture', modelId: 'cheap' } });
    assert.equal(f.profile.memory.autoLearn, true, 'the profile autoLearn field is not rewritten');
    const replay = await f.service.action(profileId, input);
    assert.equal(replay.revision, snap.revision, 'the same request ID replays without a second write');
    await assert.rejects(f.service.action(profileId, { requestId: 'adopt-legacy-0002', action: 'adopt-legacy' }),
        error => error.status === 409);
    assert.equal(f.calls(), 0, 'adoption never calls a model');
});

test('an unavailable legacy model is refused with 409 until a registry-verified model is supplied', async t => {
    const f = await fixture(t);
    f.preferences.writeDocument({ memoryModels: {} });
    legacyFixture(f, { provider: 'fixture', modelId: 'retired' });
    assert.equal((await f.service.snapshot(profileId)).legacy.reviewModelAvailable, false);
    await assert.rejects(f.service.action(profileId, { requestId: 'adopt-legacy-0003', action: 'adopt-legacy' }),
        error => error.status === 409 && error.code === 'legacy-model-unavailable');
    await assert.rejects(f.service.action(profileId, { requestId: 'adopt-legacy-0004', action: 'adopt-legacy',
        model: { provider: 'fixture', modelId: 'missing' } }), error => error.code === 'legacy-model-unavailable');
    let snap = await f.service.snapshot(profileId);
    assert.equal(snap.settings.enabled, false);
    assert.deepEqual(snap.legacy.purposes, ['memory-correction', 'memory-review', 'memory-extraction']);
    await assert.rejects(f.service.action(profileId, { requestId: 'adopt-legacy-0005', action: 'adopt-legacy',
        model: { provider: 'fixture', modelId: 'cheap', extra: true } }), /Invalid learning action/);
    snap = await f.service.action(profileId, { requestId: 'adopt-legacy-0006', action: 'adopt-legacy',
        model: { provider: 'fixture', modelId: 'cheap' } });
    assert.equal(snap.legacy, null);
    assert.equal(snap.settings.reviewEnabled, true);
    assert.deepEqual(Object.values(f.preferences.getMemoryModels()), Array(3).fill({ provider: 'fixture', modelId: 'cheap' }));
});

test('dismissed legacy auto-learning is not offered again and profiles without it show no banner', async t => {
    const f = await fixture(t);
    legacyFixture(f, { provider: 'fixture', modelId: 'cheap' });
    const before = f.preferences.readDocument();
    assert.ok((await f.service.snapshot(profileId)).legacy);
    const input = { requestId: 'dismiss-legacy-01', action: 'dismiss-legacy' };
    const snap = await f.service.action(profileId, input);
    assert.equal(snap.legacy, null);
    assert.equal(snap.settings.enabled, false);
    assert.ok(!snap.capabilities.actions.includes('adopt-legacy'));
    assert.deepEqual(f.preferences.readDocument(), before);
    assert.equal((await f.service.action(profileId, input)).revision, snap.revision);
    await assert.rejects(f.service.action(profileId, { requestId: 'adopt-legacy-0007', action: 'adopt-legacy' }),
        error => error.status === 409);
    const plain = await fixture(t, { autoLearn: false });
    legacyFixture(plain, { provider: 'fixture', modelId: 'cheap' });
    assert.equal((await plain.service.snapshot(profileId)).legacy, null);
});

const memoryRow = (n, content, extra = {}) => ({ id: String(n).padStart(64, 'e'), revision: String(n).padStart(64, 'd'),
    kind: 'memory', scope: 'profile', target: 'memory', category: 'fact', state: 'active', content, ...extra });
const consolidationReply = groups => ({ stopReason: 'stop', usage: { input: 400, output: 60 },
    content: [{ type: 'text', text: JSON.stringify({ groups }) }] });
async function consolidationFixture(t, options) {
    const f = await fixture(t, options);
    const rows = [memoryRow(1, '合成环境使用新版校验清单。'), memoryRow(2, '合成环境的校验清单是新版。'),
        memoryRow(3, '合成部署前先运行隔离检查。'), memoryRow(4, '部署合成环境之前运行隔离检查。'),
        memoryRow(5, '用户偏好中文回答。', { target: 'user', category: 'preference' }),
        memoryRow(6, '旧失败记录。', { target: 'failure', readOnly: true })];
    f.items(rows);
    const requests = [];
    let reply = () => consolidationReply([{ itemIds: ['m1', 'm2'], content: '合成环境使用新版校验清单。', category: 'fact' }]);
    f.runtime.completeSimple = async (_model, request, options) => {
        requests.push({ request, options });
        if (options.delay) await options.delay;
        return reply(request, options);
    };
    // Every knowledge write path fails the test: proposals must never write.
    f.knowledge.mutateFromNative = async () => { throw new Error('consolidation proposals must not write knowledge'); };
    f.knowledge.mutate = async () => { throw new Error('consolidation proposals must not write knowledge'); };
    await f.enable({ maxRunsPerDay: 20, maxTokensPerDay: 200000 });
    return { ...f, rows, requests, reply: value => { reply = value; } };
}
const settled = (f, count) => waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === count);

test('propose-consolidation stores a plan from the review model without writing knowledge', async t => {
    const f = await consolidationFixture(t);
    f.reply(() => consolidationReply([
        { itemIds: ['m1', 'm2'], content: '合成环境使用新版校验清单。', category: 'fact' },
        { itemIds: ['m3', 'm4'], content: '合成部署前运行隔离检查。', category: 'procedure' }]));
    const input = { requestId: 'consolidate-memory-01', action: 'propose-consolidation', target: 'memory' };
    const queued = await f.service.action(profileId, input);
    assert.ok(queued.capabilities.actions.includes('propose-consolidation'));
    assert.equal(queued.capabilities.consolidation.writesKnowledge, false);
    await settled(f, 1);
    let snap = await f.service.snapshot(profileId);
    const run = snap.recentRuns[0];
    assert.deepEqual({ reason: run.reason, target: run.target, status: run.status, model: run.model },
        { reason: 'consolidate', target: 'memory', status: 'completed', model: { provider: 'fixture', modelId: 'cheap' } });
    assert.equal(snap.health.today.reservedTokens, 18000);
    assert.equal(f.requests.length, 1);
    const { request, options } = f.requests[0];
    assert.deepEqual([options.toolChoice, options.maxRetries, options.maxTokens], ['none', 0, 4000]);
    const offered = JSON.parse(request.messages[0].content);
    assert.deepEqual(offered.map(entry => entry.id), ['m1', 'm2', 'm3', 'm4'], 'only writable profile entries of the target');
    assert.ok(!request.messages[0].content.includes(f.rows[0].id), 'model sees short references, not item IDs');
    assert.equal(snap.proposals.length, 1);
    const proposal = snap.proposals[0];
    assert.deepEqual({ id: proposal.id, target: proposal.target, model: proposal.model }, { id: run.id, target: 'memory',
        model: { provider: 'fixture', modelId: 'cheap' } });
    assert.equal(proposal.groups.length, 2);
    assert.deepEqual(proposal.groups[1], { content: '合成部署前运行隔离检查。', category: 'procedure', items: [
        { itemId: f.rows[2].id, itemRevision: f.rows[2].revision, preview: f.rows[2].content, category: 'fact' },
        { itemId: f.rows[3].id, itemRevision: f.rows[3].revision, preview: f.rows[3].content, category: 'fact' }] });
    assert.equal(f.mutations.length, 0);
    assert.equal((await f.service.action(profileId, input)).proposals.length, 1, 'replayed request ID queues nothing new');
    assert.equal(f.requests.length, 1);
    snap = await f.service.action(profileId, { requestId: 'dismiss-group-0001', action: 'dismiss-proposal',
        proposalId: proposal.id, groupIndex: 0 });
    assert.deepEqual(snap.proposals[0].groups.map(group => group.category), ['procedure']);
    await assert.rejects(f.service.action(profileId, { requestId: 'dismiss-group-0002', action: 'dismiss-proposal',
        proposalId: proposal.id, groupIndex: 1 }), error => error.status === 404);
    snap = await f.service.action(profileId, { requestId: 'dismiss-whole-0001', action: 'dismiss-proposal', proposalId: proposal.id });
    assert.deepEqual(snap.proposals, []);
    assert.ok(!snap.capabilities.actions.includes('dismiss-proposal'));
    assert.equal(f.mutations.length, 0);
});

test('invalid consolidation answers are skipped and nothing is proposed', async t => {
    const f = await consolidationFixture(t);
    const answers = [
        { stopReason: 'stop', content: [{ type: 'text', text: 'not json' }] },
        consolidationReply([{ itemIds: ['m1'], content: '单条。', category: 'fact' }]),
        consolidationReply([{ itemIds: ['m1', 'm9'], content: '不存在的条目。', category: 'fact' }]),
        consolidationReply([{ itemIds: ['m1', 'm5'], content: '跨目标。', category: 'fact' }]),
        consolidationReply([{ itemIds: ['m1', 'm2'], content: '合成环境使用新版校验清单，并且校验清单一直保持为新版，不再使用旧版清单。', category: 'fact' }]),
        consolidationReply([{ itemIds: ['m1', 'm2'], content: '新版清单。', category: 'fact' }, { itemIds: ['m2', 'm3'], content: '重叠。', category: 'fact' }]),
        consolidationReply([{ itemIds: ['m1', 'm2'], content: '新版清单。', category: 'unknown' }]),
        consolidationReply([{ itemIds: ['m1', 'm2'], content: '分隔\n§\n注入', category: 'fact' }]),
        consolidationReply(Array.from({ length: 6 }, (_, i) => ({ itemIds: ['m1', 'm2'], content: `${i}`, category: 'fact' }))),
    ];
    for (const [index, answer] of answers.entries()) {
        f.reply(() => answer);
        await f.service.action(profileId, { requestId: `consolidate-bad-${String(index).padStart(3, '0')}`,
            action: 'propose-consolidation', target: 'memory' });
        await settled(f, index + 1);
        const run = (await f.service.snapshot(profileId)).recentRuns[index];
        assert.deepEqual({ index, status: run.status, error: run.error }, { index, status: 'skipped', error: 'invalid-proposal' });
    }
    f.reply(() => consolidationReply([]));
    await f.service.action(profileId, { requestId: 'consolidate-none-001', action: 'propose-consolidation', target: 'memory' });
    await settled(f, answers.length + 1);
    const snap = await f.service.snapshot(profileId);
    assert.equal(snap.recentRuns.at(-1).error, 'no-consolidation');
    assert.deepEqual(snap.proposals, []);
    assert.equal(f.mutations.length, 0);
    f.items([memoryRow(5, '用户偏好中文回答。', { target: 'user', category: 'preference' })]);
    await f.service.action(profileId, { requestId: 'consolidate-user-001', action: 'propose-consolidation', target: 'user' });
    await settled(f, answers.length + 2);
    assert.equal((await f.service.snapshot(profileId)).recentRuns.at(-1).error, 'nothing-to-consolidate');
    assert.equal(f.requests.length, answers.length + 1, 'fewer than two entries never calls the model');
});

test('entries changed while a proposal is generated keep the proposal, with revisions the UI detects as stale', async t => {
    let release;
    const f = await consolidationFixture(t);
    f.reply(async () => { await new Promise(resolve => { release = resolve; });
        return consolidationReply([{ itemIds: ['m1', 'm2'], content: '合成环境使用新版校验清单。', category: 'fact' }]); });
    await f.service.action(profileId, { requestId: 'consolidate-stale-01', action: 'propose-consolidation', target: 'memory' });
    await waitFor(() => Boolean(release));
    const edited = { ...f.rows[0], content: '合成环境使用新版校验清单（已编辑）。', revision: 'f'.repeat(64) };
    f.items([edited, ...f.rows.slice(1)]);
    f.revision('c'.repeat(64));
    release();
    await settled(f, 1);
    const snap = await f.service.snapshot(profileId);
    assert.equal(snap.recentRuns[0].status, 'completed');
    const item = snap.proposals[0].groups[0].items[0];
    assert.equal(item.itemRevision, f.rows[0].revision);
    const current = (await f.knowledge.snapshot(profileId)).items.find(row => row.id === item.itemId);
    assert.notEqual(current.revision, item.itemRevision, 'the stored revision no longer matches the current entry');
    assert.equal(f.mutations.length, 0);
});

test('consolidation respects the daily token budget, per-profile concurrency and the maintenance lock', async t => {
    let release;
    const f = await consolidationFixture(t);
    await assert.rejects(f.service.action(profileId, { requestId: 'consolidate-bad-target', action: 'propose-consolidation',
        target: 'project' }), /Invalid learning action/);
    await assert.rejects(f.service.action(profileId, { requestId: 'dismiss-bad-proposal', action: 'dismiss-proposal',
        proposalId: 'not-a-proposal' }), /Invalid learning action/);
    let locked = true;
    f.service.idle = () => !locked;
    await f.service.action(profileId, { requestId: 'consolidate-lock-001', action: 'propose-consolidation', target: 'memory' });
    await assert.rejects(f.service.action(profileId, { requestId: 'consolidate-lock-002', action: 'propose-consolidation',
        target: 'memory' }), /already queued/);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(f.requests.length, 0, 'the maintenance lock holds consolidation back');
    f.reply(async () => { await new Promise(resolve => { release = resolve; });
        return consolidationReply([{ itemIds: ['m1', 'm2'], content: '合成环境使用新版校验清单。', category: 'fact' }]); });
    locked = false;
    await waitFor(() => Boolean(release));
    await f.service.action(profileId, { requestId: 'consolidate-user-002', action: 'propose-consolidation', target: 'user' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.requests.length, 1, 'one running job per profile');
    assert.equal((await f.service.snapshot(profileId)).jobs.find(job => job.target === 'user').status, 'queued');
    release();
    await settled(f, 2);
    assert.equal((await f.service.snapshot(profileId)).recentRuns[1].error, 'nothing-to-consolidate');

    const budgeted = await consolidationFixture(t);
    await budgeted.enable({ maxTokensPerDay: 12000 });
    await assert.rejects(budgeted.service.action(profileId, { requestId: 'consolidate-budget-01', action: 'propose-consolidation',
        target: 'memory' }), error => error.status === 409 && /too low/.test(error.message));
    await budgeted.enable({ maxTokensPerDay: 24000 });
    const today = new Date().toISOString();
    await budgeted.service.change(profileId, state => {
        state.recentRuns = [0, 1].map(i => ({ id: String(i).repeat(64), reason: 'correction', status: 'completed',
            createdAt: today, startedAt: today, endedAt: today, reservedTokens: 6000 }));
    });
    await budgeted.service.action(profileId, { requestId: 'consolidate-budget-02', action: 'propose-consolidation', target: 'memory' });
    await new Promise(resolve => setTimeout(resolve, 200));
    const snap = await budgeted.service.snapshot(profileId);
    assert.equal(budgeted.requests.length, 0, '12000 reserved + 18000 exceeds the 24000 daily budget');
    assert.equal(snap.jobs[0].status, 'queued');
    assert.equal(snap.health.state, 'ok', 'a turn job still fits, so the quota is not exhausted');
});

test('drafts count pending skill drafts across pages and cap at 200', async t => {
    const f = await fixture(t); await f.enable();
    let skills = [];
    const skill = (n, state) => ({ id: String(n).padStart(64, 'a'), kind: 'skill', name: `draft-${n}`, state, revision: 'r' });
    f.knowledge.snapshot = async (_id, options = {}) => {
        const offset = options.offset || 0;
        const rows = options.kind === 'skill' ? skills : [];
        return { status: 'ready', revision: 'a'.repeat(64), items: rows.slice(offset, offset + 50), hasMore: rows.length > offset + 50,
            capabilities: { memory: true, skill: true } };
    };
    assert.deepEqual((await f.service.snapshot(profileId)).drafts, { pending: 0 });
    skills = [...Array.from({ length: 60 }, (_, i) => skill(i, 'active')), ...Array.from({ length: 7 }, (_, i) => skill(100 + i, 'draft'))];
    assert.deepEqual((await f.service.snapshot(profileId)).drafts, { pending: 7 });
    skills = Array.from({ length: 230 }, (_, i) => skill(i, 'draft'));
    assert.deepEqual((await f.service.snapshot(profileId)).drafts, { pending: 200, capped: true });
    const original = f.knowledge.snapshot;
    f.knowledge.snapshot = async (id, options) => ({ ...await original(id, options), capabilities: { memory: true, skill: false } });
    assert.deepEqual((await f.service.snapshot(profileId)).drafts, { pending: 0 }, 'no learned skills, no drafts');
});

test('health reports memory-full after needs-model and before quota-exhausted', async t => {
    const f = await fixture(t); await f.enable({ maxRunsPerDay: 4, maxTokensPerDay: 24000 });
    let usage = { memory: { chars: 100, limit: 16000 }, user: { chars: 10, limit: 8000 } };
    const original = f.knowledge.snapshot;
    f.knowledge.snapshot = async (...args) => ({ ...await original(...args), usage });
    assert.equal((await f.service.snapshot(profileId)).health.state, 'ok');
    usage = { memory: { chars: 100, limit: 16000 }, user: { chars: 8000, limit: 8000 } };
    assert.equal((await f.service.snapshot(profileId)).health.state, 'memory-full');
    const today = new Date().toISOString();
    await f.service.change(profileId, state => {
        state.recentRuns = [0, 1, 2, 3].map(i => ({ id: String(i).repeat(64), reason: 'correction', status: 'completed',
            createdAt: today, startedAt: today, endedAt: today, reservedTokens: 6000 }));
    });
    assert.equal((await f.service.snapshot(profileId)).health.state, 'memory-full', 'memory-full precedes quota-exhausted');
    usage = { memory: { chars: 15000, limit: 16000 }, user: { chars: 10, limit: 8000 } };
    assert.equal((await f.service.snapshot(profileId)).health.state, 'quota-exhausted');
    usage = { memory: { chars: 16001, limit: 16000 }, user: { chars: 10, limit: 8000 } };
    f.preferences.writeDocument({ memoryModels: {} });
    assert.equal((await f.service.snapshot(profileId)).health.state, 'needs-model', 'needs-model precedes memory-full');
});

test('a cancelled consolidation keeps no proposal', async t => {
    let release;
    const f = await consolidationFixture(t);
    f.reply(async () => { await new Promise(resolve => { release = resolve; });
        return consolidationReply([{ itemIds: ['m1', 'm2'], content: '合成环境使用新版校验清单。', category: 'fact' }]); });
    await f.service.action(profileId, { requestId: 'consolidate-cancel-1', action: 'propose-consolidation', target: 'memory' });
    await waitFor(() => Boolean(release));
    const job = (await f.service.snapshot(profileId)).jobs[0];
    await f.service.action(profileId, { requestId: 'cancel-consolidate-1', action: 'cancel', jobId: job.id });
    release();
    await settled(f, 1);
    const snap = await f.service.snapshot(profileId);
    assert.equal(snap.recentRuns[0].status, 'cancelled');
    assert.deepEqual(snap.proposals, []);
    assert.equal(f.mutations.length, 0);
});

test('consolidation input size is a setting and sizes the reservation', async t => {
    const f = await fixture(t);
    assert.equal((await f.service.snapshot(profileId)).settings.consolidationInputChars, 12000);
    await assert.rejects(f.enable({ consolidationInputChars: 3999 }), /Invalid learning setting/);
    await assert.rejects(f.enable({ consolidationInputChars: 40001 }), /Invalid learning setting/);
    await f.enable({ consolidationInputChars: 30000 });
    const snap = await f.service.snapshot(profileId);
    assert.equal(snap.capabilities.consolidation.maxInputChars, 30000);
    assert.equal(snap.capabilities.consolidation.reservedTokens, 36000);
    assert.deepEqual(snap.capabilities.limits.consolidationInputChars, { min: 4000, max: 40000 });
});

test('English corrections and custom trigger phrases queue immediate learning; settings validate phrases', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: true, reviewEnabled: false });
    f.append('No, use the new checklist instead of the old one.');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    assert.equal(f.calls(), 1);
    assert.equal(f.mutations[0].category, 'correction');
    f.append('Nein, benutze die neue Liste.');
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 0, 'no built-in German rule');
    await assert.rejects(f.enable({ triggerPhrases: { correction: ['x'.repeat(81)] } }), /Invalid learning setting/);
    await assert.rejects(f.enable({ triggerPhrases: { unknown: [] } }), /Invalid learning setting/);
    await f.enable({ triggerPhrases: { correction: [' Nein ', 'Nein'], preference: [], temporary: ['nur heute'] } });
    const saved = (await f.service.snapshot(profileId)).settings.triggerPhrases;
    assert.deepEqual(saved, { correction: ['Nein'], preference: [], temporary: ['nur heute'], ignore: [] });
    f.append('Nur heute: nein, benutze die alte Liste.');
    await f.service.register(f.session);
    assert.equal((await f.service.snapshot(profileId)).jobs.length, 0, 'custom temporary phrase wins');
    f.append('Nein, benutze ab sofort die neue Liste.');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 2);
    assert.equal(f.calls(), 2);
});

test('a learned entry refused by the content scan is recorded as skipped, not uncertain', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: true, reviewEnabled: false });
    f.knowledge.mutateFromNative = async () => { throw Object.assign(new Error('Content looks like a credential'), { status: 400,
        code: 'content-blocked', details: { rule: 'openai_api_key', kind: 'secret' } }); };
    f.append('纠正：不是旧清单而是新清单，以后都按新版。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    const run = (await f.service.snapshot(profileId)).recentRuns[0];
    assert.deepEqual({ status: run.status, error: run.error }, { status: 'skipped', error: 'content-blocked' });
});

test('imported history before a learning baseline is never queued; turns after it are learned', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: true, reviewEnabled: true, extractionEnabled: true });
    f.append('不对，应该用旧版校验清单。');
    f.append('以后都用旧版流程。');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    SessionManager.open(f.session.sessionPath).appendCustomEntry('pivane-learning-baseline', { version: 1, source: 'import' });
    await f.service.register(f.session, 'compaction');
    await f.service.register(f.session);
    await pause(); await pause();
    let snap = await f.service.snapshot(profileId);
    assert.equal(snap.jobs.length + snap.recentRuns.length, 0, 'nothing before the baseline is learned, even at a boundary');
    f.append('不对，应该用新版校验清单。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    snap = await f.service.snapshot(profileId);
    assert.equal(snap.recentRuns[0].reason, 'correction');
    assert.equal(f.calls(), 1);
});

test('a long-running thread above the 8 MiB index bound is still learned, up to the source-proof bound', async t => {
    const f = await fixture(t); await f.enable({ correctionEnabled: true });
    f.append('这是合成的长线程背景。', 'x'.repeat(9 * 1024 * 1024));
    assert.ok(fs.statSync(f.session.sessionPath).size > 8 * 1024 * 1024);
    f.append('不对，应该用新版校验清单。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    const snap = await f.service.snapshot(profileId);
    assert.equal(snap.recentRuns[0].reason, 'correction');
    assert.equal(snap.recentRuns[0].status, 'completed');
    assert.match(JSON.stringify(snap.capabilities), new RegExp(`"maxSourceBytes":${64 * 1024 * 1024}\\b`));
});
