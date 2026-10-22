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
        const { fixtureFinishReason, ...delta } = respond(body, requests.length);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta, finish_reason: fixtureFinishReason || (delta.tool_calls ? 'tool_calls' : 'stop') }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { requests, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}
async function session(t, selected, extra = {}) {
    const { extensionFactories = [], settingsOverrides = {}, ...sessionOptions } = extra;
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['read', 'write'], enableInstallTelemetry: false,
        compaction: { enabled: false }, retry: { enabled: false }, ...settingsOverrides });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, extensionFactories });
    await loader.reload();
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
        modelsStorePath: path.join(agentDir, 'catalog.json'), allowModelNetwork: false });
    runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: selected.baseUrl, apiKey: 'synthetic', models: [selected] });
    await runtime.refresh({ allowNetwork: false });
    const created = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel('fixture', 'model'),
        resourceLoader: loader, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(cwd), ...sessionOptions });
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

test('new extension tools join resumed native loadouts while hidden, inactive, removed and explicit selections remain authoritative', async t => {
    const remote = await loopback(t, () => ({ content: 'Synthetic loadout.' }));
    const { Type } = await import('typebox');
    const definition = (name, extra = {}) => ({ name, label: name, description: 'Synthetic extension tool', parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }), ...extra });
    const extension = pi => {
        pi.registerTool(definition('fixture_new'));
        pi.registerTool(definition('fixture_inactive', { defaultActive: false }));
        pi.registerTool(definition('fixture_hidden', { exposure: 'hidden' }));
        pi.registerTool(definition('fixture_removed'));
        pi.on('session_start', () => { pi.registerTool(definition('fixture_late')); });
    };
    const manager = sdk.SessionManager.create(cwd, path.join(root, 'extension-sessions'));
    manager.appendMessage({ role: 'user', content: 'Before upgrade.', timestamp: 1 });
    manager.appendMessage(assistant([{ type: 'text', text: 'Saved branch.' }]));
    manager.appendMessage({ role: 'system', content: '', toolsAdded: [definition('read'), definition('fixture_removed')], timestamp: 3 });
    manager.appendMessage({ role: 'system', content: '', toolsRemoved: [definition('fixture_removed')], timestamp: 4 });
    const kept = manager.appendMessage({ role: 'user', content: 'Retained after checkpoint.', timestamp: 5 });
    manager.appendCompaction('Synthetic checkpoint', kept, 100);
    const file = manager.getSessionFile(), original = fs.readFileSync(file);
    const cases = [
        [{}, ['fixture_late', 'fixture_new', 'read']],
        [{ tools: ['read'] }, ['read']],
        [{ tools: ['+fixture_inactive', '-read'] }, ['fixture_inactive', 'fixture_late', 'fixture_new']],
        [{ excludeTools: ['fixture_new', 'fixture_late'] }, ['read']],
        [{ noTools: 'all' }, []],
        [{ noTools: 'builtin' }, ['fixture_late', 'fixture_new', 'fixture_removed']],
    ];
    for (const [options, expected] of cases) {
        const current = await session(t, remote.model, { sessionManager: sdk.SessionManager.open(file), extensionFactories: [extension], ...options });
        assert.deepEqual(current.getActiveToolNames().sort(), expected, JSON.stringify(options));
        current.dispose();
    }
    const fresh = await session(t, remote.model, { extensionFactories: [extension] });
    assert.deepEqual(fresh.getActiveToolNames().sort(), ['fixture_late', 'fixture_new', 'fixture_removed', 'read', 'write']);
    assert.deepEqual(fs.readFileSync(file).subarray(0, original.length), original, 'loading appends native selection metadata without rewriting the saved branch');
});

