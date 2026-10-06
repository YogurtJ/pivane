// Synthetic service and WebSockets only. CSS pixels + Retina density, saved split widths,
// interactive parallel tool panels, expanded file reading, mobile modal transitions,
// retained side/history/file state, and native thinking values.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const model = { provider: 'fixture', id: 'reasoning', name: 'Fixture reasoning', reasoning: true, input: ['text'], contextWindow: 32000, levels };
const cwd = '/synthetic/side-layout';
const evidence = process.env.PI_SIDE_LAYOUT_EVIDENCE || '/tmp/pi-side-layout';
async function run(browser, base, viewport, locale, preferred = 336, navExpanded = false) {
    const context = await browser.newContext({ viewport, locale, reducedMotion: 'reduce', deviceScaleFactor: 2, isMobile: viewport.width <= 680, hasTouch: viewport.width <= 680 });
    const page = await context.newPage(), errors = [], prompts = [], preparations = [];
    let side, sockets = 0, closes = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, preferred, navExpanded, theme }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'main');
        localStorage.setItem('pi.workspace.split:agent-inspector', String(preferred));
        localStorage.setItem('pi.workspace.split:agent-sessions', '320');
        localStorage.setItem('pi.workspace.sidebarCollapsed', String(!navExpanded));
        localStorage.setItem('pi.workspace.theme', theme);
    }, { cwd, preferred, navExpanded, theme: locale === 'en-US' ? 'dark' : 'daylight' });
    await page.route('https://**', route => route.abort());
    const session = { cwd, id: 'main', name: 'Synthetic main', messageCount: 0 };
    await page.route('**/api/**', route => {
        assert.equal(route.request().method(), 'GET');
        const p = new URL(route.request().url()).pathname;
        const json = p.endsWith('/status') ? { ok: true, projectRoots: ['/synthetic'], sideChat: true, sideChatContext: true, sideChatTools: true, sideChatModels: true, sideChatLifecycle: true, sideChatRetention: true, fileViewer: true, fileBrowser: true, historySearch: true }
            : p.endsWith('/projects') ? { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }], roots: ['/synthetic'] }
            : p.endsWith('/sessions') ? { sessions: [session] }
            : p.endsWith('/activity') ? { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] }
            : p.endsWith('/model-favorites') ? { version: 1, revision: 0, favorites: [] }
            : p.endsWith('/files/list') ? { cwd, path: '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file' }], partial: false }
            : p.endsWith('/files/content') ? { cwd, path: 'README.md', absolutePath: cwd + '/README.md', content: '# Synthetic file\n\n' + 'A readable paragraph.\n\n'.repeat(60), revision: 'fixture', readAt: new Date().toISOString() } : {};
        return route.fulfill({ json });
    });
    const emit = event => side.send(JSON.stringify(event));
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let isSide = false, selected = 'high', messages = [];
        ws.onClose(() => { if (isSide) closes++; });
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); let data = {};
            const state = () => ({ model, thinkingLevel: selected, isStreaming: false, toolMode: 'assist', toolAccess: 'read', pendingUi: [] });
            if (cmd.type === 'open_session') data = { session, state: state(), messages: { messages: [] }, models: { models: [model] }, thinkingLevels: { levels }, commands: { commands: [] }, stats: {} };
            else if (cmd.type === 'get_side_model_options') data = { model, thinkingLevel: 'high', models: [model] };
            else if (cmd.type === 'prepare_side_chat') { preparations.push(cmd); data = { ticket: 'synthetic', reference: { mode: 'context', capturedAt: new Date().toISOString(), messageCount: 0, source: { cwd }, preview: [] }, limits: { messageCharacters: 8000 } }; }
            else if (cmd.type === 'open_side_chat') { isSide = true; side = ws; sockets++; selected = preparations.at(-1).thinkingLevel; data = { state: state(), reference: { mode: 'context', capturedAt: new Date().toISOString(), messageCount: 0, source: { cwd }, preview: [] }, messages, stats: {}, limits: { messageCharacters: 8000 } }; }
            else if (cmd.type === 'get_side_models') data = { models: [model], levels };
            else if (cmd.type === 'get_state') data = state();
            else if (cmd.type === 'get_messages') data = { messages };
            else if (cmd.type === 'search_history') data = { results: [], offset: 0, pageSize: 30, revision: 'fixture', hasMore: false, total: 0 };
            else if (cmd.type === 'prompt') {
                assert.equal(isSide, true, 'layout/level controls never send the main draft'); prompts.push(cmd);
                messages = [{ role: 'user', content: cmd.message, timestamp: Date.now() }, { role: 'assistant', content: 'Synthetic side answer', stopReason: 'stop', timestamp: Date.now() + 1 }];
                emit({ type: 'agent_start' }); messages.forEach(message => emit({ type: 'message_end', message })); emit({ type: 'agent_settled' }); data = { accepted: true };
            }
            ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        });
    });
    await page.goto(base, { waitUntil: 'load' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    await page.locator('#pi-input').fill('Main draft stays here');
    await openInspector(page, 'side');
    await page.locator('#pi-side-input:not([disabled])').waitFor();
    const docked = async (tool = 'side') => {
        await page.waitForFunction(() => {
            const main = document.querySelector('.pi-transcript-shell'), side = document.querySelector('#pi-inspector');
            const a = main.getBoundingClientRect(), b = side.getBoundingClientRect();
            return !document.querySelector('.pi-workbench').classList.contains('pi-inspector-overlay') && !main.inert && a.width >= 359 && b.width >= 279 && a.right <= b.left + 1;
        });
        assert.equal(await page.locator('#pi-inspector').getAttribute('aria-modal'), null);
        assert.equal(await page.locator('.pi-drawer-scrim').isVisible(), false);
        assert.equal(await page.locator('#pi-inspector-split').isVisible(), true);
        for (const selector of tool === 'side' ? ['#pi-input', '#pi-side-input'] : ['#pi-input']) {
            await page.locator(selector).click();
            assert.equal(await page.locator(selector).evaluate(node => node === document.activeElement), true, selector);
        }
        for (const selector of ['body', '.pi-transcript-shell', '#pi-transcript', '.pi-composer-wrap', '#pi-inspector', ...(tool === 'side' ? ['#pi-side-chat'] : tool === 'changes' ? ['#pi-file-reader'] : [])]) assert.ok(await page.locator(selector).evaluate(node => node.scrollWidth <= node.clientWidth + 1), selector);
    };
    if (viewport.width > 900) await docked();
    else { await page.waitForFunction(() => document.querySelector('.pi-transcript-shell').inert); assert.equal(await page.locator('#pi-inspector').getAttribute('aria-modal'), 'true'); }
    await page.locator('#pi-side-reference > summary').click();
    await page.waitForFunction(() => !document.querySelector('#pi-side-thinking-select').disabled);
    const labels = await page.locator('#pi-side-thinking-select option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent })));
    assert.deepEqual(labels.map(option => option.value), levels);
    const english = locale === 'en-US';
    assert.deepEqual(labels.map(option => option.label), (english ? ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Very high', 'Maximum'] : ['不启用', '极简', '低', '中', '高', '极高', '最大']).map(label => `${english ? 'Thinking' : '思考'} ${label}`));
    assert.equal(await page.locator('#pi-side-thinking-select').getAttribute('aria-label'), english ? 'Thinking level' : '思考等级');
    await page.locator('#pi-side-thinking-select').selectOption('medium');
    assert.equal(preparations.length, 0); assert.equal(sockets, 0);
    await page.locator('#pi-side-input').fill('Start the synthetic discussion'); await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-messages').textContent.includes('Synthetic side answer') && document.querySelector('#pi-side-input').value === '');
    assert.equal(preparations[0].thinkingLevel, 'medium'); assert.equal(await page.locator('#pi-thinking-select').inputValue(), 'high');
    await page.locator('#pi-side-input').fill('Retained side draft');
    await page.screenshot({ path: path.join(evidence, `${viewport.width}-${preferred}-${locale}-${navExpanded}-settings.png`) });
    await page.locator('#pi-side-reference > summary').click();
    if (viewport.width > 900) {
        await page.setViewportSize({ width: 393, height: 852 });
        await page.waitForFunction(() => document.querySelector('.pi-transcript-shell').inert);
        assert.equal(await page.locator('#pi-inspector').getAttribute('aria-modal'), 'true');
        assert.equal(await page.locator('#pi-inspector-split').isVisible(), false);
        await page.setViewportSize(viewport); await docked();
        const fitted = await page.locator('#pi-inspector').evaluate(node => node.getBoundingClientRect().width);
        assert.ok(fitted <= preferred + 1);
        assert.equal(await page.evaluate(() => localStorage.getItem('pi.workspace.split:agent-inspector')), String(preferred), 'viewport fitting preserves saved preference');
        await page.setViewportSize({ width: 2200, height: 950 });
        await page.waitForFunction(size => Math.abs(document.querySelector('#pi-inspector').getBoundingClientRect().width - size) < 1, preferred);
        await page.setViewportSize(viewport); await docked();
        for (const tool of ['details', 'changes', 'history']) {
            await openInspector(page, tool); await docked(tool);
            assert.equal(await page.locator('#pi-session-pane').isVisible(), viewport.width >= 1200);
            if (tool === 'changes') {
                await page.locator('[data-path="README.md"]').click(); await page.locator('#pi-file-body h1').waitFor();
                await page.locator('#pi-file-body').evaluate(node => node.scrollTop = 120);
                const normal = await page.locator('#pi-inspector').evaluate(node => node.getBoundingClientRect().width);
                await page.locator('#pi-files-expand').click(); await docked(tool);
                await page.waitForFunction(size => document.querySelector('#pi-inspector').getBoundingClientRect().width >= size, normal);
                assert.equal(await page.locator('#pi-session-pane').isVisible(), false);
                assert.equal(await page.locator('#pi-files-expand').getAttribute('aria-pressed'), 'true');
                await page.locator('#pi-inspector-split').focus(); await page.keyboard.press('Home');
                await page.waitForFunction(() => document.querySelector('#pi-inspector').getBoundingClientRect().width <= 281);
                await page.keyboard.press('End'); await docked(tool);
                const expanded = await page.locator('#pi-inspector').evaluate(node => node.getBoundingClientRect().width);
                assert.ok(expanded <= 1120 && expanded >= normal);
                assert.equal(await page.evaluate(() => localStorage.getItem('pi.workspace.split:agent-inspector')), String(preferred), 'expanded resizing preserves ordinary tool preference');
                // Let the reader's own ResizeObserver finish its column layout
                // before comparing positions at the same expanded width.
                const readerSettled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
                await readerSettled();
                const readerShape = () => page.locator('#pi-file-body').evaluate(node => ({ top: node.scrollTop, width: node.clientWidth, height: node.clientHeight, scrollHeight: node.scrollHeight, paragraphs: node.querySelectorAll('p').length, font: getComputedStyle(node.querySelector('p')).font, paragraphTop: node.querySelector('p').getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop }));
                const reading = await readerShape();
                await page.setViewportSize({ width: 393, height: 852 });
                await page.waitForFunction(() => document.querySelector('.pi-transcript-shell').inert);
                assert.equal(await page.locator('#pi-inspector').getAttribute('aria-modal'), 'true');
                assert.equal(await page.locator('#pi-file-body h1').textContent(), 'Synthetic file');
                await page.setViewportSize(viewport); await docked(tool); await readerSettled();
                const restored = await readerShape();
                assert.deepEqual(restored, reading, JSON.stringify({ reading, restored }));
                await page.locator('#pi-files-expand').click(); await docked(tool);
                await page.waitForFunction(size => Math.abs(document.querySelector('#pi-inspector').getBoundingClientRect().width - size) < 1, normal);
            } else if (tool === 'history') {
                await page.locator('#pi-history-query').fill('Retained history search');
                await page.locator('#pi-input').click();
            }
            await page.screenshot({ path: path.join(evidence, `${viewport.width}-${preferred}-${locale}-${navExpanded}-${tool}.png`) });
            await page.locator('#pi-close-inspector').click();
            await page.waitForFunction(() => getComputedStyle(document.querySelector('#pi-session-pane')).display !== 'none');
            assert.equal(await page.locator('.pi-drawer-scrim').isVisible(), false);
        }
        await openInspector(page, 'history'); await docked('history');
        assert.equal(await page.locator('#pi-history-query').inputValue(), 'Retained history search');
        await openInspector(page, 'changes'); await docked('changes');
        assert.equal(await page.locator('#pi-file-body h1').textContent(), 'Synthetic file');
        await openInspector(page, 'side'); await docked();
    } else {
        for (const tool of ['details', 'changes', 'history', 'side']) {
            await page.locator('#pi-inspector-title').selectOption(tool);
            await page.waitForFunction(() => document.querySelector('.pi-transcript-shell').inert);
            assert.equal(await page.locator('#pi-inspector').getAttribute('aria-modal'), 'true');
            assert.equal(await page.locator('.pi-drawer-scrim').isVisible(), true);
            assert.equal(await page.locator('#pi-inspector-split').isVisible(), false);
        }
    }
    assert.equal(await page.locator('#pi-input').inputValue(), 'Main draft stays here');
    assert.equal(await page.locator('#pi-side-input').inputValue(), 'Retained side draft');
    assert.equal(await page.locator('#pi-side-thinking-select').inputValue(), 'medium');
    assert.equal(await page.locator('#pi-side-messages article.assistant').count(), 1);
    assert.equal(sockets, 1); assert.equal(closes, 0); assert.equal(preparations.length, 1); assert.equal(prompts.length, 1); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(evidence, `${viewport.width}-${preferred}-${locale}-${navExpanded}-conversation.png`) });
    await context.close(); console.log(`PASS side layout ${viewport.width}x${viewport.height} ${locale} saved=${preferred} expandedNav=${navExpanded}`);
}
(async () => {
    await fs.mkdir(evidence, { recursive: true });
    const root = path.resolve(__dirname, '../..'), app = express(); app.use(express.static(path.join(root, 'public')));
    for (const [n,d] of [['marked','marked/lib'],['dompurify','dompurify/dist'],['highlight','@highlightjs/cdn-assets']]) app.use('/vendor/'+n,express.static(path.join(root,'node_modules',d)));
    const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const locale of ['zh-CN','en-US']) for (const [width,height,preferred,navExpanded] of [[1468,834,700],[1280,800,800],[1440,900,800,true],[1920,1080,800],[1024,768,336],[901,768,800],[901,768,800,true],[1199,800,700],[1200,800,700],[1200,800,800,true],[960,720,336],[900,720,700],[393,852,336],[320,740,336]]) {
            if (process.env.PI_SIDE_LAYOUT_WIDTH && process.env.PI_SIDE_LAYOUT_WIDTH !== String(width)) continue;
            await run(browser, 'http://127.0.0.1:'+server.address().port, {width,height},locale,preferred,navExpanded);
        }
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
