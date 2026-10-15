// Synthetic HTTP/API/WebSocket fixtures only; never connects to a running workbench or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const evidence = '/tmp/pivane-feedback/agent-a';
const networkEvidence = '/tmp/pivane-feedback/round2/network';
const token = 'Test12345!';
const cwd = '/tmp/pi-access-synthetic/project';
const session = { id: 'access-fixture', cwd, name: 'Synthetic access fixture', messageCount: 0 };
const model = { provider: 'fixture', id: 'fixture-model', name: 'Fixture', available: true, input: ['text'], contextWindow: 32000 };
function fixture() {
    let enabled = false, currentToken = token, revision = 1, cookie = 0;
    const validCookies = new Set(), writes = [], gates = new Map();
    let networkRevision = 1, saved = { listen: 'local', proxy: { mode: 'environment', url: '', noProxy: '' } };
    let getFailure = false, writeFailure = false, testResponse = { reached: true, ok: true, status: 200, durationMs: 42 };
    const authorized = req => !enabled || validCookies.has(/pi_access_fixture=([^;]+)/.exec(req.headers.cookie || '')?.[1]);
    const accessSettings = () => ({ enabled, editable: true, source: 'workspace', revision: String(revision), hasToken: enabled });
    const networkSettings = () => ({ authEnabled: enabled, revision: String(networkRevision), listenEditable: true, listenSource: 'workspace', nativeProxy: false,
        current: { host: '127.0.0.1', port: 12345, local: true, proxyMode: 'environment', usesProxy: false }, saved,
        restartRequired: saved.listen !== 'local' || saved.proxy.mode !== 'environment' || Boolean(saved.proxy.noProxy),
        addresses: [{ kind: 'local', url: 'http://127.0.0.1:12345' }, { kind: 'device', url: 'http://192.0.2.100:12345' }] });
    function login(res, remember) {
        const id = String(++cookie); validCookies.add(id);
        res.cookie('pi_access_fixture', id, { httpOnly: true, sameSite: 'strict', path: '/', ...(remember ? { maxAge: 30 * 86400000 } : {}) });
    }
    return {
        writes,
        hold(method, route) {
            let release; const pending = new Promise(resolve => { release = resolve; }); gates.set(method + ' ' + route, pending);
            return () => { gates.delete(method + ' ' + route); release(); };
        },
        failGet(value) { getFailure = value; }, failWrite() { writeFailure = true; }, testResult(value) { testResponse = { ...value, durationMs: 42 }; },
        async handle(req, res) {
            const route = req.path;
            if (req.method !== 'GET') writes.push({ route, body: req.body });
            await gates.get(req.method + ' ' + route);
            if (route === '/api/access/status') return res.json({ accessControl: true, enabled, authenticated: authorized(req) });
            if (route === '/api/access/login') {
                if (req.body.token !== currentToken) return res.status(401).json({ error: 'Token 不正确' });
                login(res, req.body.remember); return res.json({ ok: true });
            }
            if (!authorized(req)) return res.status(401).json({ error: '请先登录' });
            if (route === '/api/access/settings') {
                if (req.method === 'PUT') {
                    assert.equal(req.headers['x-pi-access'], '1'); assert.equal(req.body.confirmed, true); assert.equal(req.body.expectedRevision, String(revision));
                    enabled = req.body.enabled; revision++; validCookies.clear();
                    const generatedToken = req.body.generate ? 'synthetic-generated-token-32-characters-long' : undefined;
                    currentToken = generatedToken || req.body.token || currentToken; login(res);
                    return res.json({ ...accessSettings(), ...(generatedToken ? { generatedToken } : {}) });
                }
                return res.json(accessSettings());
            }
            if (route === '/api/access/logout' || route === '/api/access/revoke') {
                if (route.endsWith('revoke')) validCookies.clear();
                else validCookies.delete(/pi_access_fixture=([^;]+)/.exec(req.headers.cookie || '')?.[1]);
                res.clearCookie('pi_access_fixture', { path: '/' }); return res.json({ ok: true });
            }
            if (route === '/api/network/settings') {
                if (req.method === 'GET' && getFailure) return res.status(503).json({ error: 'fixture network unavailable' });
                if (req.method === 'PUT') {
                    assert.equal(req.body.confirmed, true); assert.equal(req.body.expectedRevision, String(networkRevision));
                    if (writeFailure) { writeFailure = false; return res.status(503).json({ error: 'fixture response uncertain' }); }
                    networkRevision++;
                    if (req.body.section === 'discard') saved = { listen: 'local', proxy: { mode: 'environment', url: '', noProxy: '' } };
                    else saved = { ...saved, [req.body.section]: req.body.value };
                }
                return res.json(networkSettings());
            }
            if (route === '/api/network/test') return res.json(testResponse);
            if (route === '/api/pi/status') return res.json({ ok: true, accessControl: true, projectRoots: [cwd], defaultProject: cwd, nativeSettings: true });
            if (route === '/api/pi/projects') return res.json({ roots: [cwd], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] });
            if (route === '/api/pi/sessions') return res.json({ sessions: [session] });
            if (route === '/api/pi/settings/models') return res.json({ models: [model], providers: [], customProviders: [], preferences: {} });
            if (route === '/api/pi/activity') return res.json({ runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] });
            if (route.endsWith('/history')) return res.json([]);
            return res.json({});
        }
    };
}
async function attach(page, errors) {
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.route('https://**/*', route => route.abort());
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw), state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        if (command.type === 'open_session') data = { session, state, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (command.type === 'get_state') data = state;
        else if (command.type === 'get_messages') data = { messages: [] };
        else if (command.type === 'get_available_models') data = { models: [model] };
        else if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
}
async function pending(page, button, status, card) {
    // The busy button carries the pending state; the inline status beside it is reserved for the outcome.
    await page.locator(`#${button}[aria-busy="true"] .pi-spinner`).waitFor();
    assert.equal(await page.locator(`#${status}`).isVisible(), false, 'no duplicate pending text beside the busy button');
    assert.equal(await page.locator(`#${button}`).evaluate((node, card) => node.closest(card) !== null, card), true);
    assert.equal(await page.locator(`#${status}`).evaluate((node, card) => node.closest(card) !== null, card), true);
    assert.equal(await page.locator('#network-feedback').count(), 0, 'feedback has no page-bottom sink');
}
async function result(page, status, tone, card) {
    await page.waitForFunction(({ status, tone }) => {
        const node = document.getElementById(status);
        return node?.dataset.tone === tone && !node.hidden && node.getClientRects().length > 0;
    }, { status, tone });
    assert.equal(await page.locator(`#${status}`).isVisible(), true);
    assert.equal(await page.locator(`#${status}`).evaluate((node, card) => node.closest(card) !== null, card), true);
}
async function widths(page) {
    const metrics = await page.evaluate(() => [...document.querySelectorAll('html,.workspace-settings-content,#workspace-access-panel,.network-card,.network-pending,.pv-inline-status')].filter(n => n.getClientRects().length).map(n => ({ id: n.id, width: n.clientWidth, scroll: n.scrollWidth })));
    assert.ok(metrics.every(n => n.scroll <= n.width + 1), JSON.stringify(metrics));
    assert.ok(await page.locator('.network-card input,.network-card select').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).every(n => parseFloat(getComputedStyle(n).fontSize) >= 16)));
}
(async () => {
    fs.mkdirSync(evidence, { recursive: true });
    fs.mkdirSync(networkEvidence, { recursive: true });
    const app = express(); app.use(express.json()); let state;
    app.use('/api', (req, res, next) => { req.url = '/api' + req.url; state.handle(req, res).catch(next); });
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            state = fixture();
            const status = await (await fetch(base + '/api/pi/status')).json();
            assert.ok(status.projectRoots.every(p => p.startsWith('/tmp/pi-access-')), 'must use isolated project roots');
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: width === 1440 ? 1000 : 852 } });
            await context.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'access-fixture'); }, cwd);
            const page = await context.newPage(), errors = [], pendingRequests = new Set(); page.setDefaultTimeout(12000); await attach(page, errors);
            page.on('request', request => pendingRequests.add(request.url()));
            page.on('requestfinished', request => pendingRequests.delete(request.url()));
            page.on('requestfailed', request => pendingRequests.delete(request.url()));
            let release = state.hold('GET', '/api/network/settings');
            try { await page.goto(base + '/#/settings?tab=access', { waitUntil: 'domcontentloaded' }); }
            catch (error) { console.error({ width, pendingRequests: [...pendingRequests], errors, readyState: await page.evaluate(() => document.readyState) }); release(); throw error; }
            await page.waitForFunction(() => window.WorkspaceAccess?.supported === true);
            await page.locator('#network-summary .pv-skeleton--lines').waitFor();
            assert.equal(await page.locator('#network-listen').isVisible(), false, 'empty or stale cards stay hidden during load');
            release(); await page.locator('#network-listen').waitFor();
            assert.equal(await page.locator('#network-auth-hint').getAttribute('data-tone'), 'warning');
            assert.equal(await page.locator('#network-auth-hint').evaluate(n => n.previousElementSibling.id), 'network-summary');
            assert.equal(await page.locator('#network-proxy-save').isDisabled(), true);
            assert.equal(await page.locator('#workspace-access-refresh').count(), 1); assert.equal(await page.locator('#network-refresh').count(), 0);
            if (await page.locator('#pi-project-dialog:not(.hidden)').isVisible()) await page.locator('#pi-project-dialog-close').click();
            assert.match(await page.locator('label[for="workspace-access-token"]').textContent(), /10–256/);
            await page.locator('#workspace-access-enabled').check(); await page.locator('#workspace-access-token').fill(token);
            release = state.hold('PUT', '/api/access/settings'); await page.locator('#workspace-access-save').click();
            await pending(page, 'workspace-access-save', 'workspace-access-result', '#network-security');
            const releaseNetwork = state.hold('GET', '/api/network/settings'); release();
            await page.waitForFunction(() => document.querySelector('#workspace-access-result')?.textContent.includes('已保存'));
            await result(page, 'workspace-access-result', 'success', '#network-security');
            await page.locator('#network-summary .pv-skeleton--lines').waitFor();
            assert.equal(await page.locator('#network-security').isVisible(), true, 'access feedback stays visible during an independent network refresh');
            assert.equal(await page.locator('#network-listen').isVisible(), false);
            releaseNetwork();
            assert.equal((await fetch(base + '/api/pi/status')).status, 401);
            await page.waitForFunction(() => !document.getElementById('network-proxy-save').disabled);

            // Every network action reports directly under its own controls, preserving sibling drafts.
            await page.locator('#network-proxy-mode').selectOption('custom'); await page.locator('#network-proxy-url').fill('http://127.0.0.1:7890');
            await page.locator('#network-listen-mode').selectOption('devices');
            release = state.hold('PUT', '/api/network/settings'); await page.locator('#network-proxy-save').click();
            await pending(page, 'network-proxy-save', 'network-proxy-status', '#network-proxy');
            assert.equal(await page.locator('#network-listen-save').innerText(), '保存访问范围', 'only pressed button changes label');
            assert.equal(await page.locator('#network-listen-save').isDisabled(), true); await widths(page);
            await page.screenshot({ path: `${evidence}/network-${width}-saving.png` });
            release(); await result(page, 'network-proxy-status', 'success', '#network-proxy');
            assert.equal(await page.locator('#network-listen-mode').inputValue(), 'devices');
            assert.equal(await page.locator('#network-summary').textContent().then(s => s.includes('自定义代理')), false, 'saved proxy is not active');
            await page.screenshot({ path: `${evidence}/network-${width}-saved.png` });
            const proxyBody = state.writes.find(w => w.route === '/api/network/settings').body;
            assert.equal(proxyBody.section, 'proxy'); assert.equal(proxyBody.value.url, 'http://127.0.0.1:7890');
            release = state.hold('PUT', '/api/network/settings'); await page.locator('#network-listen-save').click();
            await pending(page, 'network-listen-save', 'network-listen-status', '#network-listen'); release();
            await result(page, 'network-listen-status', 'success', '#network-listen');
            assert.equal(await page.locator('#network-proxy-url').inputValue(), 'http://127.0.0.1:7890');
            release = state.hold('PUT', '/api/network/settings'); await page.locator('#network-discard').click();
            await pending(page, 'network-discard', 'network-discard-status', '#network-pending'); release();
            await result(page, 'network-discard-status', 'success', '#network-pending');
            assert.equal(await page.locator('#network-discard').isVisible(), false, 'discard completion stays visible without a stale pending action');

            await page.locator('#network-proxy details').last().locator('summary').click();
            const beforeTests = state.writes.length;
            release = state.hold('POST', '/api/network/test'); await page.locator('#network-proxy-test').click();
            await pending(page, 'network-proxy-test', 'network-test-status', '.network-test'); release();
            await result(page, 'network-test-status', 'success', '.network-test');
            assert.equal(await page.locator('#network-test-status').textContent(), '已连接到目标（HTTP 200，42 ms）。未保存配置，也未调用生成模型。');
            for (const [httpStatus, hint] of [[403, '可能是目标限流。'], [429, '可能是目标限流。'], [503, '目标暂时不可用。'], [404, '请稍后重试或检查目标状态。']]) {
                state.testResult({ reached: true, ok: false, status: httpStatus });
                await page.locator('#network-proxy-test').click(); await result(page, 'network-test-status', 'warning', '.network-test');
                assert.equal(await page.locator('#network-test-status').textContent(), `网络/代理路径已连通，但目标返回 HTTP ${httpStatus}（42 ms）。${hint}未保存配置，也未调用生成模型。`);
                assert.equal(await page.locator('#network-proxy-test').innerText(), '测试连接');
                assert.equal(await page.locator('#network-proxy-test').getAttribute('aria-busy'), null);
                assert.equal(await page.locator('#network-feedback').count(), 0);
                await widths(page);
                if (httpStatus === 503 && width !== 320) {
                    await page.locator('.network-test').scrollIntoViewIfNeeded();
                    await page.screenshot({ path: `${networkEvidence}/network-${width}-warning-503.png` });
                }
            }
            await page.screenshot({ path: `${evidence}/network-${width}-test.png` });
            state.testResult({ reached: false, ok: false }); await page.locator('#network-proxy-test').click(); await result(page, 'network-test-status', 'error', '.network-test');
            assert.equal(await page.locator('#network-test-status').textContent(), '未能连接。请检查服务器上的代理地址、端口与网络。');
            assert.ok(state.writes.slice(beforeTests).every(w => w.route === '/api/network/test'), 'connection tests never save settings or call a model');
            if (width === 1440) {
                const englishContext = await browser.newContext({ locale: 'en-US', viewport: { width, height: 1000 }, storageState: await context.storageState() });
                await englishContext.addInitScript(() => localStorage.setItem('pi.workspace.language', 'en'));
                const englishPage = await englishContext.newPage(); await attach(englishPage, errors);
                await englishPage.goto(base + '/#/settings?tab=access', { waitUntil: 'domcontentloaded' });
                await englishPage.waitForFunction(() => document.getElementById('network-proxy-save')?.disabled === false);
                if (await englishPage.locator('#pi-project-dialog:not(.hidden)').isVisible()) await englishPage.locator('#pi-project-dialog-close').click();
                await englishPage.locator('#network-proxy details').last().locator('summary').click();
                for (const [httpStatus, hint] of [[403, 'The target is likely rate limiting requests.'], [503, 'The target is temporarily unavailable.']]) {
                    state.testResult({ reached: true, ok: false, status: httpStatus });
                    await englishPage.locator('#network-proxy-test').click(); await result(englishPage, 'network-test-status', 'warning', '.network-test');
                    assert.equal(await englishPage.locator('#network-test-status').textContent(), `The network/proxy path works, but the target returned HTTP ${httpStatus} (42 ms). ${hint} Configuration was not saved, and no generative model was called.`);
                    await widths(englishPage);
                }
                await englishContext.close();
            }

            const addressDetails = page.locator('#network-listen details'); await addressDetails.locator('summary').click();
            await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedAddress = text; } } }));
            await page.locator('.network-address button').first().click(); assert.equal(await page.locator('.network-address button').first().innerText(), '已复制');
            assert.equal(await page.evaluate(() => window.copiedAddress), 'http://127.0.0.1:12345');
            await page.waitForFunction(() => document.querySelector('.network-address button').textContent === '复制地址');
            await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('fixture denied'); }; });
            await page.locator('.network-address button').first().click();
            assert.equal(await page.locator('.network-copy-status').first().getAttribute('data-tone'), 'error');
            assert.equal(await page.locator('.network-copy-status').first().evaluate(n => Boolean(n.closest('.network-address'))), true);

            state.failWrite(); const beforeFailure = state.writes.length; await page.locator('#network-proxy-save').click();
            await result(page, 'network-proxy-status', 'error', '#network-proxy');
            assert.match(await page.locator('#network-proxy-status').textContent(), /请刷新核对后再保存；未自动重试。/);
            assert.equal(await page.locator('#network-proxy-save').isDisabled(), true); assert.equal(await page.locator('#network-listen-save').isDisabled(), true);
            assert.equal(state.writes.length, beforeFailure + 1, 'uncertain writes are never replayed');
            state.failGet(true); release = state.hold('GET', '/api/network/settings'); await page.locator('#workspace-access-refresh').click();
            await page.locator('#network-summary .pv-skeleton--lines').waitFor(); assert.equal(await page.locator('#network-proxy').isVisible(), false);
            release(); await result(page, 'network-load-status', 'error', '#workspace-access-panel');
            assert.equal(await page.locator('#network-load-status').evaluate(n => n.previousElementSibling.classList.contains('settings-panel-header')), true, 'load errors sit directly below the header');
            state.failGet(false); await page.locator('#workspace-access-refresh').click(); await page.locator('#network-proxy').waitFor();
            await page.waitForFunction(() => !document.getElementById('network-proxy-save').disabled);

            const freshContext = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 852 } });
            const fresh = await freshContext.newPage(); await attach(fresh, errors);
            await fresh.goto(base, { waitUntil: 'domcontentloaded' }); await fresh.locator('#pi-token-dialog:not(.hidden)').waitFor();
            assert.equal(await fresh.evaluate(() => document.querySelector('.app-container').inert), true);
            assert.equal(await fresh.locator('#pi-token-input').inputValue(), '');
            for (const theme of ['daylight', 'mint', 'dark']) {
                await fresh.evaluate(t => document.documentElement.dataset.theme = t, theme);
                const layout = await fresh.evaluate(() => {
                    const form = document.querySelector('#pi-token-form'), box = form.getBoundingClientRect();
                    const input = document.querySelector('#pi-token-input'), checkbox = document.querySelector('#workspace-access-remember').getBoundingClientRect();
                    const brand = document.querySelector('.workspace-login-brand').getBoundingClientRect();
                    return { padding: brand.left - box.left, checkbox: [checkbox.width, checkbox.height], font: parseFloat(getComputedStyle(input).fontSize), overflow: form.scrollWidth > form.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth, logo: document.querySelector('.workspace-login-brand img').naturalWidth };
                });
                assert.ok(layout.padding >= 24 && layout.checkbox.every(n => n >= 16 && n <= 20), 'login padding and checkbox must not inherit legacy text-field sizes');
                assert.ok(layout.font >= 16 && !layout.overflow && layout.logo > 0);
                await fresh.screenshot({ path: `/tmp/pi-login-ui-${width}-${theme}.png` });
            }
            await fresh.locator('#pi-token-input').fill('visibility-fixture'); await fresh.locator('#workspace-access-token-visibility').click();
            assert.equal(await fresh.locator('#pi-token-input').getAttribute('type'), 'text'); await fresh.locator('#workspace-access-token-visibility').click();
            assert.equal(await fresh.locator('#pi-token-input').getAttribute('type'), 'password');
            await fresh.locator('.workspace-login-help summary').click(); await fresh.keyboard.press('Tab');
            assert.equal(await fresh.evaluate(() => document.activeElement.id), 'pi-token-input', 'focus wraps across the help control'); await fresh.keyboard.press('Shift+Tab');
            assert.equal(await fresh.evaluate(() => document.activeElement.tagName), 'SUMMARY');
            await fresh.setViewportSize({ width, height: 420 }); await fresh.locator('.workspace-login-submit').scrollIntoViewIfNeeded();
            assert.ok(await fresh.locator('.workspace-login-submit').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'short screens can scroll to submit');
            await freshContext.close();
            assert.equal(await page.evaluate(() => sessionStorage.getItem('pi.web.token')), null);
            assert.ok((await context.cookies()).some(c => c.name.startsWith('pi_access_') && c.httpOnly && c.sameSite === 'Strict'));
            await page.evaluate(() => { const input = document.querySelector('#pi-input'); input.value = '保留未发送草稿'; input.dispatchEvent(new Event('input', { bubbles: true })); });
            release = state.hold('POST', '/api/access/logout'); await page.locator('#workspace-access-logout').click();
            await pending(page, 'workspace-access-logout', 'workspace-access-result', '#network-security'); release();
            await page.locator('#pi-token-dialog:not(.hidden)').waitFor();
            await page.locator('#pi-token-input').fill('wrong-token'); await page.locator('#pi-token-form button[type="submit"]').click();
            await page.waitForFunction(() => document.querySelector('#workspace-access-login-error')?.textContent.includes('Token'));
            await page.locator('#pi-token-input').fill(token); await page.locator('#workspace-access-remember').check(); await page.locator('#pi-token-form button[type="submit"]').click();
            await page.locator('#pi-token-dialog').waitFor({ state: 'hidden' });
            assert.equal(await page.locator('#pi-input').inputValue(), '保留未发送草稿'); assert.equal(await page.evaluate(() => sessionStorage.getItem('pi.web.token')), null);
            assert.ok((await context.cookies()).some(c => c.name === 'pi_access_fixture' && c.expires > Date.now() / 1000 + 29 * 86400));
            await page.locator('[data-settings-tab="access"]').click();
            release = state.hold('POST', '/api/access/revoke'); await page.locator('#workspace-access-revoke').click();
            await pending(page, 'workspace-access-revoke', 'workspace-access-result', '#network-security'); release();
            await page.locator('#pi-token-dialog:not(.hidden)').waitFor(); await page.locator('#pi-token-input').fill(token); await page.locator('#pi-token-form button[type="submit"]').click();
            await page.locator('#pi-token-dialog').waitFor({ state: 'hidden' }); await page.locator('[data-settings-tab="access"]').click();
            await page.locator('#workspace-access-generate').check(); await page.locator('#workspace-access-save').click(); await page.locator('#workspace-access-generated:not([hidden])').waitFor();
            assert.ok((await page.locator('#workspace-access-generated-token').inputValue()).length >= 32); assert.equal(await page.locator('#workspace-access-token').inputValue(), '');
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
                assert.ok(await page.locator('#workspace-access-token').evaluate(e => {
                    const style = getComputedStyle(e);
                    const light = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
                    const a = light(style.color), b = light(style.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5;
                }), 'token field contrast must be readable in every theme');
                assert.ok(await page.evaluate(() => [document.documentElement, document.querySelector('#workspace-access-panel'), document.querySelector('.workspace-settings-content')].filter(Boolean).every(e => e.scrollWidth <= e.clientWidth + 1)), 'internal widths must fit');
                await widths(page);
            }
            assert.ok(await page.locator('#workspace-access-token').evaluate(e => window.innerWidth > 680 || parseFloat(getComputedStyle(e).fontSize) >= 16));
            await page.screenshot({ path: `/tmp/pi-access-${width}.png` });
            await page.locator('#workspace-access-enabled').uncheck(); await page.locator('#workspace-access-save').click({ noWaitAfter: true });
            await page.waitForFunction(() => document.querySelector('#workspace-access-result')?.textContent.includes('已保存，访问验证已关闭'));
            const publicStatus = await fetch(base + '/api/pi/status');
            await publicStatus.arrayBuffer();
            assert.equal(publicStatus.status, 200);
            await page.route('**/api/access/status', route => route.fulfill({ status: 503, json: { error: 'fixture status unavailable' } }));
            await page.evaluate(async () => { window.auditAccessReady = 0; window.addEventListener('workspace:access-ready', () => window.auditAccessReady++); await window.WorkspaceAccess.refresh(); });
            assert.equal(await page.evaluate(() => window.auditAccessReady), 0, 'failed status must not announce a successful login or reconnect');
            await page.unroute('**/api/access/status'); assert.deepEqual(errors, []);
            console.log(`PASS ${width}: synthetic access/network, inline pending/success/error, locking/revisions/no retry/drafts, themes, no pageerror/overflow`);
            await context.close();
        }
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
