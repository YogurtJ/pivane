const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-mcp-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const serverFile = path.join(root, 'mcp-server.cjs');
const callsFile = path.join(root, 'calls');
fs.writeFileSync(serverFile, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:['echo','forbidden'].map(name=>({name,inputSchema:{type:'object',properties:{value:{type:'string'}}},description:'Synthetic '+name}))};
else if(m.method==='tools/call'){fs.appendFileSync(${JSON.stringify(callsFile)},m.params.name+'\\n');result={content:[{type:'text',text:'NATIVE_MCP_OK:'+m.params.arguments.value}]};}
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never',
    defaultProvider: 'fixture', defaultModel: 'fixture', pivaneBuiltins: { subagents: { extensions: [] } } }));
const config = { mcpServers: { fixture: { command: process.execPath, args: [serverFile], exposure: 'codemode' } } };
fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify(config));
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic',
    models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
} } }));

async function fixtureSession(t, tools, factories) {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const native = await import('../server/pi-native-mcp.mjs');
    const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const extensionFactories = factories || await native.nativeExtensionFactories();
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true, noPromptTemplates: true,
        noContextFiles: true, extensionFactories });
    await loader.reload();
    const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
    const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
        settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(cwd), resourceLoader: loader, ...(tools ? { tools } : {}) });
    const errors = [];
    // A bound error handler also keeps SDK reload's lifecycle bindings active.
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    t.after(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); assert.deepEqual(errors, []); });
    return session;
}
async function waitTools(session) {
    for (let i = 0; i < 100; i++) {
        if (session.getAllTools().some(tool => tool.name === 'mcp__fixture__echo')) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Native MCP connection did not register tools');
}
test('managed resource selection replaces obsolete adapter packages before factories run', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const old = path.join(root, 'pi-mcp-adapter'); fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ name: 'pi-mcp-adapter', version: '2.33.0', type: 'module', pi: { extensions: ['index.js'] } }));
    fs.writeFileSync(path.join(old, 'index.js'), 'throw new Error("OLD_ADAPTER_EXECUTED");');
    const settings = sdk.SettingsManager.inMemory({ packages: ['npm:pi-mcp-adapter@2.33.0', old], extensions: [path.join(old, 'index.js')] });
    const { managedLoaderOptions } = await import('../server/pi-bundled-loader.mjs');
    const { options, settingsView } = await managedLoaderOptions({ cwd, agentDir, settings, parsed: {} });
    assert.equal(settingsView.getGlobalSettings().packages.some(item => String(item.source || item).includes('mcp-adapter')), false);
    assert.equal(options.additionalExtensionPaths.includes('builtin:mcp'), true);
    assert.equal(options.additionalExtensionPaths.includes(path.join(old, 'index.js')), false);
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settingsView, ...options });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.filter(item => item.path === 'builtin:mcp').length, 1);
    assert.equal(settings.getGlobalSettings().packages.length, 2, 'disk/CLI declarations are untouched');
});
test('native MCP codemode runs through nested tool hooks, records children, and closes transport', async t => {
    const session = await fixtureSession(t); await waitTools(session);
    assert.ok(session.getActiveToolNames().includes('codemode'));
    assert.equal(session.getActiveToolNames().includes('mcp__fixture__echo'), false);
    const events = []; session.subscribe(event => events.push(event));
    // Synthetic completed assistant message; no real provider is called.
    session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'parent-call', name: 'codemode', arguments: {} }],
        provider: 'fixture', api: 'openai-completions', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now() });
    const result = await session.agent.state.tools.find(tool => tool.name === 'codemode').execute('parent-call', {
        code: 'const r = await tools.mcp__fixture__echo({value:"fixture"}); text(r);',
    });
    assert.match(JSON.stringify(result.content), /NATIVE_MCP_OK/);
    assert.ok(events.some(event => event.type === 'tool_execution_start' && event.parentToolCallId === 'parent-call'));
    const resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['fixture/echo'], cwd).selections, [{ name: 'mcp__fixture__echo', selector: 'fixture/echo' }]);
    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'))); saved.mcpServers.fixture.args.push('changed');
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify(saved));
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['fixture/echo'], cwd).unresolvedSelectors, ['fixture/echo']);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify(config));
});
test('explicit child tools deny unauthorized nested MCP calls even with codemode enabled', async t => {
    const native = await import('../server/pi-native-mcp.mjs');
    const resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = JSON.stringify({ version: 1, tools: ['echo','forbidden'].map(raw => ({ server: 'fixture', raw,
        name: `mcp__fixture__${raw}`, cwd, hash: resolver.configHash(config.mcpServers.fixture) })) });
    const tools = ['read', 'codemode', 'mcp__fixture__echo'];
    const factories = native.childNativeExtensions({ cwd, agentDir, allowedTools: tools });
    const session = await fixtureSession(t, tools, factories); await waitTools(session);
    assert.equal(session.getAllTools().some(tool => tool.name === 'mcp__fixture__forbidden' && tool.exposure !== 'hidden'), false);
    session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'accepted-parent', name: 'codemode', arguments: {} }],
        provider: 'fixture', api: 'openai-completions', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now() });
    const code = session.agent.state.tools.find(tool => tool.name === 'codemode');
    const before = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8') : '';
    const denied = await code.execute('denied-parent', { code: 'text(await tools.mcp__fixture__forbidden({value:"no"}));' });
    assert.doesNotMatch(JSON.stringify(denied), /NATIVE_MCP_OK:no/);
    assert.equal(fs.readFileSync(callsFile, 'utf8'), before);
    const accepted = await code.execute('accepted-parent', { code: 'text(await tools.mcp__fixture__echo({value:"child"}));' });
    assert.match(JSON.stringify(accepted), /NATIVE_MCP_OK:child/);
});

