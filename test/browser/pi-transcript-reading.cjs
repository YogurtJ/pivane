const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseUrl = process.env.PI_READING_TEST_URL || 'http://127.0.0.1:3101';
const cwd = '/srv/pi-reading-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'] };
const session = { id: 'reading-fixture', cwd, name: '复杂任务阅读验证', messageCount: 120 };
const shortSession = { ...session, id: 'short-fixture', name: '空会话', messageCount: 0 };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' };
const plain = text => ({ type: 'text', text });
const thought = { type: 'thinking', thinking: '思考内容保留，不进入正文。'.repeat(30) };
const call = id => ({ type: 'toolCall', id, name: 'read', arguments: { path: '/srv/example/source.js' } });
const paragraph = label => `${label}\n\n${'这段是执行过程中给用户的普通说明，应当保留原文和先后顺序。'.repeat(5)}`;

function fixture() {
    const messages = [];
    let timestamp = 1000;
    const add = (role, content, extra = {}) => messages.push({ role, timestamp: timestamp++, content, ...extra });
    for (let round = 0; round < 4; round++) {
        add('user', [plain(`请检查第 ${round + 1} 个模块，并保留重要发现。`)]);
        add('assistant', [plain(paragraph(`开始检查 ${round}`)), thought, call(`first-${round}`)]);
        add('toolResult', [plain('First output\n'.repeat(30))], { toolCallId: `first-${round}`, toolName: 'read' });
        for (let i = 0; i < 12; i++) {
            const id = `tool-${round}-${i}`;
            add('assistant', [thought, call(id)]);
            add('toolResult', [plain(i === 3 ? '<img src=x onerror="window.fixtureXss=true">\nControlled failure' : 'Detailed tool output\n'.repeat(40)), ...(i === 3 ? [image] : [])], { toolCallId: id, toolName: 'read', isError: i === 3 });
        }
        add('assistant', [plain(paragraph(`中途发现 ${round}`)), thought, call(`middle-${round}`), plain(paragraph(`进一步说明 ${round}`))]);
        add('toolResult', [plain('Complete')], { toolCallId: `middle-${round}`, toolName: 'read' });
        add('assistant', [plain(`## 最终回复 ${round}\n\n处理完成，验证通过。\n\n\`\`\`js\nconst checked = true;\n\`\`\``)]);
    }
    add('toolResult', [plain('Standalone result preserved')], { toolCallId: 'orphan', toolName: 'bash', isError: true });
    add('assistant', [], { stopReason: 'error', errorMessage: '最终请求失败，请检查连接。' });
    return messages;
}

