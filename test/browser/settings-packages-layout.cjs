const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SETTINGS_LAYOUT_URL || 'http://127.0.0.1:3001';
const cwd = '/tmp/package-layout-fixture';
const provider = 'fixture-' + 'provider-'.repeat(15);
const model = { provider, id: 'model/' + 'identifier-'.repeat(15), name: 'Planning model', available: true, input: ['text'] };
async function run(browser, width, locale, theme) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [];
    let revision = 'r1', empty = false, conflict = false, accept = true, held = false, release, failRead = false;
    const resources = Array.from({ length: 46 }, (_, i) => ({ id: String(i), path: '/fixture/' + 'long-folder/'.repeat(12) + `resource-${i}.md`, source: 'npm:fixture', type: ['extensions', 'skills', 'prompts', 'themes'][i % 4], scope: 'user', enabled: i % 3 !== 0, override: 'inherit' }));
    const packages = [{ source: 'npm:fixture@1.0.0', scope: 'user', installed: true }, { source: 'git:https://example.com/' + 'long-repository-'.repeat(14), scope: 'project', installed: false }];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => accept ? d.accept() : d.dismiss());
    await page.addInitScript(({cwd, theme}) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.workspace.theme', theme); }, {cwd, theme});
    if (process.env.PI_PREFERENCES_BASELINE_CSS) await page.route('**/workspace.css', r => r.fulfill({ contentType: 'text/css', body: fs.readFileSync(process.env.PI_PREFERENCES_BASELINE_CSS) }));
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        if (req.method() !== 'GET') {
            const body = req.postDataJSON(); writes.push({ path, body });
            if (conflict) return route.fulfill({ status: 409, json: { error: 'fixture conflict' } });
            assert.equal(body.expectedRevision, revision); assert.equal(body.confirmed, true); revision += 'x';
            if (path.endsWith('/native/packages')) {
                if (body.action === 'install') packages.push({ source: body.source, scope: body.scope === 'global' ? 'user' : 'project', installed: true });
                if (body.action === 'remove') packages.splice(packages.findIndex(p => p.source === body.source), 1);
            } else if (path.endsWith('/native/resources')) resources.find(r => r.id === body.resourceId).enabled = body.state === 'on';
            else throw Error('Unexpected write: ' + path);
            return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, nativeResources: true, projectRoots: ['/tmp'], defaultProject: cwd } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 0 }], roots: ['/tmp'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [] } });
        if (path === '/api/pi/settings/models') return route.fulfill({ json: { preferences: { mediaAgent: {provider, modelId: model.id}, sessionTitles: { enabled: true } }, providers: [{ id: provider, name: provider, configured: true, authMethods: {} }], models: [model], customProviders: [] } });
        if (path === '/api/pi/settings/resources') return route.fulfill({ json: { packages: [], resources: { extensions: [], skills: [], prompts: [], themes: [] }, skills: [], diagnostics: [], settings: {} } });
        if (path === '/api/pi/settings/native/resources') {
            if (failRead) { failRead = false; return route.fulfill({ status: 503, json: { error: 'fixture read failure' } }); }
            const scope = url.searchParams.get('scope');
            if (held && scope === 'project') await new Promise(r => { release = r; });
            return route.fulfill({ json: { cwd, scope, revision, trust: { effective: false }, packages: empty ? [] : packages, resources: empty ? [] : resources } });
        }
        return route.fulfill({ json: path.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw Error('Settings must not open a session'); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator('#settings-session-titles:visible').waitFor();
    const measure = () => page.locator('.workspace-settings-panel.active').evaluate(panel => {
        const selectors = ['.settings-feature-card', '.settings-feature-card > *', '.settings-feature-controls', '.pi-notification-card', '.pi-notification-heading', '.pi-notification-actions', '.pi-notification-actions button', '#native-packages', '.native-package-summary', '.native-package-install-card', '.native-package-card', '.native-resource-row', '.native-resource-controls'];
        return [panel, ...panel.querySelectorAll(selectors.join(','))].filter(el => el.clientWidth).map(el => { el.scrollLeft = 200; return { id: el.id, class: el.className, w: el.clientWidth, s: el.scrollWidth, left: el.scrollLeft }; });
    });
    const check = async () => { const metrics = await measure(); for (const m of metrics) assert.ok(m.s <= m.w + 1 && m.left <= 1, `${width} ${locale} ${JSON.stringify(m)}`); return metrics; };
    if (process.env.PI_PREFERENCES_BASELINE_CSS) { console.log(JSON.stringify({ width, locale, baseline: (await measure()).filter(m => m.s > m.w + 1) })); await context.close(); return; }
    await check();
    for (const details of await page.locator('#pi-notification-card details').all()) await details.locator(':scope > summary').click();
    await check();
    await page.locator('#workspace-language').selectOption('system'); await check();
    assert.ok((await page.locator('#workspace-language').boundingBox()).width > 100);
    if (width < 900) {
        const panel = page.locator('.workspace-settings-panel.active');
        await panel.evaluate(el => { el.scrollTop = 0; });
        const box = await panel.boundingBox(), cdp = await context.newCDPSession(page);
        const swipe = async (x, y, dx, dy) => {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let i = 1; i <= 12; i++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 12, y: y + dy * i / 12 }] });
                await page.waitForTimeout(16);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(150);
        };
        await swipe(box.x + 6, box.y + box.height * .75, 0, -180);
        assert.ok(await panel.evaluate(el => el.scrollTop > 0), 'vertical touch scrolling stays available');
        await swipe(box.x + box.width * .7, box.y + box.height * .5, -100, 0);
        assert.equal(await panel.evaluate(el => el.scrollLeft), 0);
        await cdp.detach();
    }
    await page.locator('.workspace-settings-panel.active').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/preferences-layout-${locale}-${width}-${theme}.png` });
    assert.deepEqual(writes, []);
    await page.locator('[data-settings-tab="packages"]').click();
    await page.locator('#native-resource-scope').waitFor();
    assert.equal(await page.locator('#native-package-install').isDisabled(), true, 'untrusted project cannot install');
    await page.locator('#native-resource-scope').selectOption('global');
    await page.locator('#native-package-install:not([disabled])').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.native-package-install-card').evaluate(node => node.open), false);
    await page.locator('.native-package-install-card > summary').click();
    await page.locator('.native-resources-advanced > summary').click();
    assert.equal(await page.locator('.native-resource-row').count(), 40);
    await check();
    await page.screenshot({ path: `/tmp/packages-layout-${locale}-${width}-${theme}.png` });
    await page.locator('.native-resource-list > button').click(); assert.equal(await page.locator('.native-resource-row').count(), 46);
    await page.locator('.native-package-search input').fill('resource-45.md'); assert.equal(await page.locator('.native-resource-row').count(), 1);
    await page.locator('.native-resource-row .native-resource-origin summary').click(); await check();
    assert.equal(await page.locator('.native-resource-row .native-resource-origin code').textContent(), resources[45].path);
    await page.locator('.native-package-search input').fill('no-matching-resource'); assert.equal(await page.locator('.native-resource-empty').count(), 1);
    await page.locator('.native-package-search input').fill('');
    await page.locator('#native-package-source').fill('npm:new-fixture@2.0.0');
    accept = false; await page.locator('#native-package-install').click(); assert.equal(writes.length, 0);
    accept = true; await page.locator('#native-package-install').click();
    await page.waitForFunction(() => document.querySelectorAll('.native-package-card').length === 3);
    assert.deepEqual(writes.at(-1).body, { cwd, scope: 'global', source: 'npm:new-fixture@2.0.0', action: 'install', expectedRevision: 'r1', confirmed: true });
    const card = page.locator('.native-package-card').filter({ hasText: 'npm:new-fixture@2.0.0' });
    conflict = true; await card.locator('[data-package-action="update"]').click(); await page.waitForFunction(() => document.getElementById('native-resource-status').textContent === 'fixture conflict');
    assert.equal(writes.length, 2, 'conflict must not retry'); conflict = false;
    await card.locator('[data-package-action="remove"]').click(); await page.waitForFunction(() => document.querySelectorAll('.native-package-card').length === 2);
    assert.equal(writes.at(-1).body.action, 'remove');
    const row = page.locator('[data-resource-id="0"]'); await row.locator('select').selectOption('on'); await row.locator('button').click();
    await page.waitForFunction(() => document.getElementById('native-resource-status').textContent.length > 0);
    assert.equal(writes.at(-1).body.resourceId, '0'); assert.equal(writes.at(-1).body.state, 'on');
    held = true; await page.locator('#native-resource-scope').selectOption('project');
    for (let i = 0; !release && i < 100; i++) await page.waitForTimeout(10);
    assert.ok(release); await page.locator('#native-resource-scope').selectOption('global'); await page.locator('#native-package-install:not([disabled])').waitFor({ state: 'attached' });
    held = false; release(); await page.waitForTimeout(50); assert.equal(await page.locator('#native-resource-scope').inputValue(), 'global');
    failRead = true; await page.locator('#native-packages-refresh').click();
    await page.waitForFunction(() => document.getElementById('native-resource-status').textContent === 'fixture read failure');
    assert.equal(await page.locator('#native-packages-refresh').isDisabled(), false);
    assert.equal(await page.locator('#native-package-install').isDisabled(), true, 'failed reads do not re-enable stale mutations');
    empty = true; await page.locator('#native-packages-refresh').click(); await page.locator('.native-package-list .native-package-empty').waitFor();
    await check(); assert.equal(await page.locator('.native-package-summary strong').first().textContent(), '0');
    await page.locator('.workspace-settings-panel.active').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/packages-empty-${locale}-${width}-${theme}.png` });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ width, locale, theme, errors, fixtureWrites: writes.length, overflow: 0 })); await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const locale of ['zh-CN', 'en']) for (const width of [320, 393, 768, 1440]) {
            if (process.env.PI_SETTINGS_TEST_WIDTH && width !== Number(process.env.PI_SETTINGS_TEST_WIDTH)) continue;
            await run(browser, width, locale, width === 320 ? 'dark' : width === 768 ? 'mint' : 'daylight');
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
