const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_NATIVE_TEST_URL || 'http://127.0.0.1:3106';
const cwd = '/srv/native-fixture';
const session = { id: 'native', cwd, name: 'Native fixture', messageCount: 4 };
const second = { ...session, id: 'second', name: 'Second thread' };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const patch = 'Index: code.js\n===================================================================\n--- code.js\n+++ code.js\n@@ -1,2 +1,2 @@\n-old 中文\n+new <img src=x onerror=alert(1)>\n keep\n';
const messages = [
    { role: 'user', content: 'Review changes', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'edit1', name: 'edit', arguments: { path: 'src/' + 'long-path/'.repeat(30) + 'code.js', edits: [{ oldText: 'old 中文', newText: 'new' }] } }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'edit1', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced one block.' }], details: { patch }, timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }], timestamp: 4 }
];
const empty = runtimeId => ({ runtimeId, revision: 1, queue: { steering: [], followUp: [] }, recoveries: [], stopping: false, extension: { title: '', statuses: [], widgets: [] } });
async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [], commands = [], writes = [];
    let socket, active = session, pendingStop, pendingAck, rejectAck = false, holdStop = false, holdAck = false;
    let controls = empty('runtime-a'); controls.extension = { title: 'Fixture mode', statuses: [['mode', 'Testing <img src=x>']], widgets: [['steps', { lines: 'Step one\n' + 'x'.repeat(600), placement: 'aboveEditor' }]] };
    let runtime = { model, thinkingLevel: 'off', isStreaming: true, isCompacting: false };
    const stats = { totalMessages: 4, tokens: { input: 100, output: 10 }, contextUsage: { tokens: 100, percent: 1, contextWindow: 128000 } };
    const reply = (ws, command, data, error) => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: !error, error, data }));
    const event = data => socket.send(JSON.stringify(data));
    const update = () => { controls.revision++; event({ type: 'gateway_controls', controls }); };
    const finish = () => {
        controls.stopping = false; runtime.isStreaming = false; runtime.isCompacting = false; update();
        if (pendingStop) { reply(pendingStop.ws, pendingStop.command, controls); pendingStop = null; }
        event({ type: 'agent_settled' });
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); localStorage.setItem('pi.web.transcriptMode', 'full'); }, { cwd, id: session.id });
    await page.route('**/api/**', route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (request.method() !== 'GET') { writes.push(pathname); return route.fulfill({ json: {} }); }
        if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '0.85.0', runtimeControls: true, extensionStatus: true, projectRoots: ['/srv'] } });
        if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Native', sessionCount: 2 }], roots: ['/srv'] } });
        if (pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, second] } });
        if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (pathname.includes('history') || pathname === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); commands.push(command);
            if (command.type === 'open_session') {
                active = command.sessionId === session.id ? session : second;
                if (active === second) { controls = empty('runtime-b'); runtime.isStreaming = false; }
                return reply(ws, command, { session: active, state: { ...runtime, webControls: controls }, controls, messages: { messages }, stats,
                    models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (command.type === 'get_state') return reply(ws, command, { ...runtime, webControls: controls });
            if (command.type === 'get_messages') return reply(ws, command, { messages });
            if (command.type === 'get_session_stats') return reply(ws, command, stats);
            if (command.type === 'stop_and_recover' || command.type === 'take_queue') {
                const queue = controls.queue;
                if (queue.steering.length || queue.followUp.length) controls.recoveries.push({ id: 'recovery-' + controls.revision, status: 'recovered', ...queue });
                controls.queue = { steering: [], followUp: [] }; controls.stopping = true; update();
                if (command.type === 'take_queue') { controls.stopping = false; update(); return reply(ws, command, controls); }
                pendingStop = { ws, command }; if (!holdStop) finish(); return;
            }
            if (command.type === 'ack_recovery') {
                if (holdAck) { pendingAck = { ws, command }; return; }
                if (rejectAck) return reply(ws, command, null, 'Controlled acknowledgement failure');
                controls.recoveries = controls.recoveries.filter(item => item.id !== command.recoveryId); update(); return reply(ws, command, controls);
            }
            throw new Error(`Unexpected RPC ${command.type}`);
        });
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    assert.match(await page.title(), /Fixture mode/);
    const tool = page.locator('[data-tool-id="edit1"]');
    await tool.locator(':scope > summary').click();
    assert.equal(await tool.locator('.pi-edit-diff').count(), 1);
    assert.match(await tool.locator('.pi-diff-heading').textContent(), /\+1 \/ −1/);
    assert.equal(await tool.locator('.pi-edit-diff img').count(), 0);
    assert.equal(await tool.locator('.pi-tool-raw').getAttribute('open'), null);
    await tool.getByRole('button', { name: '复制 patch' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), patch);
    await selectMessageView(page, 'reading');
    await page.locator('.pi-process-group > summary').click();
    await tool.locator('.pi-edit-diff').waitFor({ state: 'visible' });
    assert.equal(await tool.locator('.pi-edit-diff').isVisible(), true, 'diff remains available in body view');
    await selectMessageView(page, 'full');
    const operators = '@@ -1 +1 @@\n---operator\n+++operator\n';
    event({ type: 'tool_execution_end', toolCallId: 'edit1', toolName: 'edit', result: { content: [], details: { patch: operators } } });
    await page.waitForFunction(() => document.querySelector('.pi-diff-code').textContent.includes('operator'));
    assert.match(await tool.locator('.pi-diff-heading').textContent(), /\+1 \/ −1/, 'operator lines are not mistaken for patch file headers');
    event({ type: 'tool_execution_end', toolCallId: 'edit1', toolName: 'edit', result: { content: [], details: { diff: '-1 old\n+1 new' } } });
    await page.waitForFunction(() => document.querySelector('.pi-diff-code').textContent.includes('-1 old'));
    assert.equal(await tool.getByRole('button', { name: '复制 patch' }).count(), 0, 'legacy display diff is not a standard patch');
    event({ type: 'tool_execution_end', toolCallId: 'edit1', toolName: 'edit', result: { content: [], details: { patch } } });
    await page.waitForFunction(() => document.querySelector('.pi-diff-code').textContent.includes('old 中文'));
    await page.locator('#pi-toggle-inspector').click();
    await page.locator('#pi-extension-state > summary').click();
    assert.match(await page.locator('#pi-extension-body').textContent(), /Step one/);
    assert.equal(await page.locator('#pi-extension-body img').count(), 0);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const overflow = await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-content', '#pi-extension-body'].filter(selector => {
            const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1;
        })); assert.deepEqual(overflow, []);
        await page.screenshot({ path: `/tmp/pi-native-${viewport.width}-${theme}.png` });
    }
    await page.locator('#pi-close-inspector').click();
    controls.queue = { steering: ['First queued '.repeat(40)], followUp: ['Follow-up 中文'] }; update();
    await page.locator('#pi-queue-open').click();
    assert.match(await page.locator('#pi-queue-dialog').textContent(), /重新添加图片/);
    assert.match(await page.locator('#pi-queue-dialog').textContent(), /Follow-up 中文/);
    await page.locator('#pi-queue-take').click();
    await page.waitForFunction(() => document.querySelector('[data-recovery-append]'));
    assert.equal(runtime.isStreaming, true, 'taking queue must not abort');
    await page.locator('#pi-queue-dialog .pi-native-heading button').click();
    await page.locator('#pi-input').fill('New draft');
    await page.locator('#pi-queue-open').click();
    rejectAck = true;
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => document.querySelector('[data-recovery-append]').textContent.includes('本页已追加'));
    const appended = await page.locator('#pi-input').inputValue(); assert.match(appended, /^New draft\n\nFirst queued/);
    rejectAck = false;
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => !document.querySelector('[data-recovery-append]'));
    assert.equal(await page.locator('#pi-input').inputValue(), appended, 'ack retry must not append twice');
    await page.locator('#pi-queue-dialog .pi-native-heading button').click();
    controls.queue = { steering: ['Stop this next instruction'], followUp: [] }; update(); holdStop = true;
    await page.locator('#pi-stop-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-stop-button').disabled);
    await page.locator('#pi-input').fill('Draft typed during stop');
    await page.locator('#pi-input').press('Enter');
    assert.equal(commands.filter(command => command.type === 'prompt').length, 0);
    const stale = structuredClone(controls); stale.revision--;
    stale.extension.title = 'STALE'; event({ type: 'gateway_controls', controls: stale });
    assert.doesNotMatch(await page.title(), /STALE/);
    const stopCount = commands.filter(command => command.type === 'stop_and_recover').length;
    socket.close({ code: 1012, reason: 'Controlled stop reconnect' });
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('中断'));
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('执行'));
    assert.equal(commands.filter(command => command.type === 'stop_and_recover').length, stopCount, 'reconnection never repeats stop');
    pendingStop = null;
    finish();
    await page.waitForFunction(() => document.querySelector('#pi-composer-status').textContent === 'Pi Agent 已就绪');
    assert.equal(await page.locator('#pi-input').inputValue(), 'Draft typed during stop');
    // Full reload restores server-side recovery and extension state, without replaying stop.
    const stops = commands.filter(command => command.type === 'stop_and_recover').length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    assert.match(await page.locator('#pi-queue-open').textContent(), /已取回 1/);
    assert.match(await page.title(), /Fixture mode/);
    assert.equal(commands.filter(command => command.type === 'stop_and_recover').length, stops);
    runtime.isCompacting = true; event({ type: 'compaction_start', reason: 'manual' });
    await page.waitForFunction(() => !document.querySelector('#pi-stop-button').classList.contains('hidden'));
    assert.match(await page.locator('#pi-stop-button').getAttribute('title'), /取消压缩/);
    holdStop = false; await page.locator('#pi-stop-button').click();
    event({ type: 'compaction_end', reason: 'manual', aborted: true });
    await page.waitForFunction(() => !document.querySelector('#pi-stop-button').disabled);
    // Late acknowledgement after switching must not reapply the previous runtime's UI.
    await page.locator('#pi-queue-open').click(); holdAck = true;
    await page.locator('[data-recovery-append]').click();
    await page.waitForTimeout(100);
    await page.locator('#pi-queue-dialog .pi-native-heading button').click();
    if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator(`[data-session-id="${second.id}"] .pi-session-main`).click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'second');
    if (pendingAck) { try { reply(pendingAck.ws, pendingAck.command, { ...empty('runtime-a'), extension: { title: 'LATE', statuses: [], widgets: [] } }); } catch {} }
    await page.waitForTimeout(100);
    assert.doesNotMatch(await page.title(), /Fixture mode|LATE/);
    assert.equal(await page.locator('#pi-input').inputValue(), '');
    assert.equal(await page.locator('#pi-extension-state').isVisible(), false);
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`PASS ${viewport.width}: diff/patch, three themes, extension state, queue recovery/draft/ack, stop/compaction, reload and late thread results`);
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
