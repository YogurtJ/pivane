const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const express = require('express');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/fixture/updates';
const session = { id: 'updates-fixture', cwd, name: 'Fixture conversation', messageCount: 2 };
const model = { provider: 'fixture', id: 'fixture-model', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, available: true, thinkingLevels: ['off'] };
const empty = () => ({ appVersion: '1.0.0-rc.2', piVersion: '0.85.0', bundledPiVersion: '0.85.0', dependencyMatches: true,
    channel: 'preview', platform: 'linux', checkedAt: null,
    pivane: { status: 'unchecked', releasesUrl: 'https://github.com/YogurtJ/pivane/releases' },
    pi: { status: 'unchecked', releasesUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent' } });
async function run(browser, base, width, language) {
    const english = language === 'en-US';
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], writes = [], rpc = [];
    let mode = 'success', hold, releaseResponse;
    let noticeState = { enabled: false, available: false, eligible: false, idle: true, currentVersion: '0.85.0', version: '0.86.0', nextCheckAt: Date.now() + 86400000 };
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'updates-fixture'); }, { cwd });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => r.abort());
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') writes.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/pi/settings/updates/notifications') return route.fulfill({ json: noticeState });
        if (url.pathname.startsWith('/api/pi/settings/updates')) {
            if (url.pathname.includes('/review') || url.pathname.includes('/execute') || url.pathname.includes('/maintenance')) throw Error('Maintenance UI must not call maintenance endpoints');
            if (mode === 'old') return route.fulfill({ status: 404, json: { error: 'Not found' } });
            if (request.method() === 'GET') return route.fulfill({ json: empty() });
            if (hold) await hold;
            data = empty(); data.checkedAt = '2026-09-12T00:00:00Z';
            data.pi = { ...data.pi, version: '0.86.0', status: 'available' };
            data.pivane = mode === 'error' ? { ...data.pivane, status: 'error' } : mode === 'empty' ? { ...data.pivane, status: 'no-release' } : {
                status: 'available', version: '1.0.0-rc.10', prerelease: true,
                releasesUrl: 'https://github.com/YogurtJ/pivane/releases/tag/v1.0.0-rc.10',
                downloadUrl: 'https://github.com/YogurtJ/pivane/releases/download/v1.0.0-rc.10/pivane-1.0.0-rc.10.tar.gz',
                checksumUrl: 'https://github.com/YogurtJ/pivane/releases/download/v1.0.0-rc.10/pivane-1.0.0-rc.10.tar.gz.sha256' };
        } else if (url.pathname === '/api/pi/status') data = { ok: true, updateChecks: true, projectRoots: ['/fixture'], defaultProject: cwd };
        else if (url.pathname === '/api/pi/projects') data = { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
        else if (url.pathname === '/api/pi/sessions') data = { sessions: [session] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/settings/models') data = { models: [model], providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }], customProviders: [], preferences: {} };
        else if (url.pathname === '/api/pi/settings/session-titles') data = { enabled: false };
        else if (url.pathname.endsWith('/history')) data = [];
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); rpc.push(command.type);
        const state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'Fixture question' }] },
            { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/fixture/example.txt' } }] },
            { role: 'toolResult', toolCallId: 't1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'Fixture tool output' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], stopReason: 'stop' }];
        if (command.type === 'open_session') data = { session, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (command.type === 'get_state') data = state;
        else if (command.type === 'get_messages') data = { messages };
        else if (command.type === 'get_available_models') data = { models: [model] };
        else if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    await page.locator('#pi-input').fill('Unsent update discussion');
    await page.locator('#pi-file-input').setInputFiles({ name: 'update-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic data') });
    await page.locator('#pi-attachments .pi-attachment-chip').first().waitFor();
    await selectMessageView(page, 'full');
    await page.locator('.pi-tool-row summary').first().click();
    assert.equal(await page.locator('.pi-tool-output').textContent(), 'Fixture tool output');
    await page.locator('#workspace-settings-toggle').click(); await page.locator('[data-settings-tab="updates"]').click();
    await page.locator('#updates-check').waitFor();
    assert.equal(await page.locator('#settings-updates-panel h3').textContent(), english ? 'Versions and updates' : '版本与更新');
    assert.equal(await page.locator('#updates-channel, #updates-install-pivane, #maintenance-update, #maintenance-backup, #maintenance-restart').count(), 0);
    await page.locator('#updates-pivane [data-state="available"]').waitFor();
    assert.ok(writes.filter(path => path === '/api/pi/settings/updates/check').length <= 1, 'initial visit checks once if uncached');
    assert.ok((await page.locator('#updates-pivane').innerText()).includes('1.0.0-rc.10'));
    assert.ok((await page.locator('#updates-pi').innerText()).includes('0.86.0'));
    assert.equal(await page.locator('#updates-pivane a[href$=".tar.gz"]').count(), 0);
    assert.equal(await page.locator('#updates-pivane a[href$=".sha256"]').count(), 0);
    await page.locator('#updates-agent-guide summary').click();
    const prompt = await page.locator('#updates-agent-prompt').inputValue();
    assert.ok(prompt.includes('AGENT_GUIDE.md') && prompt.includes('INSTALL_RECOVERY.md'));
    assert.ok(prompt.includes(english ? 'independent Agent' : '独立 Agent'));
    assert.ok(prompt.includes(english ? 'explicit approval' : '明确确认'));
    assert.ok(prompt.includes(english ? 'do not stop or restart' : '不要在当前会话中停止或重启'));
    await page.locator('#updates-copy-prompt').click();
    await page.waitForFunction(() => document.querySelector('.updates-copy-feedback').textContent.length > 0);
    const copyStatus = await page.locator('.updates-copy-feedback').textContent();
    assert.ok(copyStatus.includes(english ? 'Copied' : '复制') || copyStatus.includes(english ? 'selected' : '选中'));
    const overflow = async () => {
        const metrics = await page.evaluate(() => [...document.querySelectorAll('.workspace-settings-dialog, .workspace-settings-body, .workspace-settings-content, .workspace-settings-nav, #settings-updates-panel, #settings-updates-panel *')].filter(e => e.clientWidth).map(e => ({ id: e.id || e.className || e.tagName, client: e.clientWidth, scroll: e.scrollWidth })));
        for (const m of metrics) assert.ok(m.scroll <= m.client + 1, `${language}/${width}: ${JSON.stringify(m)}`);
    };
    for (const theme of ['daylight', 'mint', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await overflow(); }
    if (width < 600) assert.ok(await page.locator('#updates-agent-prompt').evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
    await page.screenshot({ path: path.join(process.env.PI_BROWSER_ARTIFACT_DIR || os.tmpdir(), `pivane-updates-${language}-${width}.png`) });
    // A delayed check cannot overwrite the reopened view or change the prompt.
    hold = new Promise(resolve => { releaseResponse = resolve; });
    const checkingRequest = page.waitForRequest(r => r.url().endsWith('/settings/updates/check'));
    await page.locator('#updates-check').click(); await checkingRequest;
    await page.waitForFunction(() => document.getElementById('updates-check').disabled);
    await page.locator('#workspace-settings-close').click(); await page.locator('#workspace-settings-toggle').click();
    await page.waitForFunction(() => !document.getElementById('updates-check').disabled);
    const lateResponse = page.waitForResponse(r => r.url().endsWith('/settings/updates/check'));
    releaseResponse(); hold = null; await lateResponse;
    assert.equal(await page.locator('#updates-pivane [data-state="unchecked"]').count(), 1);
    mode = 'error'; await page.locator('#updates-check').click(); await page.locator('#updates-pivane [data-state="error"]').waitFor();
    assert.equal(await page.locator('#updates-pi [data-state="available"]').count(), 1);
    mode = 'empty'; await page.locator('#updates-check').click(); await page.locator('#updates-pivane [data-state="no-release"]').waitFor();
    mode = 'old'; await page.locator('[data-settings-tab="providers"]').click(); await page.locator('[data-settings-tab="updates"]').click();
    await page.waitForFunction(() => document.getElementById('updates-feedback')?.textContent.includes('稍后') || document.getElementById('updates-feedback')?.textContent.includes('later'));
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent update discussion');
    assert.ok((await page.locator('#pi-attachments').innerText()).includes('update-notes.txt'));
    assert.ok(writes.every(p => ['/api/pi/settings/updates/check', '/api/pi/settings/updates/notifications'].includes(p)));
    assert.ok(!rpc.includes('prompt') && !rpc.includes('abort') && !rpc.includes('restart_runtime'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ language, width, errors, readOnly: true, draftsPreserved: true }));
    await context.close();
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const language of ['zh-CN', 'en-US']) for (const width of [320, 393, 1024, 1440]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
