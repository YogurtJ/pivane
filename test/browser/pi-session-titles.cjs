const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');

async function run(browser, base, width, locale, supported = true, modelSupport = true, missingModel = false) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const en = locale === 'en', errors = [], calls = [], writes = [];
    const cwd = '/fixture/title-project';
    const session = { id: 'title-fixture', cwd, name: '', firstMessage: '帮我看看手机聊天页面为什么横向溢出', messageCount: 4, modified: '2026-09-12T00:00:00Z' };
    const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', available: true, input: ['text', 'image'], thinkingLevels: ['off'], contextWindow: 32000 };
    const cheap = { ...model, provider: 'budget', id: 'title-helper/long-model-id-for-width-check', name: 'Budget title helper with a long descriptive name' };
    const titlePreferences = { enabled: true, ...(modelSupport ? { provider: missingModel ? 'removed-provider' : '', modelId: missingModel ? 'removed-model' : '', revision: 0 } : {}) };
    const messages = [{ role: 'user', timestamp: 1, content: session.firstMessage },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: '/fixture/layout.css' } }], stopReason: 'toolUse' },
        { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'fixture tool output' }] },
        { role: 'assistant', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: '建议检查 flex 子元素的最小宽度。' }] }];
    let socket, titleMode = 'ready', releaseTitle, saveConflict = false, failSettings = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'title-fixture'); }, { cwd });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        let data = {}, status = 200;
        if (req.method() !== 'GET') writes.push({ path: url.pathname, body: req.postDataJSON() });
        if (url.pathname === '/api/pi/status') data = { ok: true, projectRoots: ['/fixture'], defaultProject: cwd, sessionTitles: supported, sessionTitleModels: supported && modelSupport };
        else if (url.pathname === '/api/pi/projects') data = { roots: ['/fixture'], projects: [{ cwd, name: 'Title project', sessionCount: 1 }], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/sessions') data = { sessions: [session] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/settings/models') data = { models: [model, cheap], providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }, { id: 'budget', name: 'Budget provider', configured: true, authMethods: {} }], customProviders: [],
            preferences: { mediaAgent: { provider: 'fixture', modelId: 'fixture' }, ...(supported ? { sessionTitles: { ...titlePreferences } } : {}) } };
        else if (url.pathname === '/api/pi/settings/session-titles') {
            if (req.method() === 'GET') data = { ...titlePreferences };
            else if (failSettings) { status = 500; data = { error: 'Fixture save failed' }; }
            else {
                const patch = req.postDataJSON();
                if (modelSupport && patch.expectedRevision !== titlePreferences.revision) { status = 409; data = { error: '标题设置已变化，请刷新后再保存' }; }
                else {
                    for (const key of ['enabled', 'provider', 'modelId']) if (Object.hasOwn(patch, key)) titlePreferences[key] = patch[key];
                    if (modelSupport) titlePreferences.revision++;
                    data = { ...titlePreferences };
                }
            }
        } else if (url.pathname.endsWith('/title')) {
            if (req.method() === 'PUT') {
                if (saveConflict) { status = 409; data = { error: '会话或标题已变化，请重新生成标题' }; }
                else { session.name = req.postDataJSON().name; data = { name: session.name }; }
            } else {
                const generatedName = titleMode === 'hold' ? '迟到的旧标题建议' : '手机聊天页横向溢出排查';
                if (titleMode === 'hold') await new Promise(resolve => { releaseTitle = resolve; });
                if (titleMode === 'error') { status = 400; data = { error: '无法生成标题，请等待会话空闲并确认模型可用后重试' }; }
                else data = { name: generatedName, nameRevision: null, contextRevision: 'fixture-revision', ...(modelSupport ? {
                    model: titlePreferences.provider === cheap.provider ? { provider: cheap.provider, id: cheap.id, name: cheap.name } : { provider: model.provider, id: model.id, name: model.name },
                    usage: { input: 92, output: 10, cacheRead: 0, cacheWrite: 3, totalTokens: 105 }
                } : {}) };
            }
        }
        await route.fulfill({ status, json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); calls.push(command.type);
            const state = { model, thinkingLevel: 'off', isStreaming: false };
            let data = {};
            if (command.type === 'open_session') data = { session, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            if (command.type === 'get_state') data = state;
            if (command.type === 'get_messages') data = { messages };
            if (command.type === 'get_available_models') data = { models: [model] };
            if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    const overflow = async selectors => {
        const metrics = await page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(e => e.clientWidth).map(e => ({ selector, width: e.clientWidth, scroll: e.scrollWidth }))), selectors);
        for (const metric of metrics) assert.ok(metric.scroll <= metric.width + 1, `${width}/${locale}: ${JSON.stringify(metric)}`);
    };
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="models"]').click();
    await page.waitForFunction(() => document.getElementById('settings-media-agent-model').options.length);
    if (!supported) {
        assert.equal(await page.locator('#settings-session-titles').isVisible(), false);
        await page.locator('#workspace-settings-close').click();
        await page.locator('#pi-current-thread-menu').click();
        assert.equal(await page.getByRole('menuitem', { name: en ? 'Generate a new title' : '重新生成标题', exact: true }).count(), 0);
        assert.deepEqual(errors, []); await context.close(); return;
    }
    assert.equal(await page.locator('#settings-auto-title').isChecked(), true);
    if (modelSupport) {
        const selectProvider = page.locator('#settings-title-provider'), selectModel = page.locator('#settings-title-model');
        const saveModel = page.locator('#settings-title-model-controls button');
        if (missingModel) {
            assert.equal(await selectProvider.inputValue(), 'removed-provider');
            assert.equal(await selectModel.inputValue(), 'removed-model');
            assert.equal(await saveModel.isDisabled(), true);
            await selectProvider.selectOption(''); await saveModel.click();
            await page.waitForFunction(() => document.querySelector('#settings-title-model-current').textContent.includes('Follow the current thread'));
            assert.equal(titlePreferences.provider, '');
            assert.deepEqual(errors, []); await context.close(); return;
        }
        assert.equal(await selectProvider.inputValue(), '');
        await selectProvider.selectOption(cheap.provider);
        assert.equal(await selectModel.inputValue(), cheap.id);
        assert.equal(writes.length, 0, 'model selection remains a draft until Save');
        await saveModel.click();
        await page.waitForFunction(() => document.querySelector('#settings-title-model-current').textContent.includes('budget/'));
        assert.equal(titlePreferences.modelId, cheap.id);
        if (width < 900) assert.ok(await selectModel.evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
        // A different browser changed preferences after this page read them.
        await selectProvider.selectOption('fixture'); titlePreferences.revision++;
        await saveModel.click();
        await page.waitForFunction(() => !document.getElementById('settings-auto-title').disabled);
        assert.equal(await selectProvider.inputValue(), 'fixture', 'conflict refresh preserves unsaved selection');
        assert.equal(titlePreferences.provider, cheap.provider);
        assert.ok((await page.locator('#settings-auto-title-status').textContent()).includes(en ? 'changed' : '已变化'));
        await selectProvider.selectOption(''); await saveModel.click();
        await page.waitForFunction(() => !document.getElementById('settings-title-provider').disabled);
        assert.equal(titlePreferences.provider, ''); assert.equal(titlePreferences.modelId, '');
        await selectProvider.selectOption(cheap.provider); await saveModel.click();
        await page.waitForFunction(() => !document.getElementById('settings-title-provider').disabled);
    } else assert.equal(await page.locator('#settings-title-model-controls').isVisible(), false);
    assert.ok((await page.locator('#settings-session-titles').innerText()).includes(en ? 'Automatically name conversations' : '自动生成会话标题'));
    await page.locator('#settings-auto-title').uncheck();
    await page.waitForFunction(() => !document.getElementById('settings-auto-title').disabled);
    assert.equal(writes.at(-1).body.enabled, false);
    if (modelSupport) assert.equal(titlePreferences.modelId, cheap.id);
    failSettings = true;
    await page.locator('#settings-auto-title').click();
    await page.waitForFunction(() => !document.getElementById('settings-auto-title').disabled);
    assert.equal(await page.locator('#settings-auto-title').isChecked(), false);
    await overflow(['body', '.workspace-settings-dialog', '.workspace-settings-content', '#settings-session-titles', '#settings-session-titles label', '#settings-title-model-controls', '#settings-title-model-controls select']);
    await page.screenshot({ path: `/tmp/pi-session-titles-${locale}-${width}-settings.png` });
    await page.locator('#workspace-settings-close').click();
    await page.locator('#pi-input').fill('未发送草稿 <keep>');
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('附件内容') });
    await page.locator('#pi-attachments .pi-attachment-chip').first().waitFor();
    const draft = await page.locator('#pi-input').inputValue();
    const openEditor = async () => {
        await page.locator('#pi-current-thread-menu').click();
        await page.getByRole('menuitem', { name: en ? 'Generate a new title' : '重新生成标题', exact: true }).click();
        await page.locator('#pi-title-dialog').waitFor({ state: 'visible' });
    };
    await openEditor();
    await page.waitForFunction(() => !document.getElementById('pi-title-input').disabled);
    assert.equal(await page.locator('#pi-title-input').inputValue(), '手机聊天页横向溢出排查');
    await overflow(['body', '#pi-title-dialog', '#pi-title-dialog .pi-transfer-body', '#pi-title-dialog label', '#pi-title-input', '#pi-title-dialog footer', '#pi-title-usage']);
    if (modelSupport) {
        const usage = await page.locator('#pi-title-usage').textContent();
        assert.ok(usage.includes(`${cheap.provider}/${cheap.id}`));
        assert.ok(usage.includes('92') && usage.includes('10') && usage.includes(en ? 'cache read 0' : '缓存读取 0'));
    } else assert.equal(await page.locator('#pi-title-usage').isVisible(), false);
    if (width < 900) assert.ok(await page.locator('#pi-title-input').evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
    await page.screenshot({ path: `/tmp/pi-session-titles-${locale}-${width}-editor.png` });
    const name = '我的排查 <img src=x onerror=alert(1)>';
    await page.locator('#pi-title-input').fill(name);
    await page.locator('#pi-title-dialog footer').getByRole('button', { name: en ? 'Save' : '保存', exact: true }).click();
    await page.locator('#pi-title-dialog').waitFor({ state: 'hidden' });
    assert.equal(session.name, name);
    assert.ok(!Object.hasOwn(writes.at(-1).body, 'model') && !Object.hasOwn(writes.at(-1).body, 'usage'));
    assert.equal(await page.locator('.pi-session-title img').count(), 0);
    assert.equal(await page.locator('#pi-input').inputValue(), draft);
    assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
    const initialWrites = writes.filter(write => write.path.endsWith('/title') && write.body.name).length;
    titleMode = 'hold';
    await openEditor();
    while (!releaseTitle) await new Promise(resolve => setTimeout(resolve, 10));
    await page.keyboard.press('Escape');
    titleMode = 'ready';
    await openEditor();
    await page.waitForFunction(() => !document.getElementById('pi-title-input').disabled);
    releaseTitle();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pi-title-input').inputValue(), '手机聊天页横向溢出排查', 'a late suggestion cannot overwrite a reopened editor');
    await page.keyboard.press('Escape');
    assert.equal(writes.filter(write => write.path.endsWith('/title') && write.body.name).length, initialWrites);
    saveConflict = true;
    await openEditor(); await page.waitForFunction(() => !document.getElementById('pi-title-input').disabled);
    await page.locator('#pi-title-dialog footer').getByRole('button', { name: en ? 'Save' : '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#pi-title-dialog .pi-transfer-status').textContent.includes(document.documentElement.lang === 'en' ? 'changed' : '已变化'));
    assert.equal(await page.locator('#pi-title-input').inputValue(), '手机聊天页横向溢出排查');
    assert.equal(await page.locator('#pi-title-input').isEnabled(), true, 'failed saves keep the suggestion available for editing/copying');
    await page.keyboard.press('Escape');
    socket.send(JSON.stringify({ type: 'gateway_session_named', cwd, sessionId: session.id, name: '后台生成的新标题' }));
    await page.waitForFunction(() => [...document.querySelectorAll('.pi-session-title')].some(node => node.textContent === '后台生成的新标题'));
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await overflow(['#pi-session-pane', '.pi-session-title']); await page.locator('#pi-toggle-sessions').click(); }
    await page.locator('[data-transcript-mode="full"]').click();
    assert.ok((await page.locator('.pi-tool-output').textContent()).includes('fixture tool output'));
    await overflow(['body', '#pi-attachments', '.pi-tool-block']);
    assert.ok(!calls.includes('prompt'), 'title UI must not prompt the main agent');
    assert.equal(calls.filter(call => call === 'open_session').length, 1, 'title UI must not reconnect the current thread');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`title UI passed: ${locale} ${width}px`);
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const locale of ['zh-CN', 'en']) for (const width of [1440, 393, 320]) await run(browser, base, width, locale);
        await run(browser, base, 393, 'en', false);
        await run(browser, base, 393, 'en', true, false);
        await run(browser, base, 320, 'en', true, true, true);
        console.log('9 title model UI scenarios passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
