const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/synthetic/performance';
const model = { provider: 'fixture', id: 'fixture', input: ['text', 'image'] };
const sessions = ['first', 'second'].map(id => ({ id, cwd, name: id, messageCount: 2 }));
const message = (role, text, timestamp) => ({ role, timestamp, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stopReason: 'stop' } : {}) });

async function run(browser, base, width) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let revision = 'queue-1', jobs = [], deferredReads = 0, hold = null, notifyHeld = null, fail = false;
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'first');
        localStorage.setItem('pi.web.transcriptMode', 'full');
        Object.defineProperty(window, 'PiSessionWorkflows', { configurable: true, set(Class) {
            Object.defineProperty(window, 'PiSessionWorkflows', { value: class extends Class {
                constructor(...args) { super(...args); window.fixtureWorkflows = this; }
            }, configurable: true });
        } });
        window.fixtureEvent = event => window.fixtureSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
    }, { cwd });
    await page.route('**/pi-chat.js*', route => route.fulfill({ contentType: 'text/javascript', body: `
        { const Socket = window.WebSocket; window.WebSocket = class extends Socket {
            constructor(...args) { super(...args); if (String(args[0]).includes('/api/pi/ws')) window.fixtureSocket = this; }
        }; }
    ` + fs.readFileSync(path.join(root, 'public/pi-chat.js'), 'utf8') }));
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()), endpoint = url.pathname;
        const reply = data => route.fulfill({ json: data });
        if (endpoint === '/api/pi/status') return reply({ ok: true, projectRoots: ['/synthetic'], sessionWorkflows: true });
        if (endpoint === '/api/pi/projects') return reply({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }] });
        if (endpoint === '/api/pi/sessions') return reply({ sessions });
        if (endpoint === '/api/pi/activity') return reply({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [], deferred: { revision, sessions: [] } });
        if (endpoint.endsWith('/workflow')) return reply({ prompts: [], replies: [], versions: [], leafId: null });
        if (endpoint.endsWith('/deferred')) {
            deferredReads++;
            const sessionId = endpoint.split('/').at(-2);
            const data = structuredClone({ revision, jobs: jobs.filter(job => job.sessionId === sessionId) });
            if (hold) { notifyHeld?.(); await hold; }
            if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Synthetic failure' } }); }
            return reply(data);
        }
        return reply(endpoint.includes('history') || endpoint === '/api/prompts' ? [] : {});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let id = 'first';
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            const runtime = { model, isStreaming: false, thinkingLevel: 'off' };
            let data = {};
            const messages = () => [message('user', `Question ${id}`, 1), message('assistant', `Answer ${id}`, 2)];
            if (command.type === 'open_session') {
                id = command.sessionId;
                data = { session: sessions.find(row => row.id === id), state: runtime, messages: { messages: messages() }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            } else if (command.type === 'get_state') data = runtime;
            else if (command.type === 'get_messages') data = { messages: messages() };
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    try {
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => window.fixtureWorkflows?.deferredRevision === 'queue-1');
        const poll = token => page.evaluate(token => window.fixtureWorkflows.refresh(false, { deferredRevision: token }), token);
        const before = deferredReads;
        await poll(revision); await poll(revision); await poll(revision);
        assert.equal(deferredReads, before, 'unchanged polls do not fetch deferred details');
        revision = 'queue-2';
        jobs = [{ id: 'job', sessionId: 'first', status: 'scheduled', revision: 1, preview: 'Scheduled text', dueAt: Date.now() + 600000 }];
        await poll(revision);
        assert.equal(await page.locator('#pi-deferred-banner').isVisible(), true);
        assert.equal(await page.evaluate(() => window.fixtureWorkflows.jobs[0].preview), 'Scheduled text');
        revision = 'queue-3'; jobs[0].preview = 'Changed without changing count'; jobs[0].revision++;
        await poll(revision);
        assert.equal(await page.evaluate(() => window.fixtureWorkflows.jobs[0].preview), 'Changed without changing count');
        const forced = deferredReads;
        await page.evaluate(() => window.fixtureWorkflows.refresh());
        assert.equal(deferredReads, forced + 1, 'explicit refresh still reads authoritative details');
        revision = 'queue-4'; fail = true;
        assert.equal(await page.evaluate(() => window.fixtureWorkflows.refresh(false, { deferredRevision: 'queue-4' }).then(() => false, () => true)), true);
        await poll(revision);
        assert.equal(await page.evaluate(() => window.fixtureWorkflows.deferredRevision), revision, 'failed reads are retried');
        revision = 'queue-5';
        let release;
        hold = new Promise(resolve => { release = resolve; });
        const count = deferredReads;
        const held = new Promise(resolve => { notifyHeld = resolve; });
        await page.evaluate(() => { window.fixtureReads = [0, 1, 2].map(() => window.fixtureWorkflows.refresh(false, { deferredRevision: 'queue-5' })); });
        await held;
        notifyHeld = null;
        assert.equal(deferredReads, count + 1, 'overlapping polls share one request');
        hold = null; release();
        await page.evaluate(() => Promise.all(window.fixtureReads));
        const legacy = deferredReads;
        await page.evaluate(() => window.fixtureWorkflows.refresh(false, {}));
        assert.equal(deferredReads, legacy + 1, 'old server without summary revision keeps refreshing');

        await page.evaluate(() => {
            const original = window.PiFileViewer.markdown;
            window.fixtureMarkdownCalls = 0;
            window.PiFileViewer.markdown = function(...args) { window.fixtureMarkdownCalls++; return original.apply(this, args); };
        });
        const streamed = await page.evaluate(() => {
            fixtureEvent({ type: 'agent_start' });
            fixtureEvent({ type: 'message_start', message: { role: 'assistant', timestamp: 10, content: [] } });
            fixtureMarkdownCalls = 0;
            const delta = '**流式文字** 与 Unicode：✓\n\n';
            for (let i = 0; i < 300; i++) fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
            return { calls: fixtureMarkdownCalls, raw: delta.repeat(300) };
        });
        assert.equal(streamed.calls, 0, 'delta burst is buffered before the next animation frame');
        await page.waitForFunction(raw => document.querySelector('.streaming .pi-markdown')?.dataset.raw === raw, streamed.raw);
        assert.equal(await page.evaluate(() => fixtureMarkdownCalls), 1, 'one Markdown parse for one frame');
        await page.evaluate(() => {
            for (const delta of ['思考', '保留✓']) fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta } });
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call', toolName: 'read' } });
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"unfinished' } });
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'call', name: 'read', arguments: { path: 'authoritative.js' } } } });
        });
        await page.waitForFunction(() => document.querySelector('.streaming .pi-thinking-content')?.textContent === '思考保留✓');
        assert.ok((await page.locator('[data-tool-id="call"] .pi-tool-args').textContent()).includes('authoritative.js'));
        assert.equal((await page.locator('[data-tool-id="call"] .pi-tool-args').textContent()).includes('unfinished'), false);
        await page.evaluate(() => {
            // Recovery supplies unfinished tool arguments through the same toolcall_end projection.
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 3, toolCall: { id: 'recovered', name: 'read', arguments: '{"path":"' } } });
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 3, delta: 'recovered.js"}' } });
        });
        await page.waitForFunction(() => document.querySelector('[data-tool-id="recovered"] .pi-tool-args')?.textContent === '{"path":"recovered.js"}');
        const ended = await page.evaluate(() => {
            fixtureEvent({ type: 'message_start', message: { role: 'assistant', timestamp: 20, content: [] } });
            fixtureMarkdownCalls = 0;
            const text = '最后一个片段 ✓ <script>window.fixtureUnsafe=true</script>';
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
            fixtureEvent({ type: 'message_end', message: { role: 'assistant', timestamp: 20, stopReason: 'stop', content: [{ type: 'text', text }] } });
            return fixtureMarkdownCalls;
        });
        assert.equal(ended, 1, 'final authoritative rendering consumes all text without an extra pending parse');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => fixtureMarkdownCalls), 1);
        assert.equal(await page.evaluate(() => Boolean(window.fixtureUnsafe)), false);
        assert.ok((await page.locator('#pi-transcript-content').textContent()).includes('最后一个片段 ✓'));

        // Hold a deferred response and a stream frame across the same thread switch.
        revision = 'queue-late';
        hold = new Promise(resolve => { release = resolve; });
        await page.evaluate(() => { window.fixtureLate = fixtureWorkflows.refresh(false, { deferredRevision: 'queue-late' }); });
        await page.waitForFunction(() => fixtureWorkflows.pollRequest?.revision === 'queue-late');
        await page.evaluate(() => {
            fixtureEvent({ type: 'message_start', message: { role: 'assistant', timestamp: 30, content: [] } });
            fixtureEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'OLD_FRAME_MUST_NOT_APPEAR' } });
            document.querySelector('[data-session-id="second"] .pi-session-main').click();
        });
        hold = null; release();
        await page.evaluate(() => window.fixtureLate);
        await page.waitForFunction(() => fixtureWorkflows.context().session?.id === 'second' && fixtureWorkflows.context().connected && fixtureWorkflows.deferredRevision === 'queue-late');
        assert.equal(await page.evaluate(() => fixtureWorkflows.jobs.length), 0);
        assert.equal((await page.locator('#pi-transcript-content').textContent()).includes('OLD_FRAME_MUST_NOT_APPEAR'), false);
        assert.ok((await page.locator('#pi-transcript-content').textContent()).includes('Answer second'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ width, status: 'passed', deferredReads, burstDeltas: 300, burstMarkdownParses: 1 }));
        if (process.env.PI_PERFORMANCE_EVIDENCE) {
            fs.mkdirSync(process.env.PI_PERFORMANCE_EVIDENCE, { recursive: true });
            await page.screenshot({ path: path.join(process.env.PI_PERFORMANCE_EVIDENCE, `performance-${width}.png`) });
        }
    } finally { await context.close(); }
}

(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 393]) await run(browser, `http://127.0.0.1:${server.address().port}`, width);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
