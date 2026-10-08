const assert = require('node:assert/strict'), http = require('node:http'), path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/synthetic/request-stats';
const model = { provider: 'fixture', id: 'fixture', input: ['text', 'image'] };
const stats = { version: 1, outputTokens: 400, requestMs: 4000, requests: 2, excludedRequests: 0 };
const reply = (timestamp, data = stats) => ({ role: 'assistant', timestamp, model: 'fixture', stopReason: 'stop', content: [{ type: 'text', text: 'Synthetic answer' }], ...(data ? { pivaneRequestStats: data } : {}) });
async function run(browser, base, width, language) {
    const context = await browser.newContext({ locale: language, viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], calls = [];
    let messages = [{ role: 'user', timestamp: 1, content: 'Old question' }, reply(2, null),
        { role: 'user', timestamp: 3, content: [{ type: 'text', text: 'New question' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=' }] },
        { role: 'assistant', timestamp: 4, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'fixture.txt' } }] },
        { role: 'toolResult', timestamp: 5, toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'Synthetic tool output' }] }, reply(6)];
    let socket, running = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'one');
        localStorage.setItem('pi.workspace.language', language);
    }, { cwd, language });
    await page.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET') calls.push(endpoint);
        let data = {};
        if (endpoint === '/api/pi/status') data = { projectRoots: ['/synthetic'] };
        else if (endpoint === '/api/pi/projects') data = { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
        else if (endpoint === '/api/pi/sessions') data = { sessions: [{ cwd, id: 'one', name: 'Fixture' }] };
        else if (endpoint === '/api/pi/activity') data = { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] };
        else if (endpoint.includes('history') || endpoint === '/api/prompts') data = [];
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw), state = { model, isStreaming: running, thinkingLevel: 'off' };
            calls.push(command.type);
            let data = {};
            if (command.type === 'open_session') data = { session: { cwd, id: 'one', name: 'Fixture' }, state, messages: { messages }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            else if (command.type === 'get_state') data = state;
            else if (command.type === 'get_messages') data = { messages };
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    const settings = async () => { await page.locator('#workspace-settings-toggle').click(); await page.locator('[data-settings-tab="models"]').click(); };
    const back = async () => { await page.locator('#workspace-settings-close').click(); };
    const emit = event => socket.send(JSON.stringify(event));
    try {
        await page.goto(base); await page.locator('.pi-request-stats').waitFor({ state: 'attached' });
        assert.equal(await page.locator('.pi-request-stats').isVisible(), false);
        assert.equal(await page.locator('.pi-request-stats').count(), 1, 'legacy replies have no fabricated stats');
        await settings(); await page.locator('#pi-show-request-stats').check();
        assert.equal(await page.locator('#pi-show-request-stats').isChecked(), true);
        assert.match(await page.locator('#pi-request-stats-label').textContent(), language === 'en' ? /average/ : /平均/);
        await back();
        await page.locator('.pi-request-stats').waitFor();
        assert.match(await page.locator('.pi-request-stats').textContent(), /100 tok\/s/);
        assert.match(await page.locator('.pi-request-stats').getAttribute('title'), language === 'en' ? /2 valid requests/ : /2 次有效请求/);
        await page.locator('#pi-input').fill('Keep this draft');
        await page.reload(); await page.locator('.pi-request-stats').waitFor();
        // Live messages and message_end are not a final settlement.
        running = true; emit({ type: 'agent_start' });
        const user = { role: 'user', timestamp: 10, content: 'Streaming question' };
        emit({ type: 'message_end', message: user });
        emit({ type: 'message_start', message: { role: 'assistant', timestamp: 11, content: [] } });
        for (let i = 0; i < 100; i++) emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });
        const final = reply(11, { ...stats, excludedRequests: 1 });
        emit({ type: 'message_end', message: final });
        await page.waitForFunction(() => !document.querySelector('.pi-message.streaming'));
        assert.equal(await page.locator('.pi-request-stats').count(), 1, 'no live-stat allocations');
        messages.push(user, { role: 'compactionSummary', summary: 'Synthetic compressed history', timestamp: 10.5 }, final);
        running = false; emit({ type: 'agent_settled' });
        await page.waitForFunction(() => document.querySelectorAll('.pi-request-stats').length === 2);
        assert.match(await page.locator('.pi-request-stats').last().textContent(), language === 'en' ? /partial/ : /部分/);
        assert.match(await page.locator('.pi-request-stats').last().getAttribute('title'), language === 'en' ? /Excluded 1/ : /排除 1/);
        assert.equal(await page.locator('.pi-tool-row').count(), 1);
        const widths = await page.locator('.pi-message-actions').evaluateAll(nodes => nodes.map(node => ({ width: node.clientWidth, scroll: node.scrollWidth, right: node.getBoundingClientRect().right })));
        for (const item of widths) assert.ok(item.scroll <= item.width + 1 && item.right <= width + 1, JSON.stringify(item));
        if (width < 900) {
            await page.locator('#pi-mobile-context-trigger').click();
            assert.equal(await page.locator('#pi-mobile-session-dialog').isVisible(), true);
            await page.locator('#pi-mobile-session-dialog .pi-mobile-sheet-head button').click();
        }
        assert.equal(await page.locator('.pi-message-image').count(), 1, 'reply preference preserves attachments');
        await page.locator('.pi-request-stats').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/pivane-request-stats-${width}-${language}.png` });
        await settings(); await page.locator('#pi-show-request-stats').uncheck(); await back();
        assert.equal(await page.locator('.pi-request-stats:visible').count(), 0);
        await page.reload(); await page.locator('.pi-request-stats').first().waitFor({ state: 'attached' });
        assert.equal(await page.locator('.pi-request-stats:visible').count(), 0);
        assert.ok(!calls.includes('prompt'), 'preference and stats never request a model');
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        console.log(JSON.stringify({ width, language, status: 'passed', scenarios: ['default-hidden', 'toggle', 'reload', 'legacy', 'streaming', 'settlement', 'compaction', 'partial', 'tools', 'mobile-sheet', 'width'] }));
    } finally { await context.close(); }
}
(async () => {
    const app = express();
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, language] of [[1440, 'zh-CN'], [393, 'zh-CN'], [320, 'en']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
