const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/srv/thread-card-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
const sessions = [
 ['named', 'Pivane v1.0.0-rc.3 版本发布', '我想请你帮我发布新版本，整理这次改进。'],
 ['fallback', '', '感觉是不是可以把安装引导整理得更清楚，方便第一次使用的用户配置自己的项目与模型。'],
 ['running', '优化安装流程与文档', '安装流程的第一句话'],
 ['waiting', '扩展与工具管理', '等待确认的第一句话'],
 ['unread', '会话标题命名', '未读会话的第一句话'],
 ['error', '版本更新', '失败会话的第一句话'],
 ['search', '历史整理', '前面的内容不应挤占日常列表。'.repeat(12) + '隐藏命中 <b>不执行标签</b> 后面的匹配上下文。'],
 ['unsafe', '<img src=x onerror="window.injected=1">', '安全显示 <svg onload="window.injected=1">'],
 ['empty', '', '(no messages)']
].map(([id,name,firstMessage]) => ({ cwd,id,name,firstMessage,messageCount:id==='empty'?0:40,modified:'2026-09-19T10:08:00Z' }));
async function run(browser, base, width, locale) {
 const context=await browser.newContext({locale,viewport:{width,height:1000},isMobile:width<900,hasTouch:width<900});
 const page=await context.newPage(), errors=[], commands=[];let fresh=true, phase='tool', retained=true;
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(cwd=>{localStorage.setItem('pi.web.cwd',cwd);localStorage.setItem(`pi.web.session:${cwd}`,'named');localStorage.setItem('pi.web.expandedProjects',JSON.stringify([cwd]));},cwd);
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());
  assert.equal(req.method(),'GET','card browsing must not write server state');
  if(url.pathname==='/api/pi/status')return route.fulfill({json:{ok:true,projectRoots:['/srv'],sessionWorkflows:true,sessionTransfer:true,nativeSettings:true}});
  if(url.pathname==='/api/pi/projects')return route.fulfill({json:{projects:[{cwd,name:'Pivane 项目',sessionCount:sessions.length}],roots:['/srv'],pinnedProjects:[],hiddenProjects:[]}});
  if(url.pathname==='/api/pi/sessions')return route.fulfill({json:{sessions}});
  if(url.pathname==='/api/pi/activity')return route.fulfill({status:fresh?200:503,json:{runtimes:[...(retained?[{cwd,sessionId:'named',phase:'idle',busy:false}]:[]),{cwd,sessionId:'running',phase,busy:['running','tool','retrying','compacting'].includes(phase)},{cwd,sessionId:'waiting',phase:'waiting',busy:true},{cwd,sessionId:'error',phase:'error',busy:false}],replyNotices:[{cwd,sessionId:'unread',completionId:'notice',completedAt:'2026-09-19T10:08:00Z'}],pinnedProjects:[],hiddenProjects:[],deferred:{sessions:[{cwd,sessionId:'search',count:1,attention:false}]}}});
  if(url.pathname.endsWith('/deferred'))return route.fulfill({json:{jobs:url.pathname.includes('/search/')?[{id:'queued',status:'scheduled',preview:'Fixture queued message',dueAt:Date.now()+600000}]:[]}});
  if(url.pathname.includes('history'))return route.fulfill({json:[]});
  return route.fulfill({json:{}});
 });
 await page.routeWebSocket('**/api/pi/ws',socket=>socket.onMessage(raw=>{
  const command=JSON.parse(raw);commands.push(command.type);let data={};
  const state={model,isStreaming:false,thinkingLevel:'off'};
  if(command.type==='open_session'||command.type==='open_ephemeral')data={...(command.type==='open_session'?{session:sessions.find(s=>s.id===command.sessionId)}:{}),state,messages:{messages:[]},stats:{},models:{models:[model]},thinkingLevels:{levels:['off']},commands:{commands:[]}};
  else if(command.type==='get_state')data=state;
  else if(command.type==='get_messages')data={messages:[]};
  socket.send(JSON.stringify({type:'response',id:command.id,command:command.type,success:true,data}));
 }));
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>!document.getElementById('pi-input').disabled);
 const drawer=async()=>{if(width<900&&!await page.locator('#pi-session-pane').evaluate(n=>n.classList.contains('open')))await page.locator('#pi-toggle-sessions').click();await page.waitForFunction(()=>document.getElementById('pi-session-pane').getBoundingClientRect().left>=-1)};
 await drawer();
 await page.waitForFunction(()=>document.querySelector('[data-session-id="running"] .pi-session-activity')?.dataset.phase==='tool');
 await page.locator('[data-project-action="more-threads"]').click();
 const row=id=>page.locator(`#pi-session-list [data-session-id="${id}"]`);
 assert.equal(await page.locator('.pi-session-preview').count(),0,'normal cards have no duplicated first message');
 assert.equal(await row('named').locator('.pi-session-title').getAttribute('title'),sessions[0].name);
 assert.equal(await row('fallback').locator('.pi-session-title').innerText(),sessions[1].firstMessage);
 assert.equal(await row('empty').locator('.pi-session-title').innerText(),locale==='zh-CN'?'未命名会话':'Untitled session');
 assert.equal(await row('named').locator('.pi-session-activity').isVisible(),true,'retained idle runtime remains visible');
 assert.match(await row('named').locator('.pi-session-activity').getAttribute('title'),/\/quit/);
 assert.equal(await row('fallback').locator('.pi-session-activity').isVisible(),false,'inactive is silent');
 for(const id of ['running','waiting','error'])assert.equal(await row(id).locator('.pi-session-activity').isVisible(),true);
 assert.equal(await row('unread').locator('.pi-session-unread').isVisible(),true);
 assert.equal(await row('unsafe').locator('img').count(),0);
 assert.equal(await page.evaluate(()=>window.injected),undefined);
 const height=await row('named').evaluate(n=>n.getBoundingClientRect().height);
 const fallbackHeight=await row('fallback').evaluate(n=>n.getBoundingClientRect().height);
 assert.ok(height>=58&&height<=66,`named card has comfortable compact spacing: ${height}`);
 assert.ok(fallbackHeight>height&&fallbackHeight<=height+22,`fallback uses at most two title lines: ${fallbackHeight}`);
 const checkLayout=async()=>{
  assert.equal(await page.locator('#pi-session-pane, #pi-session-list, .pi-session-item, .pi-session-main, .pi-session-foot').evaluateAll(ns=>ns.some(n=>n.scrollWidth>n.clientWidth+1)),false,'actual card children stay inside sidebar');
  const geometry=await row('named').evaluate(n=>{const r=e=>e.getBoundingClientRect();return {title:r(n.querySelector('.pi-session-title')).toJSON(),action:r(n.querySelector('[data-action="menu"]')).toJSON(),metadata:r(n.querySelector('.pi-session-foot')).toJSON()}});
  assert.ok(geometry.metadata.y>=geometry.title.bottom+4,'title and metadata retain breathing room');
  assert.ok(geometry.action.y+geometry.action.height<=geometry.metadata.bottom+1,'menu stays inside card');
 };
 for(const theme of ['daylight','mint','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.locator('#pi-session-list').evaluate(n=>n.scrollTop=0);
  await checkLayout();
  const colors=await page.locator('.pi-session-item').evaluateAll(ns=>ns.map(n=>({active:n.classList.contains('active'),background:getComputedStyle(n).backgroundColor})));
  assert.notEqual(colors.find(n=>n.active).background,colors.find(n=>!n.active).background);
  await page.screenshot({path:`/tmp/pi-thread-card-${locale}-${width}-${theme}.png`});
 }
 await page.locator('#pi-session-search-toggle').click();
 await page.locator('#pi-session-search').fill('隐藏命中');
 const preview=row('search').locator('.pi-session-preview');await preview.waitFor();
 assert.match(await preview.innerText(),/^….*隐藏命中/);
 assert.equal(await preview.locator('b').count(),0);
 await page.locator('#pi-session-search').fill('Pivane v1.0');
 assert.equal(await row('named').locator('.pi-session-preview').count(),0,'title match needs no duplicate preview');
 await page.locator('#pi-session-search').fill('自己的项目');
 assert.match(await row('fallback').locator('.pi-session-preview').innerText(),/自己的项目/);
 await page.locator('#pi-session-search').press('Escape');
 assert.equal(await page.locator('.pi-session-preview').count(),0);
 await page.locator('[data-project-action="menu"]').click();
 const menu=page.locator('.pi-thread-menu:not(.hidden)');
 const more=locale==='zh-CN'?'更多操作':'More actions';
 const rare=locale==='zh-CN'?['导入 Pi 会话','项目信任','复制项目路径']:['Import Pi session','Project trust','Copy project path'];
 for(const label of rare)assert.equal(await menu.getByRole('menuitem',{name:label,exact:true}).count(),0);
 await menu.getByRole('menuitem',{name:more,exact:true}).focus();await page.keyboard.press('ArrowRight');
 for(const label of rare)assert.equal(await menu.getByRole('menuitem',{name:label,exact:true}).count(),1);
 await page.keyboard.press('ArrowLeft');assert.equal(await menu.getByRole('menuitem',{name:more,exact:true}).isVisible(),true);
 await page.keyboard.press('Escape');
 await row('named').locator('[data-action="menu"]').click();
 assert.equal(await menu.getByRole('menuitem',{name:locale==='zh-CN'?'待发送消息':'Pending messages',exact:true}).count(),0);
 await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem',{name:locale==='zh-CN'?'复制':'Copy',exact:true}).click();
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await row('fallback').locator('.pi-session-main').click();await page.waitForFunction(()=>document.querySelector('.pi-session-item.active')?.dataset.sessionId==='fallback');await drawer();
 assert.equal(await row('named').locator('.pi-session-activity').isVisible(),true,'idle persists after navigating away');
 retained=false;await page.waitForFunction(()=>document.querySelector('[data-session-id="named"] .pi-session-activity')?.dataset.phase==='inactive');
 assert.equal(await row('named').locator('.pi-session-activity').isVisible(),false,'reclaimed runtime no longer shows idle');
 retained=true;await page.waitForFunction(()=>document.querySelector('[data-session-id="named"] .pi-session-activity')?.dataset.phase==='idle');
 phase='compacting';await page.waitForFunction(()=>document.querySelector('[data-session-id="running"] .pi-session-activity')?.dataset.phase==='compacting');
 assert.equal(await row('running').locator('.pi-session-activity').isVisible(),true);
 fresh=false;await page.waitForFunction(()=>document.querySelector('.pi-session-activity')?.dataset.phase==='unknown');
 assert.equal(await row('named').locator('.pi-session-activity').isVisible(),true,'lost connectivity is not hidden as idle');
 fresh=true;await page.waitForFunction(()=>document.querySelector('.pi-session-activity')?.dataset.phase==='idle');
 await page.locator('[data-filter="work"]').click();
 assert.ok(await page.locator('.pi-work-session .pi-session-project:visible').count());
 assert.equal(await page.locator('.pi-session-preview').count(),0);
 await page.locator('[data-filter="all"]').click();
 assert.equal(await row('search').locator('.pi-session-deferred').isVisible(),true,'sidebar retains queued-message indication');
 await row('search').locator('.pi-session-main').click();
 await page.locator('#pi-deferred-open').click();await page.locator('#pi-workflow-dialog').waitFor();
 assert.match(await page.locator('#pi-workflow-content').innerText(),/Fixture queued message/);
 await page.locator('#pi-workflow-close').click();await drawer();
 await page.locator('#pi-temp-session').click();await page.waitForFunction(()=>document.querySelector('.pi-session-item.ephemeral'));await drawer();
 assert.equal(await page.locator('.ephemeral .pi-session-preview').innerText(),locale==='zh-CN'?'退出或断开后立即销毁':'Destroyed immediately on exit or disconnect');
 assert.deepEqual(errors,[]);
 assert.equal(commands.some(c=>['prompt','steer','follow_up'].includes(c)),false);
 console.log(`PASS ${locale} ${width}: ${height.toFixed(1)}px named, ${fallbackHeight.toFixed(1)}px fallback; compact layout, themes, safe snippets, statuses, selection, menus, temporary warning`);
 await context.close();
}
(async()=>{
 const app=express();for(const [name,dir]of [['marked','marked/lib'],['dompurify','dompurify/dist'],['highlight','@highlightjs/cdn-assets']])app.use('/vendor/'+name,express.static(path.join(root,'node_modules',dir)));
 app.use(express.static(path.join(root,'public')));const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{for(const locale of (process.env.PI_CARD_LOCALES?.split(',') || ['zh-CN','en-US']))for(const width of (process.env.PI_CARD_WIDTHS?.split(',').map(Number) || [1440,393,320]))await run(browser,process.env.PI_CARD_TEST_URL || `http://127.0.0.1:${server.address().port}`,width,locale)}
 finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
