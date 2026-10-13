const assert = require('node:assert/strict');
const path = require('node:path'), http = require('node:http'), { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { marker } = require('../../public/pi-document-references');
const root = path.resolve(__dirname, '../..'), cwd = '/projects/durability-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const sessions = ['a', 'b'].map(id => ({ id, cwd, name: id, messageCount: 0 }));
const documentRef = { id: 'a'.repeat(64), revision: 'b'.repeat(64), name: '原件 <img src=x>.docx', format: 'docx', size: 2048 };
const orphan = { id: 'c'.repeat(64), name: 'Unused.docx', size: 4096, sessionId: 'a', savedReference: 'not-found' };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pNn8AAAAASUVORK5CYII=' };
const payload = { message: 'Recovered text\n' + marker(documentRef), images: [image] };
const controlsFor = id => ({ runtimeId: 'runtime-' + id, revision: 1, durable: true, queue: { steering: [], followUp: [] }, recoveries: [], stopping: false,
    extension: { title: '', statuses: [], widgets: [] } });
const recovery = id => ({ id, status: 'recovered', state: 'recovered', durable: true, hasPayload: true, imageCount: 1, steering: [], followUp: ['Recovered text'] });
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ locale, viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], commands = [], writes = [], readStarted = Promise.withResolvers(), openRuntimes = new Set();
    let socket, active = 'a', controls = controlsFor('a'), readPayload = payload, heldRead, holdRead = false, rejectDelete = true, deleted = false, receipt;
    controls.recoveries = [recovery('first')];
    const label = (zh, en) => locale === 'en' ? en : zh;
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, r => r.abort());
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'a'); }, { cwd });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), endpoint = url.pathname, json = data => route.fulfill({ json: data });
        if (endpoint.includes('/uploads/storage/')) {
            const body = req.method() === 'POST' ? req.postDataJSON() : Object.fromEntries(url.searchParams);
            writes.push({ endpoint, body, method: req.method() });
            if (endpoint.endsWith('/usage')) return json({ totalBytes: deleted ? 2048 : 6144, count: deleted ? 1 : 2, limits: { bytes: 2 * 1024 ** 3, count: 10000 }, complete: true,
                items: [{ ...documentRef, sessionId: 'a', savedReference: body.draftIds.includes(documentRef.id) ? 'protected' : 'not-found' }, ...deleted ? [] : [orphan]] });
            if (endpoint.endsWith('/preview')) {
                if (openRuntimes.size) return route.fulfill({ status: 409, json: { code: 'DOCUMENT_STORAGE_BUSY', error: '请先退出工作台中已打开的运行实例，再清理附件；用量仍可查看' } });
                return json({ ticket: 'ticket', revision: 'revision', item: orphan });
            }
            if (endpoint.endsWith('/cleanup')) {
                assert.equal(body.confirmed, true); assert.equal(body.externalWritersStopped, true); assert.ok(body.draftIds.includes(documentRef.id));
                if (rejectDelete) { rejectDelete = false; return route.fulfill({ status: 409, json: { code: 'DOCUMENT_STORAGE_CHANGED', error: '附件或保存引用已变化，请重新预览' } }); }
                deleted = true; receipt = { state: 'deleted', id: orphan.id, requestId: body.requestId }; return route.abort();
            }
            if (endpoint.endsWith('/status')) { assert.equal(body.requestId, receipt.requestId); return json(receipt); }
        }
        if (endpoint === '/api/pi/status') return json({ ok: true, runtimeControls: true, documentUploads: true, documentStorage: true, durableQueueRecovery: true, projectRoots: ['/projects'] });
        if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Durability', sessionCount: 2 }], roots: ['/projects'] });
        if (endpoint === '/api/pi/sessions') return json({ sessions });
        if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (req.method() !== 'GET') throw new Error('Unexpected write: ' + endpoint);
        return json(endpoint.includes('history') || endpoint === '/api/prompts' ? [] : {});
    });
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    const push = () => { controls.revision++; socket.send(JSON.stringify({ type: 'gateway_controls', controls })); };
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd);
            const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, webControls: controls };
            if (cmd.type === 'open_session') {
                active = cmd.sessionId;
                if (active === 'b' || commands.filter(c => c.type === 'open_session' && c.sessionId === 'a').length > 1) controls = controlsFor(active);
                openRuntimes.add(active);
                return reply(ws, cmd, { session: sessions.find(s => s.id === active), state: { ...state, webControls: controls }, controls,
                    messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (cmd.type === 'get_recovery_payload') {
                const finish = () => reply(ws, cmd, { payload: readPayload });
                if (holdRead) { heldRead = finish; readStarted.resolve(); } else finish(); return;
            }
            if (cmd.type === 'ack_recovery') { controls.recoveries = []; controls.revision++; return reply(ws, cmd, controls); }
            if (cmd.type === 'quit_session') { openRuntimes.delete(active); return reply(ws, cmd, {}); }
            if (cmd.type === 'get_state') return reply(ws, cmd, state);
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [] });
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
            throw new Error('Unexpected RPC: ' + cmd.type);
        });
    });
    const insecure = width === 1440 && locale === 'en';
    const target = new URL(base); if (insecure) target.hostname = 'pivane-durability.test';
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    if (insecure) assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, 'undefined']);
    const input = page.locator('#pi-input'), chips = page.locator('#pi-attachments .pi-attachment-chip'), queueDialog = page.locator('#pi-queue-dialog');
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await input.fill('Existing draft'); await page.locator('#pi-queue-open').click(); await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === 2);
    assert.equal(await input.inputValue(), 'Existing draft\n\nRecovered text'); assert.equal(commands.filter(c => c.type === 'ack_recovery').length, 1);
    assert.match(await chips.allTextContents().then(v => v.join('')), /原件/);
    controls.recoveries = [recovery('budget')]; readPayload = { message: 'Budget candidate', images: Array(6).fill(image) }; push();
    await page.locator('[data-recovery-id="budget"] [data-recovery-append]').click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('6'));
    assert.equal(await input.inputValue(), 'Existing draft\n\nRecovered text'); assert.equal(await chips.count(), 2);
    assert.equal(commands.some(c => c.type === 'ack_recovery' && c.recoveryId === 'budget'), false);
    controls.recoveries = [recovery('late')]; readPayload = payload; holdRead = true; push();
    await page.locator('[data-recovery-id="late"] [data-recovery-append]').click();
    await readStarted.promise; assert.ok(heldRead); await queueDialog.locator('.pi-native-heading button').click();
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click(); await page.locator('[data-session-id="b"] .pi-session-main').click();
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled && document.querySelector('#pi-meta-id').textContent === 'b');
    await input.fill('Other draft'); heldRead(); controls.recoveries = [recovery('after-late')]; push();
    await page.locator('#pi-queue-open').click(); await page.locator('[data-recovery-id="after-late"]').waitFor();
    assert.equal(await input.inputValue(), 'Other draft'); assert.equal(await chips.count(), 0); assert.equal(commands.some(c => c.type === 'ack_recovery' && c.recoveryId === 'late'), false);
    await queueDialog.locator('.pi-native-heading button').click();
    await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-document-storage-open').click();
    const storage = page.locator('dialog.pi-document-storage');
    await storage.locator(`[data-document-id="${orphan.id}"]`).waitFor();
    assert.ok(writes.at(-1).body.draftIds.includes(documentRef.id), 'another saved composer draft remains protected');
    assert.equal(await storage.locator(`[data-document-id="${documentRef.id}"] button`).isDisabled(), true);
    await storage.locator(`[data-document-id="${orphan.id}"] button`).click();
    await storage.getByRole('status').filter({ hasText: label('请先退出', 'Exit all open') }).waitFor();
    await storage.getByRole('button', { name: label('关闭', 'Close'), exact: true }).click();
    const exitRuntime = async () => {
        await page.locator('#pi-current-thread-menu').click();
        await page.locator('.pi-thread-menu [role="menuitem"]').filter({ has: page.locator('i.fa-right-from-bracket') }).click();
        await page.waitForFunction(() => document.querySelector('#pi-input').disabled);
    };
    await exitRuntime(); assert.equal(await input.inputValue(), 'Other draft');
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click(); await page.locator('[data-session-id="a"] .pi-session-main').click();
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled && document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === 2);
    await exitRuntime(); assert.equal(await chips.count(), 2); assert.equal(await input.inputValue(), 'Existing draft\n\nRecovered text');
    assert.equal(openRuntimes.size, 0);
    await page.locator('#workspace-settings-toggle').click(); await page.locator('[data-settings-tab="usage"]').click();
    await page.locator('#settings-document-storage').click(); await storage.locator(`[data-document-id="${orphan.id}"]`).waitFor();
    const preview = async () => {
        await storage.locator(`[data-document-id="${orphan.id}"] button`).click();
        const confirm = storage.getByRole('button', { name: label('永久删除原件', 'Permanently delete original'), exact: true });
        assert.equal(await confirm.isDisabled(), true); await storage.locator('input[type="checkbox"]').check(); await confirm.click();
    };
    await preview(); await storage.getByRole('button', { name: label('刷新用量', 'Refresh usage'), exact: true }).click();
    await storage.locator(`[data-document-id="${orphan.id}"]`).waitFor(); await preview();
    await storage.getByRole('button', { name: label('查询清理结果', 'Check cleanup result'), exact: true }).click();
    await storage.locator(`[data-document-id="${orphan.id}"]`).waitFor({ state: 'detached' });
    await storage.locator(`[data-document-id="${documentRef.id}"]`).waitFor();
    assert.equal(writes.filter(w => w.endpoint.endsWith('/cleanup')).length, 2, 'one refusal and one confirmed deletion; no automatic retry');
    assert.equal(commands.some(c => ['prompt', 'steer', 'follow_up'].includes(c.type)), false);
    await page.screenshot({ path: `/tmp/pi-durability-${width}-${locale}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await storage.evaluate(n => n.scrollWidth > n.clientWidth + 1), false);
    if (locale === 'en') assert.equal(await storage.getAttribute('aria-label'), 'Attachment management');
    await storage.getByRole('button', { name: label('关闭', 'Close'), exact: true }).click();
    assert.equal(await page.locator('#settings-document-storage').isVisible(), true);
    assert.equal(commands.filter(c => c.type === 'quit_session').length, 2);
    assert.deepEqual(errors, []); console.log(`PASS ${width} ${locale}: full composer recovery, combined budget, stale response, draft protection, explicit cleanup/status and settings entry`);
    await context.close();
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP pivane-durability.test 127.0.0.1', '--no-proxy-server'] });
    try { for (const [width, locale] of [[1440, 'zh-CN'], [393, 'zh-CN'], [320, 'en'], [1440, 'en']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
