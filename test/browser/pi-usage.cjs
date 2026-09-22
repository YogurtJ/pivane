const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_USAGE_TEST_URL || 'http://127.0.0.1:3123';
const live = process.env.PI_USAGE_LIVE === '1';
function fixture(query) {
    const total = { input: 10000, output: 2000, cacheRead: 30000, cacheWrite: 4000, total: 46000, cost: 1.234,
        records: 10, missingUsage: 0, missingCost: 1, zeroCost: 2, estimatedRecords: 7, unpricedRecords: 1 };
    const daily = [];
    for (let d = Date.parse(query.get('from')); d <= Date.parse(query.get('to')); d += 86400000) daily.push({ ...total, date: new Date(d).toISOString().slice(0, 10) });
    return { ledger: true, weekly: [{ ...total, date: '2026-09-21' }], monthly: [{ ...total, date: '2026-09' }], from: query.get('from'), to: query.get('to'), timeZone: query.get('timeZone'), generatedAt: new Date().toISOString(), total, daily,
        coverage: { scannedFiles: 25, skippedFiles: 0, duplicates: 5, invalidDates: 0 }, partial: false,
        providers: [{ ...total, provider: 'fixture' }], models: [{ ...total, provider: 'fixture', model: '<img src=x onerror=alert(1)>' + 'very-long-model/'.repeat(20) }],
        projects: [{ ...total, cwd: '/fixture/' + 'long-project/'.repeat(15) }],
        sessions: Array.from({ length: 25 }, (_, i) => ({ ...total, name: `会话 ${i}`, cwd: '/fixture/project', id: String(i) })) };
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: width === 1440 ? 1000 : 852 }, isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(), errors = [], writes = [], calls = [];
            let mode = 'normal', supported = true, release = null;
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/api/**', async route => {
                const request = route.request(), url = new URL(request.url()), path = url.pathname;
                if (request.method() !== 'GET') writes.push(path);
                if (live && ['/api/pi/status', '/api/pi/settings/usage'].includes(path)) return route.continue();
                if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, usageStats: supported, projectRoots: ['/fixture'] } });
                if (path === '/api/pi/settings/usage') {
                    calls.push(url.searchParams.toString()); const data = fixture(url.searchParams);
                    if (mode === 'delay') await new Promise(resolve => { release = resolve; });
                    if (mode === 'error') return route.fulfill({ status: 503, json: { error: '暂时不可用' } });
                    if (mode === 'empty') { for (const key of Object.keys(data.total)) data.total[key] = 0; data.models = []; data.providers = []; data.projects = []; data.sessions = []; }
                    if (mode === 'partial') { data.partial = true; data.coverage.skippedFiles = 2; data.total.missingUsage = 1; }
                    return route.fulfill({ json: data });
                }
                if (path === '/api/pi/settings/models') return route.fulfill({ json: { providers: [], models: [], preferences: {}, customProviders: [] } });
                if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd: '/fixture/project', name: 'Fixture', sessionCount: 0 }], roots: ['/fixture'] } });
                if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
                if (path === '/api/pi/settings/resources') return route.fulfill({ json: { packages: [], skills: [], diagnostics: [] } });
                if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
                if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
                return route.fulfill({ json: {} });
            });
            await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('No runtime should be opened'); });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.locator('#workspace-settings-toggle').click();
            assert.equal(calls.length, 0);
            await page.locator('[data-settings-tab="usage"]').click();
            await page.locator('.pi-usage-cards').waitFor();
            if (live) {
                const dimensions = await page.evaluate(() => ['body', '.workspace-settings-nav', '.workspace-settings-content', '#settings-usage-panel', '#settings-usage-result'].map(selector => {
                    const e = document.querySelector(selector); return { selector, client: e.clientWidth, scroll: e.scrollWidth };
                }));
                for (const metric of dimensions) assert.ok(metric.scroll <= metric.client + 1, `${width} ${JSON.stringify(metric)}`);
                assert.match(await page.locator('#settings-usage-status').textContent(), /已扫描/);
                assert.deepEqual(errors, []); assert.deepEqual(writes, []);
                await page.screenshot({ path: `/tmp/pi-usage-live-${width}.png` });
                console.log(JSON.stringify({ width, live: true, errors, writes }));
                await context.close(); continue;
            }
            assert.ok(calls[0].includes('timeZone='));
            const panel = page.locator('#settings-usage-panel');
            assert.ok((await panel.textContent()).includes('46,000')); assert.equal(await panel.locator('img').count(), 0);
            for (const theme of ['daylight', 'mint', 'night']) {
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                const dimensions = await page.evaluate(() => ['body', '.workspace-settings-nav', '.workspace-settings-content', '#settings-usage-panel', '#settings-usage-result'].map(selector => {
                    const e = document.querySelector(selector); return { selector, client: e.clientWidth, scroll: e.scrollWidth };
                }));
                for (const m of dimensions) assert.ok(m.scroll <= m.client + 1, `${width} ${theme} ${JSON.stringify(m)}`);
                await page.screenshot({ path: `/tmp/pi-usage-${width}-${theme}.png` });
            }
            if (width < 900) assert.ok(await page.locator('#settings-usage-from').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
            await page.locator('.pi-usage-bar').first().focus();
            assert.match(await page.locator('.pi-usage-section').first().textContent(), /缓存写入/);
            await page.getByLabel('每日趋势指标').selectOption('cost');
            assert.match(await page.locator('.pi-usage-bar').first().getAttribute('aria-label'), /\$/);
            assert.match(await panel.textContent(), /删除会话后仍保留统计/);
            await page.getByLabel('汇总周期', { exact: true }).selectOption('weekly');
            assert.equal(await page.locator('.pi-usage-bar').count(), 1);
            await page.getByLabel('汇总周期', { exact: true }).selectOption('monthly');
            assert.match(await page.locator('.pi-usage-section').first().textContent(), /自然月用量/);
            await page.getByLabel('汇总周期', { exact: true }).selectOption('daily');
            await page.getByText('会话明细（25）', { exact: true }).click();
            await page.locator('details .pi-usage-table-scroll tbody tr').first().waitFor();
            assert.equal(await page.locator('details .pi-usage-table-scroll tbody tr').count(), 20);
            await page.getByText('显示更多（20 / 25）', { exact: true }).click();
            assert.equal(await page.locator('details .pi-usage-table-scroll tbody tr').count(), 25);
            assert.equal(await page.getByText('显示更多（25 / 25）', { exact: true }).isVisible(), false);
            await page.locator('#settings-usage-range').selectOption('week');
            await page.locator('.pi-usage-cards').waitFor(); assert.equal(await page.locator('.pi-usage-bar').count(), 7);
            await page.locator('#settings-usage-range').selectOption('today');
            await page.locator('.pi-usage-cards').waitFor(); assert.equal(await page.locator('.pi-usage-bar').count(), 1);
            await page.locator('#settings-usage-from').fill('2026-02-01'); await page.locator('#settings-usage-to').fill('2026-02-03');
            await page.locator('#settings-usage-filters button').click(); await page.locator('.pi-usage-cards').waitFor();
            assert.equal(await page.locator('.pi-usage-bar').count(), 3);
            mode = 'error'; await page.locator('#settings-usage-filters button').click();
            await page.waitForFunction(() => document.getElementById('settings-usage-status').textContent.includes('统计失败'));
            assert.equal(await page.locator('.pi-usage-cards').count(), 0);
            mode = 'partial'; await page.locator('#settings-usage-filters button').click(); await page.locator('.pi-usage-warning').waitFor();
            mode = 'empty'; await page.locator('#settings-usage-filters button').click(); await page.locator('#settings-usage-result .settings-empty').waitFor();
            mode = 'delay'; await page.locator('#settings-usage-filters button').click();
            await page.waitForFunction(() => document.getElementById('settings-usage-status').textContent.includes('正在读取'));
            while (!release) await new Promise(resolve => setTimeout(resolve, 10));
            await page.locator('#settings-usage-from').fill('2026-02-02'); release(); mode = 'normal';
            assert.equal(await page.locator('.pi-usage-cards').count(), 0);
            assert.match(await page.locator('#settings-usage-status').textContent(), /日期已修改/);
            supported = false;
            await page.locator('#settings-usage-filters button').click();
            await page.waitForFunction(() => document.getElementById('settings-usage-status').textContent.includes('尚未启用'));
            assert.deepEqual(errors, []); assert.deepEqual(writes, []);
            console.log(JSON.stringify({ width, errors, writes, requests: calls.length })); await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
