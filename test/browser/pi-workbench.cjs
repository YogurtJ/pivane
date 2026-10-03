// Synthetic REST/WS only: workbench layout, real entry points, drafts and focus.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const root = path.resolve(__dirname, '../..');
const evidence = process.env.PI_WORKBENCH_EVIDENCE || path.join(require('node:os').tmpdir(), 'pivane-workbench-evidence');
const cwd = '/synthetic/workbench';
const session = { id: 'empty', cwd, name: 'Synthetic workbench', modified: new Date().toISOString(), messageCount: 99,
    stats: { messages: 42, context: 12, compactions: 2, contextTokens: 172000, model: { provider: 'fixture', id: 'model-x' } } };
const model = { provider: 'fixture', id: 'model', name: 'A deliberately long model name for layout checks', input: ['text'], contextWindow: 32000 };
const plan = id => ({ version: 1, id, explanation: '', plan: [{ step: 'Inspect the workspace', status: 'in_progress' }, { step: 'Verify controls', status: 'pending' }] });
async function run(browser, base, viewport, preferences = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', locale: 'en-US', isMobile: viewport.width <= 680, hasTouch: viewport.width <= 680 });
    const page = await context.newPage(), errors = [], writes = [], commands = [];
    let socket, streaming = false, progress = null, sequence = 0;
    page.on('pageerror', error => { errors.push(error.message); console.error('pageerror:', error.stack); });
    await page.addInitScript(({ cwd, preferences }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'empty');
        for (const [key, value] of Object.entries(preferences)) localStorage.setItem(key, String(value));
    }, { cwd, preferences });
    await page.route('https://**', route => route.abort());
    await page.route('**/api/**', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') writes.push(url.pathname);
        const data = url.pathname === '/api/pi/status' ? { projectRoots: ['/synthetic'], sessionSearch: true }
            : url.pathname === '/api/pi/projects' ? { projects: [{ cwd, name: 'Workbench', sessionCount: 1 }], roots: ['/synthetic'] }
                : url.pathname === '/api/pi/sessions' ? { sessions: [session] }
                    : url.pathname === '/api/pi/activity' ? { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] }
                        : url.pathname.includes('history') || url.pathname === '/api/prompts' ? [] : {};
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); commands.push(command.type);
            const state = { model, isStreaming: streaming, thinkingLevel: 'high' };
            const messages = { messages: [], webProgress: progress, webLive: { runtimeId: 'fixture', sequence, tools: [], running: streaming } };
            const data = command.type === 'open_session' ? { session, state, messages, models: { models: [model] }, thinkingLevels: { levels: ['off', 'high'] }, commands: { commands: [] }, stats: {} }
                : command.type === 'get_state' ? state : command.type === 'get_messages' ? messages : {};
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const emit = event => socket.send(JSON.stringify({ ...event, webRuntimeId: 'fixture', webSequence: ++sequence }));
    // Geometry baselines require the complete stylesheet cascade. A ready
    // input can precede the final workbench CSS on native Windows Chromium.
    await page.goto(base, { waitUntil: 'load' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    await page.locator('.pi-start-card').first().waitFor();
    const measure = () => page.evaluate(() => {
        const box = selector => { const node = document.querySelector(selector), r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right, scroll: node.scrollWidth, client: node.clientWidth }; };
        return { width: innerWidth, height: innerHeight, page: box('body'), nav: box('#workspace-sidebar'), projects: box('#pi-session-pane'), chat: box('.pi-transcript-shell'), composer: box('.pi-composer'), input: box('#pi-input'), panel: box('#pi-inspector'), overlay: document.querySelector('.pi-workbench').classList.contains('pi-inspector-overlay') };
    });
    const before = await measure();
    assert.ok(before.page.scroll <= viewport.width && before.page.height <= viewport.height + 1, JSON.stringify(before));
    assert.ok(before.composer.bottom <= viewport.height + 1, JSON.stringify(before));
    if (viewport.width <= 680) assert.ok(await page.locator('#pi-input').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
    if (viewport.width <= 900) assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.inert), true, 'closed drawer cannot receive keyboard focus');
    if (viewport.width > 900) assert.equal(before.nav.width, preferences['pi.workspace.sidebarCollapsed'] === false ? 184 : 72);
    // Desktop merges project/context into the conversation header; smaller screens keep the command bar.
    const header = await page.evaluate(() => ({
        bar: getComputedStyle(document.querySelector('.pi-command-bar')).display,
        project: document.querySelector('#pi-project-button').parentElement.className,
        context: document.querySelector('#pi-context-button').parentElement.className,
        banner: document.querySelector('#pi-connection-banner').getBoundingClientRect().height,
        title: document.querySelector('#pi-project-button').title,
        newChat: document.querySelector('#pi-new-session').textContent.trim(),
        search: (node => node.hidden ? null : { height: node.getBoundingClientRect().height, scroll: node.scrollWidth, client: node.clientWidth })(document.querySelector('#pi-search-conversations')),
        tooltip: document.querySelector('[data-session-id="empty"] .pi-session-main').dataset.details,
        tools: [...document.querySelectorAll('.pi-tool-rail button')].map(node => node.dataset.toolPane),
        taskTool: document.querySelectorAll('#pi-tool-tasks, #pi-mobile-tool-tasks, #pi-inspector-tasks').length
    }));
    assert.equal(header.newChat, 'New chat'); assert.equal(header.taskTool, 0, 'task cards stay above the composer only');
    assert.match(header.tooltip, /42 messages/); assert.match(header.tooltip, /Compacted 2 times · 12 messages/); assert.match(header.tooltip, /172k/); assert.match(header.tooltip, /model-x/);
    assert.equal(header.tools[0], 'details', 'details is the first tool');
    if (viewport.width > 900) {
        // Styled hover card appears only after a deliberate pause and stays inside the viewport.
        const row = page.locator('[data-session-id="empty"] .pi-session-main');
        await row.hover(); await page.waitForTimeout(350);
        assert.equal(await page.locator('#pi-session-hover:visible').count(), 0, 'hover card waits for a pause');
        await page.locator('#pi-session-hover').waitFor({ state: 'visible', timeout: 2000 });
        const card = await page.locator('#pi-session-hover').evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, font: parseFloat(getComputedStyle(node).fontSize), text: node.textContent, rows: node.querySelectorAll('li').length }; });
        assert.ok(card.font >= 13 && card.rows >= 4 && card.left >= 0 && card.right <= viewport.width && card.bottom <= viewport.height, JSON.stringify(card));
        assert.match(card.text, /42 messages/);
        assert.equal(await row.getAttribute('aria-describedby'), 'pi-session-hover');
        await page.mouse.move(viewport.width - 5, viewport.height / 2);
        await page.locator('#pi-session-hover').waitFor({ state: 'hidden' });
        if (evidence) { await row.hover(); await page.waitForTimeout(900); await page.screenshot({ path: path.join(evidence, `hover-${viewport.width}.png`) }); await page.mouse.move(viewport.width - 5, viewport.height / 2); }
    }
    if (viewport.width > 900) {
        assert.equal(header.bar, 'none'); assert.match(header.project, /pi-connection-banner/); assert.match(header.context, /pi-connection-banner/);
        assert.ok(header.banner <= 56, JSON.stringify(header)); assert.match(header.title, /\/synthetic\/workbench/);
        assert.ok(header.search && header.search.height <= 34 && header.search.scroll <= header.search.client + 1, JSON.stringify(header));
    } else assert.match(header.project, /pi-command-left/);
    if (viewport.width <= 680) {
        // Idle phone composer: add, text, context ring and send in one row; model details only while composing.
        const idle = await page.evaluate(() => ({ summary: getComputedStyle(document.querySelector('#pi-mobile-composer-summary')).display,
            ring: document.querySelector('#pi-mobile-context-trigger').getBoundingClientRect().width, composer: document.querySelector('.pi-composer').getBoundingClientRect().height }));
        assert.equal(idle.summary, 'none'); assert.ok(idle.ring > 0 && idle.composer <= 60, JSON.stringify(idle));
        await page.locator('#pi-input').focus();
        const composing = await page.evaluate(() => ({ summary: document.querySelector('#pi-mobile-composer-summary').getBoundingClientRect(), input: document.querySelector('#pi-input').getBoundingClientRect() }));
        assert.ok(composing.summary.height > 0 && composing.summary.bottom <= composing.input.top + 1, JSON.stringify(composing));
        await page.locator('#pi-input').blur();
    }
    await page.locator('#pi-input').fill('Existing draft');
    await page.locator('#pi-file-input').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this attachment') });
    await page.locator('#pi-attachments .pi-attachment-chip').waitFor();
    assert.equal(await page.locator('.pi-start-card').count(), 4);
    await page.locator('.pi-start-card').nth(1).click();
    assert.match(await page.locator('#pi-input').inputValue(), /^Existing draft\n\nI ran into a problem/);
    assert.match(await page.locator('#pi-input').evaluate(node => node.value.slice(node.selectionStart, node.selectionEnd)), /^\(describe .+\)$/, 'starter selects its blank');
    const startOverflow = await page.evaluate(() => [...document.querySelectorAll('.pi-start, .pi-start-cards, .pi-start-card, .extensions-explore')].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className));
    assert.deepEqual(startOverflow, []);
    assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
    assert.ok(!commands.includes('prompt'), 'examples never send');
    await page.locator('#pi-input').fill('Keep the draft');
    await page.screenshot({ path: path.join(evidence, `home-${viewport.width}-${preferences['pi.workspace.sidebarCollapsed'] === false ? 'expanded' : 'default'}.png`) });
    await openInspector(page, 'details');
    await page.waitForFunction(() => document.querySelector('#pi-inspector').getBoundingClientRect().width > 200);
    const opened = await measure();
    if (opened.overlay) {
        assert.ok(Math.abs(opened.chat.width - before.chat.width) < 2, 'overlay preserves conversation layout width');
        await page.waitForFunction(() => document.querySelector('.pi-transcript-shell').inert);
        assert.equal(await page.locator('#pi-inspector').getAttribute('aria-modal'), 'true');
        assert.equal(await page.locator('#pi-close-inspector').evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#pi-inspector').evaluate(node => node.contains(document.activeElement)), true, 'focus stays in overlay');
    } else assert.ok(opened.chat.width >= 600, JSON.stringify(opened));
    await page.screenshot({ path: path.join(evidence, `details-${viewport.width}.png`) });
    await page.locator('#pi-close-inspector').click();
    await page.waitForFunction(() => !document.querySelector('.pi-transcript-shell').inert);
    assert.equal(await page.evaluate(width => document.activeElement.id === (width <= 900 ? 'pi-tools-toggle' : 'pi-tool-details'), viewport.width), true, 'close restores launcher focus');
    // Search shortcut opens the drawer on narrow viewports and does not leave focus on its close button.
    await page.keyboard.press('Control+k');
    await page.waitForFunction(() => document.activeElement.id === 'pi-session-search');
    await page.locator('#pi-session-search').fill('no such thread');
    await page.locator('.pi-list-state-action').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-session-search-field').isVisible(), false);
    if (viewport.width <= 900) {
        assert.equal(await page.locator('#pi-session-pane').getAttribute('aria-modal'), 'true');
        await page.locator('#pi-close-sessions').click();
        await page.waitForFunction(() => !document.querySelector('.pi-transcript-shell').inert);
    }
    // A plan arrives as the collapsed composer chip; there is no duplicate task inspector.
    progress = plan('dock'); emit({ type: 'gateway_progress', progress });
    await page.waitForFunction(() => document.querySelector('#pi-composer-chips > #pi-task-progress:not([hidden])') && !document.querySelector('#pi-task-progress').open);
    assert.equal(await page.locator('#pi-input').inputValue(), 'Keep the draft');
    assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
    // Assistant previews cap long lists but preserve the active thread and never mutate input arrays.
    const groups = await page.evaluate(() => {
        const rows = Array.from({ length: 9 }, (_, index) => ({ id: `s${index}` }));
        const input = JSON.stringify(rows), map = new Map([['group', rows]]), group = [{ id: 'group', cwd: '/synthetic', name: '<unsafe>' }];
        const render = options => { const root = document.createElement('div'); root.innerHTML = window.PiAssistantProjects.renderGroups(group, map, 'group', row => `<span data-test-row="${row.id}"></span>`, options); return { rows: [...root.querySelectorAll('[data-test-row]')].map(node => node.dataset.testRow), unsafe: root.querySelectorAll('unsafe').length }; };
        return { preview: render({ cwd: '/synthetic', sessionId: 's8' }), search: render({ query: 'x' }), unchanged: input === JSON.stringify(rows) };
    });
    assert.deepEqual(groups.preview.rows, ['s0', 's1', 's2', 's3', 's4', 's5', 's8']);
    assert.equal(groups.search.rows.length, 9); assert.equal(groups.preview.unsafe, 0); assert.equal(groups.unchanged, true);
    // Running input with a draft keeps Send; queue mode lives in the plus menu.
    streaming = true; emit({ type: 'agent_start' });
    await page.waitForFunction(() => document.querySelector('.pi-composer').dataset.running === 'true');
    await page.locator('#pi-composer-add-button').click();
    assert.equal(await page.locator('#pi-delivery-toggle').isVisible(), true);
    await page.keyboard.press('Escape');
    const running = await measure();
    // Running and idle keep the same main action width.
    if (viewport.width > 680) assert.ok(Math.abs(running.input.width - before.input.width) < 2);
    else assert.ok(running.input.width >= 96, JSON.stringify(running.input));
    assert.equal(await page.locator('#pi-send-button').isVisible(), true); assert.equal(await page.locator('#pi-stop-button').isVisible(), false);
    // A long unbroken provider error wraps; the transcript never scrolls or pans sideways.
    const failure = { role: 'assistant', content: [], stopReason: 'error', timestamp: Date.now(), provider: 'fixture', model: 'model',
        errorMessage: '503: ' + JSON.stringify({ message: 'auth_unavailable: no auth available providers=codex,model=gpt;' + 'x'.repeat(260), type: 'server_error', code: 'internal_server_error' }) };
    emit({ type: 'message_start', message: failure }); emit({ type: 'message_end', message: failure });
    await page.locator('.pi-inline-error').waitFor();
    const pan = await page.evaluate(() => { const view = document.querySelector('#pi-transcript'); view.scrollLeft = 400;
        return { left: view.scrollLeft, scroll: view.scrollWidth, client: view.clientWidth, page: document.documentElement.scrollWidth, width: innerWidth,
            error: document.querySelector('.pi-inline-error').getBoundingClientRect().right }; });
    assert.ok(pan.left === 0 && pan.scroll <= pan.client + 1 && pan.page <= pan.width && pan.error <= pan.width, JSON.stringify(pan));
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.screenshot({ path: path.join(evidence, `running-${viewport.width}-${theme}.png`) });
        const overflow = await page.evaluate(() => ['body', '#pi-transcript', '.pi-composer', '.pi-composer-models', '.pi-composer-actions.right', '#pi-attachments'].filter(selector => { const node = document.querySelector(selector); return node.clientWidth && node.scrollWidth > node.clientWidth + 1; }));
        assert.deepEqual(overflow, []);
    }
    if (viewport.width <= 680) {
        await page.setViewportSize({ width: viewport.width, height: 500 });
        await page.waitForFunction(() => document.querySelector('.pi-composer').getBoundingClientRect().bottom <= innerHeight);
        const compact = await measure(); assert.ok(compact.composer.bottom <= 500 && compact.input.width >= 96, JSON.stringify(compact));
    }
    assert.ok(!commands.some(command => ['prompt', 'steer', 'follow_up', 'abort', 'stop_and_recover'].includes(command)));
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    await context.close();
    return { viewport, preferences, before, opened, running, errors };
}
(async () => {
    await fs.mkdir(evidence, { recursive: true });
    const app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const results = [];
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const [width, height] of [[1366, 768], [1440, 900], [1536, 864], [1920, 1080], [1280, 800], [1024, 768], [960, 720], [900, 720], [768, 768], [393, 852], [320, 740]]) {
            results.push(await run(browser, base, { width, height })); console.log(`PASS workbench ${width}x${height}`);
        }
        results.push(await run(browser, base, { width: 1440, height: 900 }, { 'pi.workspace.sidebarCollapsed': false, 'pi.workspace.split:agent-sessions': 320, 'pi.workspace.split:agent-inspector': 400 }));
        await fs.writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(results, null, 2));
        console.log(`PASS saved preferences; evidence: ${evidence}`);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
