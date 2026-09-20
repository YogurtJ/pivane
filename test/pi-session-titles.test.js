const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const express = require('express');
const { WebSocket } = require('ws');
const { titleSnapshot, handleTitleRequest, TITLE_STATE } = require('../server/pi-session-title-state');
const { PiSessionTitleService, reportedUsage } = require('../server/pi-session-title-service');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-titles-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_TOKEN = 'title-test-token';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_WEB_APPROVE_PROJECTS = 'true';
process.env.PI_OFFLINE = '1';
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const model = { provider: 'fixture', id: 'fixture', input: ['text'], reasoning: false, contextWindow: 16000, maxTokens: 1024 };
const user = text => ({ role: 'user', content: text, timestamp: Date.now() });
const answer = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now() });
const waitFor = async check => {
    const end = Date.now() + 15000;
    while (!await check()) { if (Date.now() > end) throw new Error('Title fixture timeout'); await new Promise(resolve => setTimeout(resolve, 15)); }
};
async function fixture({ pending = true, text = '排查手机聊天页面的横向溢出' } = {}) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.inMemory(root);
    // The pure bridge fixture models a persistent worker without reading/writing user data.
    manager.getSessionFile = () => path.join(root, `${manager.getSessionId()}.jsonl`);
    if (pending) manager.appendCustomEntry(TITLE_STATE, { version: 1, sessionId: manager.getSessionId(), status: 'pending' });
    manager.appendMessage(user(text)); manager.appendMessage(answer('建议检查 flex 子元素的 min-width'));
    const pi = { appendEntry: (type, data) => manager.appendCustomEntry(type, data), setSessionName: name => manager.appendSessionInfo(name) };
    const ctx = { sessionManager: manager, model, isIdle: () => true, hasPendingMessages: () => false };
    const worker = Object.assign(new EventEmitter(), { sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId(), cwd: root,
        titleRequest: async input => handleTitleRequest(pi, ctx, input), _broadcast: event => worker.events.push(event), events: [] });
    return { manager, pi, ctx, worker };
}
function service(options = {}) {
    const preferences = new WorkspacePreferencesService({ filePath: path.join(root, `prefs-${Math.random()}.json`) });
    let calls = 0;
    const titles = new PiSessionTitleService({ preferences, createModelRuntime: async () => ({ getModel: () => model,
        completeSimple: async (_model, context, options) => { calls++; return { ...answer('{"title":"手机聊天页横向溢出排查"}'), ...await complete?.(context, options) }; } }), ...options });
    let complete;
    return { titles, preferences, calls: () => calls, setComplete: fn => { complete = fn; } };
}

test('title excerpts exclude tools, images, thinking, aborted replies and abandoned branches; metadata binds to the native session', async () => {
    const f = await fixture();
    const originalLeaf = f.manager.getLeafId();
    f.manager.appendMessage(user('abandoned secret'));
    f.manager.branch(originalLeaf);
    f.manager.appendMessage({ role: 'toolResult', content: 'tool secret' });
    f.manager.appendMessage({ ...answer('unfinished secret'), stopReason: 'aborted' });
    f.manager.appendMessage({ ...answer('progress secret'), stopReason: 'toolUse' });
    f.manager.appendMessage({ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'thinking secret' }, { type: 'text', text: 'Final answer' }] });
    const snapshot = titleSnapshot(f.manager, model);
    assert.equal(snapshot.eligible, true);
    for (const secret of ['abandoned secret', 'tool secret', 'unfinished secret', 'progress secret', 'thinking secret']) assert.ok(!JSON.stringify(snapshot.messages).includes(secret));
    for (let i = 0; i < 20; i++) f.manager.appendMessage(user('x'.repeat(20000)));
    const bounded = titleSnapshot(f.manager, model);
    assert.ok(bounded.messages.length <= 6); assert.ok(bounded.messages.reduce((n, m) => n + m.text.length, 0) <= 8000);
    const copy = await fixture({ pending: false });
    copy.manager.appendCustomEntry(TITLE_STATE, snapshot.state);
    assert.equal(titleSnapshot(copy.manager, model).eligible, false, 'imported metadata cannot enroll a new identity');
});