async function loopbackMcp(t, names) {
    const http = require('node:http');
    const methods = [], calls = [];
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let text = ''; for await (const chunk of req) text += chunk;
        const message = JSON.parse(text); methods.push(message.method);
        if (message.id === undefined) { res.writeHead(202); res.end(); return; }
        let result = {};
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'loopback', version: '1' } };
        if (message.method === 'tools/list') result = { tools: names.map(name => ({ name, description: `Synthetic discovery ${name}`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } })) };
        if (message.method === 'tools/call') { calls.push(message.params.name); result = { content: [{ type: 'text', text: `LOOPBACK_OK:${message.params.name}` }] }; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify(config)); });
    return { methods, calls, config: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'synthetic-only' }, exposure: 'deferred' } };
}
async function waitNativeTools(session, names) {
    for (let i = 0; i < 100; i++) {
        if (names.every(name => session.getAllTools().some(tool => tool.name === name))) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Loopback native tools did not register');
}
function syntheticCall(session, id, name) {
    session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: {} }],
        provider: 'fixture', api: 'openai-completions', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now() });
}

test('Pi 1.0 normalized namespaces preserve raw labels and collision hashes in parent and child grants', async t => {
    const native = await import('../server/pi-native-mcp.mjs'), resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    const raw = ['a-b', 'a_b', 'folder/tool', 'x'.repeat(100)];
    const remote = await loopbackMcp(t, raw);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'dev-radius': remote.config, dev_radius: remote.config } }));
    const loaded = native.loadNativeMcpConfig({ cwd, agentDir, projectTrusted: false });
    assert.deepEqual(loaded.servers.map(entry => entry.name), ['dev-radius']);
    assert.ok(loaded.errors.some(error => error.includes('conflicts')));
    const session = await fixtureSession(t);
    const names = raw.map((tool, index) => native.nativeMcpToolName('dev-radius', tool, () => index < 2));
    await waitNativeTools(session, names);
    assert.equal(session.getAllTools().some(tool => tool.name === 'mcp__dev_radius__a_b'), false, 'both colliding raw tools receive hashes');
    const snapshot = resolver.readNativeSnapshot();
    assert.deepEqual(snapshot.map(item => [item.server, item.raw, item.name]), raw.map((tool, index) => ['dev-radius', tool, names[index]]));
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['dev-radius/a-b', 'dev-radius/folder/tool'], cwd).selections,
        [0, 2].map(index => ({ name: names[index], selector: `dev-radius/${raw[index]}` })));
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['dev_radius/a-b'], cwd).unresolvedSelectors, ['dev_radius/a-b'], 'namespace aliases do not grant original-server authority');
    assert.equal(remote.calls.length, 0, 'discovery makes no tool or model calls');
    const tools = ['codemode', names[0]];
    const child = await fixtureSession(t, tools, native.childNativeExtensions({ cwd, agentDir, allowedTools: tools }));
    await waitNativeTools(child, [names[0]]);
    assert.equal(child.getAllTools().find(tool => tool.name === names[0]).exposure, 'direct');
    assert.equal(child.getAllTools().some(tool => tool.name === names[1] && tool.exposure !== 'hidden'), false);
    const codemode = child.agent.state.tools.find(tool => tool.name === 'codemode');
    syntheticCall(child, 'collision-denied', 'codemode');
    const denied = await codemode.execute('collision-denied', { code: `text(await tools.${names[1]}({value:"no"}));` });
    assert.doesNotMatch(JSON.stringify(denied), /LOOPBACK_OK/); assert.deepEqual(remote.calls, []);
    syntheticCall(child, 'collision-allowed', 'codemode');
    const accepted = await codemode.execute('collision-allowed', { code: `text(await tools.${names[0]}({value:"yes"}));` });
    assert.match(JSON.stringify(accepted), /LOOPBACK_OK:a-b/); assert.deepEqual(remote.calls, ['a-b']);
    assert.ok((await child.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'nested-write', toolName: 'write', input: { path: 'never.txt', content: 'never' }, parentToolCallId: 'collision-allowed' })).block);
});

