const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { PiLiveState } = require('../server/pi-live-state');
const { PiRpcClient } = require('../server/pi-rpc-client');
const { searchSessions } = require('../server/pi-session-search-worker');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-completion-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, {recursive:true});
test.after(() => fs.rmSync(root, {recursive:true,force:true}));
const waitFor = async predicate => { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 15000) throw new Error('fixture timeout'); await new Promise(r => setTimeout(r, 20)); } };

test('live reducer preserves partial blocks and tool progress, bounds memory, and releases authoritative completions', () => {
 const live = new PiLiveState();
 live.handle({type:'agent_start'}); live.handle({type:'message_start',message:{role:'assistant',timestamp:1}});
 live.handle({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'hello 中文'}});
 live.handle({type:'tool_execution_start',toolCallId:'a',toolName:'read',args:{path:'a'}});
 const snapshot = live.snapshot(); assert.equal(snapshot.message.content[0].text,'hello 中文'); assert.equal(snapshot.tools[0].toolName,'read');
 live.handle({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'x'.repeat(1024*1024)}});
 assert.ok(live.snapshot().message.content[0].text.length <= 512*1024); assert.equal(live.snapshot().truncated,true); assert.equal(snapshot.message.content[0].text,'hello 中文');
 live.handle({type:'tool_execution_update',toolCallId:'a',toolName:'read',partialResult:{content:'x'.repeat(100000)}});
 assert.ok(JSON.stringify(live.snapshot().tools[0]).length < 65536, 'legacy string output stays bounded without breaking the observer');
 live.handle({type:'message_update',assistantMessageEvent:{contentIndex:0}});
 live.handle({type:'message_end',message:{role:'assistant'}}); assert.equal(live.snapshot().message,null);
 live.handle({type:'tool_execution_end',toolCallId:'a',toolName:'read',result:{content:[]}}); assert.equal(live.snapshot().tools.length,1);
 live.handle({type:'message_end',message:{role:'toolResult',toolCallId:'a'}}); assert.equal(live.snapshot().tools.length,0);
 live.handle({type:'agent_settled'}); assert.equal(live.snapshot().running,false);
});

test('RPC snapshot mapper captures state before later records from the same stdout chunk', async () => {
 const client = new PiRpcClient({cwd:root,noSession:true}); let sequence = 0;
 client.child = {stdin:{destroyed:false,write(_text, callback){callback?.();}}}; client.on('event',()=>sequence++);
 const result = client.request('get_messages',{},1000,undefined,data=>({...data,sequence}));
 const id = [...client.pending.keys()][0];
 client._handleLine(JSON.stringify({type:'response',id,success:true,data:{messages:[]}}));
 client._handleLine(JSON.stringify({type:'message_update'}));
 assert.equal((await result).sequence,0); assert.equal(sequence,1); client.child=null;
});

