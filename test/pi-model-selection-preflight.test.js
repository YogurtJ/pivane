const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-model-selection-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const wrapper = import('../server/pi-model-selection-preflight.mjs');
let sdk;
test.before(async () => { sdk = await import('@earendil-works/pi-coding-agent'); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const assertUnselected = value => assert.deepEqual(value, { provider: 'unknown', id: 'unknown', name: 'unknown', api: 'unknown', baseUrl: '',
    reasoning: false, input: [], contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const model = id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
async function services(settings, options = {}) {
    const runtime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    runtime.registerProvider('fixture', { baseUrl: 'http://127.0.0.1:65530/v1', api: 'openai-completions', apiKey: 'synthetic', models: [model('B')] });
    await runtime.refresh({ allowNetwork: false });
    const result = await sdk.createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
        modelRuntime: runtime, settingsManager: sdk.SettingsManager.inMemory(settings),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, ...options } });
    return result;
}

test('SDK bootstrap keeps an unavailable saved default unselected and exposes the original runtime for explicit recovery', async t => {
    const input = await services({ defaultProvider: 'fixture', defaultModel: 'A', futureSetting: true });
    const originalMethods = [input.modelRuntime.getModel, input.modelRuntime.getAvailableSnapshot];
    const manager = sdk.SessionManager.inMemory(root);
    const { createAgentSessionWithSelectionPreflight } = await wrapper;
    const created = await createAgentSessionWithSelectionPreflight({ services: input, sessionManager: manager,
        scopedModels: [{ model: input.modelRuntime.getModel('fixture', 'B'), thinkingLevel: 'off' }], noTools: 'all' });
    t.after(() => created.session.dispose());
    assertUnselected(created.session.model);
    assert.match(created.modelFallbackMessage, /fixture\/A.*explicit/i);
    assert.deepEqual(input.modelRuntime.getModels('fixture').map(model => model.id), ['B']);
    assert.deepEqual(created.session.modelRuntime.getAvailableSnapshot().map(model => model.id), ['B']);
    assert.deepEqual(created.session.modelRuntime.getModel('fixture', 'B'), input.modelRuntime.getModel('fixture', 'B'));
    assert.deepEqual([input.modelRuntime.getModel, input.modelRuntime.getAvailableSnapshot], originalMethods);
    assert.ok(await created.session.modelRuntime.getAuth('fixture'));
    await assert.rejects(created.session.prompt('Do not automatically use B'), /No API key|No model selected/i);
    await created.session.sendCustomMessage({ customType: 'wake', content: 'Automatic wake', display: false }, { triggerTurn: true });
    assert.ok(!manager.getEntries().some(entry => entry.type === 'model_change' && entry.provider === 'unknown'), 'automatic custom wake must not persist the native unselected sentinel as a chosen model');
    assertUnselected(created.session.model);
    assert.ok(!manager.getEntries().some(entry => entry.type === 'model_change' && entry.modelId === 'B'));
    await created.session.setModel(input.modelRuntime.getModel('fixture', 'B'), { persist: true });
    assert.equal(created.session.model.id, 'B');
    assert.ok(manager.getEntries().some(entry => entry.type === 'model_change' && entry.modelId === 'B'));
    assert.equal(input.settingsManager.getDefaultModel(), 'B', 'explicit native selection retains native preference semantics');
});

test('an unavailable historical selection outranks a different available saved default', async t => {
    const input = await services({ defaultProvider: 'fixture', defaultModel: 'B' });
    const manager = sdk.SessionManager.inMemory(root);
    manager.appendModelChange('fixture', 'A');
    manager.appendThinkingLevelChange('off');
    manager.appendMessage({ role: 'user', content: 'Keep the original thread selection', timestamp: 1 });
    const before = structuredClone(manager.getEntries());
    const { createAgentSessionWithSelectionPreflight } = await wrapper;
    const created = await createAgentSessionWithSelectionPreflight({ services: input, sessionManager: manager, noTools: 'all' });
    t.after(() => created.session.dispose());
    assertUnselected(created.session.model);
    assert.match(created.modelFallbackMessage, /fixture\/A/);
    assert.deepEqual(manager.getEntries().slice(0, before.length), before);
    assert.ok(!manager.getEntries().some(entry => entry.type === 'model_change' && entry.modelId === 'B'));
    assert.equal(input.settingsManager.getDefaultModel(), 'B');
});

test('SDK bootstrap preserves first discovery, explicit choices, registered virtual selections and extension catalogs', async t => {
    const { createAgentSessionWithSelectionPreflight } = await wrapper;
    const input = await services({});
    const first = await createAgentSessionWithSelectionPreflight({ services: input, sessionManager: sdk.SessionManager.inMemory(root), noTools: 'all' });
    t.after(() => first.session.dispose());
    assert.equal(first.session.model.id, 'B', 'first configuration without any prior selection retains native discovery');
    const scopedModel = input.modelRuntime.getModel('fixture', 'B');
    const scoped = await createAgentSessionWithSelectionPreflight({ services: input, sessionManager: sdk.SessionManager.inMemory(root),
        scopedModels: [{ model: scopedModel, thinkingLevel: 'off' }], noTools: 'all' });
    t.after(() => scoped.session.dispose());
    assert.equal(scoped.session.model.id, 'B');
    assert.equal(scoped.session.thinkingLevel, 'off');
    const explicitInput = await services({ defaultProvider: 'fixture', defaultModel: 'A' });
    const explicit = await createAgentSessionWithSelectionPreflight({ services: explicitInput, sessionManager: sdk.SessionManager.inMemory(root),
        model: explicitInput.modelRuntime.getModel('fixture', 'B'), noTools: 'all' });
    t.after(() => explicit.session.dispose());
    assert.equal(explicit.session.model.id, 'B');
    const virtualInput = await services({ defaultProvider: 'fixture', defaultModel: 'A' });
    virtualInput.modelRuntime.registerVirtualModel({ provider: 'fixture', id: 'router', name: 'Authorized router',
        route: () => ({ model: virtualInput.modelRuntime.getModel('fixture', 'B') }) });
    const manager = sdk.SessionManager.inMemory(root);
    manager.appendModelChange('fixture', 'router');
    manager.appendMessage({ role: 'user', content: 'Original authorized routing', timestamp: 1 });
    manager.appendMessage({ role: 'assistant', provider: 'fixture', model: 'B', api: 'openai-completions', content: [{ type: 'text', text: 'Routed result' }],
        stopReason: 'stop', timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const virtual = await createAgentSessionWithSelectionPreflight({ services: virtualInput, sessionManager: manager, noTools: 'all' });
    t.after(() => virtual.session.dispose());
    assert.equal(virtual.session.model.id, 'router', 'registered virtual selection retains its explicitly authorized router');
    virtual.session.modelRuntime.registerProvider('extension', { baseUrl: 'http://127.0.0.1:65530/v1', api: 'openai-completions', apiKey: 'synthetic', models: [model('extended')] });
    await virtual.session.modelRuntime.refresh({ allowNetwork: false });
    assert.ok(virtualInput.modelRuntime.getModel('extension', 'extended'), 'provider registration delegates to the real runtime');
});

test('failed SDK construction releases the facade without changing shared methods or catalogs', async () => {
    const input = await services({ defaultProvider: 'fixture', defaultModel: 'A' });
    const methods = [input.modelRuntime.getModel, input.modelRuntime.getAvailableSnapshot];
    const settings = input.settingsManager;
    const manager = sdk.SessionManager.inMemory(root);
    const badServices = { ...input, settingsManager: new Proxy(settings, { get(target, key) {
        if (key === 'getDefaultThinkingLevel') return () => { throw new Error('Synthetic construction failure'); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const { createAgentSessionWithSelectionPreflight } = await wrapper;
    await assert.rejects(createAgentSessionWithSelectionPreflight({ services: badServices, sessionManager: manager, noTools: 'all' }), /Synthetic construction failure/);
    assert.deepEqual([input.modelRuntime.getModel, input.modelRuntime.getAvailableSnapshot], methods);
    assert.equal(input.modelRuntime.getModel('fixture', 'B').id, 'B');
    assert.deepEqual(input.modelRuntime.getAvailableSnapshot().map(model => model.id), ['B']);
    const recovered = await createAgentSessionWithSelectionPreflight({ services: input, sessionManager: sdk.SessionManager.inMemory(root),
        model: input.modelRuntime.getModel('fixture', 'B'), noTools: 'all' });
    assert.equal(recovered.session.model.id, 'B');
    recovered.session.dispose();
});

test('a saved model with missing provider authentication remains unselected while another provider is available', async t => {
    const input = await services({ defaultProvider: 'unconfigured', defaultModel: 'A' });
    input.modelRuntime.registerProvider('unconfigured', { baseUrl: 'http://127.0.0.1:65530/v1', api: 'openai-completions', models: [model('A')] });
    await input.modelRuntime.refresh({ allowNetwork: false });
    assert.equal(input.modelRuntime.hasConfiguredAuth('unconfigured'), false);
    const { createAgentSessionWithSelectionPreflight } = await wrapper;
    const created = await createAgentSessionWithSelectionPreflight({ services: input, sessionManager: sdk.SessionManager.inMemory(root), noTools: 'all' });
    t.after(() => created.session.dispose());
    assertUnselected(created.session.model);
    assert.ok(created.session.modelRuntime.getModel('unconfigured', 'A'));
    assert.deepEqual(created.session.modelRuntime.getAvailableSnapshot().map(model => model.id), ['B']);
    assert.equal(input.settingsManager.getDefaultProvider(), 'unconfigured');
    assert.equal(input.settingsManager.getDefaultModel(), 'A');
});

// The fixture uses the real managed entry and Supervisor, with only the approved
// integration seam replaced in a disposable file within this worktree.
test('managed Key A/B bootstrap and restart stay connectable without paid fallback until explicit set_model', { timeout: 60000 }, async t => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        requests.push({ url: req.url, auth: req.headers.authorization, raw });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/api/models/providers/openrouter?')) {
            res.setHeader('Last-Modified', 'Thu, 01 Jan 2099 00:00:00 GMT');
            return res.end(JSON.stringify({ models: ['A', 'B'].map(id => ({ ...model(id), provider: 'openrouter', api: 'openai-completions', baseUrl: base + '/v1' })) }));
        }
        if (req.url.startsWith('/api/models/providers/')) { res.writeHead(404); return res.end('{}'); }
        if (req.url === '/v1/models/user') return res.end(JSON.stringify({ data: [{ id: req.headers.authorization === 'Bearer synthetic-A' ? 'A' : 'B' }] }));
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(JSON.parse(raw).model, 'B');
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'EXPLICIT_B_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let supervisor;
    const fixtureFile = path.join(__dirname, '../server/.model-selection-fixture.mjs');
    const previousCli = process.env.PI_WEB_CLI;
    t.after(async () => { await supervisor?.dispose(); if (previousCli === undefined) delete process.env.PI_WEB_CLI; else process.env.PI_WEB_CLI = previousCli;
        fs.rmSync(fixtureFile, { force: true }); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { openrouter: { baseUrl: base + '/v1' } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openrouter', defaultModel: 'A', defaultThinkingLevel: 'off', compaction: { enabled: false } }));
    const settingsBefore = fs.readFileSync(path.join(agentDir, 'settings.json'));
    const modelsBefore = fs.readFileSync(path.join(agentDir, 'models.json'));
    const extensionDir = path.join(agentDir, 'extensions'); fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'wake.ts'), `export default function(pi) {
        pi.registerCommand('fixture-wake', { description: 'Synthetic automatic wake', handler: async () => {
            pi.sendMessage({ customType: 'fixture-wake', content: 'Synthetic automatic wake', display: false }, { triggerTurn: true });
        } });
        pi.registerCommand('fixture-route-wake', { description: 'Explicitly authorized synthetic routing', handler: async () => {
            pi.sendMessage({ customType: 'fixture-route-wake', content: 'Explicitly authorized routing', display: false }, { triggerTurn: true });
        } });
        pi.on('before_agent_start', async (event, ctx) => {
            if (event.messageType === 'custom' && event.message.customType === 'fixture-route-wake') {
                await pi.setModel(ctx.modelRegistry.find('openrouter', 'B'));
            }
        });
    }`);
    const runtime = await sdk.ModelRuntime.create({ catalogBaseUrl: base, allowModelNetwork: false });
    const login = key => runtime.login('openrouter', 'api_key', { prompt: async () => key, notify() {} });
    await login('synthetic-A');
    await runtime.refresh({ providers: ['openrouter'], allowNetwork: true, force: true });
    assert.ok(runtime.getModel('openrouter', 'A'));
    const manager = sdk.SessionManager.create(root, path.join(root, 'sessions'));
    manager.appendModelChange('openrouter', 'A'); manager.appendThinkingLevelChange('off');
    manager.appendMessage({ role: 'user', content: 'Historical A requirement', timestamp: 1 });
    manager.appendMessage({ role: 'assistant', provider: 'openrouter', model: 'A', api: 'openai-completions', content: [{ type: 'text', text: 'Original A result' }],
        stopReason: 'stop', timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const originalBytes = fs.readFileSync(manager.getSessionFile());
    const originalEntries = manager.getEntries();
    await login('synthetic-B');
    await runtime.refresh({ providers: ['openrouter'], allowNetwork: true, force: true });
    assert.equal(runtime.getModel('openrouter', 'A'), undefined); assert.ok(runtime.getModel('openrouter', 'B'));
    const source = fs.readFileSync(path.join(__dirname, '../server/pi-managed-runtime.mjs'), 'utf8');
    const prepared = source.includes('await createAgentSessionWithSelectionPreflight(') ? source :
        `import { createAgentSessionWithSelectionPreflight } from './pi-model-selection-preflight.mjs';\n` + source
            .replace('await createAgentSessionFromServices(', 'await createAgentSessionWithSelectionPreflight(')
            .replace('const model = selected.model || (!sessionManager.buildSessionContext().messages.length ? scopedModels[0]?.model : undefined);', 'const model = selected.model;');
    fs.writeFileSync(fixtureFile, prepared);
    process.env.PI_WEB_CLI = fixtureFile;
    supervisor = new PiAgentSupervisor();
    const target = { cwd: root, sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId() };
    const paid = () => requests.filter(request => request.url === '/v1/chat/completions');
    let worker = await supervisor.getWorker(target);
    assertUnselected((await worker.request('get_state')).model);
    assert.deepEqual((await worker.request('get_available_models')).models.filter(model => model.provider === 'openrouter').map(model => model.id), ['B']);
    await assert.rejects(worker.request('prompt', { message: 'Must require an explicit selection' }), error => error.code === 'MODEL_AUTH_REQUIRED');
    const wakeSettled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Synthetic wake did not settle')); }, 10000);
        const off = worker.subscribe(event => { if (event.type === 'agent_settled') { clearTimeout(timer); off(); resolve(); } });
    });
    await worker.request('prompt', { message: '/fixture-wake' }); await wakeSettled;
    assertUnselected((await worker.request('get_state')).model);
    assert.equal(paid().length, 0, 'ordinary and automatic custom wake do not request paid B');
    assert.deepEqual(fs.readFileSync(path.join(agentDir, 'settings.json')), settingsBefore);
    assert.deepEqual(fs.readFileSync(path.join(agentDir, 'models.json')), modelsBefore);
    assert.ok(!sdk.SessionManager.open(manager.getSessionFile()).getEntries().some(entry => entry.type === 'model_change' && ['B', 'unknown'].includes(entry.modelId)));
    assert.deepEqual(fs.readFileSync(manager.getSessionFile()).subarray(0, originalBytes.length), originalBytes);
    assert.deepEqual(sdk.SessionManager.open(manager.getSessionFile()).getEntries().slice(0, originalEntries.length), originalEntries);
    await worker.dispose();
    worker = await supervisor.getWorker(target);
    assertUnselected((await worker.request('get_state')).model);
    assert.equal(paid().length, 0);
    const fresh = await supervisor.createEphemeralWorker(root);
    assertUnselected((await fresh.request('get_state')).model);
    const routeSettled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Synthetic authorized route did not settle')); }, 10000);
        const off = fresh.subscribe(event => { if (event.type === 'agent_settled') { clearTimeout(timer); off(); resolve(); } });
    });
    await fresh.request('prompt', { message: '/fixture-route-wake' }); await routeSettled;
    assert.equal((await fresh.request('get_state')).model.id, 'B', 'an explicit extension routing choice can still select B through before_agent_start');
    assert.equal(paid().length, 1);
    assert.deepEqual(fs.readFileSync(path.join(agentDir, 'settings.json')), settingsBefore, 'extension selection retains native non-persisting semantics');
    await fresh.dispose();
    await worker.request('set_model', { provider: 'openrouter', modelId: 'B' });
    assert.equal((await worker.request('get_state')).model.id, 'B');
    const settled = new Promise(resolve => { const off = worker.subscribe(event => { if (event.type === 'agent_settled') { off(); resolve(); } }); });
    await worker.request('prompt', { message: 'This explicit selection may use B' }); await settled;
    assert.equal(paid().length, 2, 'only explicit extension routing and explicit user selection sent B requests');
    const after = sdk.SessionManager.open(manager.getSessionFile()).getEntries();
    assert.deepEqual(after.slice(0, originalEntries.length), originalEntries);
    assert.ok(after.some(entry => entry.type === 'model_change' && entry.modelId === 'B'));
});
