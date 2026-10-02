const assert = require('node:assert/strict');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SIDE_TEST_URL || 'http://127.0.0.1:3126';
async function run(browser, width, language, height = 900) {
    const context = await browser.newContext({ viewport: { width, height }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], answers = [], prompts = [];
    const cwd = '/fixture/side-tools', model = { provider: 'fixture', id: 'fixture', name: 'Fixture', contextWindow: 32000 }, session = { id: 'main', cwd, name: 'Main', messageCount: 0 };
    let side, pending = [], access = 'read', busy = false, holdDecision = false, releaseDecision;
    const send = event => side.send(JSON.stringify(event));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, theme }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'main'); localStorage.setItem('pi.workspace.theme', theme); }, { cwd, theme: width === 320 || height < 500 ? 'dark' : 'daylight' });
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        assert.equal(route.request().method(), 'GET');
        return route.fulfill({ json: pathname.endsWith('/status') ? { ok: true, sideChat: true, sideChatContext: true, sideChatTools: true, sideChatModels: true, projectRoots: ['/fixture'] }
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
        else if (cmd.type === 'get_side_models') data = { models: [model, { ...model, id: 'alternate', name: 'Alternate model' }], levels: ['off'] };
        else if (cmd.type === 'set_side_model') { assert.equal(busy, false); model.id = cmd.modelId; data = { state: { model, thinkingLevel: 'off' }, levels: ['off'], limits: { messageCharacters: 8000 } }; }
        else if (cmd.type === 'answer_side_confirmation') {
            const complete = () => {
                assert.equal(cmd.requestId, pending[0].id); answers.push(cmd.confirmed); pending = []; access = cmd.confirmed ? 'write' : 'read';
                send({ type: 'gateway_ui_resolved', id: cmd.requestId }); send({ type: 'gateway_side_tool_access', access });
                ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: { accepted: true } }));
            };
            if (holdDecision) releaseDecision = complete;
            else complete();
            return;
        } else if (cmd.type === 'get_state') data = { model, toolMode: 'assist', toolAccess: access, pendingUi: pending, isStreaming: busy };
        else if (cmd.type === 'get_messages') data = { messages: [] };
        else if (cmd.type === 'prompt') prompts.push(cmd);
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await openInspector(page, 'side');
    await page.waitForFunction(() => !document.querySelector('#pi-side-input').disabled);
    await page.locator('#pi-side-reference > summary').click();
    await page.waitForFunction(() => !document.querySelector('#pi-side-model-select').disabled);
    await page.locator('#pi-side-input').fill('Keep my draft');
    await page.locator('#pi-side-model-select').click();
    await page.locator('dialog.pi-model-dialog[open] .pi-model-all').click();
    await page.locator('dialog.pi-model-dialog[open] .pi-model-option').filter({ hasText: 'Alternate model' }).click();
    await page.waitForFunction(() => !document.querySelector('#pi-side-model-select').disabled);
    assert.equal(model.id, 'alternate');
    assert.equal(await page.locator('#pi-side-input').inputValue(), 'Keep my draft');
    assert.ok(await page.locator('#pi-side-model-controls').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({ path: `/tmp/pivane-side-model-${width}-${language}.png` });
    const english = language.startsWith('en');
    await page.locator('#pi-side-reference > summary').click();
    assert.equal(await page.locator('#pi-side-tool-mode').textContent(), english ? 'Can read' : '可读取');
    for (const [index, allowed] of [true, false].entries()) {
        const command = 'curl --max-time 30 https://example.invalid/tree -o /tmp/fixture.json\n' + 'long-command-'.repeat(90) + '<script>window.xssSide=true</script>';
        const message = JSON.stringify({ tool: 'bash', arguments: { command, timeout: 40 }, cwd }, null, 2);
        pending = [{ type: 'extension_ui_request', id: `confirmation-${index}`, method: 'confirm', title: '允许侧聊本次回复修改文件和运行命令？', message }];
        busy = true; send({ type: 'agent_start' }); send(pending[0]);
        await page.locator('#pi-side-confirm:not([hidden])').waitFor();
        assert.equal(await page.locator('#pi-side-model-select').isDisabled(), true);
        assert.equal(await page.locator('#pi-side-confirm strong').textContent(), english ? 'Allow side-chat actions?' : '允许侧聊执行操作？');
        assert.equal(await page.locator('.pi-side-confirm-badge').textContent(), english ? 'This reply only' : '仅本次回复');
        assert.equal(await page.locator('.pi-side-confirm-tool').textContent(), 'bash');
        assert.equal(await page.locator('.pi-side-confirm-location code').textContent(), cwd);
        assert.equal(await page.locator('.pi-side-confirm-preview pre').textContent(), command, 'decoded command has original line breaks and no truncation');
        assert.equal(await page.locator('.pi-side-confirm-details').evaluate(node => node.open), false);
        await page.screenshot({ path: `/tmp/pi-side-confirm-${width}-${height}-${language}-command.png` });
        await page.locator('.pi-side-confirm-details > summary').click();
        assert.equal(await page.locator('.pi-side-confirm-details pre').textContent(), message, 'full raw input remains available');
        for (const selector of ['body', '#pi-side-chat', '#pi-side-confirm', '#pi-side-confirm pre']) {
            assert.ok(await page.locator(selector).evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), selector);
        }
        assert.equal(await page.evaluate(() => window.xssSide), undefined);
        const hit = await page.locator('.pi-side-confirm-actions').evaluate(node => [...node.children].every(button => {
            const r = button.getBoundingClientRect(), p = node.closest('.pi-side-confirm').getBoundingClientRect();
            return r.top >= p.top && r.bottom <= p.bottom + 1 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === button;
        }));
        assert.equal(hit, true, 'actions stay visible and clickable even with long parameters');
        holdDecision = index === 0;
        await page.locator(`[data-side-confirmed="${allowed}"]`).click();
        if (holdDecision) {
            await page.waitForFunction(() => document.querySelector('#pi-side-confirm').getAttribute('aria-busy') === 'true');
            assert.ok(await page.locator('.pi-side-confirm-actions button').evaluateAll(nodes => nodes.every(node => node.disabled)));
            send(pending[0]);
            await page.waitForTimeout(30);
            assert.ok(await page.locator('.pi-side-confirm-actions button').evaluateAll(nodes => nodes.every(node => node.disabled)), 'late snapshot keeps in-flight decision locked');
            assert.equal(await page.locator('.pi-side-confirm-details').evaluate(node => node.open), true, 'same-request state refresh preserves parameter disclosure');
            holdDecision = false; releaseDecision();
        }
        await page.waitForFunction(() => document.querySelector('#pi-side-confirm').hidden);
        assert.equal(await page.locator('#pi-side-tool-mode').textContent(), allowed ? english ? 'Changes allowed' : '本次可修改' : english ? 'Can read' : '可读取');
        busy = false; access = 'read'; send({ type: 'agent_settled' });
        await page.waitForFunction(label => document.querySelector('#pi-side-tool-mode').textContent === label, english ? 'Can read' : '可读取');
    }
    for (const [index, data] of [
        { tool: 'edit', arguments: { path: '/fixture/file.js', oldText: 'old\nline', newText: 'new\n<script>window.xssSide=true</script>' }, cwd },
        { tool: 'write', arguments: { path: '/fixture/new.md', content: '# New file\n\n' + 'content '.repeat(100) }, cwd },
        null
    ].entries()) {
        const message = data ? JSON.stringify(data, null, 2) : 'Legacy unstructured operation <script>window.xssSide=true</script>';
        pending = [{ type: 'extension_ui_request', id: `preview-${index}`, method: 'confirm', title: '允许侧聊本次回复修改文件和运行命令？', message }];
        busy = true; send({ type: 'agent_start' }); send(pending[0]);
        await page.locator('#pi-side-confirm:not([hidden])').waitFor();
        if (data) {
            assert.equal(await page.locator('.pi-side-confirm-tool').textContent(), data.tool);
            await page.locator('.pi-side-confirm-details > summary').click();
            assert.equal(await page.locator('.pi-side-confirm-details pre').textContent(), message);
        } else assert.equal(await page.locator('.pi-side-confirm-preview pre').textContent(), message, 'unknown shapes retain safe full text');
        assert.equal(await page.evaluate(() => window.xssSide), undefined);
        await page.screenshot({ path: `/tmp/pi-side-confirm-${width}-${height}-${language}-${data?.tool || 'fallback'}.png` });
        await page.locator('[data-side-confirmed="false"]').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-confirm').hidden);
        busy = false; send({ type: 'agent_settled' });
    }
    assert.deepEqual(answers, [true, false, false, false, false]); assert.deepEqual(prompts, []); assert.deepEqual(errors, []);
    await context.close(); console.log(`PASS side tools ${width} ${language}: scoped approval, grant reset, safe long arguments and no unsolicited prompts`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const language of ['zh-CN', 'en-US']) {
            for (const width of [1440, 393, 320]) if (!process.env.PI_SIDE_APPROVAL_VIEWPORT || process.env.PI_SIDE_APPROVAL_VIEWPORT === String(width)) await run(browser, width, language);
            if (!process.env.PI_SIDE_APPROVAL_VIEWPORT || process.env.PI_SIDE_APPROVAL_VIEWPORT === '852') await run(browser, 852, language, 430);
        }
    }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