test('Pi 1.0 deferred discovery restores tool_search loadout on reload and drops stale snapshot mappings', async t => {
    const native = await import('../server/pi-native-mcp.mjs'), resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    const raw = ['discover-me'], remote = await loopbackMcp(t, raw);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'lazy-server': remote.config } }));
    const session = await fixtureSession(t), name = native.nativeMcpToolName('lazy-server', raw[0]);
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['lazy-server/discover-me'], cwd).selections, [], 'lazy configuration alone grants nothing');
    assert.ok(session.getActiveToolNames().includes('tool_search'), 'discovery tool is activated before background connection completes');
    const search = session.agent.state.tools.find(tool => tool.name === 'tool_search');
    const blocked = await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'search', toolName: 'tool_search', input: { query: 'discover' } });
    assert.equal(blocked?.block, undefined);
    const found = await search.execute('search', { query: 'discover', limit: 1 });
    assert.deepEqual(found.details.loaded, [name]); assert.ok(session.getActiveToolNames().includes(name));
    // Pi records tool declarations when the next request starts. Reload must
    // retain the searched loadout even before any model request is sent.
    await session.reload(); await waitNativeTools(session, [name]);
    assert.ok(session.getActiveToolNames().includes(name), 'deferred registration restores searched tools after reload');
    assert.equal(remote.methods.filter(method => method === 'initialize').length, 2);
    assert.equal(remote.calls.length, 0);
    raw.splice(0, raw.length, 'replacement');
    await session.reload(); await waitNativeTools(session, [native.nativeMcpToolName('lazy-server', 'replacement')]);
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['lazy-server/discover-me'], cwd).unresolvedSelectors, ['lazy-server/discover-me']);
    assert.deepEqual(resolver.readNativeSnapshot().map(item => item.raw), ['replacement']);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'lazy-server': { ...remote.config, enabled: false } } }));
    await session.reload(); assert.deepEqual(resolver.readNativeSnapshot(), []);
});

test('explicit empty child tools and denyExtensions never connect or acquire native MCP authority', async t => {
    const native = await import('../server/pi-native-mcp.mjs');
    const remote = await loopbackMcp(t, ['echo']);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: remote.config } }));
    for (const options of [{ allowedTools: [] }, { allowedTools: ['codemode', 'mcp__fixture__echo'], denyExtensions: true }]) {
        const session = await fixtureSession(t, [], native.childNativeExtensions({ cwd, agentDir, ...options }));
        assert.deepEqual(session.getActiveToolNames(), []);
        assert.equal(session.getAllTools().some(tool => tool.name === 'codemode' || tool.name.startsWith('mcp__')), false);
        assert.ok((await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'empty-write', toolName: 'write', input: {} })).block);
    }
    assert.deepEqual(remote.methods, []);
});

test('project partial overrides invalidate child authority on exposure, enabled and trust changes', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const native = await import('../server/pi-native-mcp.mjs'), resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    const trust = new sdk.ProjectTrustStore(agentDir), projectFile = path.join(cwd, '.pi/mcp.json');
    const prior = process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT;
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    const write = patch => fs.writeFileSync(projectFile, JSON.stringify({ mcpServers: { fixture: patch } }));
    try {
        trust.set(cwd, true); write({ exposure: 'direct', toolExposure: { echo: 'direct' } });
        const effective = native.loadNativeMcpConfig({ cwd, agentDir, projectTrusted: true }).servers[0].config;
        assert.deepEqual(effective, { ...config.mcpServers.fixture, exposure: 'direct', toolExposure: { echo: 'direct' } });
        process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = JSON.stringify({ version: 1, tools: [{ server: 'fixture', raw: 'echo', name: 'mcp__fixture__echo', cwd, hash: resolver.configHash(effective) }] });
        assert.deepEqual(resolver.resolveMcpDirectToolResolution(['fixture/echo'], cwd).selections, [{ name: 'mcp__fixture__echo', selector: 'fixture/echo' }]);
        for (const patch of [{ enabled: false }, { exposure: 'hidden' }, { exposure: 'direct', toolExposure: { echo: 'hidden' } }]) {
            write(patch);
            assert.deepEqual(resolver.resolveMcpDirectToolResolution(['fixture/echo'], cwd).unresolvedSelectors, ['fixture/echo']);
        }
        write({ exposure: 'direct', toolExposure: { echo: 'direct' } });
        trust.set(cwd, false);
        assert.deepEqual(resolver.resolveMcpDirectToolResolution(['fixture/echo'], cwd).unresolvedSelectors, ['fixture/echo']);
    } finally {
        trust.set(cwd, null); fs.rmSync(projectFile, { force: true });
        if (prior === undefined) delete process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT; else process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = prior;
    }
});

test('inherited native snapshots reject forged names and ambiguous tool identity', async () => {
    const native = await import('../server/pi-native-mcp.mjs'), resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    const prior = process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT;
    const item = { server: 'dev-radius', raw: 'a-b', name: native.nativeMcpToolName('dev-radius', 'a-b'), cwd, hash: resolver.configHash(config.mcpServers.fixture) };
    try {
        process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = JSON.stringify({ version: 1, tools: [{ ...item, name: 'mcp__other__a_b' }] });
        assert.deepEqual(resolver.readNativeSnapshot(), []);
        process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = JSON.stringify({ version: 1, tools: [item, { ...item, raw: 'a_b' }] });
        assert.deepEqual(resolver.readNativeSnapshot(), []);
    } finally { if (prior === undefined) delete process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT; else process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = prior; }
});
