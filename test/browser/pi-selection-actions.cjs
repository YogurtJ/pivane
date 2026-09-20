const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/tmp/selection-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const sessions = ['one', 'two'].map(id => ({ cwd, id, name: id, messageCount: 2 }));
const selectedText = '最大化和恢复默认尺寸 <script>literal</script> **literal**';
const messages = [{ role: 'user', content: '请解释布局', timestamp: 1 }, { role: 'assistant', content: '第一段。\n\n' + selectedText.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('*', '\\*'), timestamp: 2, stopReason: 'stop' }];
const speech = { id: 'speech', name: 'Fixture', kind: 'tts', executable: true, textFields: ['text'], parameters: { text: { type: 'textarea', maxLength: 1000 } } };
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = [], prompts = [], reviews = [], executions = []; let fail = false;
    page.on('pageerror', error => { errors.push(error.message); console.error('pageerror:', error.message); }); page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(({ cwd, theme }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'one'); localStorage.setItem('pi.workspace.theme', theme); }, { cwd, theme: width === 1440 ? 'dark' : 'light' });
    await page.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname, body = route.request().postDataJSON();
        const send = json => route.fulfill({ json });
        if (endpoint.endsWith('/status')) return send({ ok: true, sideChat: true, sideChatContext: true, sideChatRetention: true, replyTts: true, projectRoots: ['/tmp'] });
        if (endpoint.endsWith('/projects')) return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/tmp'] });
        if (endpoint.endsWith('/sessions')) return send({ sessions });
        if (endpoint.endsWith('/activity')) return send({ runtimes: [], replyNotices: [], hiddenProjects: [], pinnedProjects: [] });
        if (endpoint.endsWith('/settings/reply-tts')) return send({ models: [speech], defaults: { modelId: 'speech', textParameter: 'text', parameters: {} }, hasSavedDefaults: true });
        if (endpoint.endsWith('/review')) { reviews.push(body); return send({ ticket: 'ticket', model: speech }); }
        if (endpoint.endsWith('/execute')) { executions.push(body); return send({ kind: 'tts', modelId: 'speech', result: { asset: { url: '/audio/fixture.wav' } } }); }
        assert.equal(route.request().method(), 'GET'); return send({});
    });
    await page.route('**/audio/fixture.wav', route => route.fulfill({ status: 404, body: '' }));
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let side = false;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw);
            const reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
            const reference = { mode: 'context', capturedAt: new Date().toISOString(), source: { cwd, sessionId: 'one' }, messageCount: 2, estimatedTokens: 100, tokenBudget: 30000, preview: [] };
            if (cmd.type === 'open_session') return reply({ session: sessions.find(s => s.id === cmd.sessionId), state: { model }, messages: { messages }, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} });
            if (cmd.type === 'prepare_side_chat') return reply({ ticket: 'side', reference });
            if (cmd.type === 'open_side_chat') { side = true; return reply({ state: { model }, reference, limits: { messageCharacters: 8000 }, messages: [], stats: {} }); }
            if (cmd.type === 'get_state') return reply({ model });
            if (cmd.type === 'get_messages') return reply({ messages: side ? [] : messages });
            if (cmd.type === 'get_session_stats') return reply({});
            if (cmd.type === 'prompt') {
                prompts.push({ side, ...cmd });
                if (fail) return ws.send(JSON.stringify({ type: 'response', id: cmd.id, success: false, error: 'fixture rejection', errorCode: 'RPC_REJECTED' }));
                reply({}); ws.send(JSON.stringify({ type: 'message_end', message: { role: 'user', content: cmd.message, timestamp: Date.now() } })); return;
            }
            if (cmd.type === 'quit_side_chat') { reply({}); ws.close(); return; }
            throw Error('Unexpected command ' + cmd.type);
        });
    });
    await page.goto(base); await page.locator('#pi-input:not([disabled])').waitFor().catch(async error => { await page.screenshot({ path: '/tmp/pi-selection-startup-failure.png' }); console.error('startup errors', errors); throw error; });
    const select = async () => {
        await page.locator('#pi-transcript .assistant .pi-markdown p').last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(350);
        await page.locator('#pi-transcript .assistant .pi-markdown p').last().evaluate(el => {
            document.activeElement?.blur();
            const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            document.dispatchEvent(new Event('pointerup'));
        });
        await page.locator('.pi-selection-menu:visible').waitFor();
    };
    const action = name => page.locator(`[data-selection-action="${name}"]`).click();
    await page.locator('#pi-input').fill('已有草稿'); await select();
    const menuBox = await page.locator('.pi-selection-menu').boundingBox(); assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width);
    for (const button of await page.locator('.pi-selection-menu button').all()) assert.ok((await button.boundingBox()).width > 60);
    await page.screenshot({ path: `/tmp/pi-selection-menu-${width}-${locale}.png` });
    await action('main');
    assert.equal(await page.locator('#pi-input').inputValue(), '已有草稿'); assert.equal(prompts.length, 0);
    assert.equal(await page.locator('.pi-composer-quotes .pi-quote-preview').textContent(), selectedText);
    await page.locator('.pi-composer-quotes summary').click(); assert.ok(await page.locator('.pi-composer-quotes .pi-quote-full').isVisible());
    await page.screenshot({ path: `/tmp/pi-selection-${width}.png` });
    fail = true; await page.locator('#pi-send-button').click(); await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
    assert.equal(await page.locator('.pi-composer-quotes .pi-quote-card').count(), 1); assert.equal(await page.locator('#pi-input').inputValue(), '已有草稿');
    fail = false; await page.locator('#pi-send-button').click(); await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.ok(prompts.at(-1).message.includes('> ' + selectedText)); assert.ok(prompts.at(-1).message.endsWith('已有草稿'));
    assert.equal(await page.locator('.pi-composer-quotes .pi-quote-card').count(), 0);
    assert.ok(await page.locator('#pi-transcript .user .pi-quote-card').count());
    await select(); await action('side'); await page.locator('#pi-side-input:not([disabled])').waitFor();
    assert.equal(prompts.filter(p => p.side).length, 0); assert.equal(await page.locator('.pi-side-quotes .pi-quote-card').count(), 1);
    await page.locator('#pi-side-input').fill('侧聊问题'); await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => !document.querySelector('.pi-side-quotes').children.length);
    assert.ok(prompts.at(-1).side && prompts.at(-1).message.includes(selectedText));
    assert.ok(await page.locator('#pi-side-messages .pi-quote-card').count());
    // Close the mobile drawer without ending the side conversation.
    await page.evaluate(() => document.querySelector('#pi-inspector').classList.remove('open'));
    await select(); await action('tts');
    await page.waitForFunction(() => !document.querySelector('#pi-reply-tts-audio').hidden).catch(async error => { console.error({ reviews, executions, errors, state: await page.locator('#pi-reply-tts-bar-state').textContent() }); throw error; });
    assert.equal(reviews.length, 1); assert.equal(reviews[0].parameters.text, selectedText);
    assert.deepEqual(executions, [{ ticket: 'ticket', confirmed: true }]);
    await select(); await action('main');
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('attached fixture') });
    await page.locator('.pi-attachment-chip').waitFor();
    await page.locator('#pi-input').fill('线程一草稿');
    await page.evaluate(() => document.querySelector('[data-session-id="two"] .pi-session-main').click());
    await page.waitForFunction(() => document.querySelector('[data-session-id="two"]').classList.contains('active'));
    assert.equal(await page.locator('.pi-composer-quotes .pi-quote-card').count(), 0);
    await page.locator('#pi-input').fill('线程二草稿');
    await page.evaluate(() => document.querySelector('[data-session-id="one"] .pi-session-main').click());
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '线程一草稿');
    assert.equal(await page.locator('.pi-composer-quotes .pi-quote-card').count(), 1);
    assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
    await page.locator('.pi-composer-quotes .pi-quote-remove').click();
    assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
    assert.equal(await page.locator('.pi-composer-quotes .pi-quote-card').count(), 0);
    // Native right-click opens the same menu; Escape dismisses it.
    await select(); await page.locator('#pi-transcript .assistant .pi-markdown p').last().dispatchEvent('contextmenu', { clientX: 30, clientY: 120 });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.pi-selection-menu').isVisible(), false);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.pi-quote-card, .pi-selection-menu button, #pi-input, #pi-side-input')].filter(el => el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 2 && !el.matches('textarea')).map(el => el.className));
    assert.deepEqual(bad, []); assert.deepEqual(errors, []);
    await context.close(); console.log(`selection actions ${width} ${locale}: passed`);
}
(async () => {
    const app = express();
    app.use('/vendor/marked', express.static(path.join(root, 'node_modules/marked/lib')));
    app.use('/vendor/dompurify', express.static(path.join(root, 'node_modules/dompurify/dist')));
    app.use('/vendor/highlight', express.static(path.join(root, 'node_modules/@highlightjs/cdn-assets')));
    app.use(express.static(path.join(root, 'public')));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, locale] of [[1440, 'zh-CN'], [393, 'en-US'], [320, 'zh-CN'], [320, 'en-US']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
