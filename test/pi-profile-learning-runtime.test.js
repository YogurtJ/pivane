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
async function fixture(t, { delay } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-runtime-'));
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'workspace');
    fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_PROJECT_ROOTS = root;
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { PiSessionStore } = require('../server/pi-session-store');
    const store = new PiSessionStore();
    const profile = { id: profileId, enabled: true, memory: { enabled: true, autoLearn: true } };
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
    const knowledge = {
        snapshot: async () => ({ status: 'ready', revision, items: snapshotItems, hasMore: false, capabilities: { memory: true } }),
        mutateFromNative: async (_id, value, native) => { assert.equal(native.sessionId, session.id);
            assert.ok(native.entryId); mutations.push(value); revision = 'b'.repeat(64);
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
        calls: () => calls, mutations, revision: value => { revision = value; }, items: value => { snapshotItems = value; } };
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
    assert.ok((await f.service.snapshot(profileId)).jobs.length, 'verified native session should enqueue');
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

test('classifier recognizes explicit corrections and preferences but rejects local-only instructions and quoted questions', () => {
    assert.equal(correction('不是旧记录，而是新记录，请更正。'), true);
    assert.equal(preference('请记住，以后按新流程执行。'), true);
    assert.equal(preference('以后默认使用新流程。'), true);
    assert.equal(temporary('仅本次按这个步骤，不要记住'), true);
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