test('automatic naming runs once, survives reconstruction, skips old/manual/greeting threads, and preferences preserve unknown data', async () => {
    const { titles, preferences, calls } = service();
    const f = await fixture();
    assert.equal((await titles.auto(f.worker)).name, '手机聊天页横向溢出排查');
    assert.equal(f.manager.getSessionName(), '手机聊天页横向溢出排查');
    assert.equal(f.worker.events[0].type, 'gateway_session_named');
    await titles.auto(f.worker);
    assert.equal(calls(), 1);
    assert.equal(titleSnapshot(f.manager, model).eligible, false);
    const manual = await fixture(); manual.manager.appendSessionInfo('我的任务');
    const old = await fixture({ pending: false });
    const greeting = await fixture({ text: '你好！' });
    for (const item of [manual, old, greeting]) await titles.auto(item.worker);
    assert.equal(calls(), 1);
    greeting.manager.appendMessage(user('帮我排查移动端溢出')); greeting.manager.appendMessage(answer('可以检查布局'));
    await titles.auto(greeting.worker); assert.equal(calls(), 2);
    preferences.writeDocument({ unknown: { kept: true }, sessionTitles: { extra: 'preserved' } });
    titles.saveSettings({ enabled: false });
    assert.deepEqual(preferences.readDocument(), { unknown: { kept: true }, sessionTitles: { extra: 'preserved', enabled: false, revision: 1 } });
    const disabled = await fixture(); await titles.auto(disabled.worker); assert.equal(calls(), 2);
    assert.throws(() => titles.saveSettings({ enabled: 'false' }));
    preferences.getSessionTitles = () => { throw new Error('PRIVATE_BROKEN_PREFERENCES'); };
    assert.equal(await titles.auto((await fixture()).worker), null, 'preference failures cannot escape a completion event');
    await titles.dispose();
});

test('manual name changes, navigation and disabling during generation discard late automatic results; failures are never replayed', async () => {
    for (const mutation of ['rename', 'context', 'disabled', 'exit', 'failure']) {
        const f = await fixture(), setup = service();
        let finish;
        setup.setComplete(() => new Promise(resolve => { finish = resolve; }));
        const running = setup.titles.auto(f.worker);
        await waitFor(() => finish);
        assert.equal(f.worker.titleGeneration, true);
        await assert.rejects(setup.titles.run(f.worker), /正在生成/);
        if (mutation === 'rename') f.manager.appendSessionInfo('用户的名称');
        if (mutation === 'context') f.manager.appendMessage(user('换一个话题'));
        if (mutation === 'disabled') setup.titles.saveSettings({ enabled: false });
        if (mutation === 'exit') f.worker.emit('exit');
        finish(mutation === 'failure' ? { stopReason: 'error', errorMessage: 'PRIVATE PROVIDER ERROR' } : {});
        assert.equal(await running, null);
        assert.equal(f.manager.getSessionName() || '', mutation === 'rename' ? '用户的名称' : '');
        assert.equal(f.worker.titleGeneration, false);
        await setup.titles.auto(f.worker);
        assert.equal(setup.calls(), 1, mutation);
        await setup.titles.dispose();
    }
});

test('manual generation is a suggestion; save compares name and branch revisions, including rename ABA', async () => {
    const f = await fixture(), setup = service();
    f.manager.appendSessionInfo('已有名称');
    const before = JSON.stringify(f.manager.getEntries());
    const suggestion = await setup.titles.run(f.worker);
    assert.equal(JSON.stringify(f.manager.getEntries()), before);
    f.manager.appendSessionInfo('别人改名'); f.manager.appendSessionInfo('已有名称');
    await assert.rejects(setup.titles.apply(f.worker, suggestion), /已变化/);
    const fresh = await setup.titles.run(f.worker);
    await setup.titles.apply(f.worker, { ...fresh, name: '自行修改建议' });
    assert.equal(f.manager.getSessionName(), '自行修改建议');
    await assert.rejects(setup.titles.apply(f.worker, fresh), /已变化/);
    await setup.titles.dispose();
});

