const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SETTINGS_LAYOUT_URL || 'http://127.0.0.1:3001';
const provider = `fixture-${'long-provider-'.repeat(8)}`;
const model = { provider, id: `model-${'long-model-name-'.repeat(10)}`, name: 'Example planning model with a detailed display name', available: true, reasoning: false, input: ['text'], contextWindow: 128000, thinkingLevels: ['off'] };
const catalog = { providers: [{ id: provider, name: provider, configured: true, modelCount: 1, authMethods: {} }], models: [model], customProviders: [], preferences: { mediaAgent: { provider, modelId: model.id } } };
function usage(query) {
    const total = { input: 138428557, output: 10000000, cacheRead: 900000000, cacheWrite: 32167705, total: 1080596262, cost: 1234.567, records: 1000, missingUsage: 0, missingCost: 0, zeroCost: 0 };
    return { from: query.get('from'), to: query.get('to'), timeZone: query.get('timeZone'), generatedAt: new Date().toISOString(), total,
        coverage: { scannedFiles: 72, skippedFiles: 0, duplicates: 5, invalidDates: 0 }, partial: false,
        daily: Array.from({ length: 90 }, (_, i) => ({ ...total, date: `2026-09-${String(i % 30 + 1).padStart(2, '0')}` })),
        providers: [{ ...total, provider }], models: [{ ...total, provider, model: model.id }], projects: [{ ...total, cwd: '/fixture/' + 'long-directory/'.repeat(20) }],
        sessions: [{ ...total, id: 'fixture', name: 'Fixture session', cwd: '/fixture/project' }] };
}
async function run(browser, width) {
    const viewport = { width, height: width >= 900 ? 1000 : 852 };
    const context = await browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [], requests = [];
    let hold = false, release;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ json: { ok: true } }); }
        if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, usageStats: true, projectRoots: ['/fixture'] } });
        if (url.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd: '/fixture/project', name: 'Fixture', sessionCount: 0 }], roots: ['/fixture'] } });
        if (url.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        if (url.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (url.pathname === '/api/pi/settings/models') return route.fulfill({ json: catalog });
        if (url.pathname === '/api/pi/settings/usage') {
            requests.push(url.searchParams.toString());
            const data = usage(url.searchParams);
            if (hold) await new Promise(resolve => { release = resolve; });
            return route.fulfill({ json: data });
        }
        if (url.pathname.includes('history')) return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('Settings layout must not open sessions'); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="models"]').click();
    await page.waitForFunction(id => document.getElementById('settings-media-agent-current').textContent.includes(id), model.id);
    assert.match(await page.locator('#settings-media-agent-description').textContent(), /多媒体实验室.*生成方案/);
    assert.equal(await page.locator('#settings-media-agent-provider').inputValue(), provider);
    assert.equal(await page.locator('#settings-media-agent-model').inputValue(), model.id);
    const check = async (selectors, stage) => {
        const dimensions = await page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(el => ({ selector, width: el.clientWidth, scroll: el.scrollWidth }))), selectors);
        for (const metric of dimensions) assert.ok(metric.scroll <= metric.width + 1, `${width} ${stage} ${JSON.stringify(metric)}`);
        const panel = page.locator('.workspace-settings-panel.active');
        assert.equal(await panel.evaluate(el => { el.scrollLeft = 100; return el.scrollLeft; }), 0);
        return dimensions;
    };
    const shared = ['.workspace-settings-dialog', '.workspace-settings-body', '.workspace-settings-content', '.workspace-settings-nav', '.workspace-settings-panel.active'];
    const preferences = await check([...shared, '#settings-media-agent-form', '.settings-feature-controls', '#settings-media-agent-current', '.pi-notification-card'], 'preferences');
    if (width <= 680) {
        const p = await page.locator('#settings-media-agent-provider').boundingBox();
        const m = await page.locator('#settings-media-agent-model').boundingBox();
        assert.ok(m.y >= p.y + p.height, 'phone provider and model fields must not compete for one row');
    }
    await page.screenshot({ path: `/tmp/pi-settings-preferences-${width}.png` });
    await page.locator('[data-settings-tab="usage"]').click();
    await page.locator('.pi-usage-cards').waitFor();
    const selectors = [...shared, '#settings-usage-filters', '#settings-usage-result', '#settings-usage-status', '.pi-usage-cards', '.pi-usage-cards>div', '.pi-usage-cards strong'];
    const usageDimensions = await check(selectors, 'usage');
    const controls = await page.locator('#settings-usage-filters input, #settings-usage-filters select, #settings-usage-filters button').evaluateAll(elements => elements.map(el => {
        const r = el.getBoundingClientRect(); const parent = el.closest('label') || el.parentElement; const p = parent.getBoundingClientRect();
        return { id: el.id || 'refresh', x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height, fits: r.left >= p.left - 1 && r.right <= p.right + 1, font: parseFloat(getComputedStyle(el).fontSize) };
    }));
    for (const control of controls) { assert.ok(control.fits, JSON.stringify(control)); assert.ok(Math.abs(control.height - 44) <= 1); }
    const [range, from, to, refresh] = controls;
    assert.ok(Math.abs(range.bottom - refresh.bottom) <= 1, 'preset and refresh must align');
    if (width <= 480) { assert.ok(from.y >= range.bottom); assert.ok(to.y >= from.bottom); }
    if (width < 900) { assert.ok(from.font >= 16 && to.font >= 16); }
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await check(selectors, theme);
        await page.screenshot({ path: `/tmp/pi-settings-usage-${width}-${theme}.png` });
    }
    await page.locator('.pi-usage-cards strong').first().evaluate(el => { el.textContent = '9,007,199,254,740,991'; });
    await check(selectors, 'very-large-total');
    const localScroll = await page.locator('.pi-usage-table-scroll').first().evaluate(el => { el.scrollLeft = 100; return { scroll: el.scrollLeft, width: el.clientWidth, parentWidth: el.parentElement.clientWidth }; });
    if (width < 900) assert.ok(localScroll.scroll > 0, 'tables must remain locally scrollable');
    assert.ok(localScroll.width <= localScroll.parentWidth);
    const button = page.locator('.pi-usage-refresh');
    hold = true; await button.click();
    await page.waitForFunction(() => document.getElementById('settings-usage-result').getAttribute('aria-busy') === 'true');
    assert.equal(await button.locator('i').evaluate(el => getComputedStyle(el).animationName), 'pi-spin');
    assert.equal((await button.boundingBox()).height, 44);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await button.locator('i').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.waitForFunction(() => document.getElementById('settings-usage-status').textContent.includes('正在读取'));
    for (let i = 0; !release && i < 50; i++) await page.waitForTimeout(20);
    assert.ok(release); hold = false; release();
    await page.locator('.pi-usage-cards').waitFor();
    await page.locator('#settings-usage-from').fill('2026-09-01');
    await page.locator('#settings-usage-to').fill('2026-09-10');
    assert.equal(await page.locator('#settings-usage-range').inputValue(), 'custom');
    await button.click(); await page.locator('.pi-usage-cards').waitFor();
    assert.ok(requests.at(-1).includes('from=2026-09-01') && requests.at(-1).includes('to=2026-09-10'));
    await check(selectors, 'custom-dates');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ width, preferencesOverflow: Math.max(...preferences.map(m => m.scroll - m.width)), usageOverflow: Math.max(...usageDimensions.map(m => m.scroll - m.width)), controls, errors, writes }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const width of [393, 412, 320, 768, 1440]) await run(browser, width); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
