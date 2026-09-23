const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_WORKFLOWS_TEST_URL || 'http://127.0.0.1:3101';
const cwd = '/srv/workflow-browser-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const original = { id: 'workflow-original', cwd, name: '会话操作回归', messageCount: 4 };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=' };
const initial = [{ role: 'user', content: '第一条问题', timestamp: 1 }, { role: 'assistant', content: '第一条回复', timestamp: 2 }, { role: 'user', content: [{ type: 'text', text: '上一条问题 <img src=x onerror=alert(1)>' }, image], timestamp: 3 }, { role: 'assistant', content: '旧的回复', timestamp: 4 }];

async function run(browser, viewport, historyEnabled = true) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [], writes = [], rpc = [];
    let sessions = [original], messages = structuredClone(initial), leafId = 'leaf-original', stale = false, streaming = false;
    let jobs = [], socket, active = original;
    let writeGate = null, releaseWrite = null, writeStarted = null;
    const workflow = () => ({ leafId, lastUserId: leafId === 'leaf-retry' ? 'user-retry' : 'user-last', prompts: [
        { entryId: 'user-first', text: '第一条问题', timestamp: 1 },
        { entryId: leafId === 'leaf-retry' ? 'user-retry' : 'user-last', text: leafId === 'leaf-retry' ? '新的提示词' : '上一条问题 <img src=x onerror=alert(1)>', timestamp: 3 }
    ], versions: leafId === 'leaf-retry' ? [{ entryId: 'leaf-original', timestamp: new Date().toISOString(), text: '原来的问题与回复' }] : [] });
    const send = event => socket?.send(JSON.stringify(event));
    const reply = (ws, command, data) => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    const stats = { contextUsage: { tokens: 1000, percent: 1, contextWindow: 128000 }, totalMessages: 4 };
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); }, { cwd, id: original.id });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), endpoint = url.pathname;
        const response = (json, status = 200) => route.fulfill({ json, status });
        if (req.method() !== 'GET') {
            const body = req.postDataJSON(); writes.push({ endpoint, body, method: req.method() });
            if (writeGate) { writeStarted?.(); await writeGate; }
            if (endpoint.endsWith('/fork')) {
                const session = { ...original, id: `fork-${sessions.length}`, name: '新的分叉线程' }; sessions.push(session);
                return response({ session, draft: body.entryId ? { message: '上一条问题 <img src=x onerror=alert(1)>', images: [image] } : null }, 201);
            }
            if (endpoint.endsWith('/retry')) {
                if (stale) return response({ error: '会话已变化，请重新打开操作面板' }, 400);
                assert.equal(body.entryId, 'user-last');
                assert.equal(body.images.length, 1);
                leafId = 'leaf-retry';
                messages = [...initial.slice(0, 2), { role: 'user', content: [{ type: 'text', text: body.message }, ...body.images], timestamp: 3 }, { role: 'assistant', content: '新的回复', timestamp: 5 }];
                for (const job of jobs) if (job.status === 'scheduled') { job.status = 'paused'; job.revision++; }
                send({ type: 'gateway_context_changed' });
                return response({ accepted: true });
            }
            if (endpoint.endsWith('/restore')) { leafId = 'leaf-original'; messages = structuredClone(initial); send({ type: 'gateway_context_changed' }); return response({ restored: true }); }
            if (endpoint.endsWith('/deferred')) {
                if (!jobs.some(job => job.id === body.id)) jobs.push({ ...body, sessionId: active.id, payload: { message: body.message, images: body.images }, status: 'scheduled', revision: 1 });
                return response(jobs.at(-1), 201);
            }
            if (endpoint.includes('/deferred/')) {
                const job = jobs.find(item => item.id === endpoint.split('/').at(-1));
                if (body.revision !== job.revision) return response({ error: '消息已更新' }, 400);
                job.revision++;
                if (body.action === 'save') { job.payload = { message: body.message, images: body.images }; job.dueAt = body.dueAt; job.status = 'scheduled'; }
                if (body.action === 'pause') job.status = 'paused';
                if (body.action === 'cancel') { job.status = 'cancelled'; delete job.payload; }
                if (body.action === 'send') { job.status = 'sent'; delete job.payload; }
                return response(job);
            }
            throw new Error(`Unexpected write ${endpoint}`);
        }
        if (endpoint === '/api/pi/status') return response({ ok: true, version: '0.85.0', historySearch: historyEnabled, sessionTree: historyEnabled, historyBody: historyEnabled, sessionWorkflows: true, projectRoots: ['/srv'] });
        if (endpoint === '/api/pi/projects') return response({ projects: [{ cwd, name: 'Workflow fixture', sessionCount: sessions.length }], roots: ['/srv'] });
        if (endpoint === '/api/pi/sessions') return response({ sessions });
        if (endpoint === '/api/pi/activity') return response({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint.endsWith('/workflow')) return response(workflow());
        if (endpoint.includes('/prompt/')) return response({ leafId, message: endpoint.endsWith('user-first') ? '第一条问题' : '上一条问题 <img src=x onerror=alert(1)>', images: endpoint.endsWith('user-first') ? [] : [image] });
        if (endpoint.endsWith('/deferred')) return response({ jobs: jobs.filter(job => job.sessionId === active.id).map(job => ({ ...job, preview: job.payload?.message || '', imageCount: job.payload?.images.length || 0 })) });
        if (endpoint.includes('history') || endpoint === '/api/prompts') return response([]);
        return response({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); rpc.push(command);
            const runtime = { model, thinkingLevel: 'off', isStreaming: streaming, isCompacting: false, autoCompactionEnabled: true };
            if (command.type === 'open_session') {
                active = sessions.find(item => item.id === command.sessionId) || original;
                return reply(ws, command, { session: active, state: runtime, messages: { messages }, stats, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (command.type === 'search_history') return reply(ws, command, { results: [], total: 0, offset: 0, pageSize: 30, hasMore: false });
            if (command.type === 'get_session_tree') return reply(ws, command, { rows: [], total: 0, offset: 0, pageSize: 100, hasMore: false });
            if (command.type === 'get_state') return reply(ws, command, runtime);
            if (command.type === 'get_messages') return reply(ws, command, { messages });
            if (command.type === 'get_session_stats') return reply(ws, command, stats);
            throw new Error(`Unexpected RPC ${command.type}`);
        });
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-message-workflow="retry"]').waitFor();
    const close = () => page.locator('#pi-workflow-close').click();
    const pendingWrite = async (selector, label, confirm = true) => {
        const before = writes.length;
        writeGate = new Promise(resolve => { releaseWrite = resolve; });
        const started = new Promise(resolve => { writeStarted = resolve; });
        try {
            await page.locator(selector).click();
            await started;
            await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'true', selector);
            assert.equal(await page.locator(selector).isDisabled(), true);
            assert.equal(await page.locator(selector).getAttribute('aria-label'), label);
            assert.equal(await page.locator('#pi-workflow-close').isDisabled(), true);
            assert.equal(await page.locator('.pi-action-status').textContent(), label);
            await page.locator('#pi-workflow-dialog').press('Escape');
            assert.equal(await page.locator('#pi-workflow-dialog').evaluate(n => n.open), true);
            if (confirm) await page.locator('#pi-workflow-form').evaluate(n => n.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
            else await page.locator(selector).evaluate(n => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
            await page.waitForFunction(() => document.querySelector('#pi-workflow-dialog').open);
            assert.equal(writes.length, before + 1, 'pending action must submit exactly once');
            assert.equal(await page.locator('#pi-workflow-dialog').evaluate(n => n.scrollWidth > n.clientWidth + 1), false);
            await page.screenshot({ path: `/tmp/pi-workflows-${viewport.width}-pending-${confirm ? 'confirm' : 'pause'}.png` });
        } finally { releaseWrite(); writeGate = null; writeStarted = null; }
    };
    const inspector = async () => {
        if (!historyEnabled) {
            await closeInspector();
            await page.locator('#pi-current-thread-menu').click();
            await page.getByRole('menuitem', { name: '历史与记录', exact: true }).click();
            return;
        }
        if (!await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-toggle-inspector').click();
        await page.locator('#pi-history-tab').click();
        await page.locator('#pi-history-more').click();
    };
    const historyAction = label => page.getByRole('menuitem', { name: label, exact: true }).click();
    const closeInspector = async () => { if (await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-close-inspector').click(); };
    const overflow = async () => {
        assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
        assert.equal(await page.locator('#pi-workflow-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
    };
    await page.locator('#pi-toggle-inspector').click();
    assert.equal(await page.locator('#pi-runtime-settings').getAttribute('open'), null);
    assert.equal(await page.locator('#pi-session-information').getAttribute('open'), null);
    assert.equal(await page.locator('#pi-inspector-details button').filter({ hasText: /复制为新线程|分叉|待发送|重命名|删除/ }).count(), 0);
    assert.equal(await page.locator('#pi-compact-button').isVisible(), true);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.screenshot({ path: `/tmp/pi-inspector-slim-${viewport.width}-${theme}.png` });
        assert.equal(await page.locator('#pi-inspector-details').evaluate(n => n.scrollWidth > n.clientWidth), false);
        if (!historyEnabled) continue;
        await page.locator('#pi-history-tab').click();
        const before = await page.locator('#pi-history-browse').boundingBox();
        await page.locator('#pi-history-more').click();
        assert.equal(await page.getByRole('menuitem').count(), 2);
        const menu = await page.locator('.pi-thread-menu:not(.hidden)').boundingBox();
        assert.ok(menu.x >= 0 && menu.x + menu.width <= viewport.width && menu.height < 130);
        assert.deepEqual(await page.locator('#pi-history-browse').boundingBox(), before, 'menu must not shrink history');
        await page.screenshot({ path: `/tmp/pi-history-slim-${viewport.width}-${theme}.png` });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#pi-history-more').evaluate(n => n === document.activeElement), true);
        await page.locator('#pi-history-more').click();
        await page.locator('#pi-history-query').click();
        assert.equal(await page.locator('#pi-history-more').getAttribute('aria-expanded'), 'false');
        await page.locator('#pi-history-more').click();
        await page.locator('#pi-details-tab').click();
        assert.equal(await page.locator('.pi-thread-menu:not(.hidden)').count(), 0);
    }
    await closeInspector();
    await page.locator('#pi-input').fill('保留未发送草稿');
    await page.locator('[data-message-workflow="retry"]').click();
    assert.match(await page.locator('#pi-workflow-message').inputValue(), /上一条问题/);
    assert.equal(await page.locator('#pi-workflow-images img').count(), 1);
    assert.equal(await page.locator('#pi-workflow-content img[onerror]').count(), 0);
    await page.locator('#pi-workflow-files').setInputFiles({ name: 'extra.png', mimeType: 'image/png', buffer: Buffer.from(image.data, 'base64') });
    await page.waitForFunction(() => document.querySelectorAll('#pi-workflow-images img').length === 2 && [...document.querySelectorAll('#pi-workflow-images img')].every(image => image.complete && image.naturalWidth > 0));
    await page.locator('[data-remove-image="1"]').click();
    assert.equal(await page.locator('#pi-workflow-images img').count(), 1);
    await overflow();
    await page.screenshot({ path: `/tmp/pi-workflows-${viewport.width}-retry.png` });
    await page.locator('#pi-workflow-message').fill('取消编辑的内容');
    await close();
    assert.equal(writes.length, 0);
    assert.equal(await page.locator('#pi-input').inputValue(), '保留未发送草稿');
    let releaseRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const delayedPrompt = async route => { await readGate; await route.fallback(); };
    await page.route('**/prompt/**', delayedPrompt);
    await page.locator('[data-message-workflow="retry"]').click();
    await page.locator('#pi-workflow-content[aria-busy="true"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.pi-action-status').isVisible(), true);
    assert.equal(await page.locator('.pi-action-status').textContent(), '正在加载…');
    await close();
    await page.locator('#pi-composer-add-button').click();
    await page.locator('#pi-schedule-button').click();
    await page.locator('#pi-workflow-message').fill('保留新面板的编辑');
    const readResponse = page.waitForResponse(response => response.url().includes('/prompt/'));
    releaseRead(); await readResponse;
    await page.waitForFunction(() => !document.querySelector('[data-message-workflow="retry"]').hasAttribute('aria-busy'));
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), '保留新面板的编辑');
    assert.equal(await page.locator('#pi-workflow-title').textContent(), '延迟发送');
    await page.unroute('**/prompt/**', delayedPrompt);
    await close();
    stale = true;
    await page.locator('[data-message-workflow="retry"]').click();
    await page.locator('#pi-workflow-message').fill('新的提示词');
    await pendingWrite('#pi-workflow-submit', '正在回退并发送…');
    await page.locator('#pi-workflow-error:not([hidden])').waitFor();
    assert.equal(await page.locator('#pi-workflow-submit').getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#pi-workflow-submit').textContent(), '回退并发送');
    assert.equal(await page.locator('#pi-workflow-submit').isDisabled(), false);
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), '新的提示词');
    await close(); stale = false;
    await page.locator('#pi-composer-add-button').click();
    await page.locator('#pi-schedule-button').click();
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), '保留未发送草稿');
    await page.locator('#pi-workflow-message').fill('稍后发送的消息');
    await page.locator('#pi-workflow-delay').fill('5');
    await pendingWrite('#pi-workflow-submit', '正在预约…');
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open);
    assert.equal(jobs.length, 1);
    assert.equal(await page.locator('#pi-input').inputValue(), '');
    // Blurring this focused mobile composer must not move the banner away
    // between pointerdown and pointerup: one real click opens the list.
    await page.locator('#pi-composer-add-button').focus();
    await page.locator('#pi-deferred-open').click();
    await page.locator('[data-workflow-action="edit"]').click();
    await page.locator('#pi-workflow-message').fill('修改后的延迟消息');
    await page.locator('#pi-workflow-time-mode').selectOption('delay');
    await page.locator('#pi-workflow-delay').fill('15');
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open);
    assert.equal(jobs[0].payload.message, '修改后的延迟消息');
    await page.locator('#pi-deferred-open').click();
    await pendingWrite('[data-workflow-action="pause"]', '正在暂停…', false);
    await page.waitForFunction(() => document.querySelector('#pi-workflow-content').textContent.includes('已暂停'));
    await overflow(); await page.screenshot({ path: `/tmp/pi-workflows-${viewport.width}-deferred.png` });
    await close();
    await page.locator('[data-message-workflow="retry"]').click();
    await page.locator('#pi-workflow-message').fill('新的提示词');
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open && document.querySelector('#pi-transcript-content').textContent.includes('新的回复'));
    assert.ok(!(await page.locator('#pi-transcript-content').textContent()).includes('旧的回复'));
    await inspector(); await historyAction('恢复旧版本');
    await page.locator('[data-workflow-action="restore"]').click(); await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open && document.querySelector('#pi-transcript-content').textContent.includes('旧的回复'));
    await closeInspector();
    await page.locator('#pi-input').fill('原线程独立草稿');
    await inspector(); await historyAction('从历史问题分叉');
    await page.locator('[data-workflow-action="fork"]').first().click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-submit').disabled);
    await pendingWrite('#pi-workflow-submit', '正在创建分叉…');
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open && document.querySelector('#pi-input').value.includes('上一条问题'));
    assert.equal(sessions.length, 2);
    assert.equal(await page.locator('#pi-attachments img').count(), 1);
    const opensBeforeClone = rpc.filter(c => c.type === 'open_session').length;
    await closeInspector(); await page.locator('#pi-current-thread-menu').click();
    await historyAction('复制为新线程');
    await page.locator('#pi-workflow-dialog[open]').waitFor();
    assert.equal(rpc.filter(c => c.type === 'open_session').length, opensBeforeClone, 'opening clone must retain the current connection');
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open && document.querySelector('#pi-input').value === '').catch(async error => {
        console.error('Clone state', await page.evaluate(() => ({ open: document.querySelector('#pi-workflow-dialog').open, input: document.querySelector('#pi-input').value, error: document.querySelector('#pi-workflow-error').textContent, status: document.querySelector('.pi-action-status').textContent, toasts: document.querySelector('#pi-toast-region').textContent })), { sessions: sessions.length, writes, opens: rpc.filter(c => c.type === 'open_session') });
        throw error;
    });
    assert.equal(sessions.length, 3);
    await closeInspector();
    if (viewport.width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator(`[data-session-id="${original.id}"] .pi-session-main`).click();
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '原线程独立草稿');
    streaming = true; send({ type: 'agent_start' });
    await page.waitForFunction(() => document.querySelector('[data-message-workflow="retry"]')?.disabled === true);
    const liveUser = { role: 'user', content: '来自服务端的延迟消息', timestamp: 10 };
    send({ type: 'message_end', message: liveUser }); send({ type: 'message_end', message: liveUser });
    await page.waitForFunction(() => document.querySelector('#pi-transcript-content').textContent.includes('来自服务端的延迟消息'));
    assert.equal(await page.locator('article.user').filter({ hasText: '来自服务端的延迟消息' }).count(), 1);
    assert.equal(await page.locator('#pi-schedule-button').isDisabled(), false);
    streaming = false; send({ type: 'agent_settled' });
    jobs[0].status = 'uncertain'; jobs[0].revision++;
    await page.locator('#pi-deferred-open').click();
    await page.locator('[data-workflow-action="send"]').click();
    const beforeConfirm = writes.length;
    await page.locator('#pi-workflow-submit').click();
    assert.equal(writes.length, beforeConfirm, 'uncertain send requires an explicit checkbox');
    await page.locator('#pi-workflow-uncertain').check();
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open);
    assert.equal(jobs[0].status, 'sent');
    await page.locator('#pi-composer-add-button').click();
    await page.locator('#pi-schedule-button').click();
    await page.locator('#pi-workflow-message').fill('待取消的消息');
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open);
    await page.locator('#pi-deferred-open').click();
    await page.locator('[data-workflow-action="cancel"]').click(); await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-dialog').open);
    assert.equal(jobs[1].status, 'cancelled');
    await inspector(); await historyAction('从历史问题分叉');
    await overflow(); await page.screenshot({ path: `/tmp/pi-workflows-${viewport.width}-history.png` });
    await page.locator('#pi-workflow-dialog').press('Escape');
    await closeInspector();
    await page.waitForFunction(() => document.querySelectorAll('#pi-toast-region .pi-toast').length === 0);
    await page.screenshot({ path: `/tmp/pi-workflows-${viewport.width}-main.png` });
    assert.deepEqual(errors, []);
    assert.equal(rpc.some(command => ['prompt', 'steer', 'follow_up'].includes(command.type)), false);
    assert.equal(writes.some(write => !write.endpoint.startsWith('/api/pi/sessions/')), false);
    await context.close();
    console.log(`Workflows ${viewport.width}x${viewport.height} history=${historyEnabled}: passed (${writes.length} mocked writes)`);
}

(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }, { width: 320, height: 740 }]) await run(browser, viewport);
        await run(browser, { width: 393, height: 852 }, false);
    }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
