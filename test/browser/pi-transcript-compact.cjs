const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseUrl = process.env.PI_COMPACT_TEST_URL || process.env.n || 'http://127.0.0.1:3101';
const cwd = '/srv/pi-compact-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'] };
const session = { id: 'compact-fixture', cwd, name: '简洁视图验证', messageCount: 11 };
const plain = text => ({ type: 'text', text });
const thought = { type: 'thinking', thinking: '思考内容保留在正文视图，不进入简洁摘要。'.repeat(20) };
const call = id => ({ type: 'toolCall', id, name: 'read', arguments: { path: '/srv/example/source.js' } });

// Timestamps advance three minutes per message so turn durations are realistic.
function fixture() {
    const messages = [];
    let ts = 1767225600000;
    const add = (role, content, extra = {}) => messages.push({ role, timestamp: (ts += 180000), content, ...extra });
    add('user', [plain('检查模块 A')]);
    add('assistant', [plain('开始检查 A。'.repeat(8)), thought, call('a-1')]);
    add('toolResult', [plain('A output\n'.repeat(20))], { toolCallId: 'a-1', toolName: 'read' });
    add('assistant', [plain('## 最终回复 A\n\n模块 A 检查完成。')]);
    add('user', [plain('检查模块 B')]);
    add('assistant', [plain('开始检查 B。'.repeat(8)), call('b-1')]);
    add('toolResult', [plain('B failed')], { toolCallId: 'b-1', toolName: 'read', isError: true });
    add('assistant', [plain('B 中间说明，折叠后仍可从摘要展开。'.repeat(4))]);
    add('assistant', [{ type: 'thinking', thinking: '最终回复前的思考。' }, plain('B 的最后说明')], { stopReason: 'aborted' });
    add('user', [plain('检查模块 C')]);
    add('assistant', [plain('开始检查 C'), call('c-1')]);
    add('toolResult', [plain('C output')], { toolCallId: 'c-1', toolName: 'read' });
    add('assistant', [plain('等待你确认工具调用。')], { stopReason: 'toolUse' });
    return { messages, nextTimestamp: ts + 180000 };
}

