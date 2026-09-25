const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = express();
const root = path.resolve(__dirname, '../..');
for (const [url, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
    app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', directory)));
app.use(express.static(path.join(root, 'public')));
const cwd = '/tmp/chat-knowledge-fixture';
const sessions = ['one', 'two'].map(id => ({ id: `thread-${id}`, cwd, name: `Thread ${id}`, messageCount: 2,
    agentProfile: { id: 'profile-one', name: 'Research', enabled: true, available: true } }));
const revision = 'a'.repeat(64);
async function run(browser, base, width) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, locale: width === 393 ? 'zh-CN' : 'en-US',
        isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [];
    let hold = false, release, started;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'thread-one'); }, { cwd });
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
        const respond = (json, status = 200) => route.fulfill({ json, status });
        if (request.method() !== 'GET') {
            const body = request.postDataJSON(); writes.push({ endpoint, body });
            if (endpoint.endsWith('/knowledge/mutations')) {
                assert.equal(body.operation, 'undo'); assert.equal(body.kind, 'memory');
                assert.deepEqual(Object.keys(body).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId']);
                return respond({ version: 1, status: 'saved', revision, receipt: { id: 'undone', requestId: body.requestId,
                    operation: 'undo', kind: 'memory', status: 'saved', undoable: false, indexStatus: 'ready', activation: 'next-turn' } });
            }
            return respond({ error: 'Unexpected write' }, 400);
        }
        if (endpoint.endsWith('/knowledge')) {
            if (hold) { started?.(); await new Promise(resolve => { release = resolve; }); }
            return respond({ version: 1, status: 'ready', revision, items: [], hasMore: false,
                capabilities: { memory: true, skill: false, operations: ['create','undo'], maxContentLength: 65536 },
                receipts: [
                    { id: 'receipt-one', requestId: 'native-one', kind: 'memory', operation: 'create', status: 'saved', undoable: true,
                        source: { sessionId: 'thread-one', entryId: 'entry-one' } },
                    { id: 'receipt-two', requestId: 'native-two', kind: 'memory', operation: 'create', status: 'saved', undoable: true,
                        source: { sessionId: 'thread-two', entryId: 'entry-two' } } ] });
        }
        if (endpoint === '/api/pi/status') return respond({ ok: true, agentProfiles: true, profileLearning: true,
            projectRoots: ['/tmp'], defaultProject: cwd, runtimeConfiguration: true });
        if (endpoint === '/api/pi/projects') return respond({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/tmp'] });
        if (endpoint === '/api/pi/sessions') return respond({ sessions });
        if (endpoint === '/api/pi/activity') return respond({ runtimes: [], replyNotices: [] });
        if (endpoint === '/api/pi/profiles') return respond({ version: 1, revision: 'p1', profiles: [{ id: 'profile-one', name: 'Research', enabled: true,
            memory: { enabled: true }, skills: { learnedEnabled: false } }] });
        if (endpoint === '/api/prompts' || endpoint.includes('/history')) return respond([]);
        return respond({});
    });
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
        const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
        if (cmd.type === 'open_session') return reply(ws, cmd, { session: sessions.find(row => row.id === cmd.sessionId), state,
            messages: { messages: [{ role: 'user', content: 'Fixture question', timestamp: 1 },
                { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }] },
            stats: { totalMessages: 2, contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 } },
            models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        if (cmd.type === 'get_state') return reply(ws, cmd, state);
        if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [] });
        if (cmd.type === 'get_session_stats') return reply(ws, cmd, { totalMessages: 2 });
        if (cmd.type === 'get_runtime_configuration') return reply(ws, cmd, { runtimeId: 'fixture-runtime', revision: 'cfg', agentProfile: {
            saved: sessions[0].agentProfile, loadedProfileId: 'profile-one', loadedConfirmed: true, matchesSavedProfile: true } });
        return reply(ws, cmd, {});
    }));
    await page.goto(base);
    await page.locator('#pi-input:not([disabled])').waitFor();
    await page.locator('#pi-chat-knowledge:not([hidden]) summary').click();
    await page.locator('.pi-chat-knowledge-receipt').waitFor();
    assert.equal(await page.locator('.pi-chat-knowledge-receipt').count(), 1);
    assert.match(await page.locator('.pi-chat-knowledge-receipt').innerText(), /entry-one/);
    await page.locator('.pi-chat-knowledge-receipt button').click();
    await page.waitForFunction(() => document.querySelector('#pi-chat-knowledge .pi-knowledge-receipt')?.textContent.includes('Undo')
        || document.querySelector('#pi-chat-knowledge .pi-knowledge-receipt')?.textContent.includes('撤销'));
    assert.equal(writes.at(-1).body.receiptId, 'receipt-one');
    await page.locator('#pi-file-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
    await page.locator('.pi-attachment-chip').waitFor();
    const waitStart = new Promise(resolve => { started = resolve; }); hold = true;
    await page.locator('.pi-chat-knowledge-body button').filter({ hasText: width === 393 ? '刷新' : 'Refresh' }).last().click();
    await waitStart; hold = false;
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="thread-two"] .pi-session-main').click();
    release();
    await page.locator('#pi-chat-knowledge:not([hidden]) summary').click();
    await page.waitForFunction(() => document.querySelector('.pi-chat-knowledge-receipt')?.textContent.includes('entry-two'));
    assert.equal(await page.locator('.pi-chat-knowledge-receipt').count(), 1);
    assert.equal(await page.locator('.pi-attachment-chip').count(), 0);
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="thread-one"] .pi-session-main').click();
    assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
    const sizes = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth, chat: document.querySelector('#pi-chat-knowledge').scrollWidth }));
    assert.ok(sizes.body <= sizes.width + 1, JSON.stringify(sizes));
    assert.deepEqual(errors, []);
    console.log(`PASS chat knowledge ${width}: ${JSON.stringify(sizes)}, writes=${writes.length}`);
    await context.close();
}
(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try { for (const width of [320, 393, 1440]) await run(browser, `http://127.0.0.1:${server.address().port}`, width); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
