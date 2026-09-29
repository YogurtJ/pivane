const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { randomUUID } = require('node:crypto');
const cwd = '/synthetic/assistant';
const profileId = randomUUID(), sessionId = randomUUID();
async function check(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, isMobile: width < 680, hasTouch: width < 680 });
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(language => { localStorage.setItem('pi.workspace.language', language); localStorage.setItem('pi.workspace.theme', 'daylight'); }, language);
    const jobs = [], homes = [], now = Date.now();
    const limits = { maxRunsPerDay: 40, maxTokensPerDay: 400000, maxCostPerDay: null };
    await page.route('**/api/**', route => {
        const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
        const send = data => route.fulfill({ json: data });
        if (req.method() !== 'GET') writes.push({ path: url.pathname, body });
        if (url.pathname === '/api/pi/status') return send({ ok: true, scheduledTasks: true, projectRoots: ['/synthetic'] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Assistant', sessionCount: 1 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/profiles') return send({ profiles: [{ id: profileId, name: 'Assistant <img src=x onerror=alert(1)>', enabled: true }] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions: [{ id: sessionId, cwd, name: 'Main conversation', agentProfile: { id: profileId } }] });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], replyNotices: [] });
        if (url.pathname === '/api/pi/cron') return send({ jobs, homes, limits, today: { runs: 0, tokens: 0, cost: 0 } });
        if (url.pathname === '/api/pi/cron/preview') return send({ times: Array.from({ length: 5 }, (_, i) => now + (i + 1) * 86400000) });
        if (url.pathname === '/api/pi/cron/jobs') { jobs.push({ ...body, revision: 1, nextAt: now + 86400000 }); return send(jobs.at(-1)); }
        if (url.pathname === `/api/pi/cron/homes/${profileId}`) {
            const home = { profileId, revision: 1, status: 'ready', cwd: body.cwd, sessionId: body.sessionId, name: 'Main conversation' };
            homes.push(home); return send(home);
        }
        if (url.pathname.endsWith('/runs')) return send({ runs: [] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.goto(base + '/#/cron');
    const zh = language === 'zh-CN';
    await page.getByRole('button', { name: zh ? '新建任务' : 'New task', exact: true }).click();
    await page.getByLabel(zh ? '任务名称' : 'Task name').fill('Daily briefing <img src=x onerror=alert(1)>');
    await page.getByLabel(zh ? '工作目录' : 'Working directory', { exact: false }).fill(cwd);
    await page.getByLabel(zh ? '工作目录' : 'Working directory', { exact: false }).press('Tab');
    await page.getByLabel(zh ? '目标线程' : 'Target thread', { exact: true }).selectOption(sessionId);
    await page.getByLabel(zh ? '时间' : 'Time', { exact: true }).fill('17:00');
    const futureStart = await page.evaluate(() => { const d = new Date(Date.now() + 86400000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
    await page.getByLabel(zh ? '生效时间' : 'Starts on', { exact: true }).fill(futureStart);
    await page.getByLabel(zh ? '提示词' : 'Prompt', { exact: true }).fill('A warm, short greeting. Stay silent if the user is busy.');
    await page.locator('.cron-card summary').click();
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#cron-tab input, #cron-tab select, #cron-tab textarea, #cron-tab button, #cron-tab .cron-card')]
        .filter(n => { const r = n.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(n => n.className));
    assert.deepEqual(overflow, []);
    if (width < 680) assert.ok(await page.locator('.cron-page textarea').evaluate(n => parseFloat(getComputedStyle(n).fontSize) >= 16));
    await page.screenshot({ path: `/tmp/pivane-cron-form-${width}-${language}.png`, fullPage: true });
    await page.getByRole('button', { name: zh ? '保存任务' : 'Save task', exact: true }).click();
    await page.locator('.cron-detail-head').waitFor();
    assert.equal(jobs[0].schedule.expression, '0 17 * * *');
    assert.equal(jobs[0].target.sessionId, sessionId);
    assert.equal(jobs[0].enabled, false);
    assert.ok(jobs[0].startsAt > now);
    assert.equal(await page.locator('#cron-tab [onerror]').count(), 0);
    await page.screenshot({ path: `/tmp/pivane-cron-detail-${width}-${language}.png`, fullPage: true });
    await page.getByRole('button', { name: zh ? '编辑' : 'Edit', exact: true }).click();
    await page.getByLabel(zh ? '任务名称' : 'Task name').fill('Unsaved draft');
    await page.evaluate(() => window.PiWorkspaceRoute.navigate('chat'));
    await page.evaluate(() => window.PiWorkspaceRoute.navigate('cron'));
    assert.equal(await page.getByLabel(zh ? '任务名称' : 'Task name').inputValue(), 'Unsaved draft');
    await page.getByRole('button', { name: zh ? '主线程' : 'Main threads', exact: true }).click();
    await page.getByRole('button', { name: zh ? '放弃修改' : 'Discard changes', exact: true }).click();
    await page.getByLabel(zh ? '目标线程' : 'Target thread', { exact: true }).selectOption(sessionId);
    await page.getByRole('button', { name: zh ? '设为主线程' : 'Set as main thread', exact: true }).click();
    await page.getByRole('button', { name: zh ? '打开主线程' : 'Open main thread', exact: true }).waitFor();
    assert.equal(homes[0].sessionId, sessionId);
    assert.equal(homes[0].cwd, cwd);
    await page.screenshot({ path: `/tmp/pivane-cron-main-${width}-${language}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(writes.filter(w => w.path === '/api/pi/cron/jobs').length, 1);
    await context.close();
}
(async () => {
    const app = express(), root = path.resolve(__dirname, '../..');
    for (const [url, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await check(browser, `http://127.0.0.1:${server.address().port}`, width, language);
        console.log('Scheduled tasks: desktop/mobile, two languages, editing, preview, XSS and draft checks passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
