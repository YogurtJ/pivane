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
    await session.bindExtensions({ mode: 'print' });
    t.after(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); });
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
