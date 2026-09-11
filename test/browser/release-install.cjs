// Real HTTP/WebSocket onboarding against an isolated release rehearsal only.
// Run with PI_RELEASE_TEST_URL, PI_RELEASE_PHASE=install|verify and PLAYWRIGHT_MODULE.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_RELEASE_TEST_URL;
assert.ok(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !base.endsWith(':3001'), 'explicit isolated loopback URL required');
const cwd = process.env.PI_RELEASE_PROJECT_DIR || '/home/node/pi-workspace/projects/demo';
require('../release/guard.cjs').rehearsalRoot(cwd,true);
const projectRoot = require('node:path').dirname(cwd);
const phase = process.env.PI_RELEASE_PHASE || 'install';
assert.ok(['install', 'verify'].includes(phase));
async function get(url) { const response = await fetch(base + url); assert.equal(response.status,200); return response.json(); }
(async () => {
    const status = await get('/api/pi/status');
    assert.deepEqual(status.projectRoots, [projectRoot]);
    const marker = await get('/api/pi/files/content?'+new URLSearchParams({cwd,path:'release-marker.txt'}));
    assert.equal(marker.content, 'pi-release-rehearsal-v1\n');
    const initial = await get('/api/pi/settings/models');
    if (phase === 'install') {
        assert.equal(initial.customProviders.length,0);
        assert.ok(initial.providers.every(p=>!p.storedCredential && p.authSource !== 'env'));
        assert.deepEqual((await get('/api/pi/sessions?'+new URLSearchParams({cwd}))).sessions, []);
        assert.deepEqual((await get('/api/tts/config')).providers, []);
    } else {
        assert.equal(initial.preferences.defaultProvider,'release-fixture');
        assert.ok(initial.providers.find(p=>p.id==='release-fixture').configured);
    }
    const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true});
    const results = [];
    try {
        for (const width of [1440,393]) {
            const context = await browser.newContext({viewport:{width,height:1000},isMobile:width<900,hasTouch:width<900});
            const page = await context.newPage(); page.setDefaultTimeout(30000);
            const errors=[]; page.on('pageerror',e=>errors.push(e.message));
            // External decoration is irrelevant to this onboarding test; all application API/WS are real.
            await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)\//,r=>r.abort());
            await page.goto(base,{waitUntil:'domcontentloaded'});
            const iconFonts=await page.evaluate(async()=>{
                const fonts=await document.fonts.load('900 16px "Font Awesome 6 Free"', '\uf013');
                return fonts.map(font=>({family:font.family,status:font.status}));
            });
            assert.ok(iconFonts.some(font=>font.status==='loaded'), 'local icon font must load with external CDNs blocked');
            await page.waitForFunction(()=>!document.querySelector('#pi-project-button').disabled);
            if (await page.locator('#pi-project-dialog-close').isVisible()) await page.locator('#pi-project-dialog-close').click();
            if (phase==='install' && width===1440) {
                await page.locator('#workspace-settings-toggle').click();
                await page.locator('#settings-add-provider').click();
                const form = page.locator('#settings-provider-form');
                await form.locator('[name=id]').fill('release-fixture');
                await form.locator('[name=baseUrl]').fill('http://127.0.0.1:8089/v1');
                await form.locator('[name=authHeader]').check();
                await form.locator('[type=submit]').click();
                await page.waitForFunction(()=>document.querySelector('#workspace-settings-editor').classList.contains('hidden'));
                await page.locator('summary[data-provider="release-fixture"]').waitFor();
                await page.locator('#settings-add-model').click();
                const modelForm=page.locator('#settings-model-form');
                await modelForm.locator('[name=id]').fill('release-fixture');
                await modelForm.locator('[name=name]').fill('Release fixture');
                await modelForm.locator('[name=contextWindow]').fill('32000');
                await modelForm.locator('[name=maxTokens]').fill('1000');
                await modelForm.locator('[type=submit]').click();
                await page.waitForFunction(()=>document.querySelector('#workspace-settings-editor').classList.contains('hidden'));
                await page.locator('#settings-model-search').fill('release-fixture');
                const group=page.locator('.settings-model-group').filter({has:page.locator('summary[data-provider="release-fixture"]')});
                await group.locator('[data-action=key]').click();
                await page.locator('#settings-login-prompts input').fill('release-fixture-key');
                await page.locator('#settings-login-prompts button').click();
                await page.waitForFunction(()=>document.querySelector('#settings-login-status')?.textContent.includes('连接成功'));
                await page.locator('#workspace-settings-editor-close').click();
                await group.locator('[data-action=default]').click();
                await page.waitForFunction(()=>document.querySelector('.settings-model-group')?.textContent.includes('默认'));
                await page.locator('#workspace-settings-close').click();
            }
            await page.locator('#pi-project-button').click();
            await page.locator('#pi-project-input').fill(cwd);
            await page.locator('#pi-project-form [type=submit]').click();
            await page.waitForFunction(()=>document.querySelector('#pi-project-dialog').classList.contains('hidden'));
            if (width<900) await page.locator('#pi-toggle-sessions').click();
            if (phase==='install' && width===1440) {
                await page.locator('#pi-new-session').click();
            } else {
                await page.locator('[data-filter="all"]').click();
                await page.locator('.pi-session-main').first().click();
            }
            await page.waitForFunction(()=>document.querySelector('#pi-model-select')?.value.includes('release-fixture'));
            if (phase==='install' && width===1440) {
                await page.locator('#pi-input').fill('Only return the rehearsal marker.');
                await page.locator('#pi-send-button').click();
            }
            await page.waitForFunction(()=>document.querySelector('#pi-transcript-content')?.textContent.includes('RELEASE_REHEARSAL_OK'));
            await page.reload({waitUntil:'domcontentloaded'});
            await page.waitForFunction(()=>document.querySelector('#pi-transcript-content')?.textContent.includes('RELEASE_REHEARSAL_OK'));
            const metrics=await page.evaluate(()=>['body','#pi-transcript','#pi-transcript-content'].map(s=>{const e=document.querySelector(s);return {selector:s,width:e.clientWidth,scroll:e.scrollWidth};}));
            for (const m of metrics) assert.ok(m.scroll<=m.width+1,JSON.stringify(m));
            let media;
            if (phase==='verify') media=await page.evaluate(async()=>{
                const image=new Image();image.src='/images/rehearsal.png';await image.decode();
                const result={imageWidth:image.naturalWidth};
                for(const [kind,url] of [['audio','/audio/rehearsal.wav'],['video','/videos/rehearsal.mp4']]) {
                    const element=document.createElement(kind);
                    result[kind]=await new Promise((resolve,reject)=>{
                        const timer=setTimeout(()=>reject(new Error('media metadata timeout')),10000);
                        element.onloadedmetadata=()=>{clearTimeout(timer);resolve(element.duration);};
                        element.onerror=()=>{clearTimeout(timer);reject(new Error('media decode failed'));};
                        element.src=url;element.load();
                    });
                }
                return result;
            });
            if (media) {assert.equal(media.imageWidth,1);assert.ok(media.audio>0);assert.ok(media.video>0);}
            assert.deepEqual(errors,[]);
            const screenshot=require('node:path').join(require('node:os').tmpdir(),`pi-release-${phase}-${width}.png`);
            await page.screenshot({path:screenshot});
            results.push({width,pageerrors:errors.length,metrics,screenshot,iconFonts,...(media?{media}:{})});
            await context.close();
        }
        const sessions=(await get('/api/pi/sessions?'+new URLSearchParams({cwd}))).sessions;
        assert.equal(sessions.length,1); assert.ok(sessions[0].messageCount>=2);
        console.log(JSON.stringify({phase,status:'passed',sessionId:sessions[0].id,results},null,2));
    } finally { await browser.close(); }
})().catch(e=>{ console.error(e);process.exitCode=1; });
