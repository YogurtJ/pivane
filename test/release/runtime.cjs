// Native runtime smoke against the guarded synthetic release instance; no real provider.
const assert=require('node:assert/strict');
const {WebSocket}=require('ws');
const base=process.env.PI_RELEASE_TEST_URL;
const cwd=process.env.PI_RELEASE_PROJECT_DIR || '/home/node/pi-workspace/projects/demo';
assert.ok(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !base.endsWith(':3001'));
require('./guard.cjs').rehearsalRoot(cwd,true);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(100)}throw Error('runtime wait timeout')}
async function api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error(`${url}: ${r.status}`);return r;}
const connections=[];
async function connect(type,input){const ws=new WebSocket(base.replace('http:','ws:')+'/api/pi/ws',{origin:base});connections.push(ws);const pending=new Map(),events=[];let seq=0;
 ws.on('message',raw=>{const e=JSON.parse(raw);if(e.type==='response'&&pending.has(e.id)){const p=pending.get(e.id);pending.delete(e.id);clearTimeout(p.timer);e.success?p.resolve(e.data):p.reject(Error(e.error));}else events.push(e)});
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
 const call=(type,data={})=>new Promise((resolve,reject)=>{const id=String(++seq);const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+type))},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,type,...data}));});
 const snapshot=await call(type,input);return {ws,call,events,snapshot};
}
(async()=>{
 const status=await(await api('/api/pi/status')).json();assert.deepEqual(status.projectRoots,[require('node:path').dirname(cwd)]);
 const marker=await(await api('/api/pi/files/content?'+new URLSearchParams({cwd,path:'release-marker.txt'}))).json();assert.equal(marker.content,'pi-release-rehearsal-v1\n');
 const catalog=await(await api('/api/pi/settings/models')).json();assert.equal(catalog.customProviders.find(p=>p.id==='release-fixture').baseUrl,'http://127.0.0.1:8089/v1');
 const sessions=(await(await api('/api/pi/sessions?'+new URLSearchParams({cwd}))).json()).sessions;assert.equal(sessions.length,1);const id=sessions[0].id;
 const main=await connect('open_session',{cwd,sessionId:id});
 assert.equal(main.snapshot.state.model.provider,'release-fixture');
 assert.equal(main.snapshot.state.model.id,'release-fixture');
 try{
  const resources=await main.call('get_native_resources');assert.ok(JSON.stringify(resources).includes('read'));
  await main.call('bash',{command:"printf 'CLOUD_SHELL_OK\\n'"});await until(async()=>!(await main.call('get_state')).webShell.busy);
  assert.ok(JSON.stringify(await main.call('get_messages')).includes('CLOUD_SHELL_OK'));
  const slow=await main.call('bash',{command:'sleep 15',excludeFromContext:true});
  await assert.rejects(main.call('prompt',{message:'must reject while shell busy'}));
  await main.call('abort_bash',{executionId:slow.job.id});await until(async()=>!(await main.call('get_state')).webShell.busy);
  const search=await main.call('search_history',{q:'RELEASE_REHEARSAL_OK',filter:'assistant',scope:'all'});assert.ok(search.results.length>0);
  const target=search.results[0].entryId || search.results[0].id;
  const entry=await main.call('get_history_entry',{entryId:target});
  await main.call('set_history_bookmark',{entryId:target,label:'Cloud restore bookmark',expectedBookmarkRevision:entry.bookmarkRevision});
  const tree=await main.call('get_session_tree',{});assert.ok(JSON.stringify(tree).includes('Cloud restore bookmark'));
  const ticket=await main.call('prepare_side_chat',{mode:'context'});
  const side=await connect('open_side_chat',{ticket:ticket.ticket});
  await side.call('prompt',{message:'Synthetic side chat check'});await until(()=>side.events.some(e=>e.type==='agent_settled'));
  assert.ok(JSON.stringify(await side.call('get_messages')).includes('RELEASE_REHEARSAL_OK'));
  await side.call('quit_side_chat');side.ws.close();
  const exported=await(await api(`/api/pi/sessions/${id}/export`,'POST',{cwd,format:'jsonl'})).text();assert.ok(exported.includes('RELEASE_REHEARSAL_OK'));
  const html=await(await api(`/api/pi/sessions/${id}/export`,'POST',{cwd,format:'html'})).text();
  const embedded=html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);assert.ok(embedded);
  const htmlData=JSON.parse(Buffer.from(embedded[1],'base64').toString('utf8'));assert.ok(JSON.stringify(htmlData.entries).includes('RELEASE_REHEARSAL_OK'));
  const imported=await(await api('/api/pi/sessions/import','POST',{cwd,content:exported,requestId:require('node:crypto').randomUUID()})).json();
  assert.notEqual(imported.session.id,id);
  await api(`/api/pi/sessions/${imported.session.id}?`+new URLSearchParams({cwd}),'DELETE');
  const again=await connect('open_session',{cwd,sessionId:id});assert.equal(again.snapshot.session.id,id);assert.ok(JSON.stringify(again.snapshot.messages).includes('CLOUD_SHELL_OK'));
  await main.call('quit_session');
  console.log(JSON.stringify({status:'passed',sessionId:id,checks:['native resources','manual shell and persisted output','busy rejection','abort shell','history search','bookmark','session tree','context side chat and cleanup','HTML and JSONL export','import independent ID and cleanup','second connection snapshot','quit persistent runtime']}));
 }finally{for(const ws of connections)ws.terminate()}
})().catch(e=>{for(const ws of connections)ws.terminate();console.error(e);process.exitCode=1});
