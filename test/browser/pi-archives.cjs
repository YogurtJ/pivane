const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwdA = '/srv/archive-fixture-a', cwdB = '/srv/archive-fixture-b';
const sessions = [[cwdA,'active'],[cwdA,'a2'],[cwdA,'a3'],[cwdB,'b1'],[cwdB,'b2']].map(([cwd,id]) => ({ cwd,id,name:id,firstMessage:`Fixture ${id}`,messageCount:2,modified:'2026-09-12T00:00:00Z' }));
const model = {provider:'fixture',id:'fixture',name:'Fixture',input:['text']};
const english = {'归档线程':'Archive thread','恢复线程':'Restore thread','归档项目':'Archive project','恢复项目':'Restore project','历史与记录':'History and records','会话树':'Session tree','搜索历史与书签':'Search history and bookmarks','导出记录':'Export records'};
async function run(browser, base, width, locale) {
 const t = s => locale === 'zh-CN' ? s : english[s];
 const context = await browser.newContext({locale,viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});
 let archives={revision:0,projects:[],sessions:[]}, stale=null, reject=false, enabled=true;
 const errors=[], writes=[], commands=[];
 const runtimes=[{cwd:cwdB,sessionId:'b2',phase:'running',busy:true}];
 const notices=[{cwd:cwdB,sessionId:'b1',completionId:'unread',completedAt:'2026-09-12T00:00:00Z'}];
 async function configure(page) {
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(cwd=>{localStorage.setItem('pi.web.cwd',cwd);localStorage.setItem(`pi.web.session:${cwd}`,'active');localStorage.setItem('pi.web.expandedProjects',JSON.stringify([cwd,'/srv/archive-fixture-b']));},cwdA);
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()!=='GET') {
    writes.push(url.pathname);
    if(url.pathname.endsWith('/archive')) {
     assert.match(req.headers()['content-type'],/application\/json/);
     if(reject){reject=false;return route.fulfill({status:503,json:{error:'Fixture rejection'}})}
     const {cwd,archived}=req.postDataJSON();
     archives=structuredClone(archives);archives.revision++;
     if(url.pathname.includes('/projects/')) {archives.projects=archives.projects.filter(p=>p!==cwd);if(archived)archives.projects.push(cwd)}
     else {const sessionId=url.pathname.split('/').at(-2);archives.sessions=archives.sessions.filter(s=>s.cwd!==cwd||s.sessionId!==sessionId);if(archived)archives.sessions.push({cwd,sessionId})}
     return route.fulfill({json:{cwd,archives}});
    }
    if(url.pathname.endsWith('/read'))return route.fulfill({json:{ok:true}});
    throw Error('Unexpected write '+url.pathname);
   }
   if(url.pathname==='/api/pi/status')return route.fulfill({json:{ok:true,projectRoots:['/srv'],archives:enabled,sessionSearch:true,historySearch:true,sessionTree:true,sessionTransfer:true}});
   if(url.pathname==='/api/pi/projects')return route.fulfill({json:{roots:['/srv'],pinnedProjects:[],hiddenProjects:[],...(enabled?{archives}:{}),projects:[cwdA,cwdB].map(cwd=>({cwd,name:cwd===cwdA?'Project A':'Project B',sessionCount:sessions.filter(s=>s.cwd===cwd).length}))}});
   if(url.pathname==='/api/pi/sessions')return route.fulfill({json:{sessions:sessions.filter(s=>s.cwd===url.searchParams.get('cwd'))}});
   if(url.pathname==='/api/pi/activity')return route.fulfill({json:{...(enabled?{archives:stale||archives}:{}),runtimes,replyNotices:notices,pinnedProjects:[],hiddenProjects:[],deferred:{sessions:[]}}});
   if(url.pathname==='/api/pi/sessions/search') {
    const include=url.searchParams.get('includeArchived')==='true';
    return route.fulfill({json:{results:include?[{...sessions[1],sessionId:'a2',entryId:'entry',matches:1,snippet:'fixture',archived:true}]:[],total:include?1:0,offset:0,hasMore:false,searchId:'fixture'}});
   }
   if(url.pathname.includes('history'))return route.fulfill({json:[]});
   return route.fulfill({json:{}});
  });
  await page.routeWebSocket('**/api/pi/ws',socket=>socket.onMessage(raw=>{
   const c=JSON.parse(raw);commands.push(c.type);
   const state={model,isStreaming:false,thinkingLevel:'off'};
   let data={};
   if(c.type==='open_session')data={session:sessions.find(s=>s.cwd===c.cwd&&s.id===c.sessionId),state,messages:{messages:[]},models:{models:[model]},thinkingLevels:{levels:['off']},commands:{commands:[]},stats:{}};
   else if(c.type==='get_state')data=state;
   else if(c.type==='get_messages')data={messages:[]};
   socket.send(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data}));
  }));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.getElementById('pi-input').disabled);
 }
 const page=await context.newPage();await configure(page);
 const drawer=async(p=page)=>{if(width<900&&!await p.locator('#pi-session-pane').evaluate(n=>n.classList.contains('open')))await p.locator('#pi-toggle-sessions').click();await p.waitForFunction(()=>document.getElementById('pi-session-pane').getBoundingClientRect().left>=-1)};
 await drawer();
 const group=cwd=>page.locator(`[data-project-cwd="${cwd}"]`);
 const row=id=>page.locator(`#pi-session-list [data-session-id="${id}"]`);
 const threadFold=()=>group(cwdA).locator('[data-archive-kind="threads"]');
 const projectFold=()=>page.locator('[data-archive-kind="projects"]');
 const menu=page.locator('.pi-thread-menu:not(.hidden)');
 async function action(target,label){await target.click();await menu.getByRole('menuitem',{name:t(label),exact:true}).click();}
 const threadAction=(id,label)=>action(row(id).locator('[data-action="menu"]'),label);
 const projectAction=(cwd,label)=>action(group(cwd).locator('[data-project-action="menu"]'),label);
 await row('a2').locator('[data-action="menu"]').click();
 assert.equal(await menu.getByRole('menuitem',{name:t('会话树'),exact:true}).count(),0);
 await menu.getByRole('menuitem',{name:t('历史与记录'),exact:true}).focus();
 await page.keyboard.press('ArrowRight');
 for(const s of ['会话树','搜索历史与书签','导出记录'])assert.equal(await menu.getByRole('menuitem',{name:t(s),exact:true}).isVisible(),true);
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 const opens=commands.filter(c=>c==='open_session').length;
 reject=true;await threadAction('a2','归档线程');
 await page.getByText('Fixture rejection',{exact:true}).waitFor();
 assert.equal(await threadFold().count(),0,'failed archive keeps row');
 await threadAction('a2','归档线程');await threadFold().waitFor();
 assert.equal(await threadFold().evaluate(n=>n.open),false);
 assert.equal(await row('a2').isVisible(),false);
 assert.equal(commands.filter(c=>c==='open_session').length,opens,'archive does not open runtimes');
 stale={revision:0,projects:[],sessions:[]};
 await Promise.all([page.waitForResponse('**/api/pi/activity'), page.locator('#pi-refresh-sessions').click()]);
 assert.equal(await row('a2').isVisible(),false,'late response cannot unarchive');stale=null;
 await threadFold().locator('summary').click();
 await row('a2').locator('.pi-session-main').click();await page.waitForFunction(()=>document.querySelector('.pi-session-item.active')?.dataset.sessionId==='a2');await drawer();
 assert.equal(archives.sessions.length,1,'viewing archived content does not restore it');
 assert.equal(await row('a2').evaluate(n=>n.classList.contains('active')),true);
 await projectAction(cwdA,'归档项目');await projectFold().waitFor();
 assert.equal(await projectFold().evaluate(n=>n.open),false);
 await projectFold().locator(':scope > summary').click();
 await projectAction(cwdA,'恢复项目');await page.waitForFunction(()=>!document.querySelector('[data-archive-kind="projects"]'));
 assert.equal(archives.sessions.length,1,'restoring project leaves thread archive intact');
 assert.equal(await threadFold().count(),1);
 await projectAction(cwdB,'归档项目');
 await page.locator('[data-filter="work"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-work-section="running"] [data-session-id="b2"]'));
 assert.equal(await page.locator('[data-work-section="attention"] [data-session-id="b1"]').count(),1);
 assert.equal(await page.locator('[data-work-section="recent"] .pi-session-archive-label').count(),0);
 assert.equal(await page.locator('[data-work-section="running"] .pi-session-archive-label').count(),1);
 assert.equal(await page.locator('#pi-session-list [data-session-id="b2"]').count(),1);
 await page.locator('[data-filter="all"]').click();
 await page.locator('#pi-session-search-toggle').click();await page.locator('#pi-session-search').fill('a2');
 assert.equal(await row('a2').count(),0);
 await page.locator('#pi-include-archived').check();await row('a2').waitFor();
 await page.locator('#pi-session-search').press('Escape');
 // Another independent client reads the same server archive state.
 const otherContext=await browser.newContext({locale,viewport:{width,height:900}});
 const other=await otherContext.newPage();await configure(other);await drawer(other);
 assert.equal(await other.locator('[data-archive-kind="threads"]').evaluate(n=>n.open),false);
 assert.equal(await other.locator('[data-archive-kind="projects"]').evaluate(n=>n.open),false);
 await threadFold().locator('summary').click();
 if(!await row('a2').isVisible())await threadFold().locator('summary').click();
 await threadAction('a2','恢复线程');await page.waitForFunction(()=>!document.querySelector('[data-archive-kind="threads"]'));
 await other.waitForFunction(()=>!document.querySelector('[data-archive-kind="threads"]'));
 await otherContext.close();
 // Server-side search has a distinct explicit opt-in, with archived result labels.
 await page.locator('#pi-search-conversations').click();
 const search=page.locator('#pi-session-search-dialog');await search.locator('input[type="search"]').fill('fixture');
 await Promise.all([page.waitForResponse('**/api/pi/sessions/search?**'), search.locator('button[type="submit"]').click()]);
 assert.equal(await search.locator('.pi-session-search-results button').count(),0);
 await search.locator('input[type="checkbox"]').check();await search.locator('button[type="submit"]').click();await search.locator('.pi-session-search-results button').waitFor();
 await page.keyboard.press('Escape');
 if(!await projectFold().evaluate(n=>n.open))await projectFold().locator(':scope > summary').click();
 for(const theme of ['daylight','mint','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.screenshot({path:`/tmp/pi-archives-${locale}-${width}-${theme}.png`});
  assert.equal(await page.locator('#pi-session-pane, #pi-session-list, .pi-archive-group').evaluateAll(ns=>ns.some(n=>n.scrollWidth>n.clientWidth+1)),false);
 }
 const openProjectPicker=async()=>{if(width<=680){await page.locator('#pi-mobile-summary').click()}else await page.locator('#pi-project-button').click()};
 await openProjectPicker();
 await page.locator('#pi-project-dialog').waitFor();
 assert.equal(await page.locator('#pi-project-list .pi-project-row, #pi-project-list .pi-project-row em').evaluateAll(ns=>ns.some(n=>n.scrollWidth>n.clientWidth+1)),false,'localized archive labels fit the project picker');
 await page.locator('#pi-project-dialog-close').click();
 await projectAction(cwdB,'恢复项目');await page.waitForFunction(()=>!document.querySelector('[data-archive-kind="projects"]'));
 enabled=false;await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!document.getElementById('pi-input').disabled);await drawer();
 await row('a2').locator('[data-action="menu"]').click();assert.equal(await menu.getByRole('menuitem',{name:t('归档线程'),exact:true}).count(),0,'old backend has no unsupported action');
 assert.deepEqual(errors,[]);
 assert.equal(commands.some(c=>['prompt','steer','follow_up','abort'].includes(c)),false);
 assert.ok(writes.every(p=>p.endsWith('/archive')||p.endsWith('/read')));
 await context.close();console.log(`PASS archives ${locale} ${width}: reversible folds, direct viewing, cross-client/stale/failure handling, running reminders, search, nested menu, old backend`);
}
(async()=>{
 const app=express();for(const [name,dir] of [['marked','marked/lib'],['dompurify','dompurify/dist'],['highlight','@highlightjs/cdn-assets']])app.use('/vendor/'+name,express.static(path.join(root,'node_modules',dir)));
 app.use(express.static(path.join(root,'public')));const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try {for(const locale of (process.env.PI_ARCHIVE_TEST_LOCALES?.split(',') || ['zh-CN','en-US']))for(const width of (process.env.PI_ARCHIVE_TEST_WIDTHS?.split(',').map(Number) || [1440,393,320]))await run(browser,`http://127.0.0.1:${server.address().port}`,width,locale)}
 finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
