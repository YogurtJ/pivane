const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/result-project', parent = { cwd, id: 'parent', name: 'Source' }, child = { cwd, id: 'child', name: 'Child' };
const model = { provider: 'fixture', id: 'fixture', input: ['text'], contextWindow: 32000 };
async function check(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language });
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    let active = parent, read = false, busy = false, indexed = false, delivered = false, liveSocket, holdNextRead = false, releaseRead, heldReady;
    const heldReadReady = new Promise(resolve => { heldReady = resolve; });
    const messages = Array.from({ length: 15 }, (_, index) => ({ role: 'user', timestamp: index + 1, content: `Earlier message ${index}\n` + 'Previous context\n'.repeat(10) }));
    messages.push({ role: 'custom', customType: 'pivane-agent-task-receipt', timestamp: 20, display: true, content: 'Task created',
        details: { session: child, status: 'running', requestId: 'task', model: { provider: 'fixture', modelId: 'fixture' } } });
    const result = { deliveryId: 'a'.repeat(64), requestId: 'task', sourceSessionId: parent.id, session: child,
        status: 'completed', preview: '<img src=x onerror=alert(1)> ' + 'long-result-'.repeat(150), truncated: true };
    await page.addInitScript(({ cwd, language }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'parent'); localStorage.setItem('pi.workspace.language', language); }, { cwd, language });
    await page.route('**/api/**', route => {
        const req = route.request(), url = new URL(req.url()), send = json => route.fulfill({ json });
        if (req.method() !== 'GET') writes.push(url.pathname);
        if (url.pathname === '/api/pi/status') return send({ ok: true, agentThreads: true, agentTaskResults: true, projectRoots: ['/synthetic'] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions: [parent, child] });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname === '/api/pi/agent-threads/results') {
            if (!indexed) { indexed = true; return send({ status: 'indexing', coverage: { files: 54, checked: 10 }, results: [] }); }
            return send({ status: 'ready', results: delivered && url.searchParams.get('sourceSessionId') === 'parent' ? [{ ...result, read }] : [] });
        }
        if (url.pathname === '/api/pi/agent-threads/read') { assert.equal(req.headers()['content-type'], 'application/json'); assert.equal(req.postDataJSON().cwd, cwd); read = true; return send({ read: true }); }
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        liveSocket = ws;
        const cmd = JSON.parse(raw), reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        const state = { model, thinkingLevel: 'off', isStreaming: busy, isCompacting: false, autoCompactionEnabled: true };
        if (cmd.type === 'open_session') { active = cmd.sessionId === 'child' ? child : parent; return reply({ session: active, state,
            messages: { messages: active.id === parent.id ? messages : [{ role: 'user', content: 'Child fixture' }] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }); }
        if (cmd.type === 'get_state') return reply(state);
        if (cmd.type === 'get_messages') {
            const snapshot = structuredClone(active.id === parent.id ? messages : []);
            if (holdNextRead) { holdNextRead = false; releaseRead = () => reply({ messages: snapshot }); heldReady(); return; }
            return reply({ messages: snapshot });
        }
        if (cmd.type === 'get_session_stats') return reply({});
        throw new Error(`Unexpected RPC: ${cmd.type}`);
    }));
    await page.goto(base);
    await page.locator('#pi-input').fill('Unsent draft');
    await page.locator('#pi-file-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    const transcriptResult = page.locator('#pi-transcript-content .pi-agent-thread-message').filter({ has: page.locator('strong', { hasText: language === 'en' ? 'Agent task result' : 'Agent 任务结果' }) });
    assert.equal(await transcriptResult.count(), 0);
    assert.ok((await page.locator('#pi-transcript-content .pi-agent-thread-meta').textContent()).includes(language === 'en' ? 'State at creation:' : '创建时状态：'));
    // Hold a history snapshot from before delivery. A live custom message must
    // appear without reload, and this older response must not erase it.
    holdNextRead = true; liveSocket.send(JSON.stringify({ type: 'agent_settled' }));
    let timer; await Promise.race([heldReadReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No history reconciliation')), 10000); })]); clearTimeout(timer);
    const beforeScroll = await page.locator('#pi-transcript').evaluate(async node => {
        node.scrollTop = 300;
        node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return node.scrollTop;
    });
    const message = { role: 'custom', customType: 'pivane-agent-task-result', timestamp: 30, display: true, content: result.preview, details: result };
    messages.push(message); delivered = true;
    liveSocket.send(JSON.stringify({ type: 'message_start', message }));
    liveSocket.send(JSON.stringify({ type: 'message_end', message }));
    await transcriptResult.waitFor();
    assert.equal(await transcriptResult.locator('img').count(), 0);
    releaseRead();
    liveSocket.send(JSON.stringify({ type: 'message_end', message: { ...message, timestamp: 31 } }));
    liveSocket.send(JSON.stringify({ type: 'message_end', message: { role: 'custom', customType: 'hidden-fixture', content: 'HIDDEN_FIXTURE', display: false } }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await transcriptResult.count(), 1);
    assert.ok(Math.abs(await page.locator('#pi-transcript').evaluate(node => node.scrollTop) - beforeScroll) < 3);
    assert.equal(await page.getByText('HIDDEN_FIXTURE', { exact: true }).count(), 0);
    assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent draft');
    assert.ok(await page.locator('#pi-attachments').isVisible());
    await page.locator('#pi-task-results').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.pi-task-result').length === 1);
    // The chip lives in the composer chip row and never takes transcript height.
    assert.equal(await page.locator('#pi-composer-chips > #pi-task-results').count(), 1);
    const chipBox = await page.locator('#pi-task-results > summary').boundingBox();
    assert.ok(chipBox.height <= 42, `chip stays one line (${chipBox.height})`);
    assert.ok((await page.locator('#pi-task-results > summary').textContent()).includes(language === 'en' ? '1 unread' : '1 未读'));
    await page.locator('#pi-task-results > summary').click();
    assert.equal(await page.locator('.pi-task-result img').count(), 0);
    const row = page.locator('.pi-task-result').first();
    const rowBox = await row.boundingBox();
    assert.ok(rowBox.height <= (width <= 600 ? 64 : 40), `result row stays compact (${rowBox.height})`);
    assert.ok((await row.locator('.pi-task-result-preview').textContent()).includes('<img'));
    assert.ok(await row.locator('.pi-task-result-text').isHidden());
    assert.equal(await page.locator('.pi-results-note').count(), 1);
    assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent draft');
    assert.ok(await page.locator('#pi-attachments').isVisible());
    const overflow = await page.locator('.pi-task-results, .pi-task-results-list, .pi-task-result, .pi-task-result-row, .pi-results-body').evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 2 || n.getBoundingClientRect().right > innerWidth + 1).map(n => n.className));
    assert.deepEqual(overflow, []);
    // A row jumps to the delivered transcript card, opens its body and marks the result read.
    await page.locator('#pi-transcript').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); });
    // The composer chip remains the only task-results surface; opening a row closes the popover.
    assert.equal(await page.locator('#pi-tool-tasks').count(), 0, 'no duplicate task inspector');
    await row.locator('.pi-task-result-main').click();
    await page.waitForFunction(() => document.querySelector('.pi-agent-card[data-agent-card="result"] .pi-agent-card-body')?.open === true);
    assert.equal(await page.locator('#pi-task-results').evaluate(node => node.open), false);
    await page.waitForFunction(() => {
        const card = document.querySelector('.pi-agent-card[data-agent-card="result"]'), view = document.querySelector('#pi-transcript');
        const a = card.getBoundingClientRect(), b = view.getBoundingClientRect();
        return a.top >= b.top - 2 && a.top < b.bottom - 20;
    });
    await page.waitForFunction(() => document.querySelector('#pi-task-results > summary').textContent.match(/All read|全部已读/));
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.pi-task-result').length === 1);
    assert.equal(await transcriptResult.count(), 1, 'native history reload keeps exactly one delivered receipt');
    assert.ok((await page.locator('#pi-task-results > summary').textContent()).includes(language === 'en' ? 'All read' : '全部已读'));
    await page.locator('#pi-task-results > summary').click();
    await page.locator('#pi-task-results').getByRole('button', { name: language === 'en' ? 'Open complete result' : '查看完整结果', exact: true }).click();
    await page.waitForFunction(cwd => localStorage.getItem(`pi.web.session:${cwd}`) === 'child', cwd);
    await page.waitForFunction(() => document.querySelector('#pi-task-results').hidden);
    assert.equal(active.id, 'child');
    read = false; busy = true;
    await page.evaluate(({ cwd }) => localStorage.setItem(`pi.web.session:${cwd}`, 'parent'), { cwd });
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.pi-task-result').length === 1);
    await page.locator('#pi-task-results > summary').click();
    assert.ok(await page.getByRole('button', { name: language === 'en' ? 'Mark read' : '标为已读', exact: true }).isDisabled());
    assert.ok(await page.getByRole('button', { name: language === 'en' ? 'Mark all read' : '全部标为已读', exact: true }).isDisabled());
    await page.screenshot({ path: `/tmp/pivane-task-results-${width}-${language}.png` });
    assert.deepEqual(writes, ['/api/pi/agent-threads/read']); assert.deepEqual(errors, []);
    await context.close();
}
// Results whose card is not in the loaded transcript expand in place; "mark all" reads each unread result once.
async function checkList(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, locale: language });
    const page = await context.newPage(), errors = [], reads = [];
    page.on('pageerror', e => errors.push(e.message));
    const now = Date.now();
    const results = ['b', 'c'].map((letter, index) => ({ deliveryId: letter.repeat(64), requestId: `task-${letter}`, sourceSessionId: parent.id,
        session: { ...child, name: index ? 'A very long task thread name that must stay on one line in the list' : 'Backend' },
        status: index ? 'error' : 'completed', completedAt: new Date(now - index * 60000).toISOString(),
        preview: `Result ${letter}\n` + 'detail line\n'.repeat(60), truncated: false, delivered: true }));
    await page.addInitScript(({ cwd, language }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'parent'); localStorage.setItem('pi.workspace.language', language); }, { cwd, language });
    await page.route('**/api/**', route => {
        const req = route.request(), url = new URL(req.url()), send = json => route.fulfill({ json });
        if (url.pathname === '/api/pi/status') return send({ ok: true, agentThreads: true, agentTaskResults: true, projectRoots: ['/synthetic'] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions: [parent, child] });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname === '/api/pi/agent-threads/results') return send({ status: 'ready',
            results: results.map(r => ({ ...r, read: reads.includes(r.deliveryId) })), tasks: [{ requestId: 'running', status: 'running', session: { ...child, name: 'Frontend' } }] });
        if (url.pathname === '/api/pi/agent-threads/read') { assert.equal(req.headers()['content-type'], 'application/json'); assert.equal(req.postDataJSON().cwd, cwd); reads.push(JSON.parse(req.postData()).deliveryId); return send({ read: true }); }
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    // Result "b" was delivered inside a turn that compact view folds; "c" is not in the loaded transcript.
    const history = [{ role: 'user', content: 'Hello', timestamp: 1 },
        { role: 'custom', customType: 'pivane-agent-task-result', timestamp: 2, display: true, content: results[0].preview, details: results[0] },
        { role: 'assistant', content: [{ type: 'text', text: 'Final reply after the result' }], stopReason: 'stop', timestamp: 3, provider: 'fixture', model: 'fixture', usage: {} },
        ...Array.from({ length: 8 }, (_, index) => [{ role: 'user', content: `Later ${index}\n` + 'context\n'.repeat(8), timestamp: 10 + index * 2 },
            { role: 'assistant', content: [{ type: 'text', text: `Answer ${index}` }], stopReason: 'stop', timestamp: 11 + index * 2, provider: 'fixture', model: 'fixture', usage: {} }]).flat()];
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
        if (cmd.type === 'open_session') return reply({ session: parent, state, messages: { messages: structuredClone(history) }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        if (cmd.type === 'get_state') return reply(state);
        if (cmd.type === 'get_messages') return reply({ messages: structuredClone(history) });
        if (cmd.type === 'get_session_stats') return reply({});
        throw new Error(`Unexpected RPC: ${cmd.type}`);
    }));
    await page.addInitScript(() => localStorage.setItem('pi.web.transcriptMode', 'compact'));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.pi-task-result').length === 3);
    assert.ok((await page.locator('#pi-task-results > summary').textContent()).includes(language === 'en' ? '2 unread · 1 active' : '2 未读 · 1 进行中'));
    const card = page.locator('.pi-agent-card[data-agent-card="result"]');
    assert.ok(await card.isHidden(), 'fixture card starts folded inside a compact turn');
    await page.locator('#pi-task-results > summary').click();
    await page.locator('.pi-task-result').nth(1).locator('.pi-task-result-main').click();
    await card.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
        const node = document.querySelector('.pi-agent-card[data-agent-card="result"]'), view = document.querySelector('#pi-transcript');
        const a = node.getBoundingClientRect(), b = view.getBoundingClientRect();
        return node.querySelector('.pi-agent-card-body')?.open && a.top >= b.top - 2 && a.top < b.top + 60;
    });
    await page.waitForFunction(() => document.querySelector('#pi-task-results > summary').textContent.match(/1 (unread|未读)/));
    assert.deepEqual(reads, ['b'.repeat(64)]);
    await page.locator('#pi-task-results > summary').click();
    const rows = page.locator('.pi-task-result');
    for (let i = 0; i < 3; i++) assert.ok((await rows.nth(i).boundingBox()).height <= (width <= 600 ? 64 : 40));
    const second = rows.nth(2);
    await second.locator('.pi-task-result-main').click();
    await second.locator('.pi-task-result-text').waitFor();
    const text = await second.locator('.pi-task-result-text').evaluate(n => ({ h: n.clientHeight, s: n.scrollHeight }));
    assert.ok(text.h <= 242 && text.s > text.h, 'expanded body scrolls inside a bounded panel');
    assert.equal(reads.length, 1, 'expanding in place does not mark read');
    const overflow = await page.locator('.pi-results-body, .pi-task-result, .pi-task-result-row, .pi-task-result-main').evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 2 || n.getBoundingClientRect().right > innerWidth + 1).map(n => n.className));
    assert.deepEqual(overflow, []);
    await page.screenshot({ path: `/tmp/pivane-task-results-list-${width}-${language}.png` });
    await page.getByRole('button', { name: language === 'en' ? 'Mark all read' : '全部标为已读', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#pi-task-results > summary').textContent.match(/^\D*1 (active|进行中)/));
    assert.deepEqual(reads.sort(), ['b'.repeat(64), 'c'.repeat(64)]);
    assert.ok(await page.locator('.pi-results-read-all').isHidden());
    assert.deepEqual(errors, []);
    await context.close();
}
(async () => {
    const root = path.resolve(__dirname, '../..'), app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await check(browser, `http://127.0.0.1:${server.address().port}`, width, language);
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await checkList(browser, `http://127.0.0.1:${server.address().port}`, width, language);
        console.log('Task result inbox: six desktop/mobile/language scenarios and six list scenarios passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
