const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_COMPLETION_TEST_URL || 'http://127.0.0.1:3001';
const model = {provider:'fixture',id:'fixture',name:'Fixture',input:['text','image'],contextWindow:32000};
const cwd='/tmp/native-completion-browser', session={id:'fixture',cwd,name:'Fixture',messageCount:1};
const controls = () => ({runtimeId:'runtime',revision:1,queue:{steering:[],followUp:[]},recoveries:[],drafts:[],stopping:false,extension:{title:'',statuses:[],widgets:[]}});
async function run(browser, viewport) {
 const context = await browser.newContext({ locale: 'zh-CN',viewport,isMobile:viewport.width<900,hasTouch:viewport.width<900});
 const page = await context.newPage(); let socket, control=controls(), partial='PREFIX ', seq=10, busy=true, configMatch=false, rejectAck=false, holdSearch, startupFailure=false;
 const requests=[],errors=[]; const runtime=()=>({model,thinkingLevel:'off',isStreaming:busy,isCompacting:false});
 const stats={tokens:{input:10,output:10},contextUsage:{tokens:20,percent:0.1,contextWindow:32000}};
 const messages=[{role:'user',content:'Question',timestamp:1}];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({cwd})=>{localStorage.setItem('pi.web.cwd',cwd);localStorage.setItem('pi.web.session:'+cwd,'fixture');},{cwd});
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()), p=url.pathname; requests.push({path:p,method:route.request().method()});
  if(p==='/api/access/status')return route.fulfill({json:{enabled:false,authenticated:true}});
  if(p==='/api/pi/status')return route.fulfill({json:{ok:true,version:'0.85.0',projectRoots:['/tmp'],liveRecovery:true,extensionDrafts:true,runtimeControls:true,extensionStatus:true,sessionSearch:true,historySearch:true,historyBody:true,nativeSettings:true,nativeResources:true,runtimeConfiguration:true,composerTools:true}});
  if(p==='/api/pi/projects')return route.fulfill({json:{projects:[{cwd,name:'Fixture',sessionCount:1}],roots:['/tmp']}});
  if(p==='/api/pi/sessions')return route.fulfill({json:{sessions:[session]}});
  if(p==='/api/pi/activity')return route.fulfill({json:{runtimes:[],pinnedProjects:[],hiddenProjects:[],replyNotices:[]}});
  if(p==='/api/pi/composer/catalog')return route.fulfill({json:{builtins:[],templates:[],warnings:[]}});
  if(p==='/api/pi/sessions/search') {
   if(url.searchParams.get('q')==='slow')await new Promise(r=>{holdSearch=r;});
   return route.fulfill({json:{searchId:'search',offset:0,total:1,hasMore:false,coverage:{},results:[{sessionId:session.id,cwd,name:'Found thread',entryId:'answer',matchOffset:0,snippet:'MATCHED_BODY <img src=x onerror=alert(1)>',matches:1}]}}).catch(()=>{});
  }
  if(p.includes('history')||p==='/api/prompts')return route.fulfill({json:[]});
  return route.fulfill({json:{}});
 });
 await page.routeWebSocket('**/api/pi/ws',ws=>{
  socket=ws; const reply=(c,data,error)=>ws.send(JSON.stringify({type:'response',id:c.id,command:c.type,success:!error,error,data}));
  ws.onMessage(raw=>{
   const c=JSON.parse(raw); requests.push(c);
   if(c.type==='open_session') {
    if(startupFailure)return ws.send(JSON.stringify({type:'response',id:c.id,command:c.type,success:false,error:'Fixture startup interaction unsupported',errorCode:'STARTUP_UI_UNSUPPORTED'}));
    ws.send(JSON.stringify({type:'message_update',webRuntimeId:'live',webSequence:9,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'MUST_NOT_DUPLICATE'}}));
    return reply(c,{session,state:runtime(),controls:control,messages:{messages,webLive:{runtimeId:'live',sequence:seq,running:busy,message:busy?{role:'assistant',timestamp:2,content:[{type:'text',text:partial}]}:null,tools:busy?[{type:'tool_execution_update',toolCallId:'live-tool',toolName:'read',args:{path:'file.txt'},partialResult:{content:[{type:'text',text:'TOOL_PROGRESS'}]}}]:[]}},stats,models:{models:[model]},thinkingLevels:{levels:['off']},commands:{commands:[]}});
   }
   if(c.type==='get_state')return reply(c,runtime());
   if(c.type==='get_messages')return reply(c,{messages});
   if(c.type==='get_session_stats')return reply(c,stats);
   if(c.type==='get_native_resources')return reply(c,{projectTrusted:false,contextFiles:[],skills:[],commands:[],tools:[],systemPrompt:{}});
   if(c.type==='get_runtime_configuration')return reply(c,{runtimeId:control.runtimeId,revision:'revision',matchesSavedConfig:configMatch,actualProjectTrusted:false,trust:{requiresTrust:true,decision:null,override:null,defaultPolicy:'ask'},ephemeral:false,recoveries:0,drafts:control.drafts.length});
   if(c.type==='restart_runtime') {configMatch=true; reply(c,{accepted:true}); return;}
   if(c.type==='ack_extension_draft') {if(rejectAck)return reply(c,null,'fixture acknowledgement failure'); control.drafts=[];control.revision++;return reply(c,control);}
   if(c.type==='search_history')return reply(c,{results:[],offset:0,pageSize:30,total:0,hasMore:false,revision:'h'});
   if(c.type==='get_history_entry')return reply(c,{entryId:'answer',kind:'assistant',view:'body',role:'assistant',text:'MATCHED_BODY',label:'',canBookmark:false,inCurrentBranch:true,totalCharacters:12,offset:0,nextOffset:12});
   reply(c,{});
  });
 });
 const event=e=>socket.send(JSON.stringify(e));
 await page.goto(baseUrl,{waitUntil:'domcontentloaded'});
 await page.getByText('PREFIX ',{exact:false}).waitFor();
 assert.ok(!(await page.locator('#pi-transcript').innerText()).includes('MUST_NOT_DUPLICATE'));
 event({type:'message_update',webRuntimeId:'live',webSequence:++seq,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'SUFFIX'}});partial+='SUFFIX';
 await page.getByText('PREFIX SUFFIX',{exact:false}).waitFor();
 await page.reload({waitUntil:'domcontentloaded'}); await page.getByText('PREFIX SUFFIX',{exact:false}).waitFor();
 assert.equal(await page.locator('[data-tool-id="live-tool"]').count(),1);
 await page.locator('#pi-input').fill('MY_DRAFT');
 control.drafts=[{id:'draft',text:'EXTENSION_TEXT'}];control.revision++;event({type:'gateway_controls',controls:control});event({type:'extension_ui_request',method:'set_editor_text',id:'draft',text:'EXTENSION_TEXT'});
 await page.locator('#pi-editor-suggestions').waitFor({state:'visible'});assert.equal(await page.locator('#pi-input').inputValue(),'MY_DRAFT');
 await page.locator('#pi-editor-suggestions summary').click();
 const appendButton = page.getByRole('button',{name:'追加到草稿',exact:true}); await appendButton.focus();
 control.revision++; control.extension.title='Status update'; event({type:'gateway_controls',controls:control});
 await page.waitForFunction(()=>document.title.includes('Status update'));
 assert.equal(await appendButton.evaluate(e=>document.activeElement===e),true,'unrelated extension status must preserve draft action focus');
 rejectAck=true;
 await page.getByRole('button',{name:'追加到草稿',exact:true}).click();await page.waitForFunction(()=>document.getElementById('pi-input').value.includes('EXTENSION_TEXT'));
 await page.waitForFunction(()=>!document.querySelector('#pi-editor-suggestions button').disabled);
 rejectAck=false;await page.getByRole('button',{name:'追加到草稿',exact:true}).click();await page.locator('#pi-editor-suggestions').waitFor({state:'hidden'});
 assert.equal((await page.locator('#pi-input').inputValue()).split('EXTENSION_TEXT').length,2);
 busy=false;event({type:'agent_settled'});
 if(viewport.width<900)await page.locator('#pi-toggle-sessions').click();
 await page.locator('#pi-search-conversations').click();
 await page.getByRole('searchbox',{name:'对话正文关键词'}).fill('slow'); await page.locator('#pi-session-search-dialog button[type="submit"]').click();
 for(let i=0;!holdSearch&&i<100;i++)await new Promise(r=>setTimeout(r,10));assert.ok(holdSearch);
 await page.getByRole('searchbox',{name:'对话正文关键词'}).fill('MATCHED_BODY');await page.locator('#pi-session-search-dialog button[type="submit"]').click();
 await page.getByRole('button',{name:/Found thread/}).waitFor();holdSearch();
 await page.getByRole('button',{name:/Found thread/}).waitFor();assert.equal(await page.locator('#pi-session-search-dialog img').count(),0);
 await page.screenshot({path:`/tmp/pi-native-completion-search-${viewport.width}.png`,timeout:15000});
 await page.getByRole('button',{name:/Found thread/}).click();await page.locator('#pi-history-text').getByText('MATCHED_BODY',{exact:true}).waitFor();
 assert.ok((await page.locator('#pi-input').inputValue()).includes('MY_DRAFT'));
 assert.equal(requests.filter(r=>r.type==='prompt'||r.type==='navigate_history').length,0);
 await page.locator('#pi-details-tab').click();await page.locator('#pi-loaded-resources > summary').click();
 await page.locator('#pi-runtime-config-check').click();await page.waitForFunction(()=>document.getElementById('pi-runtime-config-status').dataset.state==='changed');
 page.once('dialog',d=>d.accept());await page.locator('#pi-runtime-restart').click();await page.locator('#pi-runtime-config-check').click();await page.waitForFunction(()=>document.getElementById('pi-runtime-config-status').dataset.state==='current');
 for(const theme of ['daylight','mint','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const overflow=await page.evaluate(()=>({body:document.body.scrollWidth>document.body.clientWidth+1,transcript:document.getElementById('pi-transcript').scrollWidth>document.getElementById('pi-transcript').clientWidth+1}));
  assert.equal(overflow.body,false);assert.equal(overflow.transcript,false);
 }
 startupFailure=true;await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'重试连接',exact:true}).waitFor();
 const openCount=requests.filter(r=>r.type==='open_session').length;await page.waitForTimeout(2100);assert.equal(requests.filter(r=>r.type==='open_session').length,openCount,'startup incompatibility must not loop');
 assert.deepEqual(errors,[]);assert.equal(requests.filter(r=>r.method&&r.method!=='GET').length,0);
 await context.close(); console.log(`PASS ${viewport.width}: live snapshot/event fence, tool recovery, draft acknowledgement failure, body search/preview, config/restart, no model requests/errors/overflow`);
}
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});try{for(const viewport of [{width:1440,height:1000},{width:393,height:852},{width:320,height:740}])await run(browser,viewport);}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
