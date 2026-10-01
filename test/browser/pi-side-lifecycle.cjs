const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const cwd = '/fixture/lifecycle';
const model = { provider: 'fixture', id: 'base', name: 'Default model', contextWindow: 32000, input: ['text'] };
const alternate = { ...model, id: 'alternate', name: 'Alternative model', reasoning: true };

async function run(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); const errors = [], prepares = [], prompts = [], sides = [];
    let active, rejectPrepare = false, accept = true;
    let favorites = [], favoriteRevision = 0;
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => accept ? d.accept() : d.dismiss());
    await page.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'main'); }, cwd);
    const session = { cwd, id: 'main', name: 'Main', messageCount: 0 }, other = { ...session, id: 'other', name: 'Other' };
    await page.route('**/api/**', route => { const p = new URL(route.request().url()).pathname;
        if (p.endsWith('/model-favorites')) {
            if (route.request().method() === 'POST') {
                const input = route.request().postDataJSON();
                assert.equal(input.action, 'set');
                favorites = input.favorite ? [input.model] : []; favoriteRevision++;
            }
            return route.fulfill({ json: { version: 1, revision: favoriteRevision, favorites } });
        }
        assert.equal(route.request().method(), 'GET');
        return route.fulfill({ json: p.endsWith('/status') ? { ok: true, projectRoots: ['/fixture'], sideChat: true, sideChatContext: true, sideChatTools: true, sideChatModels: true, sideChatRetention: true, sideChatLifecycle: true }
            : p.endsWith('/projects') ? { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 2 }] }
            : p.endsWith('/sessions') ? { sessions: [session, other] }
            : p.endsWith('/activity') ? { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } : { configured: false } }); });
    const state = s => ({ model: s.model, thinkingLevel: s.level, isStreaming: s.busy, toolMode: 'assist', toolAccess: 'read', pendingUi: [] });
    const send = (s, event) => s.ws.send(JSON.stringify(event));
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let side;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); let data = {}, error;
            if (cmd.type === 'open_session') data = { session: cmd.sessionId === 'other' ? other : session, state: { model, thinkingLevel: 'off', isStreaming: false }, messages: { messages: [] }, models: { models: [model, alternate] }, thinkingLevels: { levels: ['off'] }, stats: {}, commands: { commands: [] } };
            else if (cmd.type === 'get_side_model_options') data = { model, thinkingLevel: 'off', models: [{ ...model, levels: ['off'] }, { ...alternate, levels: ['off', 'high'] }, ...Array.from({length: 350}, (_, i) => ({ provider: 'many', id: `extra-${i}`, name: `Extra model ${i}`, levels: ['off'] }))] };
            else if (cmd.type === 'prepare_side_chat') { prepares.push(cmd); if (rejectPrepare) error = 'context does not fit'; data = { ticket: String(prepares.length), reference: { mode: cmd.mode, capturedAt: new Date().toISOString(), messageCount: 0, source: { cwd }, preview: [] }, limits: { messageCharacters: 8000 } }; }
            else if (cmd.type === 'open_side_chat') { const prep = prepares[Number(cmd.ticket) - 1]; side = { ws, model: prep.model?.id === 'alternate' ? alternate : model, level: prep.thinkingLevel || 'off', busy: false, messages: [] }; sides.push(side); active = side; data = { state: state(side), reference: { mode: prep.mode, capturedAt: new Date().toISOString(), preview: [] }, messages: [], stats: {}, limits: { messageCharacters: 8000 } }; }
            else if (cmd.type === 'get_side_models') data = { models: [model, alternate], levels: side.level === 'high' ? ['off', 'high'] : ['off'] };
            else if (cmd.type === 'get_state') data = state(side);
            else if (cmd.type === 'get_messages') data = { messages: side.messages };
            else if (cmd.type === 'close_side_segment') { assert.equal(side.busy, false); data = { state: state(side), messages: side.messages, stats: {} }; }
            else if (cmd.type === 'prompt') {
                prompts.push(cmd); const now = Date.now(); side.messages.push({ role: 'user', content: cmd.message, timestamp: now }, { role: 'assistant', content: `Answer: ${cmd.message}`, stopReason: 'stop', timestamp: now + 1 });
                send(side, { type: 'agent_start' }); for (const message of side.messages.slice(-2)) send(side, { type: 'message_end', message }); send(side, { type: 'agent_settled' }); data = { accepted: true };
            }
            ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, error, data }));
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await openInspector(page, 'side'); await page.waitForFunction(() => !document.querySelector('#pi-side-input').disabled);
    assert.equal(prepares.length, 0); assert.equal(sides.length, 0);
    const english = locale === 'en-US';
    assert.equal(await page.locator('#pi-side-reference').evaluate(n => n.open), false);
    assert.equal(await page.locator('#pi-side-status').isVisible(), false, 'no idle explanatory status');
    assert.equal(await page.locator('#pi-side-model-note').count(), 0, 'no repeated startup instructions under model');
    assert.equal(await page.locator('#pi-side-input').getAttribute('placeholder'), english ? 'What would you like to ask?' : '想问些什么？');
    assert.equal(await page.locator('.pi-side-empty').textContent(), english ? 'Chat here without interrupting the main conversation.' : '在这里聊，不打断主对话。');
    assert.equal(await page.locator('#pi-side-reference-label').textContent(), english ? 'Background & model' : '背景与模型');
    assert.equal(await page.locator('#pi-side-info-panel').isVisible(), false);
    await page.screenshot({ path: `/tmp/pi-side-help-${width}-${locale}-default.png` });
    await page.locator('#pi-side-info').click();
    assert.equal(await page.locator('#pi-side-info').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#pi-side-info-panel').isVisible(), true);
    assert.equal(await page.locator('#pi-side-info-points li').count(), 4);
    assert.match(await page.locator('#pi-side-info-panel').textContent(), /12/);
    await page.screenshot({ path: `/tmp/pi-side-help-${width}-${locale}-info.png` });
    await page.locator('#pi-side-info-close').click();
    assert.equal(await page.locator('#pi-side-info').evaluate(n => n === document.activeElement), true);
    await page.locator('#pi-side-info').press('Enter');
    await page.locator('#pi-side-info-close').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-side-info').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#pi-inspector').evaluate(n => n.classList.contains('open')), true, 'help Escape does not close chat');
    assert.equal(prepares.length, 0, 'help never captures context or starts a runtime');
    await page.locator('#pi-side-input').fill('First private discussion'); assert.equal(prepares.length, 0);
    await page.locator('#pi-side-reference > summary').click();
    await page.waitForFunction(() => !document.querySelector('#pi-side-model-select').disabled);
    assert.equal(await page.locator('#pi-side-model').isVisible(), false, 'model appears only in selector when settings are open');
    await page.screenshot({ path: `/tmp/pi-side-help-${width}-${locale}-settings.png` });
    await page.locator('#pi-side-model-select').click();
    const picker = page.locator('dialog.pi-model-dialog[open]');
    assert.notEqual(await picker.getAttribute('id'), 'pi-model-dialog');
    assert.equal(await page.locator('[id="pi-model-dialog"]').count(), 1, 'main picker ID stays unique');
    if (width < 900) assert.equal(await picker.locator('.pi-model-search').evaluate(n => n === document.activeElement), false);
    assert.ok(await picker.locator('.pi-model-option').count() <= 6, 'hundreds of models do not flood initial view');
    await picker.locator('.pi-model-all').click();
    assert.equal(await picker.locator('.pi-model-option').count(), 60, 'all models are paged');
    await picker.locator('.pi-model-search').fill('Alternative');
    assert.equal(await picker.locator('.pi-model-option').count(), 1);
    await picker.locator('.pi-model-star:not([disabled])').waitFor();
    await picker.locator('.pi-model-star').click();
    await page.waitForFunction(() => document.querySelector('dialog[open] .pi-model-star').getAttribute('aria-pressed') === 'true');
    assert.deepEqual(favorites, [{ provider: 'fixture', modelId: 'alternate' }]);
    await page.screenshot({ path: `/tmp/pi-side-picker-${width}-${locale}.png` });
    await picker.locator('.pi-model-option').click();
    assert.equal(await page.locator('#pi-model-select').textContent().then(t => t.includes('Alternative')), false, 'main selection unchanged');
    await page.locator('#pi-side-model-select').click();
    assert.ok(await picker.locator('.pi-model-group').first().locator('.pi-model-option').textContent().then(text => text.includes('Alternative')), 'favorite returns in compact initial view');
    await picker.locator('.pi-model-close').click();
    await page.locator('#pi-side-thinking-select').selectOption('high');
    assert.equal(sides.length, 0); await page.locator('#pi-side-send').click();
    try {
        await page.waitForFunction(() => document.querySelector('#pi-side-messages').textContent.includes('Answer: First') && document.querySelector('#pi-side-input').value === '');
    } catch (error) {
        console.error(JSON.stringify({ width, locale, prepares, prompts, errors, ui: await page.locator('#pi-side-chat').textContent() }));
        await page.screenshot({ path: `/tmp/pi-side-lifecycle-${width}-${locale}-failure.png` });
        throw error;
    }
    assert.equal(await page.locator('#pi-side-status').isVisible(), false, 'successful completion stays quiet');
    assert.equal(prepares[0].model.id, 'alternate'); assert.equal(prepares[0].thinkingLevel, 'high');
    assert.equal(await page.locator('[data-side-action="insert"]').count(), 0);
    await page.locator('#pi-side-input').fill('Retain my draft');
    send(active, { type: 'agent_start' }); active.busy = true;
    await page.waitForFunction(() => document.querySelector('#pi-side-refresh').disabled);
    active.busy = false; send(active, { type: 'agent_settled' });
    await page.waitForFunction(() => !document.querySelector('#pi-side-refresh').disabled);
    accept = false; await page.locator('#pi-side-refresh').click(); assert.equal(sides.length, 1); assert.equal(await page.locator('#pi-side-input').inputValue(), 'Retain my draft');
    accept = true; await page.locator('#pi-side-refresh').click();
    await page.waitForFunction(() => document.querySelectorAll('.pi-side-archive').length === 1);
    assert.equal(prepares.length, 1); assert.equal(await page.locator('#pi-side-input').inputValue(), 'Retain my draft');
    assert.ok((await page.locator('#pi-side-history').textContent()).includes('First private discussion'));
    rejectPrepare = true; await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent.includes('context does not fit'));
    assert.equal(await page.locator('#pi-side-status').isVisible(), true, 'failure must stay visible');
    assert.equal(await page.locator('#pi-side-input').inputValue(), 'Retain my draft'); assert.equal(prompts.length, 1);
    rejectPrepare = false; await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-input').value === '' && document.querySelector('#pi-side-messages').textContent.includes('Retain my draft'));
    assert.deepEqual(active.messages.filter(m => m.role === 'user').map(m => m.content), ['Retain my draft']);
    assert.ok(!JSON.stringify(prepares.at(-1)).includes('First private discussion'));
    await page.locator('#pi-side-input').fill('Unsent after expiry');
    // Expiry can arrive while another main thread is selected; never leak into it.
    const switchTo = async id => {
        await page.locator('#pi-close-inspector').click();
        if (width < 900) await page.locator('#pi-toggle-sessions').click();
        await page.locator('[data-filter="all"]').click();
        await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
        await page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled, id);
        await openInspector(page, 'side');
    };
    await switchTo('other');
    await page.waitForFunction(() => document.querySelectorAll('dialog[id^="pi-side-model-dialog-"]').length === 2);
    assert.equal(await page.evaluate(() => {
        const ids = [...document.querySelectorAll('dialog.pi-model-dialog')].map(n => n.id);
        return new Set(ids).size === ids.length;
    }), true, 'retained threads each own an isolated picker');
    assert.equal(await page.locator('dialog.pi-model-dialog[open]').count(), 0);
    assert.equal(prepares.length, 3, 'opening another thread does not create a side');
    send(active, { type: 'gateway_side_expired', messages: active.messages, stats: {}, state: state(active), idleHours: 12 });
    active.ws.close({ code: 1000, reason: 'expired' });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#pi-side-session-note').isVisible(), false);
    assert.equal(await page.locator('#pi-side-input').inputValue(), '');
    await switchTo('main');
    await page.waitForFunction(() => !document.querySelector('#pi-side-session-note').hidden);
    assert.equal(await page.locator('#pi-side-send').isDisabled(), true); assert.equal(await page.locator('#pi-side-input').inputValue(), 'Unsent after expiry');
    await page.screenshot({ path: `/tmp/pi-side-lifecycle-${width}-${locale}-expired.png` });
    await page.locator('#pi-side-new').click(); await page.waitForFunction(() => document.querySelectorAll('.pi-side-archive').length === 2);
    assert.equal(sides.length, 2); await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-input').value === ''); assert.equal(sides.length, 3);
    assert.deepEqual(active.messages.filter(m => m.role === 'user').map(m => m.content), ['Unsent after expiry']);
    await page.locator('.pi-side-archive > summary').first().click(); await page.locator('.pi-side-archive [data-side-action="copy"]').first().click();
    for (const selector of ['body', '#pi-side-chat', '#pi-side-content', '.pi-side-archive']) assert.ok(await page.locator(selector).first().evaluate(n => n.scrollWidth <= n.clientWidth + 1), selector);
    if (width < 900) assert.ok(await page.locator('#pi-side-input').evaluate(n => parseFloat(getComputedStyle(n).fontSize) >= 16));
    await page.screenshot({ path: `/tmp/pi-side-lifecycle-${width}-${locale}-history.png` });
    await page.locator('#pi-side-end').click();
    await page.waitForFunction(() => document.querySelectorAll('.pi-side-archive').length === 0 && document.querySelector('#pi-side-input').value === '');
    assert.equal(await page.locator('#pi-side-history').textContent(), ''); assert.deepEqual(errors, []);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.waitForFunction(() => document.querySelectorAll('dialog[id^="pi-side-model-dialog-"]').length === 0);
    assert.equal(await page.locator('#pi-input').inputValue(), '');
    await context.close(); console.log(`PASS lifecycle ${width} ${locale}: deferred startup, model selection, local history, expiry, no inheritance, clear and safe layout`);
}
(async () => { const app = express(), root = path.resolve(__dirname, '../..'); app.use(express.static(path.join(root, 'public'))); for (const [n, d] of [['marked','marked/lib'], ['dompurify','dompurify/dist'], ['highlight','@highlightjs/cdn-assets']]) app.use('/vendor/' + n, express.static(path.join(root, 'node_modules', d)));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const locale of ['zh-CN', 'en-US']) for (const width of [1440, 393, 320]) await run(browser, 'http://127.0.0.1:' + server.address().port, width, locale); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
