const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_COMPACTION_TEST_URL || 'http://127.0.0.1:3102';
const cwd = '/srv/pi-compaction-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const session = { id: 'compaction-fixture', cwd, name: 'Compaction fixture', messageCount: 4 };
const second = { ...session, id: 'second', name: 'Second fixture' };
const initialMessages = () => [{ role: 'user', content: 'Fixture requirement', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }];
const statsFor = tokens => ({ contextUsage: { tokens, percent: tokens === null ? null : tokens / 1280, contextWindow: 128000 }, tokens: { input: 200, output: 10 }, totalMessages: 2 });

async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [], writes = [], commands = [];
    let socket, pendingCompact, delayedStats;
    let holdStats = false, failToggle = false;
    let stats = statsFor(60000), messages = initialMessages();
    let runtime = { model, isStreaming: false, isCompacting: false, autoCompactionEnabled: true, thinkingLevel: 'off', webCompaction: null };
    const reply = (ws, command, data = {}, error) => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: !error, data, error }));
    const send = event => socket.send(JSON.stringify(event));
    const start = reason => {
        runtime.isCompacting = true;
        runtime.webCompaction = { status: 'running', reason };
        send({ type: 'compaction_start', reason });
    };
    const finish = async ({ aborted = false, errorMessage, reason = 'manual' } = {}) => {
        const result = aborted || errorMessage ? undefined : { summary: 'Retained fixture summary', tokensBefore: 60000, estimatedTokensAfter: 4500 };
        runtime.isCompacting = false;
        const unchanged = /^Compaction failed: (Already compacted|Nothing to compact \(session too small\))$/.test(errorMessage || '');
        runtime.webCompaction = { status: aborted ? 'cancelled' : unchanged ? 'unchanged' : errorMessage ? 'error' : 'success', reason, errorMessage, ...result };
        if (result) {
            stats = statsFor(null);
            messages = [{ role: 'compactionSummary', summary: result.summary, timestamp: 3 }, ...initialMessages()];
        }
        send({ type: 'compaction_end', reason, aborted, errorMessage, result });
        if (pendingCompact) { reply(socket, pendingCompact, result, errorMessage || (aborted ? 'Compaction cancelled' : undefined)); pendingCompact = null; }
        await page.waitForTimeout(150);
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem(`pi.web.session:${cwd}`, id);
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        if (req.method() !== 'GET') { writes.push(path); return route.fulfill({ json: { ok: true } }); }
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '0.84.3', projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Compaction fixture', sessionCount: 2 }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, second] } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.startsWith('/api/pi/')) return route.fulfill({ json: {} });
        if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: { configured: false } });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            commands.push(command);
            if (command.type === 'open_session') return reply(ws, command, {
                session: command.sessionId === session.id ? session : second, state: runtime,
                messages: { messages }, stats, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }
            });
            if (command.type === 'get_state') return reply(ws, command, runtime);
            if (command.type === 'get_session_stats') {
                if (holdStats) { delayedStats = { ws, command }; return; }
                return reply(ws, command, stats);
            }
            if (command.type === 'get_messages') return reply(ws, command, { messages });
            if (command.type === 'compact') { pendingCompact = command; start('manual'); return; }
            if (command.type === 'set_auto_compaction') {
                if (failToggle) return reply(ws, command, undefined, 'Controlled settings failure');
                runtime.autoCompactionEnabled = command.enabled;
                return reply(ws, command);
            }
            if (command.type === 'prompt') throw new Error('A local compact command must not become a model prompt');
            throw new Error(`Unexpected command ${command.type}`);
        });
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pi-context-percent').textContent === '47%');
    const openInspector = async () => {
        if (!(await page.locator('#pi-compact-button').isVisible())) await page.locator('#pi-toggle-inspector').click();
    };
    const closeInspector = async () => {
        if (await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-close-inspector').click();
    };
    await openInspector();
    await page.locator('#pi-compact-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-compaction-status').textContent.includes('手动压缩中'));
    assert.equal(await page.locator('#pi-compact-button').isDisabled(), true);
    assert.equal(await page.locator('#pi-model-select').isDisabled(), true);
    assert.equal(await page.locator('#pi-stop-button').isVisible(), false, 'RPC abort is not compaction cancellation');
    runtime.webCompaction = { ...runtime.webCompaction, status: 'retrying', attempt: 1, maxAttempts: 3, delayMs: 2000 };
    send({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 2000 });
    await page.waitForFunction(() => document.querySelector('#pi-compaction-status').textContent.includes('重试 1/3'));
    // Reconnection restores the same worker's retry state without a new compaction.
    const commandsBefore = commands.filter(command => command.type === 'compact').length;
    socket.close({ code: 1012, reason: 'Controlled reconnect' });
    await page.waitForTimeout(2300);
    assert.equal(await page.locator('#pi-compact-button').isDisabled(), true);
    assert.match(await page.locator('#pi-compaction-status').textContent(), /重试 1\/3/);
    assert.equal(commands.filter(command => command.type === 'compact').length, commandsBefore);
    pendingCompact = null;
    await finish();
    assert.equal(await page.locator('#pi-context-percent').textContent(), '--');
    assert.equal(await page.locator('#pi-context-tokens').textContent(), '-- / 128k');
    assert.match(await page.locator('#pi-compaction-status').textContent(), /压缩后约 4.5k/);
    assert.match(await page.locator('#pi-transcript-content').textContent(), /Retained fixture summary/);
    assert.equal(await page.locator('#pi-compact-button').isDisabled(), false);
    assert.match(await page.locator('#pi-connection-text').textContent(), /已连接/);
    await page.screenshot({ path: `/tmp/pi-compaction-${viewport.width}-success.png` });

    // Unknown usage remains unknown across refresh; a real zero is still displayed as zero.
    runtime.webCompaction = null;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pi-context-tokens').textContent === '-- / 128k');
    stats = statsFor(0);
    send({ type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelector('#pi-context-percent').textContent === '0%');
    stats = statsFor(8500);
    send({ type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelector('#pi-context-percent').textContent === '7%');
    await openInspector();
    await page.locator('#pi-compact-button').click();
    await finish({ aborted: true });
    assert.match(await page.locator('#pi-compaction-status').textContent(), /已取消/);
    assert.doesNotMatch(await page.locator('#pi-compaction-status').textContent(), /完成/);
    await page.locator('#pi-compact-button').click();
    await finish({ errorMessage: 'Compaction failed: Already compacted' });
    assert.match(await page.locator('#pi-compaction-status').textContent(), /暂无新增内容/);
    assert.equal(await page.locator('#pi-compaction-status').getAttribute('data-status'), 'unchanged');
    await page.locator('#pi-compact-button').click();
    await finish({ errorMessage: '<img src=x onerror=alert(1)> Controlled failure' });
    assert.match(await page.locator('#pi-compaction-status').textContent(), /失败/);
    assert.equal(await page.locator('#pi-compaction-status img').count(), 0);
    await page.screenshot({ path: `/tmp/pi-compaction-${viewport.width}-failure.png` });
    send({ type: 'agent_settled' });
    await page.waitForTimeout(100);
    assert.match(await page.locator('#pi-compaction-status').textContent(), /失败/);
    failToggle = true;
    await page.locator('#pi-runtime-settings > summary').click();
    await page.locator('#pi-auto-compact').click();
    await page.waitForFunction(() => document.querySelector('#pi-auto-compact').checked);
    failToggle = false;
    await page.locator('#pi-auto-compact').uncheck();
    await page.waitForFunction(() => !document.querySelector('#pi-auto-compact').disabled);
    assert.equal(runtime.autoCompactionEnabled, false);
    await page.locator('#pi-auto-compact').check();
    await closeInspector();
    await page.locator('#pi-input').fill('/compact Keep decisions');
    await page.locator('#pi-input').press('Enter');
    await page.waitForTimeout(100);
    assert.equal(pendingCompact.customInstructions, 'Keep decisions');
    await page.locator('#pi-input').fill('New unsent draft');
    await finish();
    assert.equal(await page.locator('#pi-input').inputValue(), 'New unsent draft');
    runtime.isStreaming = true;
    send({ type: 'agent_start' });
    await openInspector();
    assert.equal(await page.locator('#pi-compact-button').isDisabled(), true);
    start('threshold');
    await finish({ reason: 'threshold' });
    runtime.isStreaming = false;
    send({ type: 'agent_settled' });
    await page.waitForTimeout(150);
    assert.match(await page.locator('#pi-compaction-status').textContent(), /自动压缩完成/);

    // An old settled snapshot must not unlock controls after a new compaction starts.
    holdStats = true;
    send({ type: 'agent_settled' });
    await page.waitForTimeout(80);
    start('manual');
    holdStats = false;
    reply(delayedStats.ws, delayedStats.command, statsFor(120000));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pi-compact-button').isDisabled(), true);
    assert.match(await page.locator('#pi-compaction-status').textContent(), /手动压缩中/);
    await finish();
    // An old stats response must not overwrite the newly selected thread.
    holdStats = true;
    runtime.isStreaming = true;
    start('threshold');
    await finish({ reason: 'threshold' });
    const stale = delayedStats;
    holdStats = false;
    runtime.isStreaming = false;
    runtime.webCompaction = null;
    stats = statsFor(9000);
    await closeInspector();
    if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator(`[data-session-id="${second.id}"] .pi-session-main`).click();
    await page.waitForFunction(() => document.querySelector('#pi-context-tokens').textContent === '9.0k / 128k');
    reply(stale.ws, stale.command, statsFor(120000));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pi-context-tokens').textContent(), '9.0k / 128k');
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    for (const tab of ['media', 'chat']) await page.locator(`[data-tab="${tab}"]`).click();
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(`PASS ${viewport.width}x${viewport.height}: unknown/zero usage, summary, retry/reconnect, error/cancel, native slash command, controls, stale snapshots; no writes/errors/overflow`);
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }]) await run(browser, viewport);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
