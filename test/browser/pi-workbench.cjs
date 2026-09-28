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
const session = { id: 'empty', cwd, name: 'Synthetic workbench', modified: new Date().toISOString() };
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
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    await page.locator('.pi-empty-actions button').first().waitFor();
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
    await page.locator('#pi-input').fill('Existing draft');
    await page.locator('#pi-file-input').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this attachment') });
    await page.locator('#pi-attachments .pi-attachment-chip').waitFor();
    await page.locator('.pi-empty-actions button').first().click();
    assert.match(await page.locator('#pi-input').inputValue(), /^Existing draft\n\n/);
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
    // A plan arriving while Tasks is empty opens in the dock, and returns to a collapsed chip.
    await openInspector(page, 'tasks');
    progress = plan('dock'); emit({ type: 'gateway_progress', progress });
    await page.waitForFunction(() => document.querySelector('#pi-task-dock > #pi-task-progress:not([hidden])')?.open);
    assert.equal(await page.locator('#pi-task-dock-empty').isVisible(), false);
    // A synchronous reset/new snapshot must not inherit another session's saved open state.
    await page.locator('#pi-task-progress').evaluate(node => { node.hidden = true; node.open = false; delete node.dataset.wasOpen; node.hidden = false; });
    await page.waitForFunction(() => document.querySelector('#pi-task-progress').open);
    await page.locator('#pi-close-inspector').click();
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
    // Running input keeps steering/follow-up, send and stop, without reducing text width.
    streaming = true; emit({ type: 'agent_start' });
    await page.locator('#pi-delivery-mode.visible').waitFor();
    const running = await measure();
    assert.ok(Math.abs(running.input.width - before.input.width) < 2);
    assert.equal(await page.locator('#pi-send-button').isVisible(), true); assert.equal(await page.locator('#pi-stop-button').isVisible(), true);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.screenshot({ path: path.join(evidence, `running-${viewport.width}-${theme}.png`) });
        const overflow = await page.evaluate(() => ['body', '.pi-composer', '.pi-composer-models', '.pi-composer-actions.right', '#pi-attachments'].filter(selector => { const node = document.querySelector(selector); return node.clientWidth && node.scrollWidth > node.clientWidth + 1; }));
        assert.deepEqual(overflow, []);
    }
    if (viewport.width <= 680) {
        await page.setViewportSize({ width: viewport.width, height: 500 });
        await page.waitForFunction(() => document.querySelector('.pi-composer').getBoundingClientRect().bottom <= innerHeight);
        const compact = await measure(); assert.ok(compact.composer.bottom <= 500 && compact.input.width >= viewport.width - 64, JSON.stringify(compact));
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