test('topic deferral waits for new content and is bounded; timeout keeps the request slot until underlying completion', async () => {
    const f = await fixture(), setup = service();
    setup.setComplete(() => answer('{"title":null}'));
    for (let i = 0; i < 4; i++) {
        await setup.titles.auto(f.worker); await setup.titles.auto(f.worker);
        f.manager.appendMessage(user(`再讨论一下 ${i}`)); f.manager.appendMessage(answer('继续讨论'));
    }
    assert.equal(setup.calls(), 3);
    await setup.titles.dispose();
    const timed = service({ timeoutMs: 30, maxConcurrent: 1 }), slow = await fixture(), other = await fixture();
    let finish;
    timed.setComplete(() => new Promise(resolve => { finish = resolve; }));
    const running = timed.titles.auto(slow.worker);
    await waitFor(() => finish);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(timed.titles.jobs.size, 1);
    await assert.rejects(timed.titles.run(other.worker), /正在生成/);
    finish({}); assert.equal(await running, null);
    assert.equal(slow.manager.getSessionName(), undefined);
    await timed.titles.dispose();
});

test('dedicated title models serve unrelated threads without changing their models; usage is a bounded metadata projection', async () => {
    const first = await fixture(), second = await fixture({ text: '讨论数据库备份恢复步骤' });
    const prefs = new WorkspacePreferencesService({ filePath: path.join(root, 'dedicated-prefs.json') });
    const cheap = { ...model, provider: 'cheap-provider', id: 'cheap/title-v1', name: 'Cheap title model' };
    const catalog = [model, cheap], calls = [];
    const runtime = { getModel: (provider, id) => catalog.find(item => item.provider === provider && item.id === id),
        getAvailable: async () => catalog,
        completeSimple: async (selected, context, options) => {
            calls.push({ selected, context, options });
            return { ...answer('{"title":"专用模型生成的标题"}'), usage: { input: 80, output: 12, cacheRead: 0, cacheWrite: 3, totalTokens: 95, privateField: 'PRIVATE_USAGE' } };
        } };
    const titles = new PiSessionTitleService({ preferences: prefs, createModelRuntime: async () => runtime });
    assert.deepEqual(prefs.getSessionTitles(), { enabled: true, provider: '', modelId: '', revision: 0 });
    const saved = await titles.saveSettings({ provider: cheap.provider, modelId: cheap.id, expectedRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.equal(calls.length, 0, 'saving validates only; it does not generate a title');
    await titles.auto(first.worker);
    const suggestion = await titles.run(second.worker);
    assert.deepEqual(calls.map(call => call.selected.id), [cheap.id, cheap.id]);
    assert.ok(!JSON.stringify(calls[0].context).includes('数据库'));
    assert.ok(!JSON.stringify(calls[1].context).includes('横向溢出'));
    assert.equal(calls[0].options.maxRetries, 0);
    assert.ok(!calls[0].context.tools?.length);
    assert.deepEqual(suggestion.model, { provider: cheap.provider, id: cheap.id, name: cheap.name });
    assert.deepEqual(suggestion.usage, { input: 80, output: 12, cacheRead: 0, cacheWrite: 3, totalTokens: 95 });
    assert.equal(second.manager.getSessionName(), undefined, 'manual suggestion remains temporary');
    assert.deepEqual(first.ctx.model, model); assert.deepEqual(second.ctx.model, model);
    titles.saveSettings({ enabled: false });
    assert.equal(prefs.getSessionTitles().modelId, cheap.id, 'old switch-only clients preserve the dedicated selection');
    const reset = titles.saveSettings({ provider: '', modelId: '', expectedRevision: 2 });
    assert.equal(reset.enabled, false, 'changing the model preserves the automatic switch');
    await titles.run(second.worker);
    assert.equal(calls.at(-1).selected.id, model.id, 'explicit follow-thread restores thread selection for manual generation');
    assert.deepEqual(reportedUsage({ input: 0, output: -1, cacheRead: Infinity, totalTokens: '5' }), { input: 0, output: null, cacheRead: null, cacheWrite: null, totalTokens: null });
    assert.equal(reportedUsage(undefined), null);
    assert.equal(reportedUsage({ private: 'secret' }), null);
    await titles.dispose();
});

test('dedicated model validation rejects unavailable models and concurrent stale saves; unrelated preferences survive', async () => {
    const prefs = new WorkspacePreferencesService({ filePath: path.join(root, 'model-validation-prefs.json') });
    prefs.writeDocument({ mediaAgent: { provider: 'media', modelId: 'planner' }, unknown: { preserved: true }, sessionTitles: { custom: 'retained' } });
    let available = [model], release;
    const runtime = { getModel: (_provider, id) => id === model.id ? model : undefined, getAvailable: async () => available };
    const titles = new PiSessionTitleService({ preferences: prefs, createModelRuntime: async () => runtime });
    const before = prefs.readDocument();
    await assert.rejects(titles.saveSettings({ provider: model.provider, modelId: 'missing', expectedRevision: 0 }), /已接入/);
    available = [];
    await assert.rejects(titles.saveSettings({ provider: model.provider, modelId: model.id, expectedRevision: 0 }), /不可用/);
    assert.deepEqual(prefs.readDocument(), before);
    available = [model];
    runtime.getAvailable = () => new Promise(resolve => { release = resolve; });
    const pending = titles.saveSettings({ provider: model.provider, modelId: model.id, expectedRevision: 0 });
    await waitFor(() => release);
    assert.throws(() => titles.saveSettings({ provider: model.provider, modelId: model.id }), /正在保存/);
    titles.saveSettings({ enabled: false, expectedRevision: 0 });
    const rejected = assert.rejects(pending, /已变化/);
    release([model]); await rejected;
    assert.deepEqual(prefs.getSessionTitles(), { enabled: false, provider: '', modelId: '', revision: 1 });
    assert.deepEqual(prefs.readDocument().mediaAgent, before.mediaAgent);
    assert.deepEqual(prefs.readDocument().unknown, before.unknown);
    assert.equal(prefs.readDocument().sessionTitles.custom, 'retained');
    for (const input of [{ provider: 'one-sided' }, { provider: '', modelId: 'partial' }, { provider: [], modelId: '' }, { enabled: true, injected: 'field' }, { enabled: true, expectedRevision: -1 }]) {
        assert.throws(() => titles.saveSettings(input));
    }
    await titles.dispose();
});

test('a missing or failing dedicated model never falls back; model changes do not retarget an in-flight request', async () => {
    const f = await fixture(), prefs = new WorkspacePreferencesService({ filePath: path.join(root, 'no-fallback-prefs.json') });
    prefs.setSessionTitles({ provider: 'cheap', modelId: 'title-a' });
    const cheapA = { ...model, provider: 'cheap', id: 'title-a' }, cheapB = { ...cheapA, id: 'title-b' };
    const catalog = [model, cheapB]; let finish;
    const selected = [];
    const runtime = { getModel: (provider, id) => catalog.find(item => item.provider === provider && item.id === id), getAvailable: async () => catalog,
        completeSimple: async selectedModel => {
            selected.push(selectedModel.id);
            return new Promise(resolve => { finish = resolve; });
        } };
    const titles = new PiSessionTitleService({ preferences: prefs, createModelRuntime: async () => runtime });
    await assert.rejects(titles.run(f.worker), /不会改用线程模型/);
    assert.deepEqual(selected, []);
    catalog.push(cheapA);
    const running = titles.run(f.worker);
    await waitFor(() => finish);
    await titles.saveSettings({ provider: cheapB.provider, modelId: cheapB.id, expectedRevision: 1 });
    finish(answer('{"title":"冻结选择的建议"}'));
    const result = await running;
    assert.equal(result.model.id, cheapA.id); assert.deepEqual(selected, [cheapA.id]);
    runtime.completeSimple = async selectedModel => { selected.push(selectedModel.id); throw new Error('PRIVATE_PROVIDER_ERROR'); };
    await assert.rejects(titles.run(f.worker), /PRIVATE_PROVIDER_ERROR/);
    assert.deepEqual(selected, [cheapA.id, cheapB.id]);
    assert.equal(f.manager.getSessionName(), undefined);
    prefs.writeDocument({ sessionTitles: { provider: 'cheap' } });
    assert.equal(await titles.auto(f.worker), null, 'malformed references do not fall back');
    assert.equal(selected.length, 2);
    await titles.dispose();
});

async function connect(url, session) {
    const ws = new WebSocket(url), events = [], pending = new Map();
    ws.on('message', raw => { const event = JSON.parse(raw); events.push(event); if (pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); } });
    let next = 0;
    ws.call = (type, payload = {}) => new Promise(resolve => { const id = String(++next); pending.set(id, resolve); ws.send(JSON.stringify({ type, id, ...payload })); });
    ws.events = events; await once(ws, 'open');
    assert.equal((await ws.call('open_session', { token: process.env.PI_WEB_TOKEN, cwd: root, sessionId: session.id })).success, true);
    return ws;
}

test('real managed RPC and synthetic provider: settled automation, private snapshots, native persistence, REST suggestions and shared worker', { timeout: 90000 }, async t => {
    const requests = [];
    let holdTitle = false, releaseModelTitle;
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        const isTitle = body.messages.some(m => typeof m.content === 'string' && m.content.includes('Name a conversation'));
        const content = isTitle ? '{"title":"手机聊天页横向溢出排查"}' : '请检查 flex 子元素的 min-width。';
        if (isTitle && holdTitle) await new Promise(resolve => { releaseModelTitle = resolve; });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 } })}\n\ndata: [DONE]\n\n`);
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'PRIVATE_PROJECT_INSTRUCTIONS');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-key', models: [model, { ...model, id: 'title-helper', name: 'Title helper' }]
    } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    const gateway = createPiAgentGateway();
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const wss = gateway.attachWebSocket(server), base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        for (const ws of wss.clients) ws.terminate();
        await gateway.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const api = async (suffix, method = 'GET', body) => {
        const response = await fetch(base + '/api/pi' + suffix, { method, headers: { Authorization: `Bearer ${process.env.PI_WEB_TOKEN}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    assert.equal((await api('/status')).data.sessionTitles, true);
    const { data: session } = await api('/sessions', 'POST', { cwd: root });
    const ws = await connect(base.replace('http:', 'ws:') + '/api/pi/ws', session);
    const ws2 = await connect(base.replace('http:', 'ws:') + '/api/pi/ws', session);
    assert.equal(gateway.supervisor.workers.size, 1);
    assert.equal((await ws.call('prompt', { message: '帮我排查手机聊天页面横向溢出的问题' })).success, true);
    await waitFor(() => ws.events.some(event => event.type === 'gateway_session_named'));
    assert.ok(ws.events.some(event => event.type === 'agent_settled'));
    assert.ok(ws2.events.some(event => event.type === 'gateway_session_named'));
    assert.equal(requests.length, 2);
    const generated = requests[1];
    assert.ok(!generated.tools?.length); assert.ok(!JSON.stringify(generated).includes('PRIVATE_PROJECT_INSTRUCTIONS'));
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const saved = SessionManager.open(session.path);
    assert.equal(saved.getSessionName(), '手机聊天页横向溢出排查');
    assert.equal(saved.getEntries().filter(entry => entry.type === 'message' && entry.message?.role !== 'system').length, 2);
    assert.ok(!JSON.stringify(ws.events).includes('pi5Title'));
    const worker = gateway.supervisor.getActiveWorker(session.path);
    worker._handleEvent({ type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ pi5Title: 'unknown', data: 'PRIVATE_LATE_TITLE_EXCERPT' }) });
    assert.ok(!JSON.stringify(ws.events).includes('PRIVATE_LATE_TITLE_EXCERPT'));
    const titlePreferences = (await api('/settings/session-titles')).data;
    assert.equal((await api('/settings/session-titles', 'PUT', { provider: 'fixture', modelId: 'title-helper', expectedRevision: titlePreferences.revision })).status, 200);
    assert.equal((await api('/settings/session-titles', 'PUT', { enabled: true, expectedRevision: titlePreferences.revision })).status, 409);
    const before = fs.readFileSync(session.path);
    const suggestion = await api(`/sessions/${session.id}/title`, 'POST', { cwd: root });
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.data.model.id, 'title-helper');
    assert.equal(suggestion.data.usage.input, 80);
    assert.equal(suggestion.data.usage.output, 10);
    assert.equal(requests.at(-1).model, 'title-helper');
    assert.deepEqual(fs.readFileSync(session.path), before, 'suggestions do not write native history');
    assert.equal((await api(`/sessions/${session.id}`, 'PATCH', { cwd: root, name: '手工标题' })).status, 200);
    assert.equal((await api(`/sessions/${session.id}/title`, 'PUT', { cwd: root, ...suggestion.data })).status, 409);
    const fresh = await api(`/sessions/${session.id}/title`, 'POST', { cwd: root });
    assert.equal((await api(`/sessions/${session.id}/title`, 'PUT', { cwd: root, ...fresh.data, name: '编辑后的建议' })).status, 200);
    assert.equal((await api('/activity')).data.titleGenerations, 0);
    await gateway.supervisor.stopSession(session.path);
    const reopened = await gateway.supervisor.getWorker({ cwd: root, sessionId: session.id, sessionPath: session.path });
    const count = requests.length; await gateway.titles.auto(reopened); assert.equal(requests.length, count);
    holdTitle = true;
    const concurrent = (await api('/sessions', 'POST', { cwd: root })).data;
    const active = await connect(base.replace('http:', 'ws:') + '/api/pi/ws', concurrent);
    assert.equal((await active.call('prompt', { message: '为第二线程检查布局问题' })).success, true);
    await waitFor(() => releaseModelTitle);
    const titleActivity = (await api('/activity')).data;
    assert.equal(titleActivity.titleGenerations, 1);
    assert.equal(titleActivity.runtimes.find(item => item.sessionId === concurrent.id).titleGenerating, true);
    assert.equal((await active.call('prompt', { message: '继续检查移动端按钮' })).success, true, 'background naming must not block the main prompt');
    await waitFor(() => active.events.filter(event => event.type === 'agent_settled').length === 2);
    holdTitle = false; releaseModelTitle();
    await waitFor(() => gateway.titles.jobs.size === 0);
    assert.equal(SessionManager.open(concurrent.path).getSessionName(), undefined, 'changed content invalidates the old automatic result');
    await api('/settings/session-titles', 'PUT', { enabled: false });
    const disabled = (await api('/sessions', 'POST', { cwd: root })).data;
    assert.ok(!SessionManager.open(disabled.path).getEntries().some(entry => entry.customType === TITLE_STATE));
    const invalid = await api(`/sessions/${session.id}/title`, 'POST', { cwd: os.tmpdir() }); assert.equal(invalid.status, 400);
});
