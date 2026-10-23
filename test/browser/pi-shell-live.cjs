// pivane-browser: manual — needs an isolated live server with userShell and PI_SHELL_LIVE_PROJECT (defaults to the temporary pi-web-shell-preview/project fixture).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SHELL_LIVE_URL || 'http://127.0.0.1:3131';
const cwd = fs.realpathSync.native(process.env.PI_SHELL_LIVE_PROJECT || path.join(os.tmpdir(), 'pi-web-shell-preview', 'project'));
function modelRefreshReady(page, timeout) {
    const deadline = Date.now() + timeout;
    let socket, requestId, timer;
    const read = event => { try { return JSON.parse(event.payload.toString()); } catch { return null; } };
    const finished = new Promise((resolve, reject) => {
        const settle = error => {
            clearTimeout(timer); page.off('websocket', connected); page.off('close', closed);
            socket?.off('framesent', sent); socket?.off('framereceived', received); socket?.off('close', closed); socket?.off('socketerror', failed);
            error ? reject(error) : resolve();
        };
        const closed = () => settle(new Error('Connection closed before this page completed model refresh'));
        const failed = error => settle(new Error(`Model refresh connection failed: ${error}`));
        const sent = event => { const value = read(event); if (value?.type === 'refresh_models' && requestId === undefined) requestId = value.id; };
        const received = event => {
            const value = read(event);
            if (requestId === undefined || value?.type !== 'response' || value.command !== 'refresh_models' || value.id !== requestId) return;
            settle(value.success === true ? null : new Error(`Model refresh rejected: ${JSON.stringify(value)}`));
        };
        const connected = value => {
            const url = new URL(value.url());
            if (url.host !== new URL(base).host || url.pathname !== '/api/pi/ws' || socket) return;
            socket = value; socket.on('framesent', sent); socket.on('framereceived', received); socket.on('close', closed); socket.on('socketerror', failed);
        };
        page.on('websocket', connected); page.on('close', closed);
        timer = setTimeout(() => settle(new Error('This page did not complete model refresh within its readiness budget')), timeout);
    });
    finished.catch(() => {}); // Observed with the DOM readiness promise below.
    return { finished, remaining() { const left = deadline - Date.now(); assert.ok(left > 0, 'page readiness budget expired'); return left; } };
}
(async () => {
    const url = new URL(base);
    assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '3001');
    const status = await (await fetch(base + '/api/pi/status')).json();
    assert.equal(status.userShell, true); assert.deepEqual(status.projectRoots, [cwd]);
    const reminders = await fetch(base + '/api/pi/settings/updates/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Pi-Access': '1' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(reminders.status, 200);
    const reminderState = await reminders.json();
    assert.deepEqual([reminderState.enabled, reminderState.available, reminderState.eligible], [false, false, false]);
    const response = await fetch(base + '/api/pi/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, name: 'Isolated shell smoke' }) });
    assert.equal(response.status, 201); const session = await response.json();
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const errors = [], sent = [];
    try {
        const pages = [];
        for (const width of [1440, 393]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
            context.on('weberror', event => errors.push(event.error().message));
            await context.addInitScript(({ cwd, id }) => { if (!['http:', 'https:'].includes(location.protocol)) return; localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); }, { cwd, id: session.id });
            const page = await context.newPage(); pages.push(page);
            page.on('websocket', socket => {
                socket.on('framesent', event => { try { sent.push(JSON.parse(event.payload)); } catch {} });
                socket.on('framereceived', event => {
                    let value; try { value = JSON.parse(event.payload.toString()); } catch { return; }
                    if (value.type === 'response' && value.command === 'bash' && value.success === false) console.error('Synthetic Shell rejected', JSON.stringify(value));
                });
            });
            const ready = modelRefreshReady(page, 60000);
            await Promise.all([ready.finished, (async () => {
                await page.goto(base, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, ready.remaining()) });
                await page.waitForFunction(() => !document.querySelector('#pi-input').disabled, null, { timeout: ready.remaining() });
            })()]);
        }
        const [desktop, mobile] = pages;
        await desktop.locator('#pi-input').fill("!printf 'WEB_SHELL_SMOKE'; sleep 3; printf '_DONE'");
        await desktop.locator('#pi-send-button').click();
        await mobile.waitForFunction(() => document.querySelector('.pi-shell-output')?.textContent.includes('WEB_SHELL_SMOKE'));
        const reloaded = modelRefreshReady(mobile, 30000);
        await Promise.all([reloaded.finished, (async () => {
            await mobile.reload({ waitUntil: 'domcontentloaded', timeout: reloaded.remaining() });
            await mobile.waitForFunction(() => document.querySelector('.pi-bash-message')?.textContent.includes('_DONE'), null, { timeout: reloaded.remaining() });
            await desktop.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 1 && !document.querySelector('.pi-shell-live'), null, { timeout: reloaded.remaining() });
        })()]);
        await desktop.locator('#pi-input').fill("!!printf 'CANCEL_SMOKE'; sleep 30");
        await desktop.locator('#pi-send-button').click();
        await mobile.waitForFunction(() => document.querySelector('.pi-shell-output')?.textContent.includes('CANCEL_SMOKE'));
        await mobile.locator('.pi-shell-live button').click();
        await desktop.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 2 && !document.querySelector('.pi-shell-live'));
        await mobile.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 2 && !document.querySelector('.pi-shell-live'));
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
        await mobile.waitForFunction(() => document.querySelector('.pi-shell-output')?.textContent.includes('QUIT_SMOKE'));
        await mobile.locator('#pi-input').fill('另一设备退出后保留的草稿');
        await mobile.locator('#pi-file-input').setInputFiles({ name: 'peer-quit-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('unsent attachment survives peer quit') });
        await mobile.waitForFunction(() => document.querySelector('.pi-attachment-chip'));
        const opensBeforeQuit = sent.filter(record => record.type === 'open_session').length;
        await desktop.locator('#pi-input').fill('/quit');
        assert.equal(await desktop.locator('#pi-send-button').isEnabled(), true, '/quit remains available while Shell occupies the session');
        await desktop.locator('#pi-send-button').click();
        await desktop.waitForFunction(() => document.querySelector('#pi-composer-status').textContent.includes('已退出'));
        await mobile.waitForFunction(() => document.querySelector('#pi-composer-status').textContent.includes('已退出'));
        assert.equal(await mobile.locator('.pi-shell-live').count(), 0);
        assert.equal(await mobile.locator('#pi-stop-button').isVisible(), false);
        assert.equal(await mobile.locator('#pi-input').isDisabled(), true);
        assert.equal(await mobile.locator('#pi-input').inputValue(), '另一设备退出后保留的草稿');
        assert.equal(await mobile.locator('.pi-attachment-chip').count(), 1);
        await mobile.waitForTimeout(2000);
        assert.equal(sent.filter(record => record.type === 'open_session').length, opensBeforeQuit, 'received quit must not trigger automatic reopening');
        assert.equal((await (await fetch(base + '/api/pi/activity')).json()).runtimes.some(r => r.sessionId === session.id), false);
        for (const page of pages) assert.equal(await page.locator('.pi-toast').filter({ hasText: /会话同步失败|Session sync failed/ }).count(), 0,
            'confirmed quit must not leave a reconciliation error from the retiring runtime');
        await mobile.locator('#pi-toggle-sessions').click();
        await mobile.locator(`[data-session-id="${session.id}"] .pi-session-main`).click();
        await mobile.waitForFunction(() => !document.querySelector('#pi-input').disabled, null, { timeout: 60000 });
        assert.equal(await mobile.locator('#pi-input').inputValue(), '另一设备退出后保留的草稿');
        assert.equal(await mobile.locator('.pi-attachment-chip').count(), 1);
        assert.equal(await mobile.locator('.pi-shell-live').count(), 0);
        assert.equal((await (await fetch(base + '/api/pi/activity')).json()).runtimes.filter(r => r.sessionId === session.id).length, 1);
        assert.equal(await mobile.locator('.pi-toast').filter({ hasText: /会话同步失败|Session sync failed/ }).count(), 0,
            'explicit reopening must not retain a stale reconciliation error');
        assert.deepEqual(errors, []); console.log('Isolated live WebUI / native RPC: two devices, refresh, stop, exclusion, failure and peer quit/draft/attachment/reopen passed; no model prompts');
    } finally {
        await browser.close();
        const removed = await fetch(base + '/api/pi/sessions/' + encodeURIComponent(session.id) + '?cwd=' + encodeURIComponent(cwd), { method: 'DELETE' });
        assert.equal(removed.ok, true);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
