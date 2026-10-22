const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-child-factory-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function waitFor(predicate, message) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(predicate(), message);
}
function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t, { delayed = false, fail = false } = {}) {
    const dir = fs.mkdtempSync(path.join(root, 'mcp-'));
    const pidsFile = path.join(dir, 'pids'), callsFile = path.join(dir, 'calls'), release = path.join(dir, 'release');
    const serverFile = path.join(dir, 'server.cjs');
    const raw = ['a-b', 'a_b', 'hidden'];
    fs.writeFileSync(serverFile, `const fs=require('node:fs');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize'){fs.appendFileSync(${JSON.stringify(pidsFile)},process.pid+'\\n');send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});}
 else if(m.method==='tools/list'){
   const reply=()=>{if(${fail})process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'SYNTHETIC_DISCOVERY_FAILURE'}})+'\\n');
   else send(m.id,{tools:${JSON.stringify(raw)}.map(name=>({name,description:'Synthetic '+name,inputSchema:{type:'object',properties:{value:{type:'string'}}}}))});};
   if(${delayed}){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);reply();}},10);}else reply();
 }
 else if(m.method==='tools/call'){fs.appendFileSync(${JSON.stringify(callsFile)},m.params.name+'\\n');send(m.id,{content:[{type:'text',text:'CHILD_MCP_OK:'+m.params.name}]});}
 else send(m.id,{});
});`);
    const requests = [];
    let code, imageCalls = 0;
    const provider = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text); requests.push(body);
        const done = !code || body.messages.some(message => message.role === 'tool');
        const delta = done ? { content: 'FACTORY_CHILD_OK' } : { tool_calls: [{ index: 0, id: 'factory-code', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never', defaultProvider: 'fixture', defaultModel: 'fixture', pivaneBuiltins: { subagents: { extensions: [] } } }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(agentDir, 'APPEND_SYSTEM.md'), 'PARENT_APPEND_MUST_NOT_REACH_CHILD');
    const config = { command: process.execPath, args: [serverFile], exposure: 'codemode', toolExposure: { hidden: 'hidden' } };
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: config } }));
    const native = await import('../server/pi-native-mcp.mjs');
    const resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    const names = raw.map(tool => native.nativeMcpToolName('fixture', tool, () => tool !== 'hidden'));
    process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = JSON.stringify({ version: 1, tools: raw.slice(0, 2).map((tool, index) => ({ server: 'fixture', raw: tool, name: names[index], cwd, hash: resolver.configHash(config) })) });
    const { default: createFactory } = await import('../server/pi-subagent-child-factory.mjs');
    const factory = createFactory();
    const pids = () => fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number) : [];
    t.after(async () => {
        await factory.dispose();
        provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
        await waitFor(() => pids().every(pid => !alive(pid)), 'all native child transports exited');
        delete process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT;
    });
    const launch = (index = 0, overrides = {}) => ({ cwd, projectTrusted: false, storage: { kind: 'memory' }, model: 'fixture/fixture', tools: ['read', names[index]],
        builtinMcpTools: [{ name: names[index], selector: `fixture/${raw[index]}` }], extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: {}, ...overrides });
    return { factory, names, raw, launch, requests, pids, release: () => fs.writeFileSync(release, ''),
        imageProvider: { name: 'image-sentinel', factory: pi => pi.registerProvider('image-fixture', {
            baseUrl: `http://127.0.0.1:${provider.address().port}/images`, apiKey: 'synthetic',
            models: [{ id: 'image', type: 'image', api: 'synthetic-images', name: 'Synthetic image sentinel', input: ['text'], output: ['image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
            images: { 'synthetic-images': { generateImages() { imageCalls++; throw new Error('IMAGE_PROVIDER_MUST_NOT_RUN'); } } },
        }) }, imageCalls: () => imageCalls,
        setCode: value => { code = value; }, calls: () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : [] };
}

test('real child factory waits for selected native MCP tools and retains nested and media permissions', { timeout: 30000 }, async t => {
    const f = await fixture(t, { delayed: true });
    let api, context, settled = false, unfilteredFactories = 0;
    const forbiddenFactories = ['mcp', 'codemode'].map(name => ({ name, factory: () => { unfilteredFactories++; } }));
    const pending = f.factory.create(f.launch(0, { tools: ['read', 'codemode', f.names[0]], hooks: [f.imageProvider, ...forbiddenFactories, { name: 'observe', factory: pi => {
        pi.on('session_start', (_event, ctx) => { api = pi; context = ctx; });
    } }] }));
    pending.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => f.pids().length === 1, 'native MCP connected once');
    assert.equal(settled, false, 'create stays pending while tool discovery is delayed');
    assert.deepEqual(f.requests, [], 'readiness does not send a model request');
    f.release();
    const child = await pending;
    try {
        assert.ok(api.getActiveTools().includes(f.names[0]));
        assert.equal(api.getAllTools().find(tool => tool.name === f.names[0]).exposure, 'direct');
        for (const name of [f.names[1], f.names[2]]) {
            assert.equal(api.getAllTools().some(tool => tool.name === name), false, 'hidden tools stay out of the extension catalog');
            assert.equal(api.getActiveTools().includes(name), false);
        }
        f.setCode(`text(await tools.${f.names[0]}({value:'yes'}));
            try { await tools.${f.names[1]}({value:'never'}); } catch (error) { text('UNSELECTED_DENIED:'+error.message); }
            try { await models.generateImages({provider:'image-fixture',id:'image'},{input:[{type:'text',text:'never'}]}); } catch (error) { text(error.message); }`);
        await child.prompt('Run the synthetic permission checks.');
        const result = child.messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
        assert.match(JSON.stringify(result), /CHILD_MCP_OK:a-b/);
        assert.match(JSON.stringify(result), /UNSELECTED_DENIED/);
        assert.match(JSON.stringify(result), /models\.generateImages\(\) is blocked in Pivane codemode/);
        assert.deepEqual(f.calls(), ['a-b']);
        assert.equal(f.requests.length, 2, 'only the synthetic chat provider is called');
        assert.equal(f.imageCalls(), 0, 'Codemode cannot reach even a synthetic image provider');
        assert.equal(context.isProjectTrusted(), false);
        assert.doesNotMatch(JSON.stringify(f.requests), /PARENT_APPEND_MUST_NOT_REACH_CHILD/);
        assert.equal(f.pids().length, 1, 'upstream readiness reuses the filtered MCP transport');
        assert.equal(unfilteredFactories, 0, 'same-named launch hooks cannot replace the native permission factories');
    } finally { await child.dispose(); }
    await waitFor(() => f.pids().every(pid => !alive(pid)), 'child disposal closes its MCP transport');
});

test('child factory preserves hidden Codemode metadata for readiness without making it callable', { timeout: 30000 }, async t => {
    const f = await fixture(t);
    let api;
    const child = await f.factory.create(f.launch(0, { hooks: [{ name: 'observe', factory: pi => { api = pi; } }] }));
    try {
        assert.ok(api.getActiveTools().includes(f.names[0]));
        assert.equal(api.getAllTools().find(tool => tool.name === f.names[0]).exposure, 'direct');
        assert.equal(api.getAllTools().some(tool => tool.name === 'codemode'), false, 'hidden readiness metadata does not enter the catalog');
        assert.equal(api.getActiveTools().includes('codemode'), false);
        await child.prompt('Reply with the synthetic result.');
        assert.equal(f.requests[0].tools.some(tool => tool.function.name === 'codemode'), false);
    } finally { await child.dispose(); }
});

test('excluded, hidden, mismatched raw selectors and denied extensions cannot grant native child tools', { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const attempts = [
        f.launch(0, { excludeTools: [f.names[0]] }),
        f.launch(2),
        f.launch(0, { runtime: { capabilityCeiling: { denyExtensions: true } } }),
        f.launch(0, { builtinMcpTools: [{ name: f.names[0], selector: 'fixture/a_b' }] }),
    ];
    for (const launch of attempts) {
        await assert.rejects(f.factory.create(launch), /MCP.*(did not|outside)|Selected built-in MCP tools did not register/);
        await waitFor(() => f.pids().every(pid => !alive(pid)), 'rejected launch closes every transport');
    }
    assert.equal(f.pids().length, 1, 'only the raw-selector mismatch needs discovery; hidden, excluded and denyExtensions never connect');
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.calls(), []);
});

