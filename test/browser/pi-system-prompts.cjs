const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/fixture/prompt-project', session = { id: 'prompt-fixture', cwd, name: 'Prompt fixture', messageCount: 2 };
const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000, available: true };
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], writes = [], calls = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'prompt-fixture'); }, cwd);
    let revision = 1, conflict = false, failNextRead = false, failAfterSave = false, pendingRead, slow = false, trusted = true;
    const content = { global: { append: 'GLOBAL_INSTRUCTIONS', base: null }, project: { append: null, base: null } };
    const snapshot = () => ({ cwd, revision: String(revision), maxBytes: 65536, trust: { effective: trusted }, files: Object.fromEntries(['global', 'project'].map(scope => [scope, Object.fromEntries(['append', 'base'].map(kind => [kind, { content: content[scope][kind], path: '/fixture/' + scope + '/' + (kind === 'base' ? 'SYSTEM.md' : 'APPEND_SYSTEM.md') }]))])) });
    await page.route('**/api/**', async route => {
        const req = route.request(), p = new URL(req.url()).pathname;
        if (p === '/api/pi/settings/system-prompts') {
            if (req.method() === 'PUT') {
                const input = req.postDataJSON(); writes.push(input);
                if (conflict) return route.fulfill({ status: 409, json: { error: '提示词或配置已变化，请刷新核对；草稿已保留' } });
                content[input.scope][input.kind] = input.content; revision++;
                if (failAfterSave) { failNextRead = true; failAfterSave = false; }
                return route.fulfill({ json: { ok: true, requiresReload: true } });
            }
            if (failNextRead) { failNextRead = false; return route.fulfill({ status: 503, json: { error: 'Controlled read failure' } }); }
            const result = snapshot();
            if (slow) await new Promise(resolve => { pendingRead = resolve; });
            return route.fulfill({ json: result });
        }
        let data = {};
        if (p === '/api/pi/status') data = { ok: true, nativeSettings: true, nativeResources: true, systemPrompts: true, composerTools: true, defaultProject: cwd, projectRoots: ['/fixture'] };
        else if (p === '/api/pi/projects') data = { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
        else if (p === '/api/pi/sessions') data = { sessions: [session] };
        else if (p === '/api/pi/activity') data = { runtimes: [], replyNotices: [] };
        else if (p === '/api/pi/settings/models') data = { models: [model], providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }], preferences: {}, customProviders: [] };
        else if (p.endsWith('/history') || p === '/api/prompts') data = [];
        return route.fulfill({ json: data });
    });
    let runtimeAppend = 'GLOBAL_INSTRUCTIONS', busy = false, delayedRuntime, delayRuntime = false, socket;
    await page.routeWebSocket('**/api/pi/ws', ws => { socket = ws; ws.onMessage(async raw => {
        const cmd = JSON.parse(raw); calls.push(cmd.type);
        const state = { model, isStreaming: busy, thinkingLevel: 'off' };
        let data = {};
        if (cmd.type === 'open_session') data = { session, state, messages: { messages: [{ role: 'user', content: 'Fixture question' }, { role: 'assistant', content: [{ type: 'text', text: 'Fixture response' }], stopReason: 'stop' }] }, models: { models: [model] }, stats: {}, commands: { commands: [] }, thinkingLevels: { levels: ['off'] } };
        if (cmd.type === 'get_state') data = state;
        if (cmd.type === 'get_available_models') data = { models: [model] };
        if (cmd.type === 'get_native_resources') data = { contextFiles: [], skills: [], commands: [], tools: [], systemPrompt: {}, projectTrusted: true };
        if (cmd.type === 'reload_resources') { runtimeAppend = content.project.append ?? content.global.append ?? ''; data = { commands: [] }; }
        if (cmd.type === 'get_system_prompt') {
            data = { cwd, sessionId: session.id, runtimeId: 'synthetic-runtime', capturedAt: '2026-09-12T00:00:00Z', projectTrusted: true, customPrompt: null, appendSystemPrompt: runtimeAppend,
                body: 'SYNTHETIC_BASE\n' + runtimeAppend + '\n' + 'long_context_'.repeat(300) + '\n<script>window.promptXss=true</script>',
                contextFiles: [{ path: cwd + '/AGENTS.md', content: 'Loaded instructions <script>window.promptXss=true</script>' }], skills: [{ name: 'fixture', path: '/fixture/skills/fixture/SKILL.md' }], activeTools: ['read', 'bash'],
                matchesSavedFiles: runtimeAppend === (content.project.append ?? content.global.append ?? ''),
                configured: { append: { scope: content.project.append === null ? 'global' : 'project', path: '/fixture/APPEND_SYSTEM.md', matchesLoaded: true }, base: { scope: 'default', path: null, matchesLoaded: true } } };
            if (delayRuntime) await new Promise(r => { delayedRuntime = r; });
        }
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await page.locator('#pi-input').fill('CHAT_DRAFT');
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    await page.locator('#pi-attachments .pi-attachment-chip').waitFor();
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="system-prompts"]').click();
    await page.locator('#system-prompt-append-text').waitFor();
    const widthCheck = async () => {
        const sizes = await page.evaluate(() => [...document.querySelectorAll('body,.workspace-settings-content,#system-prompts-panel,.system-prompt-card,.system-prompt-card form,.system-prompt-preview,#system-prompt-dialog[open],#system-prompt-runtime-body,.system-prompt-runtime-sources,.system-prompt-full,#pi-attachments')].filter(e => e.clientWidth && e.getClientRects().length).map(e => ({ id: e.id || e.className, w: e.clientWidth, s: e.scrollWidth })));
        assert.ok(sizes.every(s => s.s <= s.w + 1), JSON.stringify(sizes));
    };
    assert.equal(await page.locator('[data-prompt-kind="base"]').getAttribute('open'), null);
    assert.equal(await page.locator('#system-prompt-append-text').inputValue(), 'GLOBAL_INSTRUCTIONS');
    const draft = '# Custom heading\n\n中文原文 <img src=x onerror="window.promptXss=true">\n' + 'LongText'.repeat(100);
    await page.locator('#system-prompt-append-text').fill(draft);
    await page.locator('[data-prompt-kind="append"] [data-view="preview"]').click();
    assert.equal(await page.locator('.system-prompt-preview h1').textContent(), 'Custom heading');
    assert.equal(await page.evaluate(() => Boolean(window.promptXss)), false);
    await widthCheck();
    await page.locator('[data-prompt-kind="append"] [data-view="changes"]').click();
    assert.match(await page.locator('.system-prompt-diff').textContent(), /GLOBAL_INSTRUCTIONS/);
    conflict = true; await page.locator('#system-prompt-append-save').click();
    await page.waitForFunction(() => /变化|changed/.test(document.querySelector('#system-prompts-status').textContent));
    assert.equal(await page.locator('#system-prompt-append-text').inputValue(), draft); assert.equal(writes.length, 1);
    conflict = false; await page.locator('#system-prompts-refresh').click();
    await page.waitForFunction(() => /草稿|draft/.test(document.querySelector('#system-prompts-status').textContent));
    await page.locator('#system-prompt-append-save').click();
    await page.waitForFunction(() => /已保存|Saved/.test(document.querySelector('#system-prompts-status').textContent));
    assert.equal(writes.at(-1).content, draft); assert.equal(writes.at(-1).scope, 'global');
    assert.equal(calls.includes('reload_resources'), false);
    await page.locator('#system-prompts-scope').selectOption('project');
    assert.equal(await page.locator('#system-prompt-append-text').isEnabled(), false);
    await page.locator('#system-prompt-append-mode').selectOption('custom');
    await page.locator('#system-prompt-append-text').fill('PROJECT_INSTRUCTIONS');
    await page.locator('#system-prompt-append-save').click();
    await page.waitForFunction(() => /已保存|Saved/.test(document.querySelector('#system-prompts-status').textContent));
    busy = true; socket.send(JSON.stringify({ type: 'agent_start' }));
    await page.waitForFunction(() => document.querySelector('#system-prompts-reload-runtime').disabled);
    assert.equal(await page.locator('#system-prompt-append-text').isEnabled(), true, 'running tasks must not lock file editing');
    busy = false; socket.send(JSON.stringify({ type: 'agent_settled' }));
    await page.waitForFunction(() => !document.querySelector('#system-prompts-reload-runtime').disabled);
    await page.locator('#system-prompts-view-runtime').click();
    await page.locator('#system-prompt-runtime-body .system-prompt-full').waitFor({ state: 'attached' });
    assert.match(await page.locator('#system-prompt-runtime-status').textContent(), /不同|differs/);
    await page.locator('#system-prompt-runtime-reload').click();
    await page.waitForFunction(() => /一致|match the saved/.test(document.querySelector('#system-prompt-runtime-status').textContent));
    await page.getByRole('button', { name: locale === 'en' ? 'Prompt text' : '提示正文', exact: true }).click();
    await page.locator('#system-prompt-dialog input[type="search"]').fill('PROJECT_INSTRUCTIONS');
    assert.equal(await page.locator('.system-prompt-full mark').textContent(), 'PROJECT_INSTRUCTIONS');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#system-prompt-copy').click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /PROJECT_INSTRUCTIONS/);
    await widthCheck();
    assert.equal(await page.evaluate(() => Boolean(window.promptXss)), false);
    await page.screenshot({ path: `/tmp/pi-system-prompts-runtime-${width}-${locale}.png` });
    await page.locator('#system-prompt-dialog-close').click();
    await page.locator('#system-prompt-append-reset').click();
    await page.locator('#system-prompt-append-save').click();
    await page.waitForFunction(() => document.querySelector('#system-prompt-append-mode').value === 'inherit' && document.querySelector('#system-prompt-append-text').disabled);
    assert.equal(writes.at(-1).content, null); assert.equal(content.global.append, draft);
    await page.locator('#system-prompts-scope').selectOption('global');
    await page.locator('#system-prompt-append-text').fill('READBACK_FAILURE_DRAFT');
    failAfterSave = true; await page.locator('#system-prompt-append-save').click();
    await page.waitForFunction(() => /读取失败|reading back failed/.test(document.querySelector('#system-prompts-status').textContent));
    assert.equal(await page.locator('#system-prompt-append-save').isEnabled(), false);
    const count = writes.length;
    await page.locator('#system-prompts-refresh').click();
    await page.waitForFunction(() => /保留草稿|draft retained/.test(document.querySelector('#system-prompts-status').textContent));
    assert.equal(writes.length, count);
    await page.locator('#system-prompt-append-text').fill('RETAIN_ON_TAB_CHANGE');
    await page.locator('[data-settings-tab="providers"]').click();
    await page.locator('[data-settings-tab="system-prompts"]').click();
    await page.locator('#system-prompt-append-text').waitFor();
    assert.equal(await page.locator('#system-prompt-append-text').inputValue(), 'RETAIN_ON_TAB_CHANGE');
    await page.locator('[data-prompt-kind="base"] > summary').click();
    await page.locator('#system-prompt-base-mode').selectOption('custom');
    await page.locator('#system-prompt-base-text').fill('BASE_DRAFT');
    await page.locator('#system-prompts-scope').selectOption('project');
    await page.locator('#system-prompts-scope').selectOption('global');
    assert.equal(await page.locator('#system-prompt-base-text').inputValue(), 'BASE_DRAFT');
    await widthCheck();
    await page.screenshot({ path: `/tmp/pi-system-prompts-settings-${width}-${locale}.png` });
    if (width < 900) assert.equal(await page.locator('#system-prompt-append-text').evaluate(e => getComputedStyle(e).fontSize), '16px');
    // A late settings read cannot reopen a tab or replace its content.
    slow = true; await page.locator('#system-prompts-refresh').click();
    await page.waitForFunction(() => document.querySelector('#system-prompts-refresh').disabled);
    await page.locator('[data-settings-tab="providers"]').click();
    for (let i = 0; !pendingRead && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    pendingRead(); slow = false;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await page.locator('[data-settings-panel="providers"]').evaluate(e => e.classList.contains('active')), true);
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), 'CHAT_DRAFT');
    assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
    delayRuntime = true;
    await page.evaluate(() => window.PiSystemPromptRuntime.open());
    for (let i = 0; !delayedRuntime && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(delayedRuntime);
    // Simulate a socket generation change through the public runtime context.
    await page.evaluate(() => { const old = window.PiNativeRuntime.context; window.PiNativeRuntime.context = () => ({ ...old(), generation: 'changed-generation' }); window.PiSystemPromptRuntime.sync(); });
    delayedRuntime(); delayRuntime = false;
    assert.equal(await page.locator('#system-prompt-dialog').evaluate(e => e.open), false);
    assert.equal(await page.locator('#system-prompt-runtime-body').textContent(), '');
    assert.equal(calls.filter(c => c === 'reload_resources').length, 1);
    assert.equal(calls.includes('prompt'), false);
    assert.deepEqual(errors, []); console.log(`PASS system prompts ${width} ${locale}`);
    await context.close();
}
(async () => {
    const app = express(); app.use(express.static(path.join(__dirname, '../../public')));
    app.use('/vendor/highlight', express.static(path.join(__dirname, '../../node_modules/@highlightjs/cdn-assets')));
    app.use('/vendor/marked', express.static(path.join(__dirname, '../../node_modules/marked/lib')));
    app.use('/vendor/dompurify', express.static(path.join(__dirname, '../../node_modules/dompurify/dist')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const locale of ['zh-CN', 'en']) for (const width of [1440, 393, 320]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