async function run(browser, size) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: size, isMobile: size.width < 900, hasTouch: size.width < 900 });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    let socket;
    let connections = 0;
    let activeId = session.id;
    let messages = fixture();
    let streaming = false;
    const current = () => activeId === session.id ? messages : [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => {
        if (!localStorage.getItem('pi.web.cwd')) {
            localStorage.setItem('pi.web.cwd', cwd);
            localStorage.setItem(`pi.web.session:${cwd}`, id);
        }
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
            writes.push(path);
            return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '0.85.0', projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: '阅读测试', sessionCount: 2 }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, shortSession] } });
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
            if (command.type === 'open_session') {
                activeId = command.sessionId;
                data = { session: activeId === session.id ? session : shortSession, state: runtime,
                    messages: { messages: current() }, models: { models: [model] }, stats: {},
                    thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            } else if (command.type === 'get_messages') data = { messages: current() };
            else if (command.type === 'get_state') data = runtime;
            else if (!['get_session_stats', 'get_available_models', 'get_available_thinking_levels'].includes(command.type)) {
                throw new Error(`Unexpected RPC: ${command.type}`);
            }
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const send = event => socket.send(JSON.stringify(event));
    const pause = () => page.waitForTimeout(150);
    const mode = value => page.locator(`button[data-transcript-mode="${value}"]`).click();
    const height = () => page.locator('#pi-transcript').evaluate(el => el.scrollHeight);
    const bottom = () => page.waitForFunction(() => {
        const el = document.getElementById('pi-transcript');
        return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
    });
    const positionText = async label => {
        const target = page.locator('.pi-markdown').filter({ hasText: label }).first();
        await target.evaluate(el => {
            const viewport = document.getElementById('pi-transcript');
            viewport.scrollTop += el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 10;
        });
        await pause();
        return target;
    };
    const offset = target => target.evaluate(el => el.getBoundingClientRect().top - document.getElementById('pi-transcript').getBoundingClientRect().top);
    const assertText = async () => {
        const expected = current().filter(message => ['user', 'assistant'].includes(message.role))
            .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text));
        const actual = await page.locator('.pi-message-body > .pi-markdown').allTextContents();
        assert.equal(actual.length, expected.length);
        for (const [i, text] of expected.entries()) assert.ok(actual[i].includes(text.split('\n')[0].replace(/^## /, '')), `body text ${i} retained in order`);
        assert.equal(await page.locator('.pi-tool-result').count(), 0, 'no separate result articles');
        const ids = await page.locator('.pi-tool-row').evaluateAll(rows => rows.map(row => row.dataset.toolId));
        assert.equal(new Set(ids).size, ids.length, 'one row per tool ID');
    };
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pi-process-group');
    await bottom();
    assert.equal(await page.locator('button[data-transcript-mode="reading"]').getAttribute('aria-pressed'), 'true');
    await assertText();
    assert.equal(await page.locator('.pi-process-group:visible').count(), 9, 'one disclosure per consecutive process run');
    assert.equal(await page.locator('.pi-tool-row:visible').count(), 0);
    assert.equal(await page.locator('.pi-inline-error:visible').count(), 1, 'final failure remains visible');
    assert.equal(await page.locator('.pi-process-group.has-error:visible').count(), 5);
    const compactHeight = await height();
    await mode('full');
    await pause();
    assert.ok(await height() > compactHeight * 1.5, 'reading mode meaningfully reduces transcript height');
    assert.equal(await page.locator('.pi-tool-row:visible').count(), 57);
    assert.equal(await page.locator('.pi-tool-row[open]').count(), 0, 'failed tools never force logs open');

    const anchor = await positionText('进一步说明 1');
    const before = await offset(anchor);
    await mode('reading');
    await pause();
    assert.ok(Math.abs(await offset(anchor) - before) <= 2, 'view switch preserves nested body anchor');
    const settle = async () => { streaming = false; send({ type: 'agent_settled' }); await page.waitForTimeout(350); };
    await settle();
    assert.ok(Math.abs(await offset(anchor) - before) <= 2, 'settled retains reading anchor');
    const previousConnections = connections;
    socket.close({ code: 1012, reason: 'Reconnect fixture' });
    await page.waitForTimeout(2500);
    assert.ok(connections > previousConnections);
    assert.ok(Math.abs(await offset(anchor) - before) <= 2, 'reconnect retains reading anchor');

    // A run crosses many assistant messages but excludes all ordinary text.
    const group = page.locator('.pi-process-group').first();
    await group.locator('summary').click();
    await pause();
    assert.equal(await page.locator('.pi-tool-row:visible').count(), 13);
    const failed = page.locator('[data-tool-id="tool-0-3"]');
    await failed.locator('summary').click();
    assert.ok(await failed.locator('.pi-tool-output').isVisible());
    assert.equal(await page.evaluate(() => Boolean(window.fixtureXss)), false);
    assert.ok(await failed.locator('img').evaluate(async el => { await el.decode(); return el.naturalWidth > 0; }), 'tool image rendered');
    const groupKey = await group.getAttribute('data-detail-key');
    await settle();
    assert.equal(await page.locator('.pi-process-group').first().getAttribute('data-detail-key'), groupKey);
    assert.equal(await page.locator('.pi-process-group').first().evaluate(el => el.open), true);
    assert.equal(await failed.evaluate(el => el.open), true);
    await mode('full');
    await mode('reading');
    assert.equal(await failed.evaluate(el => el.open), true, 'individual log expansion survives mode switches');
    await page.locator('.pi-process-group').first().locator('summary').click();
    await pause();
    await positionText('中途发现 2');
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: `/tmp/pi-reading-${size.width}-${theme}.png` });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'daylight'; });

    // Incremental updates, authoritative messages and toolResult all share a single row.
    const paused = await offset(await positionText('中途发现 2'));
    streaming = true;
    send({ type: 'agent_start' });
    const live = { role: 'assistant', timestamp: 9000, content: [plain(paragraph('实时正文')), thought, call('live-call')] };
    send({ type: 'message_start', message: { ...live, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: live.content[0].text } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: thought.thinking } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'live-call', toolName: 'read' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: call('live-call') } });
    send({ type: 'message_end', message: live });
    messages.push(live);
    send({ type: 'tool_execution_start', toolCallId: 'live-call', toolName: 'read', args: call('live-call').arguments });
    await pause();
    await page.waitForFunction(() => [...document.querySelectorAll('.pi-process-group')].at(-1)?.textContent.includes('执行中'));
    await mode('full');
    await mode('reading');
    send({ type: 'tool_execution_update', toolCallId: 'live-call', toolName: 'read', partialResult: { content: [plain('Partial output\n'.repeat(500))] } });
    const result = { role: 'toolResult', timestamp: 9001, toolCallId: 'live-call', toolName: 'read', isError: true, content: [plain('Live error remains inspectable')] };
    send({ type: 'tool_execution_end', toolCallId: 'live-call', toolName: 'read', isError: true, result });
    send({ type: 'message_end', message: result });
    messages.push(result);
    await pause();
    assert.equal(await page.locator('[data-tool-id="live-call"]').count(), 1);
    assert.equal(await page.locator('[data-tool-id="live-call"]').evaluate(el => el.open), false);
    assert.ok(Math.abs(await offset(page.locator('.pi-markdown').filter({ hasText: '中途发现 2' }).first()) - paused) <= 2, 'live updates do not move earlier body text');
    await page.locator('[data-tab="media"]').click();
    await settle();
    await page.locator('[data-tab="chat"]').click();
    await pause();
    assert.ok(Math.abs(await offset(page.locator('.pi-markdown').filter({ hasText: '中途发现 2' }).first()) - paused) <= 2, 'hidden workspace redraw retains body text');
    await assertText();
    await page.locator('#pi-jump-latest').click();
    await bottom();
    const final = { role: 'assistant', timestamp: 9002, content: [plain(paragraph('实时最终回复'))] };
    send({ type: 'message_start', message: { ...final, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: final.content[0].text } });
    send({ type: 'message_end', message: final });
    messages.push(final);
    await settle();
    await bottom();

    // A tool-only streamed message keeps the same process disclosure after message_end.
    const toolOnly = { role: 'assistant', timestamp: 9010, content: [call('tool-only-live')] };
    send({ type: 'message_start', message: { ...toolOnly, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'tool-only-live', toolName: 'read' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call('tool-only-live') } });
    await pause();
    const lastGroup = page.locator('.pi-process-group').last();
    await lastGroup.locator('summary').focus();
    await lastGroup.locator('summary').press('Enter');
    await pause();
    await page.locator('[data-tool-id="tool-only-live"] summary').click();
    send({ type: 'tool_execution_end', toolCallId: 'tool-only-live', toolName: 'read', result: { content: [plain('Early completion')] } });
    send({ type: 'message_end', message: toolOnly });
    messages.push(toolOnly);
    await pause();
    assert.equal(await lastGroup.evaluate(el => el.open), true, 'tool-only group survives authoritative replacement');
    assert.equal(await page.locator('[data-tool-id="tool-only-live"]').evaluate(el => el.open), true);
    assert.equal(await page.locator('[data-tool-id="tool-only-live"] .pi-tool-output').textContent(), 'Early completion');

    await mode('full');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pi-tool-row');
    assert.equal(await page.locator('button[data-transcript-mode="full"]').getAttribute('aria-pressed'), 'true', 'only mode preference persists');
    await mode('reading');
    if (size.width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator(`[data-session-id="${shortSession.id}"] .pi-session-main`).click();
    await page.waitForSelector('.pi-empty-state');
    assert.equal(await page.locator('.pi-process-group').count(), 0);
    if (size.width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator(`[data-session-id="${session.id}"] .pi-session-main`).click();
    await page.waitForSelector('.pi-process-group');
    await bottom();
    assert.equal(await page.locator('.pi-process-group[open]').count(), 0, 'expansion does not leak to a newly opened session');
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    const layout = await page.locator('.pi-transcript-modes').boundingBox();
    const banner = await page.locator('#pi-connection-banner').boundingBox();
    const viewport = await page.locator('#pi-transcript').boundingBox();
    assert.equal(await page.locator('.pi-transcript-toolbar').count(), 0, 'no separate toolbar row');
    assert.ok(Math.abs(banner.y + banner.height - viewport.y) <= 1, 'transcript begins directly after the existing status bar');
    assert.ok(layout.y >= banner.y && layout.y + layout.height <= banner.y + banner.height, 'mode controls fit within status bar');
    assert.ok(banner.height <= (size.width < 900 ? 37 : 29), 'status bar has bounded height');
    const textBox = await page.locator('#pi-connection-text').boundingBox();
    assert.ok(textBox.x + textBox.width <= layout.x, 'connection text does not overlap controls');
    const originalStatus = await page.locator('#pi-connection-text').textContent();
    await page.locator('#pi-connection-text').evaluate(el => { el.textContent = '正在连接并同步会话消息'.repeat(40); });
    assert.equal((await page.locator('#pi-connection-banner').boundingBox()).height, banner.height, 'long status cannot increase bar height');
    assert.equal((await page.locator('.pi-transcript-modes').boundingBox()).width, layout.width, 'long status cannot squeeze controls');
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    await page.locator('#pi-connection-text').evaluate((el, text) => { el.textContent = text; }, originalStatus);
    await page.locator('#pi-pending-ui-banner').evaluate(el => {
        el.classList.remove('hidden');
        el.querySelector('#pi-pending-ui-count').textContent = '1 项待确认';
    });
    const pending = await page.locator('#pi-pending-ui-banner').boundingBox();
    assert.ok(pending.y >= banner.y + banner.height, 'confirmation stays below the status controls');
    assert.ok(pending.y + pending.height <= (await page.locator('#pi-transcript').boundingBox()).y + 1, 'confirmation does not cover transcript');
    await page.locator('#pi-pending-ui-banner').evaluate(el => el.classList.add('hidden'));
    console.log(`LAYOUT ${size.width}: status ${banner.height}px, controls ${layout.width}x${layout.height}px, no extra row`);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(`PASS ${size.width}x${size.height}: grouped body/full views, merged tools, failures, images, stream, settled, reconnect, anchors, preferences; no writes/errors/overflow`);
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const size of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }]) await run(browser, size);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