test('length recovery omits paired tool results from outgoing context and keeps raw JSONL intact across resume', async t => {
    const remote = await loopback(t, () => ({ content: 'Recovered synthetic reply.' }));
    for (const resumed of [false, true]) {
        const manager = sdk.SessionManager.create(cwd, path.join(root, 'length-sessions'));
        const callId = `truncated-${resumed}`;
        manager.appendMessage({ role: 'user', content: 'Check synthetic status.', timestamp: 1 });
        const truncated = { ...assistant([{ type: 'toolCall', id: callId, name: 'read', arguments: { path: 'synthetic' } }]), stopReason: 'length' };
        const callEntry = manager.appendMessage(truncated);
        const resultEntry = manager.appendMessage({ role: 'toolResult', toolCallId: callId, toolName: 'read', isError: true,
            content: [{ type: 'text', text: 'Not executed: output token limit reached.' }], timestamp: 3 });
        const file = manager.getSessionFile(), original = fs.readFileSync(file);
        const extension = pi => pi.on('session_before_compact', event => ({ compaction: {
            summary: 'Synthetic recovery checkpoint', firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore, details: {},
        } }));
        const current = await session(t, remote.model, { sessionManager: resumed ? sdk.SessionManager.open(file) : manager,
            extensionFactories: [extension], settingsOverrides: { compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 256 } } });
        const offset = remote.requests.length;
        await current.prompt('Continue after truncated response.');
        const requests = remote.requests.slice(offset);
        assert.ok(requests.length > 0);
        for (const request of requests) assert.doesNotMatch(JSON.stringify(request.messages), new RegExp(callId));
        current.dispose();
        const raw = fs.readFileSync(file);
        assert.deepEqual(raw.subarray(0, original.length), original, 'recovery appends edits without rewriting raw messages');
        const loaded = sdk.SessionManager.open(file);
        assert.deepEqual(loaded.getEntry(callEntry).message, truncated);
        assert.equal(loaded.getEntry(resultEntry).message.toolCallId, callId);
        const omitted = loaded.getEntries().filter(entry => entry.type === 'context_edit' && entry.replacement === null).map(entry => entry.targetId);
        assert.ok(omitted.includes(callEntry)); assert.ok(omitted.includes(resultEntry));
        assert.equal(loaded.buildSessionContext().messages.some(message => message.role === 'toolResult' && message.toolCallId === callId), false);
        const reopened = await session(t, remote.model, { sessionManager: loaded });
        await reopened.prompt('Check resumed projection.');
        assert.doesNotMatch(JSON.stringify(remote.requests.at(-1).messages), new RegExp(callId));
        reopened.dispose();
    }
});

test('a fresh length-truncated tool call executes no effect and sends a paired failure to the provider', async t => {
    const callId = 'fresh-truncated-call';
    const remote = await loopback(t, (_body, count) => count === 1 ? { fixtureFinishReason: 'length',
        tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] }
        : { content: 'Recovered from the fresh length stop.' });
    const { Type } = await import('typebox');
    const manager = sdk.SessionManager.create(cwd, path.join(root, 'fresh-length-sessions'));
    let executed = 0;
    const extension = pi => pi.on('session_before_compact', event => ({ compaction: {
        summary: 'Synthetic checkpoint', firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, details: {},
    } }));
    const current = await session(t, remote.model, { sessionManager: manager, extensionFactories: [extension],
        settingsOverrides: { compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 256 } },
        customTools: [{ name: 'fixture_effect', label: 'Effect', description: 'Counted synthetic effect', parameters: Type.Object({}),
            execute: async () => { executed++; return { content: [], details: {} }; } }] });
    await current.prompt('Exercise native length recovery.');
    assert.equal(executed, 0);
    assert.equal(remote.requests.length, 2);
    const outgoing = remote.requests[1].messages;
    assert.ok(outgoing.some(message => message.tool_calls?.some(call => call.id === callId)));
    assert.ok(outgoing.some(message => message.role === 'tool' && message.tool_call_id === callId));
    current.dispose();
    const loaded = sdk.SessionManager.open(manager.getSessionFile());
    const entries = loaded.getEntries();
    const call = entries.find(entry => entry.message?.role === 'assistant' && entry.message.stopReason === 'length');
    const result = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === callId);
    assert.ok(call); assert.ok(result); assert.equal(result.message.isError, true);
    assert.match(JSON.stringify(loaded.buildSessionContext().messages), new RegExp(callId));
    assert.equal(loaded.getEntries().some(entry => entry.type === 'context_edit'), false, 'successful native continuation keeps its valid call/result pair');
});
