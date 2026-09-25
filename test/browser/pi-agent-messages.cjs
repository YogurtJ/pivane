// Agent message / task / result cards and context summaries stay compact and
// collapsed by default; opening one shows a bounded, internally scrolling body.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/message-project';
const a = { id: 'thread-a', cwd, name: 'Coordinator A' }, b = { id: 'thread-b', cwd, name: 'Backend B with a very long thread name '.repeat(3) };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
const long = ['## Interface proposal', '', 'Please confirm **these** points:', '', ...Array.from({ length: 60 }, (_, i) => `- item ${i} with \`code\` and more words to wrap across the line`), '',
    '<img src=x onerror="window.__xss=1">', '```js', 'const port = 8080;', '```'].join('\n');
const header = '[Agent message from thread "Backend B" (session thread-b); messageId ' + 'f'.repeat(64) + '. It comes from another Agent, not the user.]';
const t0 = Date.parse('2026-09-25T08:00:00Z');
function history() {
    return {
        [a.id]: [
            { role: 'user', content: 'Coordinate B and C', timestamp: t0 },
            { role: 'custom', customType: 'pivane-agent-task-receipt', display: true, content: b.name, timestamp: t0 + 1000,
                details: { session: b, model: { provider: 'fixture', modelId: 'fixture' }, thinkingLevel: 'off', status: 'submitted' } },
            { role: 'assistant', content: [{ type: 'text', text: 'Waiting for B.' }], stopReason: 'stop', timestamp: t0 + 2000 },
            { role: 'custom', customType: 'pivane-agent-message', display: true, content: `${header}\n\n${long}`, timestamp: t0 + 60000,
                details: { version: 1, messageId: 'f'.repeat(64), from: { sessionId: b.id, cwd, name: 'Backend B' }, to: { sessionId: a.id, cwd }, wake: true, hop: 1,
                    replyTo: 'e'.repeat(64), conversationId: 'e'.repeat(64), bodyOffset: header.length + 2 } },
            { role: 'assistant', content: [{ type: 'text', text: 'Thanks, noted port 8080.' }], stopReason: 'stop', timestamp: t0 + 65000 },
            { role: 'custom', customType: 'pivane-agent-task-result', display: true, content: 'result', timestamp: t0 + 90000,
                details: { deliveryId: 'd'.repeat(64), session: b, status: 'completed', preview: long, truncated: true, requestId: 'r' } },
            { role: 'compactionSummary', summary: `## Goal\n${'Summary line with details. '.repeat(200)}`, tokensBefore: 123456, timestamp: t0 + 100000 },
            { role: 'custom', customType: 'pivane-agent-message', display: true, content: `${header}\n\nFYI: a note that did not wake anybody.`, timestamp: t0 + 110000,
                details: { version: 1, messageId: 'c'.repeat(64), from: { sessionId: b.id, cwd, name: 'Backend B' }, to: { sessionId: a.id, cwd }, wake: false, wakeSuppressed: 'hop-limit', hop: 6, bodyOffset: header.length + 2 } }
        ],
        [b.id]: [
            { role: 'custom', customType: 'pivane-agent-task-message', display: true, content: long, timestamp: t0, details: { source: { cwd, sessionId: a.id } } },
            { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop', timestamp: t0 + 5000 }
        ]
    };
}
async function check(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 860 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [], opened = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'thread-a');
        localStorage.setItem('pi.workspace.language', language); localStorage.setItem('pi.web.transcriptMode', 'reading');
    }, { cwd, language });
    const histories = history(); let active = a;
    await page.route('**/api/**', route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') writes.push(url.pathname);
        const send = data => route.fulfill({ json: data });
        if (url.pathname === '/api/pi/status') return send({ ok: true, agentThreads: true, agentMessages: true, projectRoots: ['/synthetic'] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions: [a, b] });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw);
        const reply = data => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        const runtime = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
        if (command.type === 'open_session') {
            active = command.sessionId === b.id ? b : a; opened.push(active.id);
            return reply({ session: active, state: runtime, messages: { messages: histories[active.id] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        }
        if (command.type === 'get_messages') return reply({ messages: histories[active.id] });
        if (command.type === 'get_state') return reply(runtime);
        if (command.type === 'get_session_stats') return reply({});
        throw new Error(`Unexpected RPC ${command.type}`);
    }));
    await page.goto(base);
    await page.locator('.pi-agent-card[data-agent-card="message"]').first().waitFor();
    const zh = language !== 'en';
    const boxes = () => page.evaluate(() => [...document.querySelectorAll('.pi-agent-card, .pi-summary-notice')].map(node => ({ kind: node.dataset.agentCard || 'summary', height: node.getBoundingClientRect().height })));
    await page.screenshot({ path: `/tmp/pi-agent-messages-collapsed-${width}-${language}.png` });
    const collapsed = await boxes();
    assert.deepEqual(collapsed.map(row => row.kind), ['receipt', 'message', 'result', 'summary', 'message']);
    for (const row of collapsed) assert.ok(row.height <= (width < 400 ? 120 : 76), `${row.kind} is compact while collapsed: ${row.height}`);
    const layout = async () => {
        const bad = await page.evaluate(() => [...document.querySelectorAll('.pi-agent-card, .pi-agent-card *, .pi-summary-notice, .pi-summary-notice > summary')]
            .filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1); }).map(node => node.className));
        assert.deepEqual(bad, []);
    };
    await layout();
    const message = page.locator('.pi-agent-card[data-agent-card="message"]').first();
    assert.equal(await message.locator('strong').textContent(), zh ? 'Agent 回复' : 'Agent reply');
    assert.ok((await message.locator('.pi-agent-thread-meta').textContent()).includes(zh ? '已唤醒处理' : 'Started a turn here'));
    assert.ok((await message.locator('.pi-agent-card-preview').textContent()).startsWith('Interface proposal Please confirm these points'));
    assert.equal(await message.locator('.pi-agent-card-content').innerHTML(), '', 'body renders only when opened');
    await message.locator('summary').click();
    await message.locator('.pi-agent-card-content h2').waitFor();
    const opened1 = await message.evaluate(node => { const body = node.querySelector('.pi-agent-card-content'); return { height: body.getBoundingClientRect().height, scroll: body.scrollHeight, client: body.clientHeight }; });
    assert.ok(opened1.height <= 421 && opened1.scroll > opened1.client, 'open body scrolls inside a bounded panel');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('.pi-agent-card [onerror]').count(), 0);
    assert.ok(!(await message.locator('.pi-agent-card-content').textContent()).includes('Agent message from thread'), 'routing header is not shown as body');
    await layout();
    await message.locator('summary').click();
    assert.equal(await message.locator('details').evaluate(node => node.open), false);
    const note = page.locator('.pi-agent-card[data-agent-card="message"]').nth(1);
    assert.equal(await note.locator('strong').textContent(), zh ? '来自 Agent 的消息' : 'Message from an Agent');
    assert.ok((await note.locator('.pi-agent-thread-meta').textContent()).includes(zh ? '自动往返已达上限' : 'automatic exchange limit'));
    const summary = page.locator('.pi-summary-notice');
    assert.ok((await summary.locator('summary').textContent()).includes('123'));
    await summary.locator('summary').click();
    await summary.locator('.pi-summary-content p').waitFor();
    assert.ok((await summary.locator('.pi-summary-content p').textContent()).startsWith('## Goal\n'), 'summary keeps its original text and line breaks');
    assert.ok((await summary.locator('.pi-summary-content').evaluate(node => node.getBoundingClientRect().height)) <= 421);
    await page.screenshot({ path: `/tmp/pi-agent-messages-${width}-${language}.png` });
    // Compact view: a waking Agent message starts its own turn instead of folding into the previous one.
    await page.evaluate(() => document.querySelector('[data-transcript-mode="compact"]').click());
    await page.waitForFunction(() => document.querySelector('.pi-transcript-content')?.dataset.transcriptMode === 'compact');
    assert.equal(await message.isVisible(), true, 'waking Agent message remains visible as a turn start');
    assert.equal(await page.locator('.pi-agent-card[data-agent-card="receipt"]').isVisible(), false, 'receipt folds into its turn');
    await page.evaluate(() => document.querySelector('[data-transcript-mode="reading"]').click());
    await page.waitForFunction(() => document.querySelector('.pi-transcript-content')?.dataset.transcriptMode === 'reading');
    await page.locator('.pi-agent-card[data-agent-card="receipt"] .pi-agent-thread-link').click();
    await page.waitForFunction(() => document.querySelector('.pi-agent-card[data-agent-card="task"]'));
    assert.equal(opened.at(-1), b.id);
    const task = page.locator('.pi-agent-card[data-agent-card="task"]');
    assert.ok((await task.evaluate(node => node.getBoundingClientRect().height)) <= (width < 400 ? 120 : 76));
    await layout();
    await task.locator('.pi-agent-thread-link').click();
    await page.waitForFunction(() => document.querySelector('.pi-agent-card[data-agent-card="receipt"]'));
    assert.equal(opened.at(-1), a.id);
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    await context.close();
}
(async () => {
    const app = express(), root = path.resolve(__dirname, '../..');
    for (const [url, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await check(browser, `http://127.0.0.1:${server.address().port}`, width, language);
        console.log('Agent message cards: six desktop/mobile/language checks passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
