const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/task-project';
const source = { id: 'source', cwd, name: 'Source A' }, child = { id: 'child', cwd, name: 'Task B' };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
const text = 'Task <img src=x onerror=alert(1)> ' + 'long-task-name-'.repeat(25);
async function check(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [], opened = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'source');
        localStorage.setItem('pi.workspace.language', language);
    }, { cwd, language });
    const receipt = { role: 'custom', customType: 'pi5-agent-task-receipt', display: true, content: text,
        details: { session: child, model: { provider: 'fixture', modelId: 'long-model-'.repeat(30) }, thinkingLevel: 'off', status: 'submitted' } };
    const task = { role: 'custom', customType: 'pi5-agent-task-message', display: true, content: text, details: { source: { cwd, sessionId: source.id } } };
    const histories = { source: [{ role: 'user', content: 'Create task B' }, receipt], child: [task, { role: 'assistant', content: 'Task complete.', stopReason: 'stop' }] };
    let active = source;
    await page.route('**/api/**', route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') writes.push(url.pathname);
        const send = data => route.fulfill({ json: data });
        if (url.pathname === '/api/pi/status') return send({ ok: true, agentThreads: true, projectRoots: ['/synthetic'] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions: [source, child] });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw);
        const reply = data => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        const runtime = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
        if (command.type === 'open_session') {
            active = command.sessionId === child.id ? child : source; opened.push(active.id);
            return reply({ session: active, state: runtime, messages: { messages: histories[active.id] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        }
        if (command.type === 'get_messages') return reply({ messages: histories[active.id] });
        if (command.type === 'get_state') return reply(runtime);
        if (command.type === 'get_session_stats') return reply({});
        throw new Error(`Unexpected RPC ${command.type}`);
    }));
    await page.goto(base);
    const card = page.locator('.pi-agent-thread-message');
    await card.waitFor();
    assert.equal(await card.locator('img').count(), 0);
    assert.ok((await card.textContent()).includes('<img src=x'));
    const layout = async () => {
        const bad = await page.evaluate(() => [...document.querySelectorAll('.pi-agent-thread-message, .pi-agent-thread-message header, .pi-agent-thread-meta, .pi-agent-thread-link, .pi-agent-thread-message .pi-message-body')]
            .filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1 || node.scrollWidth > node.clientWidth + 2); }).map(node => node.className));
        assert.deepEqual(bad, []);
    };
    await layout();
    assert.equal(await card.locator('strong').textContent(), language === 'en' ? 'Agent task thread' : 'Agent 任务线程');
    await card.locator('button').click();
    await page.waitForFunction(() => document.querySelector('.pi-agent-thread-message strong')?.textContent === (document.documentElement.lang === 'en' ? 'Task from an Agent' : '来自 Agent 的任务'));
    assert.equal(opened.at(-1), 'child');
    await layout();
    await page.screenshot({ path: `/tmp/pi-agent-threads-${width}-${language}.png` });
    await page.locator('.pi-agent-thread-link').click();
    await page.waitForFunction(() => document.querySelector('.pi-agent-thread-message strong')?.textContent === (document.documentElement.lang === 'en' ? 'Agent task thread' : 'Agent 任务线程'));
    assert.equal(opened.at(-1), 'source');
    receipt.details.status = 'constructor';
    receipt.details.model.provider = { toString: 'malformed imported metadata' };
    await page.reload();
    await page.locator('.pi-agent-thread-message').waitFor();
    assert.ok((await page.locator('.pi-agent-thread-meta').textContent()).includes(language === 'en' ? 'Startup needs verification' : '启动状态待核实'));
    await layout();
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
        console.log('Agent thread cards: six desktop/mobile/language checks passed');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
