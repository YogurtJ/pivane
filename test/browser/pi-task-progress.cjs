const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/progress-project';
const sessions = [{ cwd, id: 'plan', name: 'Plan fixture' }, { cwd, id: 'empty', name: 'Empty fixture' }];
const model = { provider: 'fixture', id: 'fixture', input: ['text'], contextWindow: 32000 };
const makePlan = (id, completed = false) => ({ version: 1, id, plan: [
    { step: 'Inspect existing implementation', status: 'completed' },
    { step: 'Implement <img src=x onerror=alert(1)> ' + 'long-path-'.repeat(10), status: completed ? 'completed' : 'in_progress' },
    { step: 'Verify desktop and mobile', status: completed ? 'completed' : 'pending' }
], explanation: '<script>throw new Error("unsafe")</script> Progress reported by Agent.' });
async function check(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let active = sessions[0], progress = null, socket, sequence = 0, holdRead = false, releaseRead, acknowledgeHeld;
    let running = false;
    const held = new Promise(resolve => { acknowledgeHeld = resolve; });
    const messages = [{ role: 'user', timestamp: 1, content: 'Synthetic task' }, { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', name: 'bash', id: 'test-tool', arguments: { command: 'fixture' } }] },
        { role: 'toolResult', toolName: 'bash', toolCallId: 'test-tool', timestamp: 3, content: [{ type: 'text', text: 'Synthetic result' }], isError: false }];
    const emit = event => socket.send(JSON.stringify({ ...event, webRuntimeId: active.id, webSequence: ++sequence }));
    const publish = value => { progress = value; emit({ type: 'gateway_progress', progress }); };
    await page.addInitScript(({ cwd, language }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'plan'); localStorage.setItem('pi.workspace.language', language); }, { cwd, language });
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url()), send = json => route.fulfill({ json });
        if (url.pathname === '/api/pi/status') return send({ ok: true, projectRoots: ['/synthetic'], taskProgress: true });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        socket = ws;
        const cmd = JSON.parse(raw), reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        const state = { model, thinkingLevel: 'off', isStreaming: running, isCompacting: false };
        const data = () => ({ messages, webProgress: active.id === 'plan' ? progress : null, webLive: { runtimeId: active.id, sequence, tools: [], running } });
        if (cmd.type === 'open_session') {
            active = sessions.find(s => s.id === cmd.sessionId);
            // A pre-snapshot event must not override the newer native snapshot.
            emit({ type: 'gateway_progress', progress: makePlan('stale-bootstrap', true) });
            return reply({ session: active, state, messages: data(), models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} });
        }
        if (cmd.type === 'get_state') return reply(state);
        if (cmd.type === 'get_session_stats') return reply({});
        if (cmd.type === 'get_messages') {
            const snapshot = structuredClone(data());
            if (holdRead) { holdRead = false; releaseRead = () => reply(snapshot); acknowledgeHeld(); return; }
            return reply(snapshot);
        }
        throw new Error(`Unexpected command: ${cmd.type}`);
    }));
    await page.goto(base);
    await page.locator('#pi-input').fill('Keep my draft');
    const card = page.locator('#pi-task-progress');
    assert.equal(await card.isVisible(), false, 'simple task has no card');
    running = true; emit({ type: 'agent_start' }); publish(makePlan('first'));
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#pi-task-progress').open);
    assert.equal(await card.locator('.pi-progress-count').textContent(), '1/3');
    assert.equal(await card.locator('img, script').count(), 0);
    assert.ok((await card.locator('strong').textContent()).includes(language === 'en' ? 'Task progress' : '当前进度'));
    assert.equal(await card.locator('[data-status="in_progress"] .pi-progress-status').textContent(), language === 'en' ? 'In progress' : '进行中');
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture attachment') });
    await card.locator('summary').click();
    assert.equal(await card.evaluate(node => node.open), false);
    publish(makePlan('milestone'));
    await page.waitForFunction(() => document.querySelector('#pi-task-progress .pi-progress-count').textContent === '1/3');
    assert.equal(await card.evaluate(node => node.open), false, 'an update respects manual collapse');
    running = false; holdRead = true; emit({ type: 'agent_settled' });
    let timer; await Promise.race([held, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reconciliation not requested')), 10000); })]); clearTimeout(timer);
    publish(makePlan('finished', true)); releaseRead();
    await page.waitForFunction(() => document.querySelector('#pi-task-progress .pi-progress-count').textContent === '3/3');
    assert.equal(await card.evaluate(node => node.open), false, 'completed card collapses');
    assert.equal(await page.locator('#pi-input').inputValue(), 'Keep my draft');
    assert.equal(await page.locator('#pi-attachments').isVisible(), true);
    publish(makePlan('branch-restored'));
    await page.waitForFunction(() => document.querySelector('#pi-task-progress').open);
    emit({ type: 'gateway_context_changed' });
    emit({ type: 'tool_execution_end', toolCallId: 'failed-plan', toolName: 'update_plan', isError: true, result: { content: [{ type: 'text', text: 'Invalid plan' }] } });
    assert.equal(await card.locator('.pi-progress-count').textContent(), '1/3', 'failed call and idle state do not complete progress');
    await selectMessageView(page, 'full');
    assert.equal(await page.locator('[data-tool-id="test-tool"]').getAttribute('data-state'), 'done');
    assert.equal(await card.isVisible(), true);
    const overflow = await card.locator('summary, .pi-progress-body, li, .pi-progress-step, .pi-progress-explanation').evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 2 || n.getBoundingClientRect().right > innerWidth + 1).map(n => n.className));
    assert.deepEqual(overflow, []);
    assert.ok(await page.locator('#pi-input').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
    if (width < 900) {
        await page.locator('#pi-toggle-sessions').click();
        await page.locator('#pi-session-pane.open').waitFor();
    }
    await page.locator('[data-session-id="empty"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-task-progress').hidden);
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="plan"] .pi-session-main').click();
    await card.waitFor({ state: 'visible' });
    assert.equal(await card.locator('.pi-progress-count').textContent(), '1/3');
    assert.equal(await page.locator('#pi-input').inputValue(), 'Keep my draft');
    assert.equal(await page.locator('#pi-attachments').isVisible(), true);
    await page.reload(); await card.waitFor({ state: 'visible' });
    assert.equal(await card.locator('.pi-progress-count').textContent(), '1/3', 'refresh reconstructs progress');
    await page.screenshot({ path: `/tmp/pivane-task-progress-${width}-${language}.png` });
    const longPlan = { version: 1, id: 'long-plan', explanation: '', plan: Array.from({ length: 20 }, (_, index) => ({ step: `${index + 1}: ` + 'long-task-'.repeat(18), status: index ? 'pending' : 'in_progress' })) };
    publish(longPlan);
    await page.waitForFunction(() => document.querySelectorAll('#pi-task-progress li').length === 20);
    if (width < 900) await page.setViewportSize({ width, height: 560 });
    assert.ok(await card.locator('.pi-progress-body').evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto'));
    const inputMetrics = await page.locator('#pi-input').evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, height: innerHeight, fontSize: parseFloat(getComputedStyle(node).fontSize) }));
    assert.ok(inputMetrics.bottom <= inputMetrics.height && (width >= 900 || inputMetrics.fontSize >= 16), JSON.stringify({ width, inputMetrics }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width, height: 900 });
    publish({ version: 1, id: 'preview', explanation: '', plan: [
        { step: language === 'en' ? 'Inspect the existing implementation' : '检查现有实现', status: 'completed' },
        { step: language === 'en' ? 'Add the plan tool and progress card' : '接入计划工具和进度卡', status: 'completed' },
        { step: language === 'en' ? 'Verify desktop and mobile' : '验证桌面和手机显示', status: 'in_progress' }
    ] });
    await page.waitForFunction(() => document.querySelector('#pi-task-progress .pi-progress-count').textContent === '2/3');
    for (const theme of ['daylight', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await card.screenshot({ path: `/tmp/pivane-task-progress-preview-${width}-${language}-${theme}.png` });
    }
    publish({ version: 1, id: 'clear', plan: [], explanation: '' });
    await page.waitForFunction(() => document.querySelector('#pi-task-progress').hidden);
    await page.reload(); await page.locator('#pi-input:not([disabled])').waitFor();
    assert.equal(await card.isVisible(), false);
    assert.deepEqual(errors, []);
    await context.close();
}
(async () => {
    const root = path.resolve(__dirname, '../..'), app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await check(browser, `http://127.0.0.1:${server.address().port}`, width, language);
        console.log('Task progress: six desktop/mobile/language scenarios passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
