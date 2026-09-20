const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/tmp/extension-assistant-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
async function run(browser, base, width, locale, noProject = false) {
    const ctx = await browser.newContext({ locale, viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await ctx.newPage(), errors = [], sent = [], writes = [];
    let hold = false, release, enabled = true, failResources = false, inspected = false;
    const sessions = [{ id: 'original', cwd, name: 'Original', messageCount: 2 }];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(width => localStorage.setItem('pi.workspace.theme', width === 1440 ? 'light' : width === 393 ? 'mint' : 'dark'), width);
    if (!noProject) await page.addInitScript(cwd => { if (!localStorage.getItem('pi.web.cwd')) { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'original'); } }, cwd);
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        if (p === '/api/pi/status') return route.fulfill({ json: { ok: true, extensionAssistant: enabled, nativeResources: true, nativeSettings: true, defaultProject: cwd, projectRoots: ['/tmp'] } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: noProject ? [] : [{ cwd, name: 'Fixture', sessionCount: sessions.length }], roots: ['/tmp'] } });
        if (p === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (p === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [] } });
        if (p === '/api/pi/extension-assistant/sessions') {
            assert.equal(req.method(), 'POST'); const body = req.postDataJSON(); writes.push(body);
            if (hold) await new Promise(r => { release = r; });
            const session = { id: 'assistant-' + writes.length, cwd, name: locale === 'en' ? 'Extension Assistant' : '扩展助手', messageCount: 0,
                assistant: { kind: 'extensions', scope: body.scope, language: body.language, returnSessionId: body.returnSessionId } };
            sessions.push(session); return route.fulfill({ status: 201, json: session });
        }
        if (p === '/api/pi/settings/native/resources' && failResources) return route.fulfill({ status: 503, json: { error: 'Synthetic inventory failure' } });
        if (p === '/api/pi/settings/native/resources') return route.fulfill({ json: { cwd, revision: 'r1', scope: url.searchParams.get('scope'), trust: { effective: false },
            packages: [{ source: 'npm:fixture', scope: 'user', installed: true }, { source: 'npm:@example/document-tools@1.2.3', scope: 'user', installed: true }], resources: [
                { id: 'fixture', type: 'skills', path: '/tmp/fixture/SKILL.md', source: 'npm:fixture', enabled: true, scope: 'user', override: 'inherit' },
                { id: 'second', type: 'skills', path: 'C:\\Skills\\spreadsheet-helper\\SKILL.md', source: 'local', enabled: false, scope: 'user', override: 'inherit' },
                { id: 'extension', type: 'extensions', path: '/tmp/packages/document-tools/extensions/index.ts', source: 'npm:@example/document-tools@1.2.3', enabled: true, scope: 'user', override: 'inherit' }
            ] } });
        if (p === '/api/pi/settings/resources') return route.fulfill({ json: { skills: [{ name: 'fixture', description: 'Fixture skill', filePath: '/tmp/fixture/SKILL.md' }], packages: [], resources: {}, settings: {} } });
        if (p === '/api/pi/settings/models') return route.fulfill({ json: { preferences: {}, providers: [], models: [], customProviders: [] } });
        return route.fulfill({ json: p.includes('history') || p === '/api/prompts' ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); sent.push(cmd);
            const reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
            if (cmd.type === 'open_session') {
                const session = sessions.find(s => s.id === cmd.sessionId);
                return reply({ session, state: { sessionId: session.id, model, isStreaming: false, isCompacting: false }, messages: { messages: [] }, commands: { commands: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] } });
            }
            if (cmd.type === 'get_messages') return reply({ messages: [] });
            if (cmd.type === 'get_state') return reply({ model, isStreaming: false });
            if (cmd.type === 'get_available_thinking_levels') return reply({ levels: ['off'] });
            return reply({});
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    if (!noProject) await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    else { await page.locator('#pi-project-dialog').waitFor({ state: 'visible' }); await page.locator('#pi-project-dialog-close').click(); }
    await page.locator('#pi-extension-assistant-add').waitFor({ state: 'attached' });
    const widths = async () => {
        const found = await page.evaluate(() => [...document.querySelectorAll('body,#pi-extension-assistant-dialog[open],#pi-extension-assistant-dialog[open] form,#pi-extension-assistant-dialog[open] textarea,#pi-extension-assistant-banner,.native-assistant-entry,.pi-composer-add-menu:not([hidden])')]
            .filter(e => e.getClientRects().length).map(e => ({ id: e.id || e.className, width: e.clientWidth, scroll: e.scrollWidth })));
        assert.ok(found.every(e => e.scroll <= e.width + 1), JSON.stringify(found));
    };
    const settings = async tab => {
        await page.locator('#workspace-settings-toggle').click();
        await page.locator(`[data-settings-tab="${tab}"]`).click();
        if (tab === 'packages' && !inspected && !failResources) {
            inspected = true;
            const advanced = page.locator('.native-resources-advanced');
            await advanced.waitFor({ state: 'visible' });
            assert.equal(await advanced.evaluate(e => e.open), false);
            assert.equal(await page.locator('.native-package-install-card').evaluate(e => e.open), false);
            assert.equal(await page.locator('.native-resource-list').isVisible(), false);
            assert.equal(await page.locator('.native-package-main > strong').nth(1).textContent(), '@example/document-tools');
            await page.screenshot({ path: `/tmp/pivane-packages-simple-${locale}-${width}.png` });
            await page.locator('.native-package-help .native-help-trigger').first().click();
            await page.locator('.native-item-help:popover-open').waitFor();
            const box = await page.locator('.native-item-help:popover-open').boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.native-item-help:popover-open').count(), 0);
            await page.locator('.native-package-help .native-help-trigger').first().click();
            await page.locator('.native-item-help:popover-open [data-help-purpose="explain"]').click();
            const draft = await page.locator('#pi-extension-assistant-need').inputValue();
            assert.match(draft, /npm:fixture/); assert.match(draft, /"resourceScope": "user"/);
            assert.match(draft, locale === 'en' ? /read-only/ : /只读/);
            await page.keyboard.press('Escape');
            await advanced.locator(':scope > summary').click();
            assert.equal(await page.locator('[data-resource-id="fixture"] strong').textContent(), 'fixture');
            assert.equal(await page.locator('[data-resource-id="second"] strong').textContent(), 'spreadsheet-helper');
            assert.equal(await page.locator('[data-resource-id="extension"] strong').textContent(), 'document-tools');
            await page.locator('.native-package-search input').fill('spreadsheet-helper');
            assert.equal(await page.locator('.native-resource-row').count(), 1);
            await page.locator('.native-package-search input').fill('');
            const overflow = await advanced.evaluate(root => [...root.querySelectorAll('div, input, select, code')].filter(e => e.getClientRects().length && e.clientWidth && e.scrollWidth > e.clientWidth + 1).map(e => e.className));
            assert.deepEqual(overflow, []);
            await page.screenshot({ path: `/tmp/pivane-packages-advanced-${locale}-${width}.png` });
            await advanced.locator(':scope > summary').click();
            await page.locator('#native-resource-scope').selectOption('global');
            await page.locator('.native-package-actions [data-package-action="update"]').first().waitFor({ state: 'visible' });
            await page.locator('#native-packages .native-packages-header').scrollIntoViewIfNeeded();
            await page.screenshot({ path: `/tmp/pivane-packages-global-${locale}-${width}.png` });
            await page.locator('.native-package-help .native-help-trigger').first().click();
            await page.locator('.native-item-help:popover-open').waitFor();
            await page.screenshot({ path: `/tmp/pivane-packages-help-${locale}-${width}.png` });
            await page.keyboard.press('Escape');
        }
        await page.locator(`#native-${tab} .native-assistant-entry button`).click();
    };
    const input = page.locator('#pi-input');
    if (!noProject) {
        await input.fill('Original unsent draft');
        await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
        await page.locator('.pi-attachment-chip').waitFor();
        await page.locator('#pi-composer-add-button').click(); await widths();
        await page.locator('#pi-extension-assistant-add').click();
    } else await settings('skills');
    await page.locator('#pi-extension-assistant-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-extension-assistant-scope option').count(), noProject ? 1 : 2);
    if (width < 600) assert.equal(await page.locator('#pi-extension-assistant-need').evaluate(e => getComputedStyle(e).fontSize), '16px');
    await widths();
    assert.equal(await page.locator('.pi-extension-location').evaluate(e => e.open), false);
    await page.locator('.pi-extension-location > summary').click();
    assert.ok(await page.locator('.pi-extension-target').isVisible());
    await page.locator('.pi-extension-location > summary').click();
    if (width < 600) {
        await page.setViewportSize({ width, height: 480 });
        await page.locator('.pi-extension-body').evaluate(e => { e.scrollTop = e.scrollHeight; });
        const bounds = await page.locator('#pi-extension-assistant-create').boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 480, JSON.stringify(bounds));
        await widths();
        await page.setViewportSize({ width, height: 900 });
        await page.locator('.pi-extension-body').evaluate(e => { e.scrollTop = 0; });
    }
    await page.locator('#pi-extension-assistant-need').fill('Find a presentation skill; inspect licenses first.');
    await page.screenshot({ path: `/tmp/pivane-extension-dialog-${locale}-${width}.png` });
    await page.locator('#pi-extension-assistant-create').dblclick();
    await page.locator('#pi-extension-assistant-banner').waitFor({ state: 'visible' });
    assert.equal(writes.length, 1, 'double click creates one session');
    assert.equal(await input.inputValue(), 'Find a presentation skill; inspect licenses first.');
    assert.equal(sent.some(c => ['prompt', 'steer', 'follow_up'].includes(c.type)), false);
    assert.equal(await page.locator('.pi-attachment-chip').count(), 0);
    await widths();
    await page.screenshot({ path: `/tmp/pivane-extension-session-${locale}-${width}.png` });
    if (!noProject) {
        await page.locator('#pi-extension-assistant-return').click();
        await page.waitForFunction(() => document.getElementById('pi-input').value === 'Original unsent draft');
        assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
        assert.equal(await page.locator('#pi-extension-assistant-banner').isVisible(), false);
        await settings('packages');
        await page.locator('#pi-extension-assistant-scope').selectOption('project');
        await page.locator('#pi-extension-assistant-need').fill('Keep late assistant draft');
        hold = true;
        await page.locator('#pi-extension-assistant-create').click();
        await page.waitForFunction(() => document.getElementById('pi-extension-assistant-create').disabled);
        while (!release) await new Promise(r => setTimeout(r, 10));
        await page.keyboard.press('Escape');
        release(); hold = false;
        await page.waitForFunction(() => document.querySelector('.toast')?.textContent || !document.getElementById('pi-extension-assistant-dialog').open);
        await page.locator('#workspace-settings-close').click();
        await new Promise(r => setTimeout(r, 100));
        assert.equal(await input.inputValue(), 'Original unsent draft', 'late creation must not navigate after dialog cancellation');
        assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
        await settings('skills');
        await page.keyboard.press('Escape');
        await page.screenshot({ path: `/tmp/pivane-skills-simple-${locale}-${width}.png` });
        await page.locator('#native-skills .native-help-trigger').first().click();
        await page.locator('.native-item-help:popover-open').waitFor();
        await page.screenshot({ path: `/tmp/pivane-skills-help-${locale}-${width}.png` });
        await page.locator('.native-item-help:popover-open [data-help-purpose="diagnose"]').click();
        assert.match(await page.locator('#pi-extension-assistant-need').inputValue(), /\/tmp\/fixture\/SKILL.md/);
        await page.keyboard.press('Escape'); await page.locator('#workspace-settings-close').click();
        // Reopening a persisted assistant recovers its role from the socket snapshot.
        await page.evaluate(cwd => localStorage.setItem(`pi.web.session:${cwd}`, 'assistant-1'), cwd);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#pi-extension-assistant-banner').waitFor({ state: 'visible' });
        assert.equal(writes.length, 2);
    }
    failResources = true;
    await settings('packages');
    await page.locator('#pi-extension-assistant-dialog').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await page.locator('#workspace-settings-close').click();
    failResources = false;
    assert.deepEqual(errors, []);
    enabled = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('pi-extension-assistant-add')?.hidden === true);
    await ctx.close();
}
(async () => {
    const app = require('express')(); app.use(require('express').static(path.resolve(__dirname, '../../public')));
    app.use('/vendor', require('express').static(path.resolve(__dirname, '../../node_modules')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const [width, locale, empty] of [[1440, 'zh-CN', false], [393, 'zh-CN', false], [320, 'en', false], [393, 'en', true]]) {
            await run(browser, base, width, locale, empty); console.log(`PASS extension assistant ${width} ${locale} empty=${empty}`);
        }
    } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
