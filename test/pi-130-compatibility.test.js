'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-pi130-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
const { REVIEWED_PI_VERSION } = require('../server/pi-reviewed-host');
const { PiSettingsService } = require('../server/pi-settings-service');
let sdk;
test.before(async () => { sdk = await import('@earendil-works/pi-coding-agent'); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const model = { provider: 'fixture', id: 'model', api: 'openai-completions', name: 'Synthetic', input: ['text'],
    reasoning: false, contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = content => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    stopReason: 'stop', timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: model.cost } });

async function loopback(t, respond) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        const delta = respond(body, requests.length);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { requests, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}
async function session(t, selected, extra = {}) {
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['read', 'write'], enableInstallTelemetry: false,
        compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true });
    await loader.reload();
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
        modelsStorePath: path.join(agentDir, 'catalog.json'), allowModelNetwork: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: selected.baseUrl, apiKey: 'synthetic', models: [selected] });
    await runtime.refresh({ allowNetwork: false });
    const created = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel('fixture', 'model'),
        resourceLoader: loader, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(cwd), ...extra });
    await created.session.bindExtensions({ mode: 'print' });
    t.after(() => created.session.dispose());
    return created.session;
}

test('reviewed host, primary lock and isolated memory recipe bind the same official Pi group', () => {
    const pkg = require('../package.json'), lock = require('../package-lock.json');
    const recipe = require('../scripts/profile-memory-install.cjs').manifest;
    const memoryLock = require('../server/profile-memory/upstream-lock.json');
    assert.equal(pkg.pivaneCompatibility.piVersion, REVIEWED_PI_VERSION);
    for (const name of require('../server/pi-update-installer').PI_PACKAGES) {
        assert.equal(lock.packages['node_modules/' + name].version, REVIEWED_PI_VERSION, name);
        assert.equal(memoryLock.packages['node_modules/' + name].version, REVIEWED_PI_VERSION, name);
        if (recipe.dependencies[name]) assert.equal(recipe.dependencies[name], REVIEWED_PI_VERSION);
    }
    assert.equal(recipe.dependencies['pi-hermes-memory'], '0.9.10');
});

test('compatibility controls follow the native API schema and preserve unsupported saved fields on reset', async () => {
    const service = new PiSettingsService({ cwd });
    const file = path.join(agentDir, 'models.json');
    fs.writeFileSync(file, JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-responses', apiKey: 'synthetic',
        models: [{ ...model, api: 'openai-responses', compat: { supportsMidConvoEffort: true, supportsStore: false, futureFlag: 'keep' } }] } } }));
    let info = await service.getModelAdvanced({ provider: 'fixture', modelId: 'model' });
    const native = await import('@earendil-works/pi-ai/providers/compat-schema');
    assert.equal(info.compatSchema.supportsMidConvoEffort.description, native.OpenAIResponsesCompatSchema.properties.supportsMidConvoEffort.description);
    assert.equal(info.compatSchema.supportsStore, undefined);
    assert.equal(info.compatSchema.chatTemplateKwargs, undefined);
    await service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: info.revision,
        compat: { supportsMidConvoEffort: false, supportsAdditionalTools: true } });
    assert.equal((await service.getModelAdvanced({ provider: 'fixture', modelId: 'model' })).effectiveCompat.supportsMidConvoEffort, false);
    await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: info.revision, compat: {} }), /变化/);
    info = await service.getModelAdvanced({ provider: 'fixture', modelId: 'model' });
    for (const compat of [{ supportsStore: true }, { supportsMidConvoEffort: 1 }, { chatTemplateKwargs: {} }]) {
        await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: info.revision, compat }), /兼容参数/);
    }
    await service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: info.revision, compat: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).providers.fixture.models[0].compat, { supportsStore: false, futureFlag: 'keep' });
    const completions = await require('../server/pi-model-advanced').compatSchema('openai-completions');
    assert.deepEqual(completions.thinkingFormat.choices, native.OpenAICompletionsCompatSchema.properties.thinkingFormat.anyOf.map(x => x.const));
    assert.ok(completions.thinkingFormat.choices.includes('openai'));
    assert.deepEqual(await require('../server/pi-model-advanced').compatSchema('google-generative-ai'), {});
});

