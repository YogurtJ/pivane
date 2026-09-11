const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_ACCESS_TEST_URL;
if (!base || new URL(base).port === '3001') throw Error('Set PI_ACCESS_TEST_URL to an isolated instance, never production');
const token = 'browser-fixture-access-token-987654321';
(async () => {
    const status = await (await fetch(base + '/api/pi/status')).json();
    assert.ok(status.projectRoots.every(p => p.startsWith('/tmp/pi-access-')), 'must use isolated project roots');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: width === 1440 ? 1000 : 852 } });
            const page = await context.newPage(); const errors = [];
            page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.WorkspaceAccess?.supported === true);
            if (await page.locator('#pi-project-dialog:not(.hidden)').isVisible()) await page.locator('#pi-project-dialog-close').click();
            await page.evaluate(() => { document.querySelector('#workspace-settings-toggle').click(); });
            await page.locator('[data-settings-tab="access"]').click();
            await page.locator('#workspace-access-enabled').waitFor();
            await page.locator('#workspace-access-enabled').check();
            await page.locator('#workspace-access-token').fill(token);
            await page.locator('#workspace-access-save').click();
            await page.waitForFunction(() => document.querySelector('#workspace-access-result')?.textContent.includes('已保存'));
            assert.equal((await fetch(base + '/api/pi/status')).status, 401);
            const freshContext = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 852 } });
            const fresh = await freshContext.newPage();
            fresh.on('pageerror', e => errors.push(e.message));
            await fresh.route(/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)\//, route => route.abort());
            await fresh.goto(base, { waitUntil: 'domcontentloaded' });
            await fresh.locator('#pi-token-dialog:not(.hidden)').waitFor();
            assert.equal(await fresh.evaluate(() => document.querySelector('.app-container').inert), true);
            assert.equal(await fresh.locator('#pi-token-input').inputValue(), '');
            for (const theme of ['daylight', 'mint', 'dark']) {
                await fresh.evaluate(t => document.documentElement.dataset.theme = t, theme);
                const layout = await fresh.evaluate(() => {
                    const form = document.querySelector('#pi-token-form'), box = form.getBoundingClientRect();
                    const input = document.querySelector('#pi-token-input'), checkbox = document.querySelector('#workspace-access-remember').getBoundingClientRect();
                    const brand = document.querySelector('.workspace-login-brand').getBoundingClientRect();
                    return { padding: brand.left - box.left, checkbox: [checkbox.width, checkbox.height], font: parseFloat(getComputedStyle(input).fontSize), overflow: form.scrollWidth > form.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth, logo: document.querySelector('.workspace-login-brand img').naturalWidth };
                });
                assert.ok(layout.padding >= 24 && layout.checkbox.every(n => n >= 16 && n <= 20), 'login padding and checkbox must not inherit legacy text-field sizes');
                assert.ok(layout.font >= 16 && !layout.overflow && layout.logo > 0);
                await fresh.screenshot({ path: `/tmp/pi-login-ui-${width}-${theme}.png` });
            }
            await fresh.locator('#pi-token-input').fill('visibility-fixture');
            await fresh.locator('#workspace-access-token-visibility').click();
            assert.equal(await fresh.locator('#pi-token-input').getAttribute('type'), 'text');
            await fresh.locator('#workspace-access-token-visibility').click();
            assert.equal(await fresh.locator('#pi-token-input').getAttribute('type'), 'password');
            await fresh.locator('.workspace-login-help summary').click();
            await fresh.keyboard.press('Tab');
            assert.equal(await fresh.evaluate(() => document.activeElement.id), 'pi-token-input', 'focus wraps across the help control');
            await fresh.keyboard.press('Shift+Tab');
            assert.equal(await fresh.evaluate(() => document.activeElement.tagName), 'SUMMARY');
            await fresh.setViewportSize({ width, height: 420 });
            await fresh.locator('.workspace-login-submit').scrollIntoViewIfNeeded();
            assert.ok(await fresh.locator('.workspace-login-submit').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'short screens can scroll to submit');
            await freshContext.close();
            assert.equal(await page.evaluate(() => sessionStorage.getItem('pi.web.token')), null);
            assert.ok((await context.cookies()).some(c => c.name.startsWith('pi_access_') && c.httpOnly && c.sameSite === 'Strict'));
            await page.evaluate(() => { const input = document.querySelector('#pi-input'); input.value = '保留未发送草稿'; input.dispatchEvent(new Event('input', { bubbles: true })); });
            await page.locator('#workspace-access-logout').click();
            await page.locator('#pi-token-dialog:not(.hidden)').waitFor();
            await page.locator('#pi-token-input').fill('wrong-token'); await page.locator('#pi-token-form button[type="submit"]').click();
            await page.waitForFunction(() => document.querySelector('#workspace-access-login-error')?.textContent.includes('Token'));
            await page.locator('#pi-token-input').fill(token); await page.locator('#workspace-access-remember').check(); await page.locator('#pi-token-form button[type="submit"]').click();
            await page.locator('#pi-token-dialog').waitFor({ state: 'hidden' });
            assert.equal(await page.locator('#pi-input').inputValue(), '保留未发送草稿');
            assert.equal(await page.evaluate(() => sessionStorage.getItem('pi.web.token')), null);
            await page.locator('[data-settings-tab="access"]').click();
            await page.locator('#workspace-access-revoke').click();
            await page.locator('#pi-token-dialog:not(.hidden)').waitFor();
            await page.locator('#pi-token-input').fill(token); await page.locator('#pi-token-form button[type="submit"]').click();
            await page.locator('#pi-token-dialog').waitFor({ state: 'hidden' });
            await page.locator('[data-settings-tab="access"]').click();
            await page.locator('#workspace-access-generate').check(); await page.locator('#workspace-access-save').click();
            await page.locator('#workspace-access-generated:not([hidden])').waitFor();
            assert.ok((await page.locator('#workspace-access-generated-token').inputValue()).length >= 32);
            assert.equal(await page.locator('#workspace-access-token').inputValue(), '');
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
                assert.ok(await page.locator('#workspace-access-token').evaluate(e => {
                    const style = getComputedStyle(e);
                    const light = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
                    const a = light(style.color), b = light(style.backgroundColor);
                    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5;
                }), 'token field contrast must be readable in every theme');
                assert.ok(await page.evaluate(() => [document.documentElement, document.querySelector('#workspace-access-panel'), document.querySelector('.workspace-settings-content')].filter(Boolean).every(e => e.scrollWidth <= e.clientWidth + 1)), 'internal widths must fit');
            }
            assert.ok(await page.locator('#workspace-access-token').evaluate(e => window.innerWidth > 680 || parseFloat(getComputedStyle(e).fontSize) >= 16));
            await page.screenshot({ path: `/tmp/pi-access-${width}.png` });
            await page.locator('#workspace-access-enabled').uncheck(); await page.locator('#workspace-access-save').click();
            await page.waitForFunction(() => document.querySelector('#workspace-access-result')?.textContent.includes('已保存'));
            assert.equal((await fetch(base + '/api/pi/status')).status, 200);
            await page.route('**/api/access/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture status unavailable' }) }));
            await page.evaluate(async () => { window.auditAccessReady = 0; window.addEventListener('workspace:access-ready', () => window.auditAccessReady++); await window.WorkspaceAccess.refresh(); });
            assert.equal(await page.evaluate(() => window.auditAccessReady), 0, 'failed status must not announce a successful login or reconnect');
            await page.unroute('**/api/access/status');
            assert.deepEqual(errors, []);
            console.log(`PASS ${width}: open/enabled/login/logout/revoke/rotation/draft, three themes, no pageerror or overflow`);
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
