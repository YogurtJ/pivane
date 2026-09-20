const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SIDE_TEST_URL || 'http://127.0.0.1:3126';
async function run(browser, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], answers = [], prompts = [];
    const cwd = '/fixture/side-tools', model = { provider: 'fixture', id: 'fixture', name: 'Fixture', contextWindow: 32000 }, session = { id: 'main', cwd, name: 'Main', messageCount: 0 };
    let side, pending = [], access = 'read', busy = false;
    const send = event => side.send(JSON.stringify(event));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'main'); }, cwd);
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        assert.equal(route.request().method(), 'GET');
        return route.fulfill({ json: pathname.endsWith('/status') ? { ok: true, sideChat: true, sideChatContext: true, sideChatTools: true, projectRoots: ['/fixture'] }
            : pathname.endsWith('/projects') ? { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] }
            : pathname.endsWith('/sessions') ? { sessions: [session] }
            : pathname.endsWith('/activity') ? { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } : { configured: false } });
    });
    const reference = { mode: 'context', toolMode: 'assist', capturedAt: new Date().toISOString(), messageCount: 0, preview: [], source: { cwd, sessionId: 'main' } };
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw); let data = {};
        if (cmd.type === 'open_session') data = { session, state: { model, isStreaming: false }, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (cmd.type === 'prepare_side_chat') { assert.equal(cmd.toolMode, 'assist'); data = { ticket: 'fixture-ticket', reference, limits: { messageCharacters: 8000 } }; }
        else if (cmd.type === 'open_side_chat') { side = ws; data = { state: { model, toolMode: 'assist', toolAccess: access, pendingUi: [] }, reference, messages: [], stats: {}, limits: { messageCharacters: 8000 } }; }
        else if (cmd.type === 'answer_side_confirmation') {
            assert.equal(cmd.requestId, pending[0].id); answers.push(cmd.confirmed); pending = []; access = cmd.confirmed ? 'write' : 'read';
            send({ type: 'gateway_ui_resolved', id: cmd.requestId }); send({ type: 'gateway_side_tool_access', access });
        } else if (cmd.type === 'get_state') data = { model, toolMode: 'assist', toolAccess: access, pendingUi: pending, isStreaming: busy };
        else if (cmd.type === 'get_messages') data = { messages: [] };
        else if (cmd.type === 'prompt') prompts.push(cmd);
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await page.locator('#pi-toggle-side-chat').click();
    await page.waitForFunction(() => !document.querySelector('#pi-side-input').disabled);
    const english = language.startsWith('en');
    assert.equal(await page.locator('#pi-side-tool-mode').textContent(), english ? 'Can read' : '可读取');
    for (const [index, allowed] of [true, false].entries()) {
        pending = [{ type: 'extension_ui_request', id: `confirmation-${index}`, method: 'confirm', title: '允许侧聊本次回复修改文件和运行命令？', message: JSON.stringify({ tool: 'bash', arguments: { command: 'long-command-'.repeat(90) + '<script>window.xssSide=true</script>' } }) }];
        busy = true; send({ type: 'agent_start' }); send(pending[0]);
        await page.locator('#pi-side-confirm:not([hidden])').waitFor();
        assert.equal(await page.locator('#pi-side-confirm strong').textContent(), english ? 'Allow changes and commands for this side reply?' : pending[0].title);
        for (const selector of ['body', '#pi-side-chat', '#pi-side-confirm', '#pi-side-confirm pre']) assert.ok(await page.locator(selector).evaluate(node => node.scrollWidth <= node.clientWidth + 1), selector);
        assert.equal(await page.evaluate(() => window.xssSide), undefined);
        await page.locator('#pi-side-confirm button').nth(allowed ? 1 : 0).click();
        await page.waitForFunction(() => document.querySelector('#pi-side-confirm').hidden);
        assert.equal(await page.locator('#pi-side-tool-mode').textContent(), allowed ? english ? 'Changes allowed' : '本次可修改' : english ? 'Can read' : '可读取');
        busy = false; access = 'read'; send({ type: 'agent_settled' });
        await page.waitForFunction(label => document.querySelector('#pi-side-tool-mode').textContent === label, english ? 'Can read' : '可读取');
    }
    assert.deepEqual(answers, [true, false]); assert.deepEqual(prompts, []); assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS side tools ${width} ${language}: scoped approval, grant reset, safe long arguments and no unsolicited prompts`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const language of ['zh-CN', 'en-US']) for (const width of [1440, 393, 320]) await run(browser, width, language); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
