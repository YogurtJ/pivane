const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
    const app = express(); app.use(express.static(path.join(root, 'public')));
    app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/brand/fontawesome-6.4.0/css/all.min.css"><link rel="stylesheet" href="/pi-updates.css"><style>body{margin:0}#workspace-settings-dialog.hidden{display:none}</style></head><body>
        <button id="workspace-settings-toggle">Settings</button><button data-settings-tab="updates">Updates</button><div id="workspace-settings-dialog" class="hidden"></div>
        <script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-update-notifications.js"></script>
        <script>window.events=[];addEventListener('workspace:open-settings',e=>events.push(e.detail));
        const n=PiUpdateNotifications.create({apiFetch:async(url,opts)=>{const r=await fetch(url,opts);if(!r.ok)throw Error('fixture');return r.json()}});document.querySelector('#workspace-settings-dialog').append(n.element);</script>
        </body></html>`));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 393, 1024, 1440]) {
            const context = await browser.newContext({ locale, viewport: { width, height: 800 } });
            const page = await context.newPage(); const errors = [], posts = [];
            page.on('pageerror', e => errors.push(e.message)); await page.clock.install();
            let calls = 0, fail = false;
            let state = { enabled: true, available: false, eligible: false, idle: false, currentVersion: '0.86.1', version: null, nextCheckAt: null };
            await page.route('**/api/pi/settings/updates/**', async route => {
                const url = new URL(route.request().url()), body = route.request().postDataJSON();
                if (route.request().method() !== 'GET') posts.push({ path: url.pathname, body });
                if (fail) return route.fulfill({ status: 503, json: {} });
                if (url.pathname.endsWith('/automatic')) { calls++; state = { ...state, available: true, eligible: true, version: '0.86.2', nextCheckAt: Date.now() + 86400000 }; }
                if (body?.action === 'claim') { const claimed = state.idle && state.eligible; if (claimed) state.eligible = false; return route.fulfill({ json: { ...state, claimed } }); }
                if (body?.action === 'snooze') state.eligible = false;
                if (body?.action === 'ignore') state.available = false;
                if (typeof body?.enabled === 'boolean') state = { ...state, enabled: body.enabled, available: body.enabled && state.available };
                return route.fulfill({ json: state });
            });
            await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
            await page.clock.fastForward(5000);
            await page.locator('#workspace-settings-toggle .pi-update-badge:not([hidden])').waitFor();
            assert.equal(calls, 1); assert.equal(await page.locator('#pi-update-notice').isVisible(), false, 'busy work defers popup');
            const refresh = async () => { await page.evaluate(() => dispatchEvent(new Event('focus'))); await page.clock.fastForward(5000); };
            state.idle = true; await refresh(); await page.locator('#pi-update-notice').waitFor();
            assert.ok((await page.locator('#pi-update-notice').innerText()).includes(locale === 'en-US' ? 'Review and update' : '查看并更新'));
            const box = await page.locator('#pi-update-notice').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
            assert.equal(await page.locator('#pi-update-notice').evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
            await page.locator('#pi-update-notice-snooze').click(); await page.waitForFunction(() => document.getElementById('pi-update-notice').hidden);
            assert.equal(calls, 1);
            // The server owns the three-day deadline (covered with a fake clock in Node tests).
            state.eligible = true; await refresh(); await page.locator('#pi-update-notice').waitFor();
            await page.locator('#pi-update-notice-ignore').click(); await page.waitForFunction(() => document.querySelector('.pi-update-badge').hidden);
            state = { ...state, available: true, eligible: true, version: '0.87.0' }; await refresh(); await page.locator('#pi-update-notice').waitFor();
            const artifacts = process.env.PI_BROWSER_ARTIFACT_DIR || require('node:os').tmpdir();
            for (const theme of ['daylight', 'dark', 'mint']) {
                await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
                const card = page.locator('#pi-update-notice');
                assert.ok((await card.boundingBox()).height < 230, 'card stays compact, including English on mobile');
                assert.equal(await card.evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
                await card.screenshot({ path: path.join(artifacts, `pi-update-notice-${locale}-${width}-${theme}.png`) });
            }
            await page.locator('#pi-update-notice-open').click();
            assert.deepEqual(await page.evaluate(() => events), [{ tab: 'updates', updatePi: true }]);
            assert.ok(posts.every(p => !/execute|review/.test(p.path)), 'notification cannot execute maintenance');
            await page.evaluate(() => document.getElementById('workspace-settings-dialog').classList.remove('hidden'));
            await page.locator('#updates-auto-check').uncheck(); await page.waitForFunction(() => document.querySelector('.pi-update-badge').hidden);
            state.nextCheckAt = null; await refresh(); assert.equal(calls, 1, 'disabled setting prevents automatic requests');
            const beforePreview = posts.length;
            await page.locator('#updates-notice-preview').click();
            await page.locator('#pi-update-notice-preview').waitFor();
            for (const action of ['open', 'snooze', 'ignore']) await page.locator('#pi-update-notice-preview-' + action).click();
            assert.equal(posts.length, beforePreview, 'preview never claims, snoozes, ignores or installs');
            assert.equal(await page.evaluate(() => events.length), 1, 'preview never opens real maintenance');
            assert.ok((await page.locator('#pi-update-notice-preview .pi-update-feedback').textContent()).includes(locale === 'en-US' ? 'No action' : '未执行'));
            await page.locator('#pi-update-notice-preview-open').focus(); await page.keyboard.press('Escape');
            assert.equal(await page.locator('#updates-notice-preview').getAttribute('aria-expanded'), 'false');
            assert.equal(await page.locator('#updates-notice-preview').evaluate(e => e === document.activeElement), true);
            await page.locator('#updates-notice-preview').click(); await page.locator('#pi-update-notice-preview-close').click();
            assert.equal(await page.locator('#updates-notice-preview-area').isVisible(), false);
            fail = true; await refresh(); assert.deepEqual(errors, []);
            console.log(JSON.stringify({ locale, width, errors, busyDeferred: true, snoozeIgnoreAndNextVersion: true, confirmationOnly: true }));
            await context.close();
        }
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
