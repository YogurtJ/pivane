const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.PI_ONBOARDING_TEST_URL;
const project=process.env.PI_ONBOARDING_PROJECT;
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(base||'')&&!base.endsWith(':3001'));
assert.match(project||'',/^\/tmp\/pi-onboarding-[^/]+\/project$/);
(async()=>{
 const get=async route=>{const r=await fetch(base+route);assert.ok(r.ok,route);return r.json()};
 const status=await get('/api/pi/status');assert.deepEqual(status.projectRoots,['/']);assert.ok(status.defaultProject.startsWith('/'));
 const marker=await get('/api/pi/files/content?'+new URLSearchParams({cwd:project,path:'marker.txt'}));assert.equal(marker.content,'pi-onboarding-fixture\n');
 const models=await get('/api/pi/settings/models');assert.ok(models.providers.every(p=>!p.configured));
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});const results=[];
 try{for(const width of [1440,393,320]){
  const context=await browser.newContext({ locale: 'zh-CN',viewport:{width,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//,r=>r.abort());
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!document.querySelector('#pi-project-button').disabled);
  // Existing allowed server cwd may appear as a project, but no browser project is preselected in settings.
  await page.evaluate(()=>localStorage.removeItem('pi.web.cwd'));
  if(!await page.locator('#pi-project-dialog-close').isVisible())await page.locator('#pi-project-button').click();
  await page.waitForFunction(()=>document.querySelector('#pi-project-input').value===document.querySelector('#pi-directory-current').textContent);
  assert.equal(await page.locator('#pi-project-input').inputValue(),status.defaultProject);
  await page.locator('#pi-project-dialog-close').click();await page.locator('#workspace-settings-toggle').click();
  await page.locator('[data-settings-tab=native]').click();await page.locator('#native-settings-scope').waitFor();
  assert.deepEqual(await page.locator('#native-settings-scope option').evaluateAll(o=>o.map(x=>x.value)),['global']);
  if(width===1440){
   await page.locator('[data-group=trust] summary').click();
   const field=page.locator('[name=defaultProjectTrust]');await field.selectOption(await field.inputValue()==='never'?'ask':'never');
   await page.locator('#native-settings-save').click();await page.waitForFunction(()=>document.querySelector('#native-status').textContent.includes('已保存'));
   assert.equal(await page.evaluate(()=>localStorage.getItem('pi.web.cwd')),null,'global settings must not select a project');
  }
  await page.locator('[data-settings-tab=packages]').click();await page.locator('#native-resource-scope').waitFor();assert.equal(await page.locator('#native-resource-scope').inputValue(),'global');
  await page.locator('[data-settings-tab=skills]').click();await page.locator('#native-skills-scope').waitFor();assert.equal(await page.locator('#native-skills-scope').inputValue(),'global');
  assert.ok(!/Project path must be absolute|outside allowed roots/.test(await page.locator('#workspace-settings-dialog').innerText()));
  await page.locator('#workspace-settings-close').click();await page.locator('#pi-project-button').click();
  // Fill a different real project; selecting a project does not create a runtime.
  await page.locator('#pi-project-input').fill(project);await page.locator('#pi-project-form [type=submit]').click();
  await page.waitForFunction(p=>localStorage.getItem('pi.web.cwd')===p,project);
  await page.locator('#pi-project-button').click();await page.waitForFunction(p=>document.querySelector('#pi-directory-current').textContent===p,project);
  await page.locator('#pi-directory-up').click();const parent=project.slice(0,project.lastIndexOf('/'));
  await page.waitForFunction(p=>document.querySelector('#pi-project-input').value===p,parent);
  await page.locator('#pi-directory-list [data-path="'+project+'"]').click();
  await page.waitForFunction(p=>document.querySelector('#pi-project-input').value===p,project);
  for(const selector of ['body','#pi-project-dialog .project-dialog','#pi-project-form','#pi-directory-list']){const m=await page.locator(selector).evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));assert.ok(m.scroll<=m.width+1,selector+JSON.stringify(m));}
  await page.screenshot({path:`/tmp/pi-onboarding-${width}.png`});assert.deepEqual(errors,[]);results.push({width,globalSettingsWithoutSelection:true,absolutePathAndParent:true,pageerrors:0});await context.close();
 }}finally{await browser.close()}
 console.log(JSON.stringify({status:'passed',results}));
})().catch(e=>{console.error(e);process.exitCode=1});