test('native worker restores live output, drafts, config changes and safely replaces one idle worker', {timeout:60000}, async t => {
 const cwd = path.join(root,'project'); fs.mkdirSync(cwd);
 let finish;
 const provider = http.createServer(async (req,res) => {
  for await (const _ of req) {}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk = (delta,reason=null) => res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:reason}]})}\n\n`);
  chunk({role:'assistant',content:'PREFIX 中文 '});
  finish = () => { chunk({content:'SUFFIX'}); chunk({},'stop'); res.end('data: [DONE]\n\n'); };
 }); provider.listen(0,'127.0.0.1'); await once(provider,'listening');
 const agent = process.env.PI_CODING_AGENT_DIR;
 fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',apiKey:'synthetic',models:[{id:'fixture',input:['text'],contextWindow:32000,maxTokens:1000}]}}}));
 fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture',enableInstallTelemetry:false,compaction:{enabled:false}}));
 const { createPiAgentGateway } = require('../server/pi-agent-routes');
 const gateway = createPiAgentGateway(); const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
 const server = app.listen(0,'127.0.0.1'); await once(server,'listening'); gateway.attachWebSocket(server);
 const sockets = [];
 t.after(async()=>{for(const s of sockets)s.terminate(); finish?.(); await gateway.dispose(); server.closeAllConnections(); await new Promise(r=>server.close(r)); provider.closeAllConnections(); await new Promise(r=>provider.close(r));});
 const session = await gateway.store.createSession(cwd,'fixture');
 const connect = async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/pi/ws`,{origin:`http://127.0.0.1:${server.address().port}`}); sockets.push(socket);
  const events = [], pending = new Map(); let id=0;
  socket.on('message',raw=>{const r=JSON.parse(raw); if(r.type==='response'&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.success?p.resolve(r.data):p.reject(new Error(r.error));}else events.push(r);});
  await once(socket,'open');
  const call = (type,data={}) => new Promise((resolve,reject)=>{const key=String(++id); const timer=setTimeout(()=>{pending.delete(key);reject(new Error('timeout '+type));},15000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id:key,type,...data}));});
  const snapshot = await call('open_session',{cwd,sessionId:session.id}); return {socket,call,events,snapshot};
 };
 const a = await connect(); const worker = gateway.supervisor.getActiveWorker(session.path);
 await a.call('prompt',{message:'Fixture only'}); await waitFor(()=>a.events.some(e=>e.type==='message_update'));
 const b = await connect(); assert.match(b.snapshot.messages.webLive.message.content[0].text,/PREFIX 中文/); assert.equal(b.snapshot.state.isStreaming,true);
 assert.equal(gateway.supervisor.workers.size,1);
 await assert.rejects(a.call('restart_runtime',{runtimeId:worker.controls.runtimeId,expectedRevision:worker.configRevision,confirmed:true}),/空闲|运行/);
 finish(); await waitFor(()=>a.events.some(e=>e.type==='agent_settled'));
 assert.match(JSON.stringify((await b.call('get_messages')).messages),/PREFIX 中文 SUFFIX/);
 worker._handleEvent({type:'extension_ui_request',method:'set_editor_text',id:'draft1',text:'suggestion'});
 const c = await connect(); assert.equal(c.snapshot.controls.drafts[0].text,'suggestion');
 const initial = await c.call('get_runtime_configuration'); assert.equal(initial.matchesSavedConfig,true);
 await assert.rejects(c.call('restart_runtime',{runtimeId:initial.runtimeId,expectedRevision:initial.revision,confirmed:true}),/草稿/);
 await c.call('ack_extension_draft',{runtimeId:initial.runtimeId,draftId:'draft1'});
 const settings = JSON.parse(fs.readFileSync(path.join(agent,'settings.json'))); settings.steeringMode='all'; fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify(settings));
 const changed = await c.call('get_runtime_configuration'); assert.equal(changed.matchesSavedConfig,false);
 await c.call('restart_runtime',{runtimeId:changed.runtimeId,expectedRevision:changed.revision,confirmed:true});
 await waitFor(()=>gateway.supervisor.getActiveWorker(session.path)?.controls.runtimeId !== changed.runtimeId && gateway.supervisor.workers.size === 1);
 const d = await connect(); assert.equal((await d.call('get_runtime_configuration')).matchesSavedConfig,true); assert.equal(d.snapshot.state.steeringMode,'all');
 assert.equal(d.snapshot.session.id,session.id); assert.match(JSON.stringify(d.snapshot.messages.messages),/PREFIX 中文 SUFFIX/);
 const search = searchSessions({root:path.join(agent,'sessions'),roots:[root],q:'SUFFIX'}); assert.equal(search.results.length,1); assert.equal(search.results[0].sessionId,session.id);
 const base = `http://127.0.0.1:${server.address().port}/api/pi/sessions/search`;
 const response = await fetch(base+'?q=SUFFIX'); assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/);
 const found = await response.json(); assert.equal(found.results[0].sessionId,session.id);
 assert.equal((await fetch(base+'?q=SUFFIX&offset=20&searchId=wrong')).status,409);
 assert.equal((await fetch(base+'?q=x')).status,400);
 assert.equal((await fetch(base+'?q=SUFFIX',{headers:{Origin:'http://foreign.example'}})).status,403);
 assert.equal(gateway.supervisor.workers.size,1);
 assert.equal(Object.hasOwn(d.snapshot.messages.webLive,'controls'),false,'large recovery lists must not be duplicated inside webLive');
});

test('cross-session search excludes hidden, thinking, tools, symlinks, and out-of-root projects', async () => {
 const sdk = await import('@earendil-works/pi-coding-agent'); const cwd = path.join(root,'search');fs.mkdirSync(cwd);
 const manager = sdk.SessionManager.create(cwd); fs.writeFileSync(manager.getSessionFile(),''); const sm = sdk.SessionManager.open(manager.getSessionFile(),undefined,cwd);
 sm.appendMessage({role:'user',content:'ordinary',timestamp:1});
 sm.appendMessage({role:'assistant',content:[{type:'thinking',thinking:'SECRET_NEEDLE'},{type:'toolCall',id:'call',name:'bash',arguments:{command:'SECRET_NEEDLE'}},{type:'text',text:'VISIBLE_NEEDLE'}],timestamp:2,stopReason:'stop',provider:'fixture',model:'fixture',api:'openai-completions',usage:{}});
 const input = {root:path.join(process.env.PI_CODING_AGENT_DIR,'sessions'),roots:[root],q:'SECRET_NEEDLE'};
 assert.equal(searchSessions(input).results.length,0);
 assert.equal(searchSessions({...input,q:'VISIBLE_NEEDLE'}).results.length,1);
 assert.equal(searchSessions({...input,q:'VISIBLE_NEEDLE',hidden:[cwd]}).results.length,0);
 assert.equal(searchSessions({...input,q:'VISIBLE_NEEDLE',roots:[path.parse(cwd).root]}).results.length,1);
 assert.equal(searchSessions({...input,q:'VISIBLE_NEEDLE',roots:[path.join(root,'different')]}).results.length,0);
 fs.symlinkSync(sm.getSessionFile(),path.join(path.dirname(sm.getSessionFile()),'alias.jsonl'));
 assert.equal(searchSessions({...input,q:'VISIBLE_NEEDLE'}).results.length,1);
 const limited = searchSessions({...input,q:'VISIBLE_NEEDLE'}, {...require('../server/pi-session-search-worker').LIMITS,bytes:1}); assert.equal(limited.coverage.limited,true);
});

test('startup-only blocking extension UI fails with an actionable code, without automatic acceptance', {timeout:30000}, async () => {
 const extension = path.join(root,'startup.ts'); fs.writeFileSync(extension,`export default function(pi){pi.on('session_start',async(_e,ctx)=>{await ctx.ui.confirm('fixture','fixture');});}`);
 const client = new PiRpcClient({cwd:root,noSession:true,extraArgs:['--no-extensions','-e',extension,'--no-context-files']});
 try {await assert.rejects(client.start(),e=>e.code==='STARTUP_UI_UNSUPPORTED');} finally {await client.dispose();}
});
