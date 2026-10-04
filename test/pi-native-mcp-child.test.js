const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

test('managed parent, foreground and detached children use native MCP selectors without adapter caches', { timeout: 120000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-child-')));
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
    for (const dir of [agentDir, cwd, path.join(cwd, '.pi'), path.join(agentDir, 'agents'), path.join(agentDir, 'extensions')]) fs.mkdirSync(dir, { recursive: true });
    // A test launched by a subagent must create an independent parent and use
    // this checkout's SDK, rather than inherit the orchestrator's child flags.
    const inherited = {};
    for (const key of Object.keys(process.env).filter(key => /^PI_SUBAGENT(?:_|S_)/.test(key))) {
        inherited[key] = process.env[key]; delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
    process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
    const called = path.join(root, 'mcp-called'), connections = path.join(root, 'mcp-connections');
    const mcp = path.join(root, 'mcp.cjs');
    fs.writeFileSync(mcp, `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize'){fs.appendFileSync(${JSON.stringify(connections)},'connected\\n');result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};}
if(m.method==='tools/list')result={tools:[{name:'echo',description:'Synthetic MCP',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
if(m.method==='tools/call'){fs.writeFileSync(${JSON.stringify(called)},m.params.arguments.value);result={content:[{type:'text',text:'NATIVE_CHILD_MCP_OK'}]};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
    let childRequests = 0;
    const provider = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        // Detached completion can wake the parent before status is observed. Its
        // Codemode-only catalog is not the child's explicitly granted direct catalog.
        const child = body.tools?.some(tool => tool.function?.name === 'mcp__fixture__echo');
        if (child) childRequests++;
        const done = !child || body.messages.some(message => message.role === 'tool');
        const delta = done ? { content: child ? 'CHILD_FINISHED' : 'PARENT_ACK' } : { tool_calls: [{ index: 0, id: 'child-mcp-call', type: 'function',
            function: { name: 'mcp__fixture__echo', arguments: '{"value":"NATIVE_CHILD_OK"}' } }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
            delta: { role: 'assistant', ...delta }, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false, defaultProjectTrust: 'always' }));
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcp], exposure: 'codemode' } } }));
    fs.writeFileSync(path.join(cwd, '.pi/mcp.json'), JSON.stringify({ mcpServers: { fixture: { exposure: 'codemode', toolExposure: { echo: 'codemode' } } } }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(agentDir, 'agents/fixture.md'), '---\nname: fixture\ndescription: Native MCP child\nmodel: fixture/fixture\ntools: read, mcp:fixture/echo\n---\nUse the echo tool.\n');
    fs.writeFileSync(path.join(agentDir, 'extensions/spawn.ts'), `export default function(pi) { pi.registerCommand('fixture-launch', { description:'fixture', handler:async (_args,ctx)=>{
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('launch timeout')),30000);const off=pi.events.on('subagents:rpc:v1:reply:native-child',r=>{clearTimeout(timer);off();ctx.ui.notify('NATIVE_LAUNCH:'+JSON.stringify(r));resolve();});
pi.events.emit('subagents:rpc:v1:request',{version:1,requestId:'native-child',method:'spawn',source:{extension:'fixture'},params:{agent:'fixture',task:'Call the echo tool',async:true}});}); }});
pi.registerCommand('fixture-native-foreground',{description:'fixture',handler:async(_args,ctx)=>{
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('foreground timeout')),30000);const off=pi.events.on('prompt-template:subagent:response',reply=>{if(reply.requestId!=='native-foreground')return;clearTimeout(timer);off();ctx.ui.notify('NATIVE_FOREGROUND:'+JSON.stringify(reply));resolve();});
pi.events.emit('prompt-template:subagent:request',{requestId:'native-foreground',ownerRunId:'fixture-owner',nodeId:'fixture-node',cwd:ctx.cwd,agent:'fixture',task:'Call the echo tool',context:'fresh',result:{kind:'text'}});});}}); }`);
    const { PiSessionStore } = require('../server/pi-session-store');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    t.after(async () => { await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); for (const [key, value] of Object.entries(inherited)) process.env[key] = value; });
    const saved = await store.createSession(cwd, 'Native MCP child fixture');
    const worker = await supervisor.getWorker({ cwd, sessionPath: saved.path, sessionId: saved.id });
    for (let i = 0; i < 100; i++) {
        if ((await worker.getNativeResources()).tools.some(tool => tool.name === 'mcp__fixture__echo')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok((await worker.getNativeResources()).tools.some(tool => tool.name === 'mcp__fixture__echo'));
    let launch;
    const off = worker.subscribe(event => { if (event.type === 'extension_ui_request' && event.message?.startsWith('NATIVE_LAUNCH:')) launch = JSON.parse(event.message.slice(14)); });
    await worker.request('prompt', { message: '/fixture-launch' });
    for (let i = 0; i < 300 && !launch; i++) await new Promise(resolve => setTimeout(resolve, 100));
    off(); assert.equal(launch?.success, true, JSON.stringify(launch));
    assert.notEqual(launch.data?.isError, true, JSON.stringify(launch));
    let status;
    for (let i = 0; i < 100; i++) {
        status = await worker.subagentRequest({ method: 'status', params: {} });
        if (status.snapshot?.runs.some(run => ['complete', 'failed', 'cancelled'].includes(run.state))) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(status.snapshot?.runs.some(run => run.state === 'complete'), JSON.stringify(status));
    assert.equal(fs.readFileSync(called, 'utf8'), 'NATIVE_CHILD_OK'); assert.equal(childRequests, 2, 'child makes one tool request and one final response; parent completion delivery is separate');
    for (let i = 0; i < 300 && (!worker.isIdle() || worker.retainsBackgroundWork()); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(worker.isIdle() && !worker.retainsBackgroundWork());
    let foreground;
    const offForeground = worker.subscribe(event => { if (event.type === 'extension_ui_request' && event.message?.startsWith('NATIVE_FOREGROUND:')) foreground = JSON.parse(event.message.slice(18)); });
    await worker.request('prompt', { message: '/fixture-native-foreground' });
    for (let i = 0; i < 300 && !foreground; i++) await new Promise(resolve => setTimeout(resolve, 100));
    offForeground(); assert.match(JSON.stringify(foreground), /CHILD_FINISHED/);
    assert.equal(childRequests, 4, 'both foreground and detached children use the granted MCP tool');
    assert.equal(fs.readFileSync(connections, 'utf8').trim().split('\n').length, 3, 'one MCP transport for the parent and each child using the merged project partial override');
    assert.equal(fs.existsSync(path.join(agentDir, 'mcp-cache.json')), false);
});