test('Kimi native protocol changes and explicit old or proxy overrides are visible without rewriting configuration', async () => {
    const base = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'empty-auth.json'), modelsPath: null,
        modelsStorePath: path.join(agentDir, 'kimi-base.json'), allowModelNetwork: false });
    const kimi = base.getModels().find(item => item.provider === 'kimi-coding');
    assert.ok(kimi);
    assert.equal(kimi.api, 'openai-completions');
    assert.equal(kimi.baseUrl, 'https://api.kimi.com/coding/v1');
    const cases = [undefined, { baseUrl: 'https://api.kimi.com/coding' }, { baseUrl: 'https://api.kimi.com/coding/v1' },
        { baseUrl: 'http://127.0.0.1:1/custom/v1' }, { baseUrl: 'https://api.kimi.com/coding', api: 'anthropic-messages' },
        { modelOverrides: { [kimi.id]: { api: 'anthropic-messages' } } },
        { baseUrl: 'https://api.kimi.com/coding', models: [{ id: kimi.id, api: 'anthropic-messages' }] }];
    for (const [index, config] of cases.entries()) {
        const file = path.join(agentDir, `kimi-${index}.json`);
        const raw = JSON.stringify({ providers: config ? { 'kimi-coding': config } : {} }); fs.writeFileSync(file, raw);
        const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'empty-auth.json'), modelsPath: file,
            modelsStorePath: path.join(agentDir, 'kimi-catalog.json'), allowModelNetwork: false });
        const selected = runtime.getModel('kimi-coding', kimi.id);
        assert.equal(selected.baseUrl, config?.baseUrl || kimi.baseUrl);
        // Built-in model APIs outrank provider defaults; api is not a supported
        // modelOverrides field. An explicit model definition can replace it.
        assert.equal(selected.api, config?.models?.[0]?.api || kimi.api, `configuration ${index}`);
        assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
});

test('malformed final tool arguments never execute a valid prefix and preserve the model error through native messages', async t => {
    let executed = 0;
    const remote = await loopback(t, (_body, count) => count === 1 ? { tool_calls: [{ index: 0, id: 'invalid-call', type: 'function',
        function: { name: 'fixture_effect', arguments: '{"value":7,"broken":' } }] } : { content: 'Recovered from invalid arguments.' });
    const { Type } = await import('typebox');
    const current = await session(t, remote.model, { customTools: [{ name: 'fixture_effect', label: 'Fixture', description: 'Synthetic counted effect',
        parameters: Type.Object({ value: Type.Number() }), execute: async () => { executed++; return { content: [{ type: 'text', text: 'effect' }], details: undefined }; } }] });
    await current.prompt('Exercise malformed arguments.');
    assert.equal(executed, 0);
    assert.equal(remote.requests.length, 2);
    const call = current.messages.find(m => m.role === 'assistant' && m.content.some(b => b.type === 'toolCall')).content.find(b => b.type === 'toolCall');
    assert.deepEqual(call.arguments, {});
    assert.match(call.argumentsError, /Received arguments/);
    const result = current.messages.find(m => m.role === 'toolResult');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /"value":7/);
    const { parseToolCallArguments } = await import('@earendil-works/pi-ai/utils/json-parse');
    const latex = parseToolCallArguments(String.raw`{"text":"\usepackage{fontspec}","other":3}`);
    assert.deepEqual(latex.arguments, { text: '\\usepackage{fontspec}', other: 3 });
});

