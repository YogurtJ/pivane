const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-threads-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { taskProfile, taskState, TASK_MESSAGE, TASK_RECEIPT } = require('../server/pi-agent-threads');
const deadline = async (fn, ms = 20000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Timed out waiting for fixture');
};

test('Agent creates a persistent task, runs immediately with defaults, preserves provenance and never replays', { timeout: 120000 }, async () => {
    const calls = []; let toolRequested = false;
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part;
        const input = JSON.parse(body); calls.push(input);
        const invoke = !toolRequested && input.messages.some(message => JSON.stringify(message.content).includes('CREATE_TASK_FIXTURE'));
        if (invoke) toolRequested = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (invoke) {
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'create-task', type: 'function', function: { name: 'agent_thread',
                arguments: JSON.stringify({ action: 'create', requestId: 'from-tool', title: 'Tool task', message: 'TASK_FROM_TOOL. Reply briefly.' }) } }] });
            chunk({}, 'tool_calls');
        } else { chunk({ role: 'assistant', content: 'TASK_FIXTURE_OK' }); chunk({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'default-model', defaultThinkingLevel: 'high', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: ['default-model', 'chosen-model'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 })) } } }));
    const access = new WorkspaceAccessService({ envToken: () => 'fixture-web-token' });
    const gateway = createPiAgentGateway({ accessService: access });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = base;
    const api = async (route, body, token, headers = {}) => {
        const response = await fetch(base + '/api/pi' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    try {
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        const source = await gateway.store.createSession(cwd, 'Source A');
        const worker = await gateway.supervisor.getWorker({ cwd, sessionPath: source.path, sessionId: source.id });
        const token = worker.navigationToken;
        assert.ok((await worker.getNativeResources()).tools.some(tool => tool.name === 'agent_thread'));
        await worker.request('set_model', { provider: 'fixture', modelId: 'chosen-model' });
        const initial = { requestId: 'one', title: 'Task B', message: 'TASK_BODY_FIXTURE. Read-only explanation.' };
        assert.equal((await api('/agent-threads/create', initial, 'fixture-web-token')).status, 403);
        assert.equal((await api('/agent-threads/create', initial, token, { Origin: 'https://evil.invalid' })).status, 403);
        assert.equal((await api('/sessions', { cwd }, token)).status, 401, 'worker token cannot use arbitrary routes');
        assert.equal((await api('/agent-threads/create', { ...initial, thinkingLevel: 'high' }, token)).status, 400, 'explicit unsupported thinking rejected');
        assert.equal((await api('/agent-threads/create', { ...initial, provider: 'fixture', modelId: 'missing' }, token)).status, 400);
        assert.equal((await gateway.store.listSessions(cwd)).length, 1, 'preflight failures create no empty threads');
        const result = await api('/agent-threads/create', initial, token);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.data.model.modelId, 'default-model', 'uses default, not source current model');
        assert.equal(result.data.thinkingLevel, 'off', 'default thinking clamps to supported level');
        const child = await gateway.store.getSession(cwd, result.data.session.id);
        await deadline(() => taskState(SessionManager.open(child.path))?.status === 'settled');
        const manager = SessionManager.open(child.path);
        assert.equal(taskProfile(manager).source.sessionId, source.id);
        assert.equal(taskProfile({ getEntries: () => manager.getEntries(), getSessionId: () => 'copied-id' }), null);
        assert.ok(manager.getEntries().some(entry => entry.type === 'custom_message' && entry.customType === TASK_MESSAGE && entry.content === initial.message));
        assert.equal(manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 0, 'Agent does not impersonate the user');
        assert.ok(calls.some(call => call.model === 'default-model' && JSON.stringify(call.messages).includes('TASK_BODY_FIXTURE')));
        assert.equal((await worker.request('get_state')).sessionId, source.id);
        const callCount = calls.length;
        const replay = await api('/agent-threads/create', initial, token);
        assert.equal(replay.data.session.id, child.id); assert.equal(replay.data.reused, true); assert.equal(calls.length, callCount);
        assert.equal((await api('/agent-threads/create', { ...initial, message: 'changed' }, token)).status, 400);
        const childWorker = gateway.supervisor.getActiveWorker(child.path);
        assert.equal((await api('/agent-threads/status', { requestId: 'one' }, childWorker.navigationToken)).status, 400, 'identity scoped to source');
        await gateway.supervisor.stopSession(child.path);
        assert.equal((await api('/agent-threads/status', { requestId: 'one' }, token)).data.status, 'completed');
        const again = await api('/agent-threads/create', initial, token);
        assert.equal(again.data.session.id, child.id); assert.equal(gateway.supervisor.getActiveWorker(child.path), undefined, 'replay does not restart worker');
        const chosen = await api('/agent-threads/create', { ...initial, requestId: 'chosen', provider: 'fixture', modelId: 'chosen-model', thinkingLevel: 'off' }, token);
        assert.equal(chosen.data.model.modelId, 'chosen-model');
        await deadline(async () => (await api('/agent-threads/status', { requestId: 'chosen' }, token)).data.status === 'completed');
        await worker.request('prompt', { message: 'CREATE_TASK_FIXTURE' });
        await deadline(async () => (await worker.request('get_messages')).messages.some(message => message.customType === TASK_RECEIPT));
        await deadline(() => !worker.activity.snapshot().busy && worker.promptPending === 0);
        const messages = (await worker.request('get_messages')).messages;
        assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'agent_thread' && !message.isError));
        assert.ok(messages.some(message => message.customType === TASK_RECEIPT && message.details.session.id));
        assert.doesNotMatch(JSON.stringify(calls), new RegExp(token));
        const originalGetWorker = gateway.supervisor.getWorker.bind(gateway.supervisor);
        gateway.supervisor.getWorker = async () => { throw new Error('Synthetic startup failure'); };
        const failed = await api('/agent-threads/create', { ...initial, requestId: 'failed-start' }, token);
        gateway.supervisor.getWorker = originalGetWorker;
        assert.equal(failed.data.status, 'saved');
        const failedSession = await gateway.store.getSession(cwd, failed.data.session.id);
        assert.ok(SessionManager.open(failedSession.path).getEntries().some(entry => entry.customType === TASK_MESSAGE));
        assert.equal((await api('/agent-threads/create', { ...initial, requestId: 'failed-start' }, token)).data.session.id, failedSession.id);
        assert.equal(gateway.supervisor.getActiveWorker(failedSession.path), undefined, 'failed launch is not automatically retried');
        const recovered = await originalGetWorker({ cwd, sessionPath: failedSession.path, sessionId: failedSession.id });
        await recovered.request('prompt', { message: 'Continue the saved task.' });
        await deadline(() => taskState(SessionManager.open(failedSession.path))?.status === 'settled');
        await gateway.supervisor.stopSession(source.path);
        assert.equal((await api('/agent-threads/status', { requestId: 'one' }, token)).status, 401, 'old worker credential revoked');
        const resumedSource = await originalGetWorker({ cwd, sessionPath: source.path, sessionId: source.id });
        const resumed = await api('/agent-threads/create', initial, resumedSource.navigationToken);
        assert.equal(resumed.data.session.id, child.id, 'deduplication survives source runtime recreation');
        const seen = [];
        const unsubscribe = resumedSource.subscribe(event => seen.push(event));
        resumedSource._handleEvent({ type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ pi5Navigation: 'late-task-reply', success: true, data: 'PRIVATE_FIXTURE' }) });
        unsubscribe(); assert.equal(seen.length, 0, 'unknown/late task acknowledgements stay private');
    } finally {
        await gateway.dispose(); access.dispose(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
