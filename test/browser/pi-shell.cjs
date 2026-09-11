const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SHELL_TEST_URL || 'http://127.0.0.1:3131';
const cwd = '/tmp/pi-shell-browser-project';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const sessions = ['a', 'b'].map(id => ({ id, cwd, name: `Shell ${id}`, messageCount: 1 }));
async function run(browser, width, legacy = false) {
    const context = await browser.newContext({ viewport: { width, height: width > 900 ? 1000 : 852 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], requests = [], writes = [], sockets = [];
    const shellStates = new Map(sessions.map(s => [s.id, { runtimeId: s.id, revision: 0, busy: false, job: null }]));
    const modes = new Map(sessions.map(s => [s.id, { runtimeId: s.id, revision: 0, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' }]));
    const histories = new Map(sessions.map(s => [s.id, []]));
    let active, holdStart = false, pendingStart, fail = false, failMode = false;
    const reply = (socket, cmd, data, error) => socket.ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error }));
    const emit = (socket, event) => socket.ws.send(JSON.stringify(event));
    const view = id => ({ model, isStreaming: false, isCompacting: false, thinkingLevel: 'off', ...(!legacy ? { webShell: shellStates.get(id), webQueueModes: modes.get(id) } : {}) });
    const snapshot = id => ({ session: sessions.find(s => s.id === id), state: view(id), messages: { messages: histories.get(id) }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a'); }, cwd);
    await page.route('**/api/**', route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname;
        if (req.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }); }
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, userShell: !legacy, queueModes: !legacy, projectRoots: ['/tmp'], version: '0.85.0' } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/tmp'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] } });
        return route.fulfill({ json: endpoint.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        const socket = { ws, id: '' }; sockets.push(socket);
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); requests.push(cmd);
            if (cmd.type === 'open_session') { socket.id = cmd.sessionId; active = socket; return reply(socket, cmd, snapshot(socket.id)); }
            if (cmd.type === 'get_state') return reply(socket, cmd, view(socket.id));
            if (cmd.type === 'get_messages') return reply(socket, cmd, { messages: histories.get(socket.id) });
            if (cmd.type === 'get_session_stats') return reply(socket, cmd, {});
            if (cmd.type === 'bash') {
                if (fail) return reply(socket, cmd, null, '命令拒绝 fixture');
                const state = shellStates.get(socket.id); state.revision++; state.busy = true;
                state.job = { id: `job-${state.revision}`, command: cmd.command, excludeFromContext: cmd.excludeFromContext, status: 'running', startedAt: Date.now(), output: '', displayTruncated: false };
                emit(socket, { type: 'gateway_shell', shell: state });
                if (holdStart) { pendingStart = { socket, cmd, state: structuredClone(state) }; return; }
                return reply(socket, cmd, state);
            }
            if (cmd.type === 'abort_bash') {
                const state = shellStates.get(socket.id); assert.equal(cmd.executionId, state.job.id);
                state.revision++; state.job.status = 'stopping'; emit(socket, { type: 'gateway_shell', shell: state }); return reply(socket, cmd, state);
            }
            if (cmd.type.startsWith('set_')) {
                if (failMode) return reply(socket, cmd, null, '设置修订冲突 fixture');
                const value = modes.get(socket.id); assert.equal(cmd.revision, value.revision);
                value.revision++; value[cmd.type === 'set_steering_mode' ? 'steeringMode' : 'followUpMode'] = cmd.mode;
                emit(socket, { type: 'gateway_queue_modes', modes: value }); return reply(socket, cmd, value);
            }
            throw new Error('unexpected RPC ' + cmd.type);
        });
    });
    const assertWidths = async () => {
        const overflow = await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-content', '#pi-inspector', '.pi-shell-live', '.pi-shell-output', '#pi-queue-modes'].filter(s => { const el = document.querySelector(s); return el?.clientWidth && el.scrollWidth > el.clientWidth + 1; }));
        assert.deepEqual(overflow, []);
    };
    const emitShell = patch => { const value = shellStates.get(active.id); Object.assign(value.job, patch); value.revision++; emit(active, { type: 'gateway_shell', shell: value }); };
    const finish = (cancelled = false) => {
        const state = shellStates.get(active.id), job = state.job;
        histories.get(active.id).push({ role: 'bashExecution', command: job.command, output: job.output, timestamp: Date.now(), excludeFromContext: job.excludeFromContext, cancelled, exitCode: cancelled ? undefined : 0, truncated: job.truncated, fullOutputPath: job.truncated ? '/tmp/pi-bash-fixture.log' : undefined });
        state.busy = false; emitShell({ status: cancelled ? 'cancelled' : 'completed', cancelled, exitCode: cancelled ? undefined : 0, recorded: true, finishedAt: Date.now() });
    };
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await page.locator('#pi-input').fill('!printf hello');
    assert.equal(await page.locator('#pi-send-button').getAttribute('aria-label'), '执行 Shell 命令');
    assert.equal(await page.locator('#pi-shell-hint').isVisible(), true);
    if (legacy) {
        await page.locator('#pi-send-button').click();
        assert.equal(requests.filter(r => r.type === 'bash').length, 0);
        assert.equal(await page.locator('#pi-input').inputValue(), '!printf hello');
        assert.equal(await page.locator('#pi-queue-modes').isVisible(), false);
        assert.deepEqual(errors, []); await context.close(); return;
    }
    holdStart = true;
    await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('.pi-shell-live'));
    await page.locator('#pi-input').fill('继续编辑的新稿');
    reply(pendingStart.socket, pendingStart.cmd, pendingStart.state); holdStart = false;
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pi-input').inputValue(), '继续编辑的新稿');
    assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    assert.equal(await page.locator('#pi-stop-button').isVisible(), false);
    const malicious = '<img src=x onerror=alert(1)>\n中文\u2028分隔\n' + 'long/path/'.repeat(120);
    emitShell({ output: malicious, displayTruncated: true });
    await page.waitForFunction(() => document.querySelector('.pi-shell-output').textContent.includes('中文'));
    assert.equal(await page.locator('.pi-shell-live img').count(), 0);
    assert.equal(await page.locator('.pi-shell-live').isVisible(), true, 'live output stays visible in reading mode');
    await assertWidths();
    await page.screenshot({ path: `/tmp/pi-shell-${width}-live.png` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.pi-shell-live .pi-shell-output')?.textContent.includes('中文'));
    assert.equal(await page.locator('.pi-shell-live button').isEnabled(), true);
    await page.locator('.pi-shell-live button').click();
    await page.waitForFunction(() => document.querySelector('.pi-shell-live').dataset.state === 'stopping');
    assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    finish(true);
    await page.waitForFunction(() => document.querySelector('.pi-bash-message'));
    await page.waitForFunction(() => !document.querySelector('.pi-shell-live'));
    assert.match(await page.locator('.pi-bash-message summary').textContent(), /已停止/);
    await page.locator('#pi-input').fill('!!printf private');
    await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.equal(requests.filter(r => r.type === 'bash').at(-1).excludeFromContext, true);
    emitShell({ output: 'private output', truncated: true }); finish();
    await page.waitForFunction(() => document.querySelectorAll('.pi-bash-message').length === 2);
    assert.match(await page.locator('.pi-bash-message').last().textContent(), /不加入模型上下文/);
    assert.equal(await page.locator('.pi-bash-message a').count(), 0, 'fullOutputPath is not arbitrary file download');
    // Rejected submission preserves the draft and never falls through to prompt.
    fail = true; await page.locator('#pi-input').fill('!rejected'); await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('命令拒绝 fixture'));
    assert.equal(await page.locator('#pi-input').inputValue(), '!rejected'); fail = false;
    // Uploaded files are never silently appended to a shell command.
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('do not execute this attachment') });
    await page.waitForFunction(() => document.querySelector('.pi-attachment-chip'));
    await page.locator('#pi-input').fill('!with-attachment');
    const beforeAttachment = requests.filter(r => r.type === 'bash').length;
    await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('不接收附件'));
    assert.equal(requests.filter(r => r.type === 'bash').length, beforeAttachment);
    assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
    await page.locator('[data-remove-attachment]').click();
    await page.locator('#pi-toggle-inspector').click();
    await page.locator('#pi-runtime-settings > summary').click();
    await page.locator('#pi-steeringMode').selectOption('all');
    await page.waitForFunction(() => document.querySelector('#pi-queue-mode-status').textContent.includes('已更新'));
    failMode = true; await page.locator('#pi-followUpMode').selectOption('all');
    await page.waitForFunction(() => document.querySelector('#pi-queue-mode-status').textContent.includes('冲突'));
    assert.equal(await page.locator('#pi-followUpMode').inputValue(), 'one-at-a-time');
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await assertWidths();
        await page.screenshot({ path: `/tmp/pi-shell-${width}-${theme}.png` });
    }
    if (width < 900) await page.locator('#pi-close-inspector').click();
    const oldSocket = active;
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator('[data-session-id="b"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b' && !document.querySelector('#pi-input').disabled);
    assert.equal(await page.locator('.pi-bash-message').count(), 0);
    assert.equal(await page.locator('.pi-shell-live').count(), 0);
    try { emit(oldSocket, { type: 'gateway_shell', shell: { ...shellStates.get('a'), revision: 999, busy: true } }); } catch {}
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.pi-shell-live').count(), 0, 'old session output cannot reappear');
    const overflow = await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-content', '#pi-inspector'].filter(s => { const el = document.querySelector(s); return el.clientWidth && el.scrollWidth > el.clientWidth + 1; }));
    assert.deepEqual(overflow, []); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    assert.equal(requests.filter(r => ['prompt', 'steer', 'follow_up'].includes(r.type)).length, 0);
    await context.close(); console.log(`Shell browser ${width} passed`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 393, 320]) await run(browser, width); await run(browser, 393, true); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
