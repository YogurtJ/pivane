const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_SUMMARY_TEST_URL || 'http://127.0.0.1:3001';
const baseline = process.env.PI_SUMMARY_BASELINE === '1';
const cwd = '/srv/summary-width-fixture';
const session = { id: 'summary-width', cwd, name: 'Summary wrapping', messageCount: 4 };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
const summary = ['上下文摘要：保留路径和原始换行。', '<read-files>',
    '/srv/example/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md',
    '/srv/example/pi-packages/media-workbench/skills/media-workbench/SKILL.md',
    ...Array.from({ length: 8 }, (_, i) => `/srv/example/very_long_directory_${'segment_'.repeat(12)}/source-${i}.js`),
    '</read-files>', '', `https://example.invalid/artifacts/${'longUnbrokenIdentifier'.repeat(35)}`, '<modified-files>', '/srv/example/public/workspace.css', '</modified-files>'].join('\n');
const code = `const id = "${'unbroken_code_'.repeat(70)}";`;
async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage(); const errors = [], writes = [];
    let socket, currentSummary = summary;
    const messages = () => [
        { role: 'compactionSummary', summary: currentSummary, timestamp: 1 },
        { role: 'branchSummary', summary: currentSummary, timestamp: 2 },
        { role: 'user', content: '摘要以外的正常消息', timestamp: 3 },
        { role: 'assistant', content: [{ type: 'text', text: `普通正文应保持屏幕宽度。\n\n\`\`\`js\n${code}\n\`\`\`` }], timestamp: 4 }
    ];
    const runtime = { model, isStreaming: false, isCompacting: false, thinkingLevel: 'off' };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem(`pi.web.session:${cwd}`, id);
    }, { cwd, id: session.id });
    await page.route('**/api/**', route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        if (req.method() !== 'GET') { writes.push(path); return route.fulfill({ json: { ok: true } }); }
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Summary fixture', sessionCount: 1 }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session] } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            let data;
            if (command.type === 'open_session') data = { session, state: runtime, messages: { messages: messages() }, stats: {},
                models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            else if (command.type === 'get_messages') data = { messages: messages() };
            else if (command.type === 'get_state') data = runtime;
            else if (command.type === 'get_session_stats') data = {};
            else throw new Error(`Unexpected command ${command.type}`);
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const check = async stage => {
        await page.waitForFunction(text => document.querySelector('.compactionSummary p')?.textContent === text, currentSummary);
        const metrics = await page.evaluate(() => {
            const selectors = ['body', '#pi-transcript', '#pi-transcript-content', '.compactionSummary', '.compactionSummary > div', '.compactionSummary p', '.branchSummary p'];
            return Object.fromEntries(selectors.map(selector => {
                const el = document.querySelector(selector);
                return [selector, { client: el.clientWidth, scroll: el.scrollWidth, overflow: el.scrollWidth - el.clientWidth }];
            }));
        });
        assert.equal(await page.locator('.compactionSummary p').textContent(), currentSummary);
        if (!baseline) {
            for (const [selector, metric] of Object.entries(metrics)) assert.ok(metric.overflow <= 1, `${viewport.width} ${stage} ${selector}: ${JSON.stringify(metric)}`);
            const horizontal = await page.locator('#pi-transcript').evaluate(el => { el.scrollTop = el.scrollHeight; el.scrollLeft = 200; return el.scrollLeft; });
            assert.equal(horizontal, 0, 'ordinary messages must not inherit empty horizontal scroll space');
            const pre = page.locator('.pi-markdown pre');
            assert.ok(await pre.evaluate(el => { el.scrollLeft = 100; return el.scrollLeft; }) > 0, 'wide code must remain locally scrollable');
            assert.equal(await pre.locator('code').textContent(), `${code}\n`);
        }
        return { stage, metrics };
    };
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const checks = [await check('initial')];
    for (const mode of ['full', 'reading']) {
        await selectMessageView(page, mode);
        checks.push(await check(mode));
    }
    currentSummary += '\n压缩后重新加载的摘要：' + 'continuousPathSegment'.repeat(40);
    socket.send(JSON.stringify({ type: 'compaction_end', reason: 'manual', result: { summary: currentSummary, tokensBefore: 10000 } }));
    checks.push(await check('after-compaction'));
    socket.close({ code: 1012, reason: 'Fixture reconnect' });
    await page.waitForTimeout(2400);
    checks.push(await check('reconnect'));
    await page.locator('#pi-transcript').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
    await page.screenshot({ path: `/tmp/pi-summary-width-${baseline ? 'before' : 'after'}-${viewport.width}.png` });
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ viewport, baseline, checks, errors, writes }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const viewport of [{ width: 393, height: 852 }, { width: 412, height: 915 }, { width: 1440, height: 1000 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
