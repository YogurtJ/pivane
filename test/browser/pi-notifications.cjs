const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_NOTIFICATION_TEST_URL || 'http://127.0.0.1:3131';
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(); const errors = []; let enabled = false; let tests = 0; let keys = 0; let notices = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.addInitScript(() => {
                const sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/test', keys: { auth: 'test', p256dh: 'test' } }), options: {}, unsubscribe: async () => { window.testSub = false; return true; } };
                window.testSub = false; window.permissionCalls = 0;
                window.shown = [];
                function Notification(title, options) { window.shown.push(options); this.close = () => {}; } Notification.permission = 'default';
                Notification.requestPermission = async () => { window.permissionCalls++; Notification.permission = 'granted'; return 'granted'; };
                window.Notification = Notification; window.PushManager = function () {};
                const reg = { showNotification: async (title, options) => window.shown.push(options), active: { scriptURL: location.origin + '/pi-notification-sw.js' }, pushManager: {
                    getSubscription: async () => window.testSub ? sub : null,
                    subscribe: async () => { window.testSub = true; return sub; }
                } };
                Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg) } });
            });
            await page.route('**/api/**', async route => {
                const req = route.request(), p = new URL(req.url()).pathname;
                let data = {};
                if (p === '/api/access/status') data = { accessControl: true, authenticated: true, enabled: false };
                if (p === '/api/pi/status') data = { ok: true, browserNotifications: true, projectRoots: ['/tmp/fixture'] };
                if (p === '/api/pi/projects') data = { projects: [{ cwd: '/tmp/fixture', name: 'Fixture', sessionCount: 0 }], roots: ['/tmp/fixture'] };
                if (p === '/api/pi/sessions') data = { sessions: [] };
                if (p === '/api/pi/settings/models') data = { models: [], providers: [], preferences: {}, customProviders: [] };
                if (p === '/api/pi/notifications/key') { keys++; data = { publicKey: 'BA' + 'A'.repeat(85) }; }
                if (p === '/api/pi/activity') data = { runtimes: [], replyNotices: notices };
                if (p === '/api/pi/notifications/status') data = { enabled };
                if (p === '/api/pi/notifications/subscription') { enabled = req.method() === 'PUT'; data = { enabled }; }
                if (p === '/api/pi/notifications/test') { tests++; data = { accepted: true }; }
                if (p.includes('history') || p === '/api/prompts') data = [];
                await route.fulfill({ json: data });
            });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.locator('#pi-project-dialog .pi-dialog-close').count().then(async n => { if (n) await page.locator('#pi-project-dialog .pi-dialog-close').click(); });
            await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); document.getElementById('pi-project-dialog')?.classList.add('hidden'); });
            await page.locator('#workspace-settings-toggle').click();
            await page.locator('[data-settings-tab="models"]').click();
            assert.equal(await page.evaluate(() => window.permissionCalls), 0);
            if (width < 900) await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android Chrome' }));
            await page.locator('#pi-page-notify').check();
            await page.waitForFunction(() => document.getElementById('pi-page-status').textContent.includes('页面打开时'));
            await page.locator('#pi-page-test').click();
            await page.waitForFunction(() => window.shown.length === 1);
            assert.equal(keys, 0, 'local notification must not initialize push');
            notices = [{ cwd: '/tmp/fixture', sessionId: 'fixture', completionId: 'new-reply', completedAt: new Date().toISOString() }];
            await page.waitForFunction(() => window.shown.length === 2, null, { timeout: 12000 });
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
                assert.ok(await page.locator('#pi-notification-card').evaluate(e => e.scrollWidth <= e.clientWidth + 1));
                await page.screenshot({ path: `/tmp/pi-notifications-local-${width}-${theme}.png` });
            }
            await page.evaluate(() => {
                PiPageNotifications.observeCompletion({ completionId: 'old', completedAt: '2020-01-01T00:00:00Z' });
                PiPageNotifications.observeCompletion({ completionId: 'manual', completedAt: new Date().toISOString(), manual: true });
            });
            assert.equal(await page.evaluate(() => window.shown.length), 2);
            assert.equal(keys, 0);
            await page.locator('.pi-notification-advanced summary').click();
            await page.locator('#pi-notification-enable').click();
            await page.waitForFunction(() => document.getElementById('pi-notification-status').textContent.includes('本设备已启用'));
            assert.equal(enabled, true);
            await page.locator('#pi-notification-test').click();
            await page.waitForFunction(() => document.getElementById('pi-notification-status').textContent.includes('测试已提交'));
            assert.equal(tests, 1);
            for (const selector of ['body', '.workspace-settings-content', '#pi-notification-card']) {
                assert.ok(await page.locator(selector).evaluate(e => e.scrollWidth <= e.clientWidth + 1), `${width}: ${selector} overflow`);
            }
            await page.screenshot({ path: `/tmp/pi-notifications-${width}.png` });
            await page.locator('#pi-notification-disable').click();
            await page.waitForFunction(() => document.getElementById('pi-notification-status').textContent.includes('尚未启用'));
            assert.equal(enabled, false);
            await page.evaluate(() => { Notification.permission = 'denied'; });
            await page.locator('#pi-notification-refresh').click();
            await page.waitForFunction(() => document.getElementById('pi-notification-status').textContent.includes('已被拒绝'));
            assert.equal(await page.locator('#pi-notification-enable').isDisabled(), true);
            await page.locator('#pi-page-notify').uncheck();
            await page.evaluate(() => { Notification.permission = 'default'; Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false }); });
            await page.locator('#pi-notification-refresh').click();
            await page.waitForFunction(() => document.getElementById('pi-notification-status').textContent.includes('HTTP'));
            assert.equal(await page.locator('#pi-notification-enable').isDisabled(), true);
            await page.locator('#pi-page-sound').check();
            await page.locator('#pi-page-test').click();
            await page.waitForFunction(() => document.getElementById('pi-page-status').textContent.includes('测试提醒已触发'));
            await page.locator('#pi-page-sound').uncheck();
            await page.evaluate(() => { Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true }); Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone Safari' }); });
            await page.locator('#pi-notification-refresh').click();
            await page.waitForFunction(() => document.getElementById('pi-notification-status').textContent.includes('主屏幕'));
            assert.equal(await page.locator('#pi-notification-enable').isDisabled(), true);
            assert.deepEqual(errors, []);
            console.log(`${width}: notification controls, permission, disable, test, layout passed`);
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
