const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/source', target = '/synthetic/目标-' + 'long-project-path-'.repeat(15);
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const original = { id: 'original-thread', cwd, name: '保留完整历史的线程', messageCount: 2, modified: '2026-10-01T00:00:00Z' };
async function run(browser, base, width, language, emptyTargets = false) {
    const context = await browser.newContext({ locale: language, viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], posts = [], opens = [];
    let moved = false, oldBackend = false, blocked = false, failMove = false, release, hold = false, activeSocket;
    const english = language === 'en';
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language }) => {
        localStorage.setItem('pi.workspace.language', language);
        if (!localStorage.getItem('pi.web.cwd')) {
            localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'original-thread');
            localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd]));
        }
        sessionStorage.setItem('pi.web.token', 'fixture-token');
    }, { cwd, language });
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), current = { ...original, cwd: moved ? target : cwd };
        if (request.method() !== 'GET') {
            assert.ok(url.pathname.endsWith('/move'), 'The fixture must not send prompts or unrelated writes');
            const body = request.postDataJSON(); posts.push(body);
            assert.equal(request.headers().authorization, 'Bearer fixture-token');
            assert.match(body.requestId, /^move-[a-f0-9]{32}$/);
            assert.equal(new Set(posts.map(post => post.requestId)).size, posts.length);
            assert.equal(body.cwd, cwd); assert.equal(body.targetCwd, target); assert.equal(body.expectedRevision, 'a'.repeat(64));
            if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
            if (failMove) return route.fulfill({ status: 409, json: { error: 'fixture move uncertain' } });
            moved = true;
            activeSocket?.send(JSON.stringify({ type: 'gateway_session_moving' }));
            activeSocket?.send(JSON.stringify({ type: 'gateway_session_moved', sourceCwd: cwd, session: { ...original, cwd: target } }));
            return route.fulfill({ json: { session: { ...original, cwd: target }, moved: true } });
        }
        let json = {};
        if (url.pathname === '/api/pi/status') json = { ok: true, projectRoots: ['/synthetic'], sessionTransfer: true, sessionMoves: !oldBackend, projectIdentity: true, archives: true };
        else if (url.pathname === '/api/pi/projects') json = { projects: [{ cwd, name: '来源', sessionCount: moved ? 0 : 1 },
            { cwd: '/synthetic/empty', name: '零会话旧项目', sessionCount: 0 }, { cwd: '/synthetic/unknown', name: '未确认项目' },
            { cwd: target, name: '目标', sessionCount: emptyTargets ? 0 : moved ? 2 : 1 }], roots: ['/synthetic'], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/projects/resolve') json = { cwd: url.searchParams.get('cwd') };
        else if (url.pathname === '/api/pi/sessions') json = { sessions: url.searchParams.get('cwd') === target && !emptyTargets
            ? [ ...(moved ? [current] : []), { id: 'target-existing', cwd: target, name: '已有目标线程', messageCount: 2 } ]
            : url.searchParams.get('cwd') === current.cwd ? [current] : [] };
        else if (url.pathname.endsWith('/resolve')) json = { session: current, moved };
        else if (url.pathname.endsWith('/move')) json = { source: original, targetCwd: url.searchParams.get('targetCwd'), revision: 'a'.repeat(64), canMove: !blocked,
            blockers: blocked ? ['线程有预约消息，请先处理或取消预约'] : [] };
        else if (url.pathname === '/api/pi/activity') json = { runtimes: [], replyNotices: [], archives: { projects: [], sessions: [] }, pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname.includes('history') || url.pathname === '/api/prompts') json = [];
        return route.fulfill({ json });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw), state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        if (command.type === 'open_session') {
            activeSocket = ws; opens.push(command.cwd);
            data = { session: { ...original, cwd: moved ? target : cwd }, state,
                messages: { messages: [{ role: 'user', content: '历史问题', timestamp: 1 }, { role: 'assistant', content: [{ type: 'text', text: '保留的历史回答' }], stopReason: 'stop', timestamp: 2 }] },
                stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        } else if (command.type === 'get_state') data = state;
        else assert.ok(!['prompt', 'steer', 'follow_up'].includes(command.type));
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => isSecureContext), !base.includes('pivane-http.test'));
    if (base.includes('pivane-http.test')) assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    await page.locator('#pi-input:not([disabled])').waitFor();
    await page.locator('#pi-input').fill('移动后保留的草稿');
    await page.locator('#pi-file-input').setInputFiles({ name: '保留附件.txt', mimeType: 'text/plain', buffer: Buffer.from('附件正文') });
    await page.locator('#pi-attachments').getByText('保留附件.txt', { exact: true }).waitFor();
    const open = async () => {
        // Let mobile viewport changes caused by leaving the draft input settle
        // before opening a transient menu that intentionally closes on resize.
        await page.locator('#pi-input').evaluate(input => input.blur());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator('#pi-current-thread-menu').click();
        await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: english ? 'Move to project…' : '移动到项目…', exact: true }).click();
        await page.locator('#pi-transfer-dialog[open]').waitFor();
        assert.deepEqual(await page.locator('#pi-transfer-project option').evaluateAll(options => options.map(option => option.value)), emptyTargets ? [''] : [target, '']);
        if (!emptyTargets) await page.locator('#pi-transfer-project').selectOption(target);
    };
    const dialog = page.locator('#pi-transfer-dialog');
    const check = () => dialog.getByRole('button', { name: english ? 'Check and preview' : '检查并预览', exact: true });
    const confirm = () => dialog.getByRole('button', { name: english ? 'Confirm move' : '确认移动', exact: true });
    await open(); assert.equal(posts.length, 0);
    if (emptyTargets) {
        assert.equal(await page.locator('#pi-transfer-path').isVisible(), true);
        await page.locator('#pi-transfer-path').fill('/synthetic/empty');
        await check().click(); await confirm().waitFor();
        assert.equal(posts.length, 0); await page.keyboard.press('Escape');
        assert.deepEqual(errors, []); await context.close();
        console.log(JSON.stringify({ width, language, variant: 'empty-targets-manual-path', status: 'passed', pageerrors: errors.length })); return;
    }
    await page.locator('#pi-transfer-project').selectOption('');
    await page.locator('#pi-transfer-path').fill('/synthetic/empty');
    await check().click(); await confirm().waitFor();
    await page.keyboard.press('Escape'); assert.equal(posts.length, 0);
    await open(); blocked = true; await check().click();
    await dialog.getByText(english ? 'Handle or cancel scheduled messages before moving.' : '线程有预约消息，请先处理或取消预约', { exact: true }).waitFor();
    assert.equal(await confirm().count(), 0); assert.equal(posts.length, 0); blocked = false;
    await check().click(); await confirm().waitFor();
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const overflow = await dialog.evaluate(element => [element, ...element.querySelectorAll('label, select, input, p')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.tagName));
        assert.deepEqual(overflow, []); assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1));
    }
    failMove = true; hold = true; await confirm().click();
    await page.waitForFunction(() => document.querySelector('#pi-transfer-dialog header button').disabled);
    await page.keyboard.press('Escape'); assert.equal(await dialog.evaluate(element => element.open), true);
    assert.equal(await dialog.locator('footer button').isDisabled(), true);
    assert.equal(posts.length, 1); assert.ok(release); release(); release = null;
    await dialog.getByText(/fixture move uncertain/).waitFor(); assert.equal(await confirm().count(), 0); assert.equal(posts.length, 1);
    assert.equal(await page.locator('#pi-input').inputValue(), '移动后保留的草稿');
    await page.keyboard.press('Escape'); failMove = false;
    await open(); await check().click(); await confirm().waitFor(); await confirm().click();
    await dialog.getByText(english ? 'The session is saved. Its old address still resolves to this thread.' : '会话已保存，旧地址仍可定位到此线程。', { exact: true }).waitFor();
    await page.locator('#pi-input:not([disabled])').waitFor();
    assert.equal(posts.length, 2); assert.equal(await page.locator('#pi-input').inputValue(), '移动后保留的草稿');
    assert.equal(await page.locator('#pi-attachments').getByText('保留附件.txt', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pi.web.expandedProjects')).length > 0), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('pi.web.cwd')), target);
    await page.screenshot({ path: '/tmp/pivane-session-move-' + width + '-' + language + '.png' });
    await page.keyboard.press('Escape');
    const oldAddress = base + '/#/chat?cwd=' + encodeURIComponent(cwd) + '&sessionId=original-thread';
    await page.goto(oldAddress, { waitUntil: 'domcontentloaded' }); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('pi.web.cwd')), target);
    assert.match(await page.locator('#pi-transcript').innerText(), /保留的历史回答/);
    oldBackend = true; await page.reload({ waitUntil: 'domcontentloaded' });
    try { await page.locator('#pi-input:not([disabled])').waitFor(); }
    catch (error) { console.log(JSON.stringify({ url: page.url(), errors, opens, body: (await page.locator('body').innerText()).slice(-2500), saved: await page.evaluate(() => ({ cwd: localStorage.getItem('pi.web.cwd'), id: localStorage.getItem('pi.web.session:' + localStorage.getItem('pi.web.cwd')) })) })); throw error; }
    await page.locator('#pi-current-thread-menu').click();
    assert.equal(await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: english ? 'Move to project…' : '移动到项目…', exact: true }).count(), 0);
    assert.deepEqual(errors, []); await context.close(); console.log(JSON.stringify({ width, language, status: 'passed', pageerrors: errors.length }));
}
(async () => {
    const app = express(), root = path.resolve(__dirname, '../..');
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP pivane-http.test 127.0.0.1'] });
    try {
        const base = 'http://pivane-http.test:' + server.address().port;
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await run(browser, base, width, language);
        await run(browser, base, 1440, 'en', true); await run(browser, base, 393, 'zh-CN', true);
    }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
