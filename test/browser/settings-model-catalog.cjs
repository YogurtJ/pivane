const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_SETTINGS_TEST_URL || 'http://127.0.0.1:3001';
const baseline = process.env.PI_SETTINGS_BASELINE === '1';
const cwd = '/srv/settings-model-fixture';
const personal = `personal-${'long-provider-'.repeat(8)}`;
function fixture() {
    const make = (provider, count) => Array.from({ length: count }, (_, i) => ({
        provider, id: i ? `model-${i}-${'long-identifier-'.repeat(6)}` : 'shared-id',
        name: `${provider === 'openrouter' ? 'Router' : 'Personal'} Model ${i}`, available: true,
        contextWindow: 128000, input: ['text', 'image'], reasoning: true
    }));
    const models = [...make('openrouter', 380), ...make('local-gpu', 25), ...make(personal, 3)];
    models.find(item => item.provider === 'local-gpu' && item.id.startsWith('model-24-')).available = false;
    models.at(-1).id = 'last-catalog-model';
    return { providers: ['openrouter', 'local-gpu', personal].map(id => ({ id, name: id === 'openrouter' ? 'OpenRouter' : id,
        modelCount: models.filter(item => item.provider === id).length, configured: true, authMethods: {} })), models,
        preferences: { defaultProvider: 'local-gpu', defaultModel: 'shared-id', mediaAgent: { provider: personal, modelId: 'last-catalog-model' } },
        customProviders: [{ id: personal, models: models.filter(item => item.provider === personal) }] };
}
async function run(browser, viewport) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage(); const errors = [], writes = [];
    const catalog = fixture();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        if (req.method() !== 'GET') {
            writes.push({ path, body: req.postData() ? req.postDataJSON() : null });
            if (path.endsWith('/models/test')) return route.fulfill({ json: { latencyMs: 123, text: 'Fixture OK' } });
            if (path.endsWith('/models/refresh')) return route.fulfill({ json: { errors: [] } });
            return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Settings fixture', sessionCount: 0 }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        if (path === '/api/pi/settings/models') return route.fulfill({ json: catalog });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('Settings browsing must not open a session'); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="providers"]').click();
    await page.waitForFunction(() => document.getElementById('settings-media-agent-current').textContent.includes('last-catalog-model'));
    const panel = page.locator('[data-settings-panel="providers"]');
    const measure = () => page.evaluate(() => Object.fromEntries([
        '.workspace-settings-dialog', '.workspace-settings-body', '.workspace-settings-nav', '.workspace-settings-content',
        '[data-settings-panel="providers"]', '#settings-model-list'
    ].map(selector => { const e = document.querySelector(selector); return [selector, { width: e.clientWidth, scroll: e.scrollWidth, overflow: e.scrollWidth - e.clientWidth }]; })));
    const initial = await measure();
    if (baseline) {
        await page.screenshot({ path: `/tmp/pi-settings-models-before-${viewport.width}.png` });
        console.log(JSON.stringify({ viewport, initial, rows: await page.locator('.model-row').count() }));
        await context.close(); return;
    }
    const checkWidth = async () => {
        const metrics = await measure();
        for (const [selector, metric] of Object.entries(metrics)) assert.ok(metric.overflow <= 1, `${viewport.width} ${selector}: ${JSON.stringify(metric)}`);
        assert.equal(await panel.evaluate(el => { el.scrollLeft = 100; return el.scrollLeft; }), 0);
    };
    await checkWidth();
    const groups = page.locator('.settings-model-group');
    const group = provider => page.locator('.settings-model-group').filter({ has: page.locator(`summary[data-provider="${provider}"]`) });
    const router = group('openrouter');
    assert.equal(await groups.count(), 3);
    assert.equal(await page.locator('.model-row').count(), 0, 'initial provider overview must not render hundreds of rows');
    assert.equal(await groups.locator('summary').count(), 3);
    await page.screenshot({ path: `/tmp/pi-settings-models-after-${viewport.width}.png` });
    await router.locator('summary').click();
    await router.locator('.model-row').first().waitFor();
    assert.equal(await router.locator('.model-row').count(), 20);
    assert.equal(await router.locator('.model-row').first().getAttribute('data-model-id'), 'shared-id');
    await router.locator('[data-model-page="next"]').click();
    assert.ok((await router.locator('.model-row').first().getAttribute('data-model-id')).startsWith('model-20-'));
    await router.locator('[data-model-page="previous"]').click();
    assert.equal(await router.locator('.model-row').first().getAttribute('data-model-id'), 'shared-id');
    await checkWidth();
    await router.locator('summary').click();
    await page.locator('#settings-model-provider').selectOption(personal);
    await group(personal).locator('.model-row').first().waitFor();
    assert.equal(await groups.count(), 1);
    assert.equal(await group(personal).locator('.model-row').count(), 3, 'providers past the old global 400 limit are reachable');
    const shared = group(personal).locator('[data-model-id="shared-id"]');
    await shared.locator('[data-action="test"]').click();
    await page.waitForFunction(() => document.getElementById('settings-model-test-result').textContent.includes('Fixture OK'));
    assert.deepEqual(writes.at(-1), { path: '/api/pi/settings/models/test', body: { provider: personal, modelId: 'shared-id' } });
    await shared.locator('[data-action="default"]').click();
    await shared.locator('.settings-badge.primary').waitFor();
    assert.deepEqual(writes.at(-1), { path: '/api/pi/settings/models/preferences', body: { defaultProvider: personal, defaultModel: 'shared-id' } });
    await shared.locator('[data-action="edit"]').click();
    await page.locator('#workspace-settings-editor').waitFor();
    assert.ok((await page.locator('#settings-model-form').textContent()).length > 0);
    await page.locator('#workspace-settings-editor-close').click();
    await page.locator('#settings-model-provider').selectOption('');
    await page.locator('#settings-model-search').fill('last-catalog-model');
    await group(personal).locator('[data-model-id="last-catalog-model"]').waitFor();
    assert.equal(await page.locator('.model-row').count(), 1);
    await page.locator('#settings-model-search').fill('no-fixture-model-matches');
    await page.locator('#settings-model-list .settings-empty').waitFor();
    assert.equal(await groups.count(), 0);
    await page.locator('#settings-model-search').fill('');
    await page.locator('#settings-model-available').check();
    await page.locator('#settings-model-provider').selectOption('local-gpu');
    await group('local-gpu').locator('[data-model-page="next"]').click();
    assert.equal(await group('local-gpu').locator('.model-row').count(), 4);
    await page.locator('#settings-model-available').uncheck();
    await group('local-gpu').locator('[data-model-page="next"]').click();
    assert.equal(await group('local-gpu').locator('.model-row').count(), 5);
    await checkWidth();
    await page.locator('#settings-model-search').fill('shared-id');
    await page.locator('#settings-model-provider').selectOption('');
    assert.equal(await groups.count(), 3);
    assert.equal(await page.locator('.model-row').count(), 3);
    await page.locator('#settings-model-search').fill('');
    await groups.first().locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await groups.first().evaluate(el => el.open), true);
    await page.keyboard.press('Enter');
    assert.equal(await groups.first().evaluate(el => el.open), false);
    assert.deepEqual(errors, []);
    assert.equal(writes.length, 2, 'only explicitly tested mock actions may write');
    console.log(JSON.stringify({ viewport, initial, groups: 3, pageSize: 20, errors, mockActions: writes.length }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const viewport of [{ width: 393, height: 852 }, { width: 412, height: 915 }, { width: 960, height: 900 }, { width: 1440, height: 1000 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