test('disposing a factory cancels native MCP readiness and queued launches without late model calls', { timeout: 30000 }, async t => {
    const f = await fixture(t, { delayed: true });
    const pending = assert.rejects(f.factory.create(f.launch()), /disposed while the child waited/);
    const queued = assert.rejects(f.factory.create(f.launch(1)), /disposed before this launch started/);
    await waitFor(() => f.pids().length === 1, 'first child is waiting on its transport');
    await f.factory.dispose();
    await Promise.all([pending, queued]);
    f.release();
    await waitFor(() => f.pids().every(pid => !alive(pid)), 'cancelled startup transport actually exited');
    assert.equal(f.pids().length, 1, 'queued launch never opens a second transport');
    assert.deepEqual(f.requests, []);
});

test('failed native MCP discovery rejects startup and closes transport before any model call', { timeout: 30000 }, async t => {
    const f = await fixture(t, { fail: true });
    await assert.rejects(f.factory.create(f.launch()), /Selected built-in MCP tools did not register/);
    await waitFor(() => f.pids().length === 1 && f.pids().every(pid => !alive(pid)), 'failed startup transport exited');
    assert.deepEqual(f.requests, []);
});

test('concurrent child creates keep exact policies and children without selectors keep the original defaults', { timeout: 30000 }, async t => {
    const f = await fixture(t);
    const seen = [];
    const launches = [0, 1].map(index => f.launch(index, { hooks: [{ name: 'observe', factory: pi => { seen[index] = pi; } }] }));
    const otherCwd = path.join(root, 'other-worktree'); fs.mkdirSync(otherCwd);
    launches.push(f.launch(0, { cwd: otherCwd, model: undefined, tools: ['read'], builtinMcpTools: undefined,
        hooks: [{ name: 'observe', factory: pi => { seen[2] = pi; pi.on('session_start', (_event, ctx) => { seen[3] = ctx.cwd; }); } }] }));
    const children = await Promise.all(launches.map(launch => f.factory.create(launch)));
    try {
        for (const index of [0, 1]) {
            assert.equal(seen[index].getAllTools().find(tool => tool.name === f.names[index]).exposure, 'direct');
            assert.equal(seen[index].getAllTools().some(tool => tool.name === f.names[1 - index]), false);
            assert.equal(seen[index].getActiveTools().includes(f.names[1 - index]), false);
        }
        assert.deepEqual(seen[2].getActiveTools(), ['read']);
        assert.equal(seen[2].getAllTools().some(tool => tool.name.startsWith('mcp__') || tool.name === 'codemode'), false);
        assert.equal(f.pids().length, 2);
        for (const child of children) await child.prompt('Reply with the synthetic result.');
        assert.equal(f.requests.length, 3);
        assert.equal(children[2].modelId, 'fixture/fixture', 'an omitted model uses the isolated identity default and auth');
        assert.equal(seen[3], otherCwd, 'the per-child worktree cwd reaches the native session');
        assert.equal(f.requests[2].tools.some(tool => tool.function.name.startsWith('mcp__')), false);
    } finally { await Promise.all(children.map(child => child.dispose())); }
});
