const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const root = path.resolve(__dirname, '../..'), cwd = '/mock/native-mcp-project';
const session = { id: 'fixture', cwd, name: 'Native MCP fixture', messageCount: 4 };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
const messages = [{ role: 'user', content: 'Fixture only', timestamp: 1 },
    { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: { code: 'fixture' } }] },
    { role: 'toolResult', toolCallId: 'parent', toolName: 'codemode', timestamp: 3, isError: false, content: [{ type: 'text', text: 'done' }], nestedCalls: { complete: true, calls: [{ id: 'parent/1', name: 'write', arguments: { path: 'fixture.txt', content: 'recorded' }, status: 'ok' }, { id: 'parent/2', name: 'edit', arguments: { path: 'fixture.txt', edits: [] }, status: 'ok' }] } },
    { role: 'assistant', timestamp: 4, stopReason: 'stop', content: [{ type: 'text', text: 'Finished fixture.' }] }];
async function run(browser, base, width, locale) {
    const ctx = await browser.newContext({ locale, viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await ctx.newPage(), errors = [], actions = []; let socket, reconnectAuth = false, outcome = 'completed';
    const auth = { server: 'demo', runtimeId: 'runtime', url: 'https://example.invalid/oauth?state=synthetic' };
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), endpoint = url.pathname;
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, nativeResources: true, nativeSettings: true, nativeMcpManagement: true, defaultProject: cwd, projectRoots: ['/mock'] } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }], roots: ['/mock'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session] } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [], deferred: [] } });
        if (endpoint === '/api/pi/settings/mcp') return route.fulfill({ json: { cwd, scope: url.searchParams.get('scope'), revision: 'r1', trust: { effective: true }, autoEnableCodemode: { global: null, project: null, value: true }, servers: [{ name: 'demo', scope: 'global', valid: true, transport: 'http', enabled: true, exposure: 'codemode', timeout: 60, config: { url: null }, secretFields: { url: { present: true } } }] } });
        if (endpoint.endsWith('/mcp')) { const body = req.postDataJSON(); actions.push(body); return route.fulfill({ json: { runtimeId: 'runtime', servers: [{ name: 'demo', state: 'connected', toolCount: 1, exposure: 'codemode' }], tools: [], notices: outcome === 'completed' ? [] : [{ kind: outcome === 'failed' ? 'error' : outcome, code: 'MCP_SYNTHETIC' }], outcome } }); }
        if (endpoint.includes('history') || endpoint === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => { socket = ws; ws.onMessage(raw => {
        const cmd = JSON.parse(raw), reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, success: true, command: cmd.type, data }));
        if (cmd.type === 'open_session') return reply({ session, state: { sessionId: session.id, model, isStreaming: false, webShell: { runtimeId: 'runtime', revision: 1, busy: false } }, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, pendingUi: [], mcpAuthorization: reconnectAuth ? auth : null });
        if (cmd.type === 'get_messages') return reply({ messages });
        if (cmd.type === 'get_state') return reply({ sessionId: session.id, model, isStreaming: false, webShell: { runtimeId: 'runtime', revision: 1, busy: false } });
        return reply({});
    }); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.PiNativeRuntime?.currentSession?.()?.runtimeId));
    assert.equal(await page.evaluate(() => PiNativeRuntime.currentSession().runtimeId), 'runtime');
    await page.evaluate(() => PiWorkspaceRoute.navigate('extensions', { tab: 'mcp' }));
    await page.locator('.mcp-settings.active').waitFor();
    await page.locator('.mcp-settings [data-mcp-write]').first().waitFor();
    assert.equal(actions.length, 0, 'opening saved configuration does not connect or request runtime');
    const read = page.locator('.mcp-settings button').filter({ hasText: locale === 'en' ? /^Read runtime snapshot$/ : /^读取运行快照$/ });
    await read.click(); assert.equal(actions[0].runtimeId, 'runtime');
    for (const state of ['failed', 'cancelled', 'unknown']) {
        outcome = state; await read.click();
        const status = await page.locator('.mcp-status').textContent();
        assert.ok(!status.includes('Runtime action completed') && !status.includes('运行操作完成'), status);
    }
    outcome = 'completed'; await read.click();
    await page.locator('.mcp-settings button').filter({ hasText: locale === 'en' ? /^Return to chat$/ : /^返回聊天$/ }).click();
    await page.locator('.mcp-settings.active').waitFor({ state: 'hidden' });
    socket.send(JSON.stringify({ type: 'gateway_mcp_authorization', authorization: auth }));
    await page.locator('#pi-mcp-authorization a').waitFor();
    assert.equal(await page.locator('#pi-mcp-authorization a').getAttribute('href'), auth.url);
    assert.equal(await page.locator('#pi-mcp-authorization a').getAttribute('rel'), 'noopener noreferrer');
    reconnectAuth = true; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#pi-mcp-authorization a').waitFor();
    socket.send(JSON.stringify({ type: 'gateway_mcp_authorization', authorization: null }));
    await page.locator('#pi-mcp-authorization').waitFor({ state: 'hidden' });
    await page.evaluate(() => document.getElementById('workspace-settings-close')?.click());
    // Nested file proof survives the assembled native-message projection, not a test-only module list.
    assert.equal(await page.locator('.pi-turn-edits').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('.pi-turn-edits').textContent.includes('codemode')), true);
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.app-container,.mcp-settings,.mcp-settings section,.mcp-settings article')].filter(node => node.getClientRects().length).map(node => ({ w: node.clientWidth, s: node.scrollWidth })));
    assert.ok(sizes.every(node => node.s <= node.w + 2), JSON.stringify(sizes)); assert.deepEqual(errors, []);
    await ctx.close(); console.log(`Native MCP assembled workbench ${width} ${locale}: passed`);
}
(async () => {
    const app = express(); app.use(express.static(path.join(root, 'public'))); app.use('/vendor', express.static(path.join(root, 'node_modules')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, locale] of [[1440, 'zh-CN'], [393, 'zh-CN'], [320, 'en']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
