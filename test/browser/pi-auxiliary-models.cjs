const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { AUXILIARY_PURPOSES } = require('../../server/pi-auxiliary-models-service');
const root = path.resolve(__dirname, '../..');
async function run(browser, base, width, locale) {
    const en = locale === 'en';
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], writes = [], calls = []; let counter = 1, holdNextRead = false, releaseRead;
    const cwd = '/fixture/auxiliary-project';
    const model = { id: 'main', provider: 'fixture', name: 'Main model', input: ['text', 'image'], available: true, thinkingLevels: ['off'], contextWindow: 32000 };
    const helper = { ...model, id: 'cheap/helper-with-a-long-id-for-layout', provider: 'budget', name: 'Budget helper with a long name' };
    let models = [model, helper];
    const settings = { 'session-title': { provider: helper.provider, modelId: helper.id, enabled: true, revision: 0 },
        'media-planner': { provider: model.provider, modelId: model.id } };
    const snapshot = () => ({ version: 1, revision: String(counter).padStart(64, '0'), purposes: AUXILIARY_PURPOSES.map(({ storage, ...descriptor }) => ({ ...descriptor, settings: { ...settings[descriptor.id] } })) });
    const session = { cwd, id: 'aux-fixture', name: '辅助模型配置讨论', messageCount: 4, modified: '2026-09-12T00:00:00Z' };
    const messages = [{ role: 'user', content: '讨论辅助模型', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/fixture/file.txt' } }], stopReason: 'toolUse' },
        { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'fixture tool output' }] },
        { role: 'assistant', content: [{ type: 'text', text: '可以按用途配置。' }], stopReason: 'stop', timestamp: 2 }];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'aux-fixture'); }, { cwd });
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()); let data = {}, status = 200;
        if (request.method() !== 'GET') writes.push({ path: url.pathname, body: request.postDataJSON() });
        if (url.pathname === '/api/pi/status') data = { ok: true, auxiliaryModels: true, sessionTitles: true, sessionTitleModels: true, defaultProject: cwd, projectRoots: ['/fixture'] };
        else if (url.pathname === '/api/pi/projects') data = { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }], roots: ['/fixture'], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/sessions') data = { sessions: [session] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/settings/models') data = { models, providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }, { id: 'budget', name: 'Budget provider', configured: true, authMethods: {} }],
            customProviders: [], preferences: { sessionTitles: settings['session-title'], mediaAgent: settings['media-planner'] }, auxiliaryModels: snapshot() };
        else if (url.pathname === '/api/pi/settings/auxiliary-models') {
            if (request.method() === 'GET') {
                data = snapshot();
                if (holdNextRead) { holdNextRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
            } else {
                const body = request.postDataJSON();
                if (body.expectedRevision !== snapshot().revision) { status = 409; data = { error: '辅助模型设置已变化，请刷新后再保存' }; }
                else { for (const [id, patch] of Object.entries(body.changes)) Object.assign(settings[id], patch); counter++; data = snapshot(); }
            }
        }
        await route.fulfill({ status, json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); calls.push(command.type); let data = {};
        const state = { model, thinkingLevel: 'off', isStreaming: false };
        if (command.type === 'open_session') data = { session, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (command.type === 'get_state') data = state;
        else if (command.type === 'get_messages') data = { messages };
        else if (command.type === 'get_available_models') data = { models: [model] };
        else if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    await page.locator('#pi-input').fill('草稿保持 <keep>');
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('附件正文') });
    await page.locator('#pi-attachments .pi-attachment-chip').first().waitFor();
    const draft = await page.locator('#pi-input').inputValue();
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="models"]').click();
    const card = page.locator('#settings-auxiliary-models'); await card.waitFor({ state: 'visible' });
    const title = card.locator('[data-purpose="session-title"]'), media = card.locator('[data-purpose="media-planner"]');
    assert.equal(await card.locator('.aux-model-row').count(), 2, 'only implemented auxiliary consumers are exposed');
    assert.equal(await page.locator('#settings-session-titles').isVisible(), false);
    assert.equal(await page.locator('#settings-media-agent-form').isVisible(), false);
    assert.equal(await title.locator('select').first().inputValue(), helper.provider);
    assert.equal(await media.locator('select').last().inputValue(), model.id);
    const save = card.locator('.aux-models-footer .settings-primary-button'), reset = card.locator('.aux-models-footer .settings-secondary-button');
    await title.locator('.aux-model-options').click();
    await title.getByRole('checkbox').uncheck();
    await media.locator('select').first().selectOption(helper.provider);
    assert.equal(writes.length, 0, 'staged changes do not save or generate');
    await save.click(); await page.waitForFunction(() => document.querySelector('#settings-auxiliary-models .aux-models-status').textContent.includes(document.documentElement.lang === 'en' ? 'saved' : '已保存'));
    assert.equal(settings['session-title'].enabled, false); assert.equal(settings['media-planner'].modelId, helper.id);
    assert.deepEqual(writes[0].body.changes, { 'session-title': { enabled: false }, 'media-planner': { provider: helper.provider, modelId: helper.id } });
    await title.locator('select').first().selectOption('fixture'); counter++;
    await save.click();
    await page.waitForFunction(() => !document.querySelector('#settings-auxiliary-models select').disabled);
    assert.equal(await title.locator('select').first().inputValue(), 'fixture', 'conflict refresh retains draft');
    assert.ok((await card.locator('.aux-models-status').textContent()).includes(en ? 'changed' : '已变化'));
    const writesBeforeReset = writes.length;
    await reset.click(); assert.equal(writes.length, writesBeforeReset);
    assert.equal(await title.locator('select').first().inputValue(), ''); assert.equal(await media.locator('select').first().inputValue(), '');
    assert.ok((await title.locator('select').first().innerText()).includes(en ? 'current thread' : '当前线程'));
    assert.ok((await media.locator('select').first().innerText()).includes(en ? 'planner defaults' : '媒体规划默认'));
    await save.click(); await page.waitForFunction(() => !document.querySelector('#settings-auxiliary-models select').disabled);
    assert.equal(settings['session-title'].provider, ''); assert.equal(settings['media-planner'].provider, '');
    assert.equal(settings['session-title'].enabled, false, 'reset routes preserves feature switches');
    // A late read started before saving cannot put the old routing back on screen.
    holdNextRead = true;
    await page.locator('[data-settings-tab="providers"]').click(); await page.locator('[data-settings-tab="models"]').click();
    while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 10));
    await title.locator('select').first().selectOption(helper.provider); await save.click();
    await page.waitForFunction(() => !document.querySelector('#settings-auxiliary-models select').disabled);
    releaseRead(); await page.waitForTimeout(60);
    assert.equal(await title.locator('select').first().inputValue(), helper.provider);
    await media.locator('.aux-model-options').click();
    const overflow = async () => {
        const metrics = await page.evaluate(() => ['body', '.workspace-settings-content', '#settings-auxiliary-models', '.aux-model-main', '.aux-model-field', '.aux-model-field select', '.aux-model-details', '.aux-models-footer'].flatMap(selector => [...document.querySelectorAll(selector)].filter(e => e.clientWidth).map(e => ({ selector, width: e.clientWidth, scroll: e.scrollWidth }))));
        for (const item of metrics) assert.ok(item.scroll <= item.width + 1, `${width}/${locale}: ${JSON.stringify(item)}`);
    };
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await overflow();
    }
    if (width <= 1000) assert.ok(await title.locator('select').last().evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/pi-auxiliary-${locale}-${width}-details.png` });
    for (const button of await card.locator('.aux-model-options').all()) {
        if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'daylight');
    await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await overflow();
    await page.screenshot({ path: `/tmp/pi-auxiliary-${locale}-${width}.png` });
    models = [model];
    await page.locator('[data-settings-tab="providers"]').click(); await page.locator('#settings-refresh-models').click();
    await page.waitForTimeout(100); await page.locator('[data-settings-tab="models"]').click();
    assert.equal(await title.locator('select').first().inputValue(), helper.provider);
    assert.equal(await title.locator('select').last().inputValue(), helper.id, 'removed models are not replaced with the first option');
    assert.ok((await title.locator('select').last().innerText()).includes(en ? 'unavailable' : '不可用'));
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), draft);
    assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
    await page.locator('[data-transcript-mode="full"]').click();
    assert.ok((await page.locator('.pi-tool-output').textContent()).includes('fixture tool output'));
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await page.locator('#pi-toggle-sessions').click(); }
    assert.equal(calls.filter(type => type === 'open_session').length, 1);
    assert.ok(!calls.includes('prompt') && !calls.includes('set_model'));
    assert.ok(writes.every(write => ['/api/pi/settings/auxiliary-models', '/api/pi/settings/models/refresh'].includes(write.path)));
    assert.equal(writes.filter(write => write.path === '/api/pi/settings/models/refresh').length, 1, 'only the explicit catalog refresh is allowed besides preference saves');
    assert.deepEqual(errors, []); await context.close();
    console.log(`auxiliary UI passed: ${locale} ${width}px`);
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const locale of ['zh-CN', 'en']) for (const width of [1440, 768, 393, 320]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