async function run(browser, size) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: size, isMobile: size.width < 900, hasTouch: size.width < 900 });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    let socket;
    let connections = 0;
    let streaming = false;
    const state = fixture();
    let messages = state.messages;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => {
        if (!localStorage.getItem('pi.web.cwd')) {
            localStorage.setItem('pi.web.cwd', cwd);
            localStorage.setItem(`pi.web.session:${cwd}`, id);
        }
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const request = route.request();
        if (request.method() !== 'GET') {
            writes.push(new URL(request.url()).pathname);
            return route.fulfill({ json: { ok: true } });
        }
        const path = new URL(request.url()).pathname;
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '0.85.0', projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: '简洁测试', sessionCount: 1 }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session] } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.startsWith('/api/pi/')) return route.fulfill({ json: {} });
        if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
        if (path.includes('/health')) return route.fulfill({ json: { ok: false, configured: false } });
        await route.continue();
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        connections++;
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            const runtime = { model, isStreaming: streaming, thinkingLevel: 'off' };
            let data = {};
            if (command.type === 'open_session') data = { session, state: runtime, messages: { messages }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            else if (command.type === 'get_messages') data = { messages };
            else if (command.type === 'get_state') data = runtime;
            else if (!['get_session_stats', 'get_available_models', 'get_available_thinking_levels'].includes(command.type)) {
                throw new Error(`Unexpected RPC: ${command.type}`);
            }
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const send = event => socket.send(JSON.stringify(event));
    const pause = () => page.waitForTimeout(150);
    const settle = async () => { streaming = false; send({ type: 'agent_settled' }); await page.waitForTimeout(350); };
    const visibleTurnBars = () => page.locator('.pi-turn-group:visible');
    const visibleAssistant = () => page.locator('.pi-message.assistant:visible');

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pi-turn-group', { state: 'attached' });
    assert.equal(await visibleTurnBars().count(), 0, 'reading mode keeps turn summaries hidden');
    assert.equal(await page.locator('.pi-turn-group').count(), 2, 'completed turns with a final reply get a summary');
    assert.equal(await visibleAssistant().count(), 7, 'reading mode keeps every assistant reply visible');

    await selectMessageView(page, 'compact');
    await pause();
    assert.equal(await page.locator('button[data-transcript-mode="compact"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await visibleTurnBars().count(), 2, 'compact mode shows one summary per completed turn');
    assert.equal(await visibleAssistant().count(), 4, 'only final replies and the pending tail stay visible');
    assert.equal(await page.locator('.pi-message.user:visible').count(), 3, 'user messages are never collapsed');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '开始检查 A' }).first().isVisible(), false, 'intermediate reply A hidden');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: 'B 中间说明' }).first().isVisible(), false, 'intermediate reply B hidden');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '最终回复 A' }).first().isVisible(), true, 'final reply A stays visible');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: 'B 的最后说明' }).first().isVisible(), true, 'aborted final reply stays visible');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '等待你确认工具调用' }).first().isVisible(), true, 'tail awaiting tool confirmation stays visible');

    const bars = page.locator('.pi-turn-group');
    const firstLabel = await bars.nth(0).locator('.pi-turn-label').textContent();
    assert.ok(firstLabel.includes('用时'), 'summary carries the elapsed time');
    assert.ok(firstLabel.includes('9m') && !firstLabel.includes('9m 0s'), `nine minute span formatted compactly, got: ${firstLabel}`);
    assert.ok(firstLabel.includes('1 次工具调用'), 'summary carries the tool count');
    assert.equal(await bars.nth(0).locator('.pi-turn-status').textContent(), '');
    const finalB = page.locator('.pi-message.assistant').filter({ hasText: 'B 的最后说明' });
    assert.equal(await finalB.locator('.pi-process-group').count(), 1, 'final reply B carries its own thinking record');
    assert.equal(await finalB.locator('.pi-process-group:visible').count(), 0, 'final reply thinking folds into the turn summary');
    assert.equal(await bars.nth(0).evaluate(el => el.classList.contains('has-error')), false);
    const secondLabel = await bars.nth(1).locator('.pi-turn-label').textContent();
    assert.ok(secondLabel.includes('12m'), `turn span measured from its own user message, got: ${secondLabel}`);
    const secondStatus = await bars.nth(1).locator('.pi-turn-status').textContent();
    assert.ok(secondStatus.includes('回复已停止'), `aborted turn flagged, got: ${secondStatus}`);
    assert.ok(secondStatus.includes('1 工具失败'), `failed tool flagged, got: ${secondStatus}`);
    assert.equal(await bars.nth(1).evaluate(el => el.classList.contains('has-error')), true);
    const summaryHeight = await bars.nth(0).locator('summary').boundingBox();
    assert.ok(summaryHeight.height >= (size.width < 900 ? 40 : 34), 'summary keeps a comfortable tap target');

    const compactHeight = await page.locator('#pi-transcript').evaluate(el => el.scrollHeight);
    await selectMessageView(page, 'reading');
    await pause();
    const readingHeight = await page.locator('#pi-transcript').evaluate(el => el.scrollHeight);
    assert.ok(compactHeight < readingHeight, 'compact mode further reduces transcript height');
    await selectMessageView(page, 'compact');
    await pause();

    // Expanding a summary reveals the whole turn process again.
    await bars.nth(0).locator('summary').click();
    await pause();
    assert.equal(await bars.nth(0).evaluate(el => el.open), true);
    assert.equal(await bars.nth(0).locator('summary').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '开始检查 A' }).first().isVisible(), true, 'expanding reveals intermediate reply A');

    await page.evaluate(() => {
        const article = [...document.querySelectorAll('.pi-message.assistant')]
            .find(el => el.textContent.includes('开始检查 A'));
        article.querySelector('.pi-process-group').open = true;
    });
    await pause();
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '开始检查 A' }).first().isVisible(), true, 'tool row revealed with its process group');
    await bars.nth(0).locator('summary').click();
    await pause();
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '开始检查 A' }).first().isVisible(), false, 'collapsing hides the process again');
    await bars.nth(1).locator('summary').click();
    await pause();
    assert.equal(await finalB.locator('.pi-process-group:visible').count(), 1, 'expanding turn B reveals its final thinking record');
    await bars.nth(1).locator('summary').click();
    await pause();
    assert.equal(await finalB.locator('.pi-process-group:visible').count(), 0, 'collapsing turn B folds it again');

    // Anchored content stays put when surrounding turns collapse or expand.
    const anchor = page.locator('.pi-markdown').filter({ hasText: '最终回复 A' }).first();
    await anchor.evaluate(el => {
        const viewport = document.getElementById('pi-transcript');
        viewport.scrollTop += el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24;
    });
    await pause();
    const anchorOffset = () => anchor.evaluate(el => el.getBoundingClientRect().top - document.getElementById('pi-transcript').getBoundingClientRect().top);
    const before = await anchorOffset();
    await selectMessageView(page, 'full');
    await pause();
    assert.ok(Math.abs(await anchorOffset() - before) <= 2, 'view switch preserves the visible anchor');
    await selectMessageView(page, 'compact');
    await pause();
    assert.ok(Math.abs(await anchorOffset() - before) <= 2, 'turn collapsing preserves the visible anchor');

    // A running tail stays expanded; once settled it folds into a new summary.
    let nextTimestamp = state.nextTimestamp;
    streaming = true;
    send({ type: 'agent_start' });
    const userD = { role: 'user', timestamp: (nextTimestamp += 180000), content: [plain('继续检查 D')] };
    send({ type: 'message_end', message: userD });
    messages.push(userD);
    const live = { role: 'assistant', timestamp: (nextTimestamp += 180000), content: [plain('D 的中间说明。'.repeat(8)), thought, call('d-1')] };
    send({ type: 'message_start', message: { ...live, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: live.content[0].text } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: thought.thinking } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'd-1', toolName: 'read' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: call('d-1') } });
    send({ type: 'message_end', message: live });
    messages.push(live);
    send({ type: 'tool_execution_start', toolCallId: 'd-1', toolName: 'read', args: call('d-1').arguments });
    await pause();
    assert.equal(await visibleTurnBars().count(), 2, 'running tail has no summary yet');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: 'D 的中间说明' }).first().isVisible(), true, 'running intermediate reply stays visible');
    const finalD = { role: 'assistant', timestamp: (nextTimestamp += 180000), content: [plain('## 最终回复 D\n\n模块 D 检查完成。')] };
    send({ type: 'message_start', message: { ...finalD, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: finalD.content[0].text } });
    send({ type: 'message_end', message: finalD });
    messages.push(finalD);
    await settle();
    assert.equal(await visibleTurnBars().count(), 3, 'settled tail folds into a summary');
    assert.equal(await page.locator('.pi-turn-group').nth(2).locator('.pi-turn-label').textContent().then(text => text.includes('1 次工具调用')), true, 'streamed tool counted once');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: 'D 的中间说明' }).first().isVisible(), false, 'settled intermediate reply folds away');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '最终回复 D' }).first().isVisible(), true, 'latest final reply stays visible');

    // Expansion survives a reconnect; the mode preference survives a reload.
    await bars.nth(0).locator('summary').click();
    await pause();
    const previousConnections = connections;
    socket.close({ code: 1012, reason: 'Reconnect fixture' });
    await page.waitForTimeout(2500);
    assert.ok(connections > previousConnections, 'socket reconnected');
    assert.equal(await bars.nth(0).evaluate(el => el.open), true, 'turn expansion survives reconnect');
    assert.equal(await page.locator('.pi-markdown').filter({ hasText: '开始检查 A' }).first().isVisible(), true, 'expanded turn content visible after reconnect');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pi-turn-group', { state: 'attached' });
    assert.equal(await page.locator('button[data-transcript-mode="compact"]').getAttribute('aria-pressed'), 'true', 'compact preference persists across reload');
    assert.equal(await visibleTurnBars().count(), 3, 'compact mode reapplies after reload');
    assert.equal(await page.locator('.pi-turn-group').nth(0).evaluate(el => el.open), false, 'turn expansion resets on reload like process groups');
    await page.waitForTimeout(800);
    assert.equal(await page.locator('[class*=toast]').filter({ hasText: 'before initialization' }).count(), 0, 'reloading a routed session shows no startup error');

    await page.evaluate(() => localStorage.removeItem('pi.web.transcriptMode'));
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: `/tmp/pi-compact-${size.width}-${theme}.png` });
    }
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false, 'no horizontal overflow');
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(`PASS ${size.width}x${size.height}: turn summaries, durations, failures, streaming tail, settle, reconnect, reload, anchors; no writes/errors/overflow`);
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const size of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }]) await run(browser, size);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
