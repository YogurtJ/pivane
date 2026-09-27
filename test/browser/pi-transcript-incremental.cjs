const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/synthetic/transcript-incremental';
const session = { cwd, id: 'incremental', name: 'Incremental fixture' };
const model = { provider: 'fixture', id: 'fixture', input: ['text', 'image'] };
const text = value => ({ type: 'text', text: value });
function history(turns) {
    const rows = [];
    for (let turn = 0; turn < turns; turn++) {
        const stamp = 1800000000000 + turn * 100;
        rows.push({ role: 'user', timestamp: stamp, content: [text(`Question ${turn}`)] });
        for (let tool = 0; tool < 3; tool++) {
            const id = `tool-${turn}-${tool}`;
            rows.push({ role: 'assistant', timestamp: stamp + tool * 2 + 1, stopReason: 'toolUse', content: [
                { type: 'thinking', thinking: 'Keep this reasoning available.' },
                { type: 'toolCall', id, name: 'read', arguments: { path: 'fixture.js' } }
            ] });
            rows.push({ role: 'toolResult', timestamp: stamp + tool * 2 + 2, toolCallId: id, toolName: 'read', content: [text(`Output ${turn}/${tool}\n` + 'Synthetic output line\n'.repeat(100))] });
        }
        rows.push({ role: 'assistant', timestamp: stamp + 7, stopReason: 'stop', content: [text(`## Answer ${turn}\n\nComplete **checked**.\n\n\`\`\`js\nconst ready = true;\n\`\`\``)] });
    }
    return rows;
}
async function run(browser, base, width) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let messages = history(100), socket, nativeBranch = 'main', generation = 0, connections = 0;
    const anchors = () => messages.flatMap((message, index) => ['user', 'assistant', 'toolResult'].includes(message.role) && message.timestamp != null
        ? [[`${nativeBranch}-${index}`, message.role, message.timestamp, message.toolCallId || '']] : []);
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id);
        localStorage.setItem('pi.web.transcriptMode', 'compact');
        Object.defineProperty(window, 'PiTranscriptView', { configurable: true, set(Class) {
            Object.defineProperty(window, 'PiTranscriptView', { configurable: true, value: class extends Class {
                constructor(...args) { super(...args); window.fixtureView = this; }
                refreshRegion(...args) { window.fixtureRegionReads = (window.fixtureRegionReads || 0) + 1; return super.refreshRegion(...args); }
            } });
        } });
    }, { cwd, id: session.id });
    await page.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        let data = {};
        if (endpoint === '/api/pi/status') data = { ok: true, projectRoots: ['/synthetic'] };
        else if (endpoint === '/api/pi/projects') data = { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
        else if (endpoint === '/api/pi/sessions') data = { sessions: [session] };
        else if (endpoint === '/api/pi/activity') data = { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] };
        else if (endpoint.includes('history') || endpoint === '/api/prompts') data = [];
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws; connections++;
        ws.onMessage(raw => {
            const command = JSON.parse(raw), runtime = { model, isStreaming: false, thinkingLevel: 'off' };
            let data = {};
            if (command.type === 'open_session') data = { session, state: runtime, messages: { messages, webAnchors: anchors() }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            else if (command.type === 'get_state') data = runtime;
            else if (command.type === 'get_messages') { data = { messages, webAnchors: anchors() }; generation++; }
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const send = event => socket.send(JSON.stringify(event));
    const settle = async () => {
        const before = generation; send({ type: 'agent_settled' });
        for (let i = 0; i < 60 && generation === before; i++) await page.waitForTimeout(50);
        assert.ok(generation > before, 'authority snapshot requested');
        await page.waitForTimeout(200);
    };
    try {
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelectorAll('.pi-message.user').length === 100);
        assert.equal(await page.locator('.pi-message.user').count(), 100);
        assert.equal(await page.locator('.pi-tool-detail').count(), 0, 'closed historical tools do not allocate output, images or diff DOM');
        await page.evaluate(() => {
            window.fixtureUser = document.querySelector('.pi-message.user');
            window.fixtureReply = document.querySelector('.pi-message.assistant');
            window.fixtureTool = document.querySelector('[data-tool-id="tool-0-0"]');
            window.fixtureGroup = document.querySelector('.pi-turn-group');
            fixtureView.setMode('full', false);
            fixtureTool.open = true;
        });
        await page.waitForSelector('[data-tool-id="tool-0-0"] .pi-tool-output');
        assert.match(await page.locator('[data-tool-id="tool-0-0"] .pi-tool-output').textContent(), /Output 0\/0/);
        assert.equal(await page.locator('.pi-tool-detail').count(), 1, 'only the expanded tool is materialized');
        await page.evaluate(() => {
            fixtureView.scroll.scrollToNode(fixtureUser);
            window.fixtureOffset = fixtureUser.getBoundingClientRect().top - fixtureView.scroll.viewport.getBoundingClientRect().top;
        });
        await settle();
        assert.equal(await page.evaluate(() => fixtureUser === document.querySelector('.pi-message.user') && fixtureReply.isConnected && fixtureTool.open), true, 'unchanged authoritative snapshot keeps original DOM and expanded tool');
        const beforeConnections = connections;
        socket.close({ code: 1012, reason: 'fixture reconnect' });
        for (let i = 0; i < 80 && connections === beforeConnections; i++) await page.waitForTimeout(50);
        await page.waitForTimeout(250);
        assert.ok(connections > beforeConnections);
        assert.equal(await page.evaluate(() => fixtureUser.isConnected && fixtureTool.open), true, 'reconnection reuses unchanged history');
        assert.ok(await page.evaluate(() => Math.abs(fixtureUser.getBoundingClientRect().top - fixtureView.scroll.viewport.getBoundingClientRect().top - fixtureOffset) < 3), 'reading anchor survives reconnect');

        // A stream in a long transcript must visit only its current turn.
        await page.evaluate(() => {
            fixtureView.setMode('compact', false);
            const group = [...document.querySelectorAll('.pi-turn-group')].at(-1);
            group.open = true; window.fixtureTailKey = group.dataset.detailKey;
        });
        send({ type: 'agent_start' });
        const user = { role: 'user', timestamp: 1900000000000, content: [text('New turn')] };
        send({ type: 'message_end', message: user });
        send({ type: 'message_start', message: { role: 'assistant', timestamp: user.timestamp + 1, content: [] } });
        await page.waitForSelector('.streaming', { state: 'attached' });
        await page.evaluate(() => {
            window.fixtureRegionReads = 0; window.fixtureHistoryEnumerations = 0;
            const children = Object.getOwnPropertyDescriptor(Element.prototype, 'children').get;
            Object.defineProperty(fixtureView.content, 'children', { configurable: true, get() {
                fixtureHistoryEnumerations++; return children.call(this);
            } });
        });
        for (let i = 0; i < 20; i++) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `part ${i} ✓\n` } });
        await page.waitForFunction(() => document.querySelector('.streaming .pi-markdown')?.textContent.includes('part 19'));
        await page.waitForTimeout(80);
        const streamedRegions = await page.evaluate(() => fixtureRegionReads);
        assert.ok(streamedRegions > 0 && streamedRegions <= 40, `bounded work across twenty deltas, observed ${streamedRegions}`);
        const historyEnumerations = await page.evaluate(() => {
            delete fixtureView.content.children; return fixtureHistoryEnumerations;
        });
        assert.equal(historyEnumerations, 0, 'streaming below a stationary reader never enumerates historical children');
        assert.equal(await page.evaluate(() => fixtureReply.isConnected && fixtureTool.open), true);
        assert.equal(await page.evaluate(() => document.querySelector(`[data-detail-key="${CSS.escape(fixtureTailKey)}"]`)?.open), true, 'previous tail keeps its expanded state when a new turn starts');
        const final = { role: 'assistant', timestamp: user.timestamp + 1, stopReason: 'stop', content: [text('Final authority ✓')] };
        send({ type: 'message_end', message: final }); messages.push(user, final);
        await settle();
        assert.equal(await page.evaluate(() => fixtureUser.isConnected && fixtureReply.isConnected && fixtureTool.open), true, 'append preserves historical DOM');
        assert.equal(await page.locator('.pi-message.user').count(), 101);
        assert.equal(await page.locator('.pi-message-actions').count(), 101);
        assert.equal(await page.locator('.pi-tool-detail').count(), 1);

        // Same identity and length with corrected content must replace the affected turn.
        messages.at(-1).content = [text('Corrected authority ✓')];
        await settle();
        assert.match(await page.locator('.pi-message.assistant').last().textContent(), /Corrected authority/);
        assert.equal(await page.evaluate(() => fixtureUser.isConnected), true);
        send({ type: 'tool_execution_end', toolCallId: 'tool-0-0', toolName: 'read', isError: true, result: { content: [text('Late <img src=x onerror="window.fixtureXss=true">')] } });
        await page.waitForFunction(() => fixtureTool.dataset.state === 'error');
        assert.match(await page.locator('[data-tool-id="tool-0-0"] .pi-tool-output').textContent(), /Late <img/);
        assert.equal(await page.evaluate(() => Boolean(window.fixtureXss)), false);
        await settle();
        assert.equal(await page.locator('[data-tool-id="tool-0-0"]').getAttribute('data-state'), 'done', 'authority corrects a late mutation of historical DOM');
        assert.match(await page.locator('[data-tool-id="tool-0-0"] .pi-tool-output').textContent(), /Output 0\/0/);

        messages = messages.slice(0, 16); await settle();
        assert.equal(await page.locator('.pi-message.user').count(), 2);
        assert.equal(await page.locator('.pi-tool-row').count(), 6);
        assert.equal(await page.evaluate(() => fixtureView.groups.size), await page.locator('.pi-process-group').count(), 'removed turns leave no stale group records');
        await page.evaluate(() => { window.fixtureUser = document.querySelector('.pi-message.user'); });
        nativeBranch = 'other-native-entries'; await settle();
        assert.equal(await page.evaluate(() => fixtureUser.isConnected), false, 'different native entry identities invalidate old DOM even when text matches');
        messages[8].timestamp = messages[0].timestamp; await settle();
        await page.evaluate(() => { window.fixtureUser = document.querySelector('.pi-message.user'); });
        await settle();
        assert.equal(await page.evaluate(() => fixtureUser.isConnected), false, 'ambiguous identity falls back to full correction');
        // Repeated assistant timestamps must not merge separate runs or steal another turn's disclosure.
        messages[1].content.push(text('Between tool runs'));
        messages[3].timestamp = messages[1].timestamp;
        messages[9].timestamp = messages[1].timestamp;
        await settle();
        assert.equal(await page.locator('.pi-process-group').count(), 3);
        await page.evaluate(() => {
            fixtureView.setMode('reading', false);
            for (const group of document.querySelectorAll('.pi-process-group')) group.open = true;
        });
        await page.waitForFunction(() => [...document.querySelectorAll('.pi-tool-row')].filter(row => row.getClientRects().length).length === 6);
        assert.equal(await page.evaluate(() => fixtureView.groups.size), 3, 'ambiguous message keys keep separate accessible process groups');
        messages = [{ role: 'compactionSummary', summary: 'Preserved compaction summary' }, ...history(1)];
        await settle();
        assert.equal(await page.locator('.pi-message.user').count(), 1);
        await page.locator('.pi-summary-notice > summary').click();
        await page.waitForFunction(() => document.querySelector('.pi-summary-content')?.textContent.includes('Preserved compaction summary'));
        assert.match(await page.locator('#pi-transcript-content').textContent(), /Preserved compaction summary/);
        await page.evaluate(() => { window.fixtureUser = document.querySelector('.pi-message.user'); });
        await settle();
        assert.equal(await page.evaluate(() => fixtureUser.isConnected), true, 'unchanged context summary without a timestamp permits safe prefix reuse');
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        console.log(JSON.stringify({ width, status: 'passed', streamedRegions, historyEnumerations, scenarios: ['lazy-tools', 'stable-dom', 'append', 'correction', 'late-tool', 'reconnect', 'truncate', 'native-identity', 'ambiguous-identity', 'compaction', 'reading-anchor'] }));
    } catch (error) { console.error(JSON.stringify({ width, pageErrors: errors })); throw error; }
    finally { await context.close(); }
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 393]) await run(browser, `http://127.0.0.1:${server.address().port}`, width); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
