const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SHELL_LIVE_URL || 'http://127.0.0.1:3131';
const cwd = '/tmp/pi-web-shell-preview/project';
(async () => {
    const url = new URL(base);
    assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '3001');
    const status = await (await fetch(base + '/api/pi/status')).json();
    assert.equal(status.userShell, true); assert.deepEqual(status.projectRoots, [cwd]);
    const response = await fetch(base + '/api/pi/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, name: 'Isolated shell smoke' }) });
    assert.equal(response.status, 201); const session = await response.json();
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const errors = [], sent = [];
    try {
        const pages = [];
        for (const width of [1440, 393]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
            await context.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); }, { cwd, id: session.id });
            const page = await context.newPage(); pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            page.on('websocket', socket => socket.on('framesent', event => { try { sent.push(JSON.parse(event.payload)); } catch {} }));
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.querySelector('#pi-input').disabled, null, { timeout: 60000 });
        }
        const [desktop, mobile] = pages;
        await desktop.locator('#pi-input').fill("!printf 'WEB_SHELL_SMOKE'; sleep 3; printf '_DONE'");
        await desktop.locator('#pi-send-button').click();
        await mobile.waitForFunction(() => document.querySelector('.pi-shell-output')?.textContent.includes('WEB_SHELL_SMOKE'));
        await mobile.reload({ waitUntil: 'domcontentloaded' });
        await mobile.waitForFunction(() => document.querySelector('.pi-bash-message')?.textContent.includes('_DONE'), null, { timeout: 30000 });
        await desktop.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 1 && !document.querySelector('.pi-shell-live'));
        await desktop.locator('#pi-input').fill("!!printf 'CANCEL_SMOKE'; sleep 30");
        await desktop.locator('#pi-send-button').click();
        await mobile.waitForFunction(() => document.querySelector('.pi-shell-output')?.textContent.includes('CANCEL_SMOKE'));
        await mobile.locator('.pi-shell-live button').click();
        await desktop.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 2 && !document.querySelector('.pi-shell-live'));
        assert.match(await desktop.locator('.pi-bash-message').last().textContent(), /已停止/);
        assert.match(await mobile.locator('.pi-bash-message').last().textContent(), /不加入模型上下文/);
        await desktop.locator('#pi-input').fill('!exit 7'); await desktop.locator('#pi-send-button').click();
        await desktop.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 3 && !document.querySelector('.pi-shell-live'));
        assert.match(await desktop.locator('.pi-bash-message').last().textContent(), /exit 7/);
        assert.equal(await desktop.locator('#pi-input').inputValue(), '');
        assert.equal(sent.filter(record => ['prompt', 'steer', 'follow_up'].includes(record.type)).length, 0);
        const activity = await (await fetch(base + '/api/pi/activity')).json();
        assert.equal(activity.runtimes.filter(r => r.sessionId === session.id).length, 1);
        assert.equal(activity.runtimes.find(r => r.sessionId === session.id).busy, false);
        await desktop.locator('#pi-input').fill("!printf 'QUIT_SMOKE'; sleep 30"); await desktop.locator('#pi-send-button').click();
        await desktop.waitForFunction(() => document.querySelector('.pi-shell-output')?.textContent.includes('QUIT_SMOKE'));
        await desktop.locator('#pi-input').fill('/quit');
        assert.equal(await desktop.locator('#pi-send-button').isEnabled(), true, '/quit remains available while Shell occupies the session');
        await desktop.locator('#pi-send-button').click();
        await desktop.waitForFunction(() => document.querySelector('#pi-composer-status').textContent.includes('已退出'));
        assert.equal((await (await fetch(base + '/api/pi/activity')).json()).runtimes.some(r => r.sessionId === session.id), false);
        assert.deepEqual(errors, []); console.log('Isolated live WebUI / native RPC: two devices, refresh, stop, exclusion and failure passed; no model prompts');
    } finally {
        await browser.close();
        const removed = await fetch(base + '/api/pi/sessions/' + encodeURIComponent(session.id) + '?cwd=' + encodeURIComponent(cwd), { method: 'DELETE' });
        assert.equal(removed.ok, true);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
