const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/tmp/tool-label-fixture', session = { id: 'labels', cwd, name: 'Execution records', messageCount: 12 };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
const calls = [
    { id: 'skill', name: 'read', arguments: { path: '/skills/slides/SKILL.md' } },
    { id: 'old', name: 'read', arguments: { path: 'C:\\skills\\legacy\\SKILL.md' } },
    { id: 'package', name: 'render_slides', arguments: {} },
    { id: 'inventory', name: 'extensions_inventory', arguments: {} },
    { id: 'cancel', name: 'extensions_package', arguments: { action: 'install', source: 'npm:fixture' } },
    { id: 'unknown', name: 'unknown_tool', arguments: {} }
];
const result = (id, name, details = {}, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: name, details, isError, content: [{ type: 'text', text: 'Synthetic tool output' }] });
const provenance = (id, name, extra, legacy = false) => ({ [legacy ? 'pi5ToolProvenance' : 'pivaneToolProvenance']: { version: 1, toolCallId: id, toolName: name, ...extra } });
const messages = [
    { role: 'user', content: 'Explain the execution records', timestamp: 1 },
    { role: 'assistant', content: calls.map(c => ({ type: 'toolCall', ...c })), timestamp: 2 },
    result('skill', 'read', provenance('skill', 'read', { skill: { name: 'slides', path: '/skills/slides/SKILL.md' } })),
    result('old', 'read', {}, true),
    result('package', 'render_slides', provenance('package', 'render_slides', { source: { origin: 'package', source: 'npm:slide-kit-with-a-long-package-name', path: '/packages/slide-kit/index.ts' } }, true)),
    result('inventory', 'extensions_inventory'),
    result('cancel', 'extensions_package', { pivanePackageOperation: { status: 'cancelled' } }),
    result('unknown', 'unknown_tool', provenance('wrong-id', 'unknown_tool', { source: { source: 'false-owner', path: '/x' } }))
];
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ locale, viewport: { width, height: 900 } }), page = await context.newPage();
    const errors = []; let socket;
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd, width }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'labels'); localStorage.setItem('pi.workspace.theme', width === 320 ? 'dark' : 'light'); }, { cwd, width });
    await page.route('**/api/**', route => {
        const p = new URL(route.request().url()).pathname;
        let data = {};
        if (p === '/api/pi/status') data = { ok: true, projectRoots: ['/tmp'] };
        if (p === '/api/pi/projects') data = { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }], roots: ['/tmp'] };
        if (p === '/api/pi/sessions') data = { sessions: [session] };
        if (p === '/api/pi/activity') data = { runtimes: [], replyNotices: [] };
        if (p.includes('history') || p === '/api/prompts') data = [];
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => { socket = ws; ws.onMessage(raw => {
        const cmd = JSON.parse(raw); let data = {};
        if (cmd.type === 'open_session') data = { session, state: { model, isStreaming: false }, messages: { messages }, models: { models: [model] }, commands: { commands: [] }, stats: {}, thinkingLevels: { levels: ['off'] } };
        if (cmd.type === 'get_messages') data = { messages };
        if (cmd.type === 'get_state') data = { model, isStreaming: false };
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    await selectMessageView(page, 'full');
    const row = id => page.locator(`.pi-tool-row[data-tool-id="${id}"]`);
    assert.match(await row('skill').locator('summary > strong').textContent(), locale === 'en' ? /Read skill · slides/ : /读取技能 · slides/);
    assert.match(await row('old').locator('summary > strong').textContent(), /legacy/);
    assert.equal(await row('old').getAttribute('data-state'), 'error');
    assert.match(await row('package').locator('.pi-tool-source').textContent(), /slide-kit/);
    assert.equal(await row('unknown').locator('.pi-tool-source').count(), 0);
    assert.equal(await row('cancel').getAttribute('data-state'), 'cancelled');
    await row('skill').locator('summary').click();
    assert.match(await row('skill').locator('.pi-tool-provenance').textContent(), /SKILL.md/);
    const send = event => socket.send(JSON.stringify(event));
    send({ type: 'tool_execution_start', toolCallId: 'live', toolName: 'extensions_package', args: { action: 'remove', source: 'npm:fixture' } });
    await row('live').waitFor();
    assert.match(await row('live').locator('summary > strong').textContent(), locale === 'en' ? /Remove package/ : /移除扩展包/);
    const live = result('live', 'extensions_package', provenance('live', 'extensions_package', { source: { origin: 'package', source: '<img src=x onerror=alert(1)>', path: '/fixture/index.ts' } }), true);
    send({ type: 'tool_execution_end', toolCallId: 'live', toolName: 'extensions_package', isError: true, result: live });
    send({ type: 'message_end', message: live });
    await row('live').locator('.pi-tool-source').waitFor();
    assert.equal(await row('live').count(), 1);
    assert.equal(await row('live').getAttribute('data-state'), 'error');
    assert.equal(await row('live').locator('img').count(), 0);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.pi-tool-row, .pi-tool-row > summary')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.className));
    assert.deepEqual(overflow, []);
    await page.screenshot({ path: `/tmp/pivane-tool-labels-${locale}-${width}.png` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-tool-id="skill"] .pi-tool-provenance'));
    assert.equal(await row('package').locator('.pi-tool-source').count(), 1);
    assert.deepEqual(errors, []); await context.close(); console.log(`PASS tool labels ${width} ${locale}`);
}
(async () => {
    const app = require('express')(); app.use(require('express').static(path.resolve(__dirname, '../../public'))); app.use('/vendor', require('express').static(path.resolve(__dirname, '../../node_modules')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, locale] of [[1440, 'zh-CN'], [393, 'zh-CN'], [320, 'en']]) await run(browser, process.env.PI_TOOL_LABELS_TEST_URL || `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
