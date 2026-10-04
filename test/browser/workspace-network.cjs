const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-access-network-'));
const project = path.join(root, 'project'); fs.mkdirSync(project);
const token = 'isolated-network-browser-token';
(async () => {
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
    const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'agent'), PORT: String(port), PI_MEDIA_PROFILE: 'clean', PI_MEDIA_CONFIG_DIR: path.join(root, 'config'), PI_MEDIA_DATA_DIR: path.join(root, 'media'), PI_PROJECT_ROOTS: project, PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_WEB_TOKEN: token };
    // No HOST: exercise the new safe default, not a fixture override.
    const server = spawn(process.execPath, ['server.js', '--direct'], { cwd: path.resolve(__dirname, '../..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
    const base = `http://127.0.0.1:${port}`;
    let browser;
    try {
        let ready = false;
        for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/access/status')).ok) { ready = true; break; } } catch {} if (server.exitCode !== null) break; await new Promise(r => setTimeout(r, 50)); }
        assert.ok(ready, log);
        const created = await fetch(base + '/api/pi/sessions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ cwd: project, name: 'Network UI fixture' }) });
        assert.equal(created.status, 201);
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const locale of ['zh-CN', 'en-US']) for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ locale, viewport: { width, height: 950 } }); const page = await context.newPage(); const errors = [];
            page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
            await page.route('https://**/*', route => route.abort());
            await page.goto(base + '/#/settings?tab=access'); await page.locator('#pi-token-dialog:not(.hidden)').waitFor();
            await page.locator('#pi-token-input').fill(token); await page.locator('#pi-token-form button[type=submit]').click();
            await page.locator('#pi-token-dialog').waitFor({ state: 'hidden' });
            await page.waitForFunction(() => window.WorkspaceNetwork && document.querySelector('#network-summary').textContent.includes('·'));
            if (await page.locator('#pi-project-dialog:not(.hidden)').isVisible()) await page.locator('#pi-project-dialog-close').click();
            assert.equal(await page.locator('#network-proxy-url').isVisible(), false);
            assert.equal(await page.locator('#network-listen-mode').isDisabled(), false);
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                const geometry = await page.evaluate(() => [...document.querySelectorAll('html,.workspace-settings-content,#workspace-access-panel,.network-card,input,select')].filter(n => n.getClientRects().length).map(n => ({ id: n.id, width: n.clientWidth, scroll: n.scrollWidth })));
                assert.ok(geometry.every(n => n.scroll <= n.width + 1), JSON.stringify(geometry));
                assert.ok(await page.locator('.network-card input,.network-card select').evaluateAll(nodes => nodes.every(n => parseFloat(getComputedStyle(n).fontSize) >= 16)));
                await page.screenshot({ path: path.join(root, `${locale}-${width}-${theme}.png`), fullPage: true });
                await page.locator('#network-proxy').scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(root, `${locale}-${width}-${theme}-proxy.png`), fullPage: true });
                await page.locator('#network-security').scrollIntoViewIfNeeded();
            }
            await page.locator('#network-proxy-mode').selectOption('custom'); await page.locator('#network-proxy-url').fill('http://127.0.0.1:7890');
            await page.locator('#network-proxy-save').click(); await page.locator('#network-pending:not([hidden])').waitFor();
            assert.equal(await page.locator('#network-summary').textContent().then(s => /自定义代理|Custom proxy/.test(s)), false, 'saved proxy must not be shown as active');
            assert.ok((await page.locator('#network-proxy-url').inputValue()).includes('7890'));
            await page.locator('#network-discard').click(); await page.locator('#network-pending').waitFor({ state: 'hidden' });
            await page.locator('#network-listen-mode').selectOption('devices'); await page.locator('#network-listen-save').click(); await page.locator('#network-pending:not([hidden])').waitFor();
            assert.equal(await page.locator('#network-summary').textContent().then(s => /仅本机|This computer only/.test(s)), true);
            await page.locator('#network-discard').click(); await page.locator('#network-pending').waitFor({ state: 'hidden' });
            await page.evaluate(() => { location.hash = '#/settings?tab=providers'; });
            await page.locator('#network-model-link').click(); await page.locator('#network-proxy').waitFor();
            assert.ok(await page.locator('#network-proxy').evaluate(n => n.getBoundingClientRect().top >= 0));
            assert.deepEqual(errors, []); await context.close(); console.log(`PASS ${locale} ${width}: themes, scoped saves, pending/discard, navigation, no overflow/pageerror`);
        }
        console.log(`Isolated UI evidence: ${root}`);
    } finally {
        await browser?.close();
        if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
        // Keep only UI screenshots, never synthetic identity or credentials.
        for (const name of fs.readdirSync(root)) if (!name.endsWith('.png')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
