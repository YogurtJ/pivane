const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { searchHistory, previewHistory, setHistoryBookmark } = require('../../server/pi-history-model');
const { sessionTree, checkNavigation } = require('../../server/pi-session-tree');
const { promptFromEntry } = require('../../server/pi-message-payload');
const base = process.env.PI_TREE_TEST_URL || 'http://127.0.0.1:3134', cwd = '/srv/tree-fixture';
async function run(browser, viewport, SessionManager) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage(), errors = [], commands = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    const sm = SessionManager.inMemory(cwd), other = SessionManager.inMemory(cwd);
    const u = text => ({ role: 'user', content: text, timestamp: Date.now() });
    const a = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(), stopReason: 'stop' });
    const first = sm.appendMessage({ ...u('原始问题'), timestamp: 0 }); const common = sm.appendMessage(a('共同结论'));
    const old = sm.appendMessage(u('尝试旧路线 A')); const oldReply = sm.appendMessage(a('旧路线已验证'));
    sm.branch(common); sm.appendMessage(u('试试方案 B'));
    const call = { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/long/path/only-in-tool.js', limit: 300, offset: 2435 } };
    const pure = sm.appendMessage({ ...a(''), content: [call], stopReason: 'toolUse' });
    sm.appendMessage({ role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'only-in-tool result' }], timestamp: Date.now() });
    const mixed = sm.appendMessage({ ...a('进展说明'), content: [...a('进展说明').content, call], stopReason: 'toolUse' });
    const replyId = sm.appendMessage(a('# 方案 B 的结论\n\n有效信息在这里。\n\n- **明确结论**：采用 B。\n- 兼容条件已核对。\n\n' + Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 段：这是用户需要阅读的决策与说明。`).join('\n\n')));
    other.appendMessage(u('另一个线程')); other.appendMessage(a('另一段回复'));
    const sessions = [{ id: 'a', cwd, name: 'Tree fixture', messageCount: 10 }, { id: 'b', cwd, name: 'Other thread', messageCount: 2 }];
    const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
    let current = sm, wsCurrent, hold = false, held, failNext = false, delayPreview = false, delayed;
    let navigation = { runtimeId: 'fixture', revision: 0, busy: false, job: null };
    const send = (ws, event) => ws.send(JSON.stringify(event));
    const respond = (ws, c, data, error) => send(ws, { type: 'response', id: c.id, command: c.type, success: !error, data, error });
    const navEvent = (ws, status, busy) => { navigation = { ...navigation, revision: navigation.revision + 1, busy, job: { ...navigation.job, status } }; send(ws, { type: 'gateway_navigation', navigation }); };
    const perform = (ws, c, manager) => {
        const target = checkNavigation(manager, c), draft = target.message?.role === 'user' ? promptFromEntry(target) : null;
        const from = manager.getLeafId(), position = draft ? target.parentId : target.id;
        if (c.summarize) manager.branchWithSummary(position, '离开分支的摘要'); else if (position) manager.branch(position); else manager.resetLeaf();
        manager.appendCustomEntry('pi5-web-navigation', { fromLeafId: from, targetId: target.id, mode: 'tree' });
        navEvent(ws, 'done', false); send(ws, { type: 'gateway_context_changed' }); respond(ws, c, { cancelled: false, leafId: manager.getLeafId(), draft });
    };
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a'); }, { cwd });
    await page.route('**/api/**', route => {
        const r = route.request(), p = new URL(r.url()).pathname;
        if (r.method() !== 'GET') { writes.push(p); return route.fulfill({ json: {} }); }
        if (p === '/api/pi/status') return route.fulfill({ json: { ok: true, historySearch: true, historyBody: true, sessionTree: true, sessionWorkflows: true, projectRoots: ['/srv'] } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Tree fixture', sessionCount: 2 }], roots: ['/srv'] } });
        if (p === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (p === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] } });
        if (p.endsWith('/deferred')) return route.fulfill({ json: { jobs: [] } });
        if (p.endsWith('/workflow')) return route.fulfill({ json: { prompts: [], replies: [], versions: [] } });
        return route.fulfill({ json: p.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        wsCurrent = ws;
        ws.onMessage(raw => {
            const c = JSON.parse(raw); commands.push(c);
            if (c.type === 'open_session') { current = c.sessionId === 'a' ? sm : other; navigation = { runtimeId: c.sessionId, revision: 0, busy: false, job: null }; return respond(ws, c, { session: sessions.find(s => s.id === c.sessionId), state: { model, isStreaming: false, webNavigation: navigation }, messages: { messages: current.buildSessionContext().messages }, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} }); }
            if (c.type === 'get_state') return respond(ws, c, { model, isStreaming: false, webNavigation: navigation });
            if (c.type === 'get_messages') return respond(ws, c, { messages: current.buildSessionContext().messages });
            if (c.type === 'get_session_stats') return respond(ws, c, {});
            try {
                if (c.type === 'search_history') return respond(ws, c, searchHistory(current, c));
                if (c.type === 'get_history_entry') { if (delayPreview) { delayed = { ws, c, manager: current }; return; } return respond(ws, c, previewHistory(current, c)); }
                if (c.type === 'get_session_tree') return respond(ws, c, sessionTree(current, c, { settled: !navigation.busy }));
                if (c.type === 'set_history_bookmark') { const result = setHistoryBookmark(current, c, current.appendLabelChange.bind(current)); send(ws, { type: 'gateway_history_changed', entryId: c.entryId }); return respond(ws, c, result); }
                if (c.type === 'navigate_history') {
                    const { id, type, ...input } = c; checkNavigation(current, input);
                    navigation.job = { id: 'nav-' + c.id, targetId: c.entryId, summarize: c.summarize }; navEvent(ws, c.summarize ? 'summarizing' : 'navigating', true);
                    if (failNext) { failNext = false; navEvent(ws, 'error', false); return respond(ws, c, null, 'fixture navigation failure'); }
                    if (hold) { held = { ws, c, manager: current }; return; }
                    return perform(ws, inputWithId(c), current);
                }
                if (c.type === 'cancel_history_navigation') {
                    navEvent(ws, 'cancelled', false); respond(held.ws, held.c, { cancelled: true }); held = null; hold = false; return respond(ws, c, navigation);
                }
            } catch (e) { return respond(ws, c, null, e.message); }
            throw Error('Unexpected RPC: ' + c.type);
        });
    });
    // Validate mutation fields separately from the RPC envelope.
    function inputWithId(c) { const { id, type, ...input } = c; Object.defineProperties(input, { id: { value: id }, type: { value: type } }); return input; }
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await page.locator('#pi-input').fill('保留已有草稿');
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-history-tab').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length > 0);
    assert.equal(await page.locator('#pi-history-filter').inputValue(), 'conversation');
    assert.equal(await page.locator(`[data-history-id="${pure}"]`).count(), 0);
    await page.locator('#pi-history-filter').selectOption('assistant');
    await page.waitForFunction(() => !document.querySelector('#pi-history-results').textContent.includes('用户问题'));
    assert.doesNotMatch(await page.locator('#pi-history-results').textContent(), /含工具调用|only-in-tool|limit:/);
    await page.locator(`[data-history-id="${mixed}"]`).click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
    assert.equal((await page.locator('#pi-history-text').textContent()).trim(), '进展说明');
    assert.equal(await page.locator('#pi-tree-navigation').isVisible(), false);
    await page.locator('#pi-history-record-toggle').click(); await page.waitForFunction(() => document.querySelector('#pi-history-text').textContent.includes('only-in-tool'));
    await page.locator('#pi-history-preview-close').click();
    await page.locator(`[data-history-id="${replyId}"]`).click(); await page.locator('#pi-history-text h1').waitFor();
    assert.equal(await page.locator('#pi-history-browse').isVisible(), false);
    const dimensions = await page.evaluate(() => ({ text: document.querySelector('#pi-history-text').getBoundingClientRect().height, panel: document.querySelector('#pi-history').getBoundingClientRect().height }));
    assert.ok(dimensions.text / dimensions.panel > .40, JSON.stringify(dimensions));
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        assert.deepEqual(await page.evaluate(() => ['body', '#pi-inspector', '#pi-history', '#pi-history-text'].filter(s => { const n = document.querySelector(s); return n.scrollWidth > n.clientWidth + 1; })), []);
        await page.screenshot({ path: `/tmp/pi-tree-reading-${viewport.width}-${theme}.png` });
    }
    await page.locator('#pi-history-preview-close').click();
    await page.locator('#pi-history-query').fill('only-in-tool'); await page.waitForFunction(() => document.querySelector('#pi-history-status').textContent === '没有匹配的记录');
    await page.locator('#pi-history-filter').selectOption('tool'); await page.locator(`[data-history-id="${pure}"]`).waitFor();
    await page.locator('#pi-history-tree-mode').click(); await page.locator(`[data-tree-entry="${oldReply}"]`).waitFor();
    // Role/stage/time have distinct, accessible treatments; toolbar buttons are not view tabs.
    assert.equal(await page.locator(`[data-tree-entry="${first}"]`).getAttribute('data-kind'), 'user');
    assert.equal(await page.locator(`[data-tree-entry="${mixed}"]`).getAttribute('data-reply-stage'), 'progress');
    assert.equal(await page.locator(`[data-tree-entry="${replyId}"]`).getAttribute('data-reply-stage'), 'final');
    assert.equal(await page.locator(`[data-tree-entry="${first}"] time`).getAttribute('datetime'), '1970-01-01T00:00:00.000Z');
    assert.match(await page.locator(`[data-tree-entry="${first}"] time`).innerText(), /1970-/);
    const treeBytes = JSON.stringify(sm.getEntries());
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        const geometry = await page.evaluate(({ first, mixed, replyId }) => {
            const node = id => document.querySelector(`[data-tree-entry="${id}"]`);
            const style = n => getComputedStyle(n);
            const modes = document.querySelector('#pi-history-modes'), toolbar = document.querySelector('.pi-tree-toolbar');
            return {
                userColor: style(node(first).querySelector('.pi-tree-role')).color,
                aiColor: style(node(replyId).querySelector('.pi-tree-role')).color,
                finalColor: style(node(replyId).querySelector('.pi-tree-stage')).color,
                progressColor: style(node(mixed).querySelector('.pi-tree-stage')).color,
                modeDisplay: style(modes).display, modeBottom: modes.getBoundingClientRect().bottom, actionTop: toolbar.getBoundingClientRect().top,
                modeBackground: style(document.querySelector('#pi-history-tree-mode')).backgroundColor,
                actionBackground: style(document.querySelector('#pi-tree-current')).backgroundColor,
                overflow: [...document.querySelectorAll('#pi-history, #pi-history-browse, #pi-history-modes, .pi-tree-toolbar, .pi-tree-heading, .pi-tree-row, .pi-tree-time')].some(n => n.scrollWidth > n.clientWidth + 1)
            };
        }, { first, mixed, replyId });
        assert.notEqual(geometry.userColor, geometry.aiColor); assert.notEqual(geometry.finalColor, geometry.progressColor);
        assert.equal(geometry.modeDisplay, 'grid'); assert.ok(geometry.modeBottom <= geometry.actionTop);
        assert.notEqual(geometry.modeBackground, geometry.actionBackground); assert.equal(geometry.overflow, false);
        await page.evaluate(() => { document.querySelector('#pi-history-browse').scrollTop = 0; });
        await page.screenshot({ path: `/tmp/pi-tree-presentation-${viewport.width}-${theme}.png` });
    }
    assert.equal(JSON.stringify(sm.getEntries()), treeBytes, 'presentation never writes native history');
    const before = sm.getLeafId();
    await page.locator(`[data-tree-entry="${oldReply}"]`).click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' }); assert.equal(sm.getLeafId(), before);
    page.once('dialog', d => d.dismiss()); await page.locator('#pi-tree-continue').click(); assert.equal(sm.getLeafId(), before);
    page.once('dialog', d => d.accept()); await page.locator('#pi-tree-continue').click();
    await page.waitForFunction(() => document.querySelector('#pi-tree-progress-text').textContent.includes('已切换'));
    assert.equal(await page.locator('#pi-input').inputValue(), '保留已有草稿'); assert.match(JSON.stringify(sm.buildSessionContext().messages), /旧路线已验证/); assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /有效信息在这里/);
    await page.locator('#pi-history-preview-close').click(); await page.locator(`[data-tree-entry="${oldReply}"][data-current="true"]`).waitFor();
    await page.locator(`[data-tree-entry="${first}"]`).click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
    page.once('dialog', d => d.accept()); await page.locator('#pi-tree-continue').click(); await page.locator('#pi-tree-use-draft').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-input').inputValue(), '保留已有草稿');
    await page.locator('#pi-tree-use-draft').click(); assert.equal(await page.locator('#pi-input').inputValue(), '保留已有草稿\n\n原始问题');
    // Summary is opt-in and remains cancellable. New draft typing is preserved while it runs.
    await page.locator('#pi-history-preview-close').click(); await page.locator(`[data-tree-entry="${replyId}"]`).click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
    await page.locator('#pi-tree-options summary').click(); await page.locator('#pi-tree-summarize').check(); await page.locator('#pi-tree-focus').fill('保留限制');
    hold = true; page.once('dialog', d => d.accept()); await page.locator('#pi-tree-continue').click(); await page.locator('#pi-tree-cancel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    await page.locator('#pi-input').fill('摘要期间的新草稿');
    const heldLeaf = sm.getLeafId(); await page.locator('#pi-tree-cancel').click(); await page.waitForFunction(() => document.querySelector('#pi-tree-progress-text').textContent.includes('已取消'));
    assert.equal(sm.getLeafId(), heldLeaf); assert.equal(await page.locator('#pi-input').inputValue(), '摘要期间的新草稿');
    assert.equal(commands.filter(c => c.type === 'navigate_history').at(-1).customInstructions, '保留限制');
    // A bookmark from another page invalidates the selected navigation revision.
    sm.appendLabelChange(common, '另一页面书签'); send(wsCurrent, { type: 'gateway_history_changed', entryId: common });
    await page.waitForFunction(() => document.querySelector('#pi-tree-continue').textContent === '重新核对继续位置');
    const navigationCount = commands.filter(c => c.type === 'navigate_history').length;
    await page.locator('#pi-tree-continue').click();
    await page.waitForFunction(() => document.querySelector('#pi-tree-continue').textContent === '从这里继续');
    assert.equal(commands.filter(c => c.type === 'navigate_history').length, navigationCount);
    await page.locator('#pi-history-preview-close').click();
    await page.locator(`[data-tree-entry="${common}"]`).waitFor();
    await page.locator(`[data-tree-entry="${common}"]`).locator('..').locator('.pi-tree-fold').click(); await page.waitForFunction(() => document.querySelectorAll('[data-tree-entry]').length === 2);
    await page.locator('#pi-tree-current').click();
    // /tree opens the same view without prompt or navigation.
    await page.locator('#pi-close-inspector').click(); await page.locator('#pi-input').fill('/tree'); await page.locator('#pi-input').press('Escape');
    await page.locator('#pi-send-button').click(); await page.locator('#pi-history-tree-pane').waitFor({ state: 'visible' }); assert.equal(await page.locator('#pi-input').inputValue(), '');
    await page.locator('#pi-tree-refresh').click();
    // Refresh clears a user fold when locating a current descendant; root has no visible active node after navigating before first.
    if (await page.locator(`[data-tree-entry="${oldReply}"]`).count() === 0) { await page.locator(`[data-tree-entry="${common}"]`).locator('..').locator('.pi-tree-fold').click(); }
    delayPreview = true; await page.locator(`[data-tree-entry="${oldReply}"]`).click(); while (!delayed) await page.waitForTimeout(10);
    await page.locator('#pi-close-inspector').click(); if (viewport.width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator('[data-session-id="b"] .pi-session-main').click(); await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b');
    try { respond(delayed.ws, delayed.c, previewHistory(delayed.manager, delayed.c)); } catch {}
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-history-tab').click();
    assert.equal(await page.locator('#pi-history-preview').isVisible(), false);
    await page.locator('#pi-history-tree-mode').click(); await page.waitForFunction(() => document.querySelector('#pi-tree-rows').textContent.includes('另一个线程'));
    assert.doesNotMatch(await page.locator('#pi-tree-rows').textContent(), /旧路线/);
    assert.ok(!commands.some(c => ['prompt', 'steer', 'follow_up', 'compact', 'bash'].includes(c.type))); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/pi-tree-outline-${viewport.width}.png` });
    console.log(`PASS ${viewport.width}: body/tools, Markdown reading area, preview, branch navigation, draft preservation, summary/cancel, folds, slash, stale thread isolation`);
    await context.close();
}
(async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent'); const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport, SessionManager); }
    finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