test('resuming a native transcript retains tools while explicit exclusions and hidden registrations stay authoritative', async t => {
    const remote = await loopback(t, () => ({ content: 'Recorded current tool loadout.' }));
    const { Type } = await import('typebox');
    const optional = { name: 'fixture_optional', label: 'Optional', description: 'Synthetic deferred tool', exposure: 'deferred',
        parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }) };
    const manager = sdk.SessionManager.create(cwd, path.join(root, 'sessions'));
    const first = await session(t, remote.model, { sessionManager: manager, customTools: [optional] });
    await first.prompt('Initialize.');
    first.setActiveToolsByName(['read', 'fixture_optional']);
    await first.prompt('Persist changed tools.');
    const file = manager.getSessionFile(); first.dispose();
    for (const [extra, expected] of [[{}, ['fixture_optional', 'read']], [{ tools: ['+grep', '-read'] }, ['fixture_optional', 'grep']],
        [{ tools: ['read'] }, ['read']], [{ noTools: 'all' }, []], [{ noTools: 'builtin' }, []],
        [{ excludeTools: ['fixture_optional'] }, ['read']]]) {
        const resumed = await session(t, remote.model, { sessionManager: sdk.SessionManager.open(file), customTools: [optional], ...extra });
        assert.deepEqual(resumed.agent.state.tools.map(x => x.name).sort(), expected);
        resumed.dispose();
    }
    const revoked = await session(t, remote.model, { sessionManager: sdk.SessionManager.open(file), customTools: [{ ...optional, exposure: 'hidden' }] });
    assert.equal(revoked.agent.state.tools.some(x => x.name === optional.name), false);
});

test('cross-model thinking is removed only from outgoing context and native metadata survives a saved branch', async () => {
    const { transformMessages } = await import('@earendil-works/pi-ai/api/transform-messages');
    const message = { ...assistant([{ type: 'thinking', thinking: 'PRIVATE OLD REASONING', thinkingSignature: 'synthetic-signature' },
        { type: 'text', text: 'Visible answer.' }]), providerThinkingLevel: 'high' };
    const unchanged = structuredClone(message);
    assert.equal(transformMessages([message], { ...model, id: 'different' })[0].content.some(b => b.type === 'thinking'), false);
    assert.equal(transformMessages([message], model)[0].content.some(b => b.type === 'thinking'), true);
    assert.deepEqual(message, unchanged);
    const manager = sdk.SessionManager.create(cwd, path.join(root, 'metadata-sessions'));
    manager.appendMessage({ role: 'user', content: 'Metadata fixture', timestamp: 1 });
    manager.appendMessage(message);
    const loaded = sdk.SessionManager.open(manager.getSessionFile());
    assert.deepEqual(loaded.buildSessionContext().messages.find(m => m.role === 'assistant'), message);
    const entry = loaded.getBranch().find(e => e.type === 'message' && e.message.role === 'assistant');
    loaded.branch(entry.id);
    assert.equal(loaded.buildSessionContext().messages.find(m => m.role === 'assistant').providerThinkingLevel, 'high');
});

test('managed RPC reports native ambiguous scope diagnostics while keeping an explicit provider selection', async t => {
    const dir = path.join(root, 'scope-agent'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture_a', defaultModel: 'same',
        enabledModels: ['same'], defaultThinkingLevel: 'off', enableInstallTelemetry: false }));
    const provider = { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic', models: [{ ...model, id: 'same' }] };
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture_a: provider, fixture_b: provider } }));
    const { PiRpcClient } = require('../server/pi-rpc-client');
    const client = new PiRpcClient({ cwd, noSession: true, projectApproval: false,
        extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '-e', path.resolve(__dirname, '../server/pi-web-session-extension.ts')],
        env: { PI_CODING_AGENT_DIR: dir, PI_WEB_NAVIGATION_TOKEN: 'synthetic' } });
    t.after(() => client.dispose());
    await client.start();
    assert.equal((await client.request('get_state')).model.provider, 'fixture_a');
    assert.match(client.stderrTail, /Pattern "same" matches several providers: fixture_a, fixture_b/);
    assert.doesNotMatch(client.stderrTail, /Bearer|apiKey/);
});
