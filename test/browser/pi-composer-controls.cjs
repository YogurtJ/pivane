const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_COMPOSER_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/srv/composer-fixture';
const sessions = ['a', 'b', 'c'].map(id => ({ id, cwd, name: `会话 ${id}`, messageCount: 3 }));
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const controls = id => ({ runtimeId: id, revision: 1, stopping: false, queue: { steering: [], followUp: [] }, recoveries: [], extension: { title: '', statuses: [], widgets: [] } });
async function run(browser, viewport, legacy = false) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [], writes = [], commands = [], sockets = [];
    const states = new Map(sessions.map(s => [s.id, { isStreaming: s.id !== 'c', isCompacting: false, model, thinkingLevel: 'off' }]));
    const views = new Map(sessions.map(s => [s.id, controls(s.id)]));
    const history = new Map(sessions.map(s => [s.id, [{ role: 'user', content: `历史问题 ${s.id}`, timestamp: 1 }]]));
    let pendingOpen, pendingStop, failStop = false;
    const reply = (ws, cmd, data, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error }));
    const emit = (socket, event) => socket.ws.send(JSON.stringify(event));
    const snapshot = id => ({ session: sessions.find(s => s.id === id), state: states.get(id), controls: legacy ? undefined : views.get(id),
        messages: { messages: history.get(id) }, stats: { totalMessages: 3 }, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a'); }, { cwd });
    await page.route('**/api/**', route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname;
        if (req.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }); }
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/srv'], runtimeControls: !legacy, version: '0.85.0' } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 3 }], roots: ['/srv'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        return route.fulfill({ json: endpoint.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        const socket = { ws, id: null }; sockets.push(socket);
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw);
            if (cmd.type === 'open_session') {
                socket.id = cmd.sessionId;
                if (socket.id === 'b') { pendingOpen = { socket, cmd }; return; }
                return reply(ws, cmd, snapshot(socket.id));
            }
            commands.push({ session: socket.id, ...cmd });
            const state = states.get(socket.id), view = views.get(socket.id);
            if (cmd.type === 'get_state') return reply(ws, cmd, { ...state, webControls: legacy ? undefined : view });
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: history.get(socket.id) });
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, { totalMessages: 3 });
            if (['prompt', 'steer', 'follow_up'].includes(cmd.type)) {
                if (cmd.type === 'prompt') throw Error('running thread must use a queue command');
                view.queue[cmd.type === 'steer' ? 'steering' : 'followUp'].push(cmd.message); view.revision++;
                if (!legacy) emit(socket, { type: 'gateway_controls', controls: view });
                else emit(socket, { type: 'queue_update', ...view.queue });
                return reply(ws, cmd, {});
            }
            if (['stop_and_recover', 'abort'].includes(cmd.type)) {
                if (failStop) return reply(ws, cmd, null, 'Controlled stop failure');
                pendingStop = { socket, cmd };
                if (!legacy) { view.stopping = true; view.revision++; emit(socket, { type: 'gateway_controls', controls: view }); }
                return;
            }
            throw Error('unexpected ' + cmd.type);
        });
    });
    const choose = async id => {
        if (viewport.width < 900) await page.locator('#pi-toggle-sessions').click();
        await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
    };
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    assert.equal(await page.locator('#pi-stop-button').isVisible(), true);
    assert.equal(await page.locator('#pi-send-button').isVisible(), true);
    await page.locator('#pi-input').fill('A 的引导');
    await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.ok(commands.some(c => c.session === 'a' && c.type === 'steer' && c.message === 'A 的引导'));
    await page.locator('#pi-stop-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-stop-button').disabled || document.querySelector('#pi-stop-button').title.includes('停止当前任务'));
    const oldStop = pendingStop;
    await choose('b');
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b');
    assert.equal(await page.locator('#pi-stop-button').isVisible(), false, 'old thread stop must disappear before new snapshot arrives');
    assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    assert.equal(await page.locator('#pi-stop-button').getAttribute('data-session-id'), '');
    assert.equal(commands.filter(c => ['abort', 'stop_and_recover'].includes(c.type)).length, 1);
    while (!pendingOpen) await page.waitForTimeout(10);
    reply(pendingOpen.socket.ws, pendingOpen.cmd, snapshot('b'));
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    assert.equal(await page.locator('#pi-stop-button').getAttribute('data-session-id'), 'b');
    assert.match(await page.locator('#pi-stop-button').getAttribute('title'), /会话 b/);
    // A late reply from the old stop cannot control B.
    try { reply(oldStop.socket.ws, oldStop.cmd, views.get('a')); } catch {}
    await page.locator('#pi-input').fill('B 的中途补充');
    await page.locator('#pi-delivery-mode').selectOption('steer');
    await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    await page.locator('#pi-input').fill('B 完成后继续');
    await page.locator('#pi-delivery-mode').selectOption('follow_up');
    assert.equal(await page.locator('#pi-send-button').getAttribute('aria-label'), '发送后续消息');
    await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.deepEqual(commands.filter(c => c.session === 'b' && ['steer', 'follow_up'].includes(c.type)).map(c => [c.type, c.message]), [['steer', 'B 的中途补充'], ['follow_up', 'B 完成后继续']]);
    assert.equal(await page.locator('#pi-stop-button').isVisible(), true);
    assert.equal(await page.locator('#pi-send-button').isVisible(), true);
    if (viewport.width <= 600) assert.ok((await page.locator('#pi-input').boundingBox()).width >= 160, 'mobile composer retains room for text');
    await page.screenshot({ path: `/tmp/pi-composer-${viewport.width}-${legacy ? 'legacy' : 'native'}.png` });
    failStop = true;
    await page.locator('#pi-stop-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Controlled stop failure'));
    await page.waitForFunction(() => !document.querySelector('#pi-stop-button').disabled);
    failStop = false;
    await page.locator('#pi-stop-button').click();
    while (pendingStop === oldStop) await page.waitForTimeout(10);
    await page.locator('#pi-input').fill('停止时保留的草稿');
    const { socket: stoppedSocket, cmd: stopCmd } = pendingStop;
    const stopped = { role: 'assistant', content: [{ type: 'text', text: '已经输出的内容' }], stopReason: 'aborted', errorMessage: 'Request aborted', timestamp: 20 };
    history.get('b').push(stopped);
    emit(stoppedSocket, { type: 'message_start', message: { ...stopped, content: [] } });
    emit(stoppedSocket, { type: 'message_end', message: stopped });
    states.get('b').isStreaming = false;
    const b = views.get('b'); b.stopping = false; b.queue = { steering: [], followUp: [] }; b.revision++;
    if (!legacy) emit(stoppedSocket, { type: 'gateway_controls', controls: b });
    reply(stoppedSocket.ws, stopCmd, legacy ? {} : b);
    emit(stoppedSocket, { type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelector('.pi-inline-stopped')?.textContent === '回复已停止');
    assert.equal(await page.locator('.pi-inline-error').count(), 0);
    assert.equal(await page.locator('.pi-stop-details pre').isVisible(), false);
    assert.equal(await page.locator('.pi-stop-details pre').textContent(), 'Request aborted');
    assert.equal(await page.locator('#pi-input').inputValue(), '停止时保留的草稿');
    assert.equal(await page.locator('#pi-send-button').isVisible(), true);
    assert.equal(await page.locator('#pi-stop-button').isVisible(), false);
    const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Request aborted by gateway failure', timestamp: 21 };
    history.get('b').push(failure);
    emit(stoppedSocket, { type: 'message_start', message: { ...failure, content: [] } });
    emit(stoppedSocket, { type: 'message_end', message: failure });
    emit(stoppedSocket, { type: 'agent_settled' });
    await page.locator('.pi-inline-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('.pi-inline-error').textContent(), /gateway failure/, 'error reason must not be relabelled as a successful cancellation');
    await choose('c');
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled && document.querySelector('#pi-meta-id').textContent === 'c');
    assert.equal(await page.locator('#pi-stop-button').isVisible(), false);
    assert.equal(await page.locator('#pi-input').inputValue(), '');
    assert.deepEqual(await page.evaluate(() => ['body', '.pi-composer', '#pi-transcript-content'].filter(s => { const n = document.querySelector(s); return n.scrollWidth > n.clientWidth + 1; })), []);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`PASS ${viewport.width} ${legacy ? 'legacy' : 'native'}: send/stop coexist, click steer/follow-up on running historical threads, delayed switch/old stop isolation, native cancellation versus real failure, draft and width`);
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport);
        await run(browser, { width: 393, height: 852 }, true);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
