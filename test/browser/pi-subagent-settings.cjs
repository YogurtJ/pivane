const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 680 : 1000 }, locale, isMobile: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(45000);
    const errors = [], writes = []; let status = 'missing', revision = 1, conflict = false, failRead = false, holdRead = false, releaseRead;
    const cwd = '/fixture/project', model = { provider: 'fixture', id: 'reasoner', name: 'Fixture Reasoner', available: true, input: ['text'], thinkingLevels: ['off', 'medium', 'high'] };
    let models = [model, ...Array.from({ length: 550 }, (_, i) => ({ ...model, provider: 'openrouter', id: `vendor/model-${String(i).padStart(3, '0')}`, name: `Research model ${String(i).padStart(3, '0')}` }))];
    const defaults = { global: { model: null, thinking: null }, project: { model: null, thinking: null } };
    const roles = ['delegate', 'evidence-auditor', 'oracle', 'researcher', 'reviewer', 'scout', 'worker', '<custom-role>', 'toString'].map(name => ({ name, global: { model: null, thinking: null }, project: { model: null, thinking: null } }));
    const snapshot = () => ({ version: 1, cwd, revision: String(revision), trust: { effective: true }, plugin: { status, name: 'pi-subagents', version: '0.69.0', installedVersions: status === 'missing' ? [] : ['0.69.0'], canInstall: status === 'missing' }, defaults, roles });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**', route => route.abort());
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()); let data = {}, code = 200;
        if (url.pathname === '/api/pi/status') data = { ok: true, defaultProject: cwd, projectRoots: ['/fixture'] };
        else if (url.pathname === '/api/pi/settings/models') data = { models, providers: [{ id: 'fixture', name: 'Fixture provider', authMethods: {} }, { id: 'openrouter', name: 'OpenRouter', authMethods: {} }], preferences: {}, customProviders: [] };
        else if (url.pathname === '/api/pi/projects') data = { projects: [], roots: ['/fixture'] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [] };
        else if (url.pathname === '/api/pi/settings/subagents/install') { writes.push(req.postDataJSON()); status = 'ready'; revision++; data = { ok: true }; }
        else if (url.pathname === '/api/pi/settings/subagents') {
            if (req.method() === 'PUT') {
                const body = req.postDataJSON(); writes.push(body);
                if (conflict) { conflict = false; code = 409; data = { error: '配置已变化，请刷新后再保存' }; }
                else {
                    for (const [key, value] of Object.entries(body.changes)) {
                        if (key === 'defaultModel') defaults[body.scope].model = value;
                        else if (key === 'defaultThinking') defaults[body.scope].thinking = value;
                        else { const [, name, field] = key.split('.'); roles.find(role => role.name === name)[body.scope][field] = value; }
                    }
                    revision++; data = { ok: true };
                }
            } else if (failRead) { failRead = false; code = 503; data = { error: 'Fixture unavailable' }; }
            else { data = structuredClone(snapshot()); if (holdRead) { holdRead = false; await new Promise(resolve => { releaseRead = resolve; }); } }
        }
        await route.fulfill({ status: code, json: data });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('#pi-project-dialog-close').click();
    await page.locator('#workspace-settings-toggle').click(); await page.locator('[data-settings-tab="media"]').click();
    const card = page.locator('#settings-subagents'), trigger = card.locator('[data-model-key="defaultModel"]'), picker = page.locator('.sa-picker');
    await card.getByText(locale === 'en' ? /pi-subagents is not installed/ : /尚未安装 pi-subagents/).waitFor(); assert.equal(await card.locator('form').count(), 0);
    page.once('dialog', dialog => dialog.dismiss()); await card.locator('.settings-primary-button').click(); assert.equal(writes.length, 0);
    page.once('dialog', dialog => dialog.accept()); await card.locator('.settings-primary-button').click(); await card.locator('form').waitFor();
    assert.equal(await card.locator('button[type="submit"]').isDisabled(), true);
    assert.equal(await card.locator('.sa-role[open]').count(), 0);
    assert.equal(await card.locator('.sa-role[data-role="delegate"] summary strong').textContent(), locale === 'en' ? 'General assistant' : '通用助手');
    assert.equal(await card.locator('.sa-role[data-role="evidence-auditor"] summary strong').textContent(), locale === 'en' ? 'Evidence auditor' : '证据核查');
    assert.equal(await card.locator('custom-role').count(), 0);
    assert.equal(await card.locator('.sa-help').getAttribute('open'), null);
    assert.equal(await card.locator('[data-sa-scope] option').count(), 1);
    const dimensions = async () => {
        const data = await page.evaluate(() => ['body', '.workspace-settings-content', '#settings-subagents', '.sa-fields', '.sa-role', '.sa-model-trigger', '.sa-picker', '.sa-picker-filters', '.sa-picker-results', '.sa-picker-item', '.sa-picker-item-copy'].flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.clientWidth).map(el => ({ selector, width: el.clientWidth, scroll: el.scrollWidth }))));
        for (const metric of data) assert.ok(metric.scroll <= metric.width + 1, JSON.stringify({ width, ...metric }));
    };
    await trigger.click(); await picker.waitFor(); assert.equal(await picker.locator('.sa-picker-item').count(), 40);
    assert.equal(await picker.locator('input').evaluate(el => el === document.activeElement), true);
    await picker.locator('.sa-picker-close').focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await picker.evaluate(el => el.contains(document.activeElement)), true, 'native dialog keeps keyboard focus inside');
    await picker.locator('.sa-picker-more').click(); assert.equal(await picker.locator('.sa-picker-item').count(), 80);
    await picker.locator('select').selectOption('fixture'); assert.equal(await picker.locator('.sa-picker-item').count(), 1);
    await picker.locator('select').selectOption('openrouter'); await picker.locator('input').fill('Research 549');
    assert.equal(await picker.locator('.sa-picker-item').count(), 1); assert.match(await picker.locator('.sa-picker-item').textContent(), /model-549/);
    await picker.locator('input').fill('no-such-model'); assert.equal(await picker.locator('.sa-picker-item').count(), 0); await picker.locator('.sa-picker-empty').waitFor();
    await picker.locator('input').fill('');
    for (const theme of ['daylight', 'mint', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await dimensions(); }
    await page.evaluate(() => document.documentElement.dataset.theme = 'daylight');
    await page.screenshot({ path: `/tmp/pivane-subagent-picker-${locale}-${width}.png` });
    await picker.locator('input').fill('model');
    await page.keyboard.press('Escape'); await picker.waitFor({ state: 'detached' }); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#workspace-settings-dialog').isVisible(), true, 'Escape closes only the picker');
    assert.equal(writes.length, 1, 'search, filter and dismiss must not write');
    await trigger.click(); await picker.locator('select').selectOption('fixture'); await picker.locator('.sa-picker-item').click();
    assert.match(await trigger.textContent(), /Fixture Reasoner/);
    await card.locator('.sa-footer .settings-secondary-button').click();
    assert.equal(await card.locator('button[type="submit"]').isDisabled(), true); assert.equal(writes.length, 1);
    await trigger.click(); await picker.locator('select').selectOption('fixture'); await picker.locator('.sa-picker-item').click();
    conflict = true; await card.locator('button[type="submit"]').click();
    await card.locator('.sa-status').filter({ hasText: locale === 'en' ? /draft is preserved/ : /草稿已保留/ }).waitFor();
    assert.equal(await card.locator('fieldset').evaluate(el => el.disabled), true);
    await card.locator('.sa-refresh').click(); await trigger.waitFor(); assert.match(await trigger.textContent(), /Fixture Reasoner/);
    await card.locator('button[type="submit"]').click(); await card.locator('.sa-status').filter({ hasText: locale === 'en' ? /Saved/ : /已保存/ }).waitFor();
    assert.equal(defaults.global.model, 'fixture/reasoner');
    const reviewer = card.locator('[data-role="reviewer"]'); await reviewer.locator('summary').click();
    await reviewer.locator('.sa-model-trigger').click(); await picker.locator('input').fill('vendor/model-549'); await picker.locator('.sa-picker-item').click();
    await reviewer.locator('select').selectOption('high'); await card.locator('button[type="submit"]').click();
    await card.locator('.sa-status').filter({ hasText: locale === 'en' ? /Saved/ : /已保存/ }).waitFor();
    assert.deepEqual(writes.at(-1).changes, { 'agentOverrides.reviewer.model': 'openrouter/vendor/model-549', 'agentOverrides.reviewer.thinking': 'high' });
    assert.equal(await reviewer.getAttribute('open'), '', 'role expansion persists across save');
    // Restore inheritance saves null, never a translated role or model name.
    await trigger.click(); await picker.locator('.sa-picker-mode').first().click(); await card.locator('button[type="submit"]').click();
    await card.locator('.sa-status').filter({ hasText: locale === 'en' ? /Saved/ : /已保存/ }).waitFor(); assert.equal(writes.at(-1).changes.defaultModel, null);
    // Save succeeds but refresh fails: show the read failure, do not claim refreshed state or replay.
    await trigger.click(); await picker.locator('select').selectOption('fixture'); await picker.locator('.sa-picker-item').click(); failRead = true;
    const countBefore = writes.length; await card.locator('button[type="submit"]').click(); await card.getByText('Fixture unavailable').waitFor();
    assert.equal(writes.length, countBefore + 1); assert.equal(await card.locator('form').count(), 0);
    await card.locator('button').click(); await trigger.waitFor();
    models = models.filter(item => item.provider !== 'fixture'); await card.locator('.sa-refresh').click(); await trigger.waitFor();
    assert.match(await trigger.textContent(), /fixture\/reasoner/); assert.equal(defaults.global.model, 'fixture/reasoner', 'missing saved models must not silently change');
    // Drafts remain scoped to the project/global setting being edited.
    await page.evaluate(cwd => localStorage.setItem('pi.web.cwd', cwd), cwd); await card.locator('.sa-refresh').click(); await trigger.waitFor();
    await card.locator('[data-sa-scope]').selectOption('project'); await card.locator('[data-thinking-key="defaultThinking"]').selectOption('medium');
    await card.locator('[data-sa-scope]').selectOption('global'); assert.equal(await card.locator('[data-thinking-key="defaultThinking"]').inputValue(), '');
    await card.locator('[data-sa-scope]').selectOption('project'); assert.equal(await card.locator('[data-thinking-key="defaultThinking"]').inputValue(), 'medium');
    await card.locator('.sa-footer .settings-secondary-button').click(); await card.locator('[data-sa-scope]').selectOption('global');
    // A stale read from a closed tab cannot replace a newer snapshot.
    holdRead = true; await card.locator('.sa-refresh').click();
    await page.waitForFunction(() => document.querySelector('#settings-subagents form') === null);
    await page.locator('[data-settings-tab="providers"]').click();
    status = 'disabled'; await page.locator('[data-settings-tab="media"]').click();
    await card.getByText(locale === 'en' ? /installed but disabled/ : /已安装但未启用/).waitFor();
    assert.ok(releaseRead); releaseRead(); await page.waitForTimeout(80); assert.equal(await card.locator('form').count(), 0);
    status = 'unsupported'; await card.locator('.sa-refresh').click(); await card.getByText(locale === 'en' ? /not supported by/ : /版本尚未适配/).waitFor();
    status = 'ready'; await card.locator('.sa-refresh').click(); await trigger.waitFor();
    if (width < 900) assert.ok(await card.locator('select').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    await reviewer.locator('summary').click(); await dimensions();
    await card.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `/tmp/pivane-subagents-polished-${locale}-${width}.png` });
    assert.deepEqual(errors, []); await context.close(); console.log(`subagent settings passed: ${locale} ${width}px, 551 models`);
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const locales = process.env.PI_UI_TEST_LOCALES ? process.env.PI_UI_TEST_LOCALES.split(',') : ['zh-CN', 'en'];
    const widths = process.env.PI_UI_TEST_WIDTHS ? process.env.PI_UI_TEST_WIDTHS.split(',').map(Number) : [1440, 393, 320];
    try { for (const locale of locales) for (const width of widths) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
