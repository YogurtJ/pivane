'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileLearningService, correction, temporary, lastMemoryRead } = require('../server/profile-memory/learning-service');
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
    let revision = 'a'.repeat(64), calls = 0, mutations = [];
    const knowledge = {
        snapshot: async () => ({ status: 'ready', revision, items: [], capabilities: { memory: true } }),
        mutate: async (_id, value) => { mutations.push(value); revision = 'b'.repeat(64); return { receipt: { id: 'receipt-1', status: 'saved' } }; }
    };
    const runtime = { getModel: (provider, id) => provider === 'fixture' && id === 'cheap' ? model : null,
        getAvailable: async () => [model], completeSimple: async (_model, request, options) => {
            calls++; assert.equal(options.toolChoice, 'none'); assert.equal(options.maxRetries, 0);
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
        calls: () => calls, mutations, revision: value => { revision = value; } };
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
    f.append('以后默认使用合成环境的明确设置，保持这个稳定偏好。');
    await f.service.register(f.session);
    await waitFor(async () => (await f.service.snapshot(profileId)).jobs[0]?.status === 'waiting-config');
    assert.equal(f.calls(), 0);
    f.preferences.writeDocument({ memoryModels: { 'memory-review': { provider: 'fixture', modelId: 'cheap' } } });
    f.service.wake(profileId);
    await waitFor(async () => (await f.service.snapshot(profileId)).recentRuns.length === 1);
    f.append('下一次也保持稳定的合成环境设置。');
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
    f.knowledge.mutate = async () => { throw Object.assign(new Error('publication unknown'), { status: 503 }); };
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

test('classifier recognizes explicit corrections but rejects local-only instructions', () => {
    assert.equal(correction('不是旧记录，而是新记录，请更正。'), true);
    assert.equal(temporary('仅本次按这个步骤，不要记住'), true);
});
