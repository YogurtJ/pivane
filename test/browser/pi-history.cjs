const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { searchHistory, previewHistory, setHistoryBookmark } = require('../../server/pi-history-model');
const base = process.env.PI_HISTORY_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/srv/history-fixture';
async function run(browser, viewport, SessionManager) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), errors = [], writes = [], commands = [];
    const sm = SessionManager.inMemory(cwd), other = SessionManager.inMemory(cwd);
    const u = text => ({ role: 'user', content: text, timestamp: Date.now() });
    const a = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(), stopReason: 'stop' });
    const target = sm.appendMessage(u('old decision 中文 <img src=x onerror=alert(1)>'));
    sm.appendMessage(a('old answer'));
    const fork = sm.getLeafId();
    const abandoned = sm.appendMessage(u('abandoned branch needle'));
    sm.appendMessage(a('other branch answer')); sm.branch(fork);
    const roleUser = sm.appendMessage(u('用户问题演示：请检查这一方案'));
    const roleProgress = sm.appendMessage(a('进展演示：正在检查相关实现'));
    const roleFinal = sm.appendMessage(a('结论演示：方案已核对，可以继续'));
    for (let i = 0; i < 65; i++) { sm.appendMessage(u(`question-${i}`)); sm.appendMessage(a(`answer-${i}`)); }
    const long = sm.appendMessage(a('x'.repeat(17000) + 'deep-needle'));
    other.appendMessage(u('second thread')); other.appendMessage(a('second answer'));
    const sessions = [{ id: 'a', cwd, name: 'History fixture', messageCount: 132 }, { id: 'b', cwd, name: 'Second', messageCount: 2 }];
    let socket, current = sm, delayedSearch = null, delayedPreview = null, holdSearch = false, holdPreview = false, labelCalls = 0;
    const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
    const messages = [u('recent question'), a('recent answer')];
    const reply = (ws, cmd, data, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error }));
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a'); }, { cwd });
    await page.route('**/api/**', route => {
        const r = route.request(), p = new URL(r.url()).pathname;
        if (r.method() !== 'GET') { writes.push(p); return route.fulfill({ json: {} }); }
        if (p === '/api/pi/status') return route.fulfill({ json: { ok: true, historySearch: true, sessionWorkflows: true, projectRoots: ['/srv'] } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'History fixture', sessionCount: 2 }], roots: ['/srv'] } });
        if (p === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (p === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] } });
        if (p.endsWith('/deferred')) return route.fulfill({ json: { jobs: [] } });
        if (p.endsWith('/workflow')) return route.fulfill({ json: { prompts: [], replies: [], versions: [] } });
        return route.fulfill({ json: p.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd);
            if (cmd.type === 'open_session') { current = cmd.sessionId === 'a' ? sm : other; return reply(ws, cmd, { session: sessions.find(s => s.id === cmd.sessionId), state: { model, isStreaming: false }, messages: { messages }, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} }); }
            if (cmd.type === 'get_state') return reply(ws, cmd, { model, isStreaming: false });
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages });
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
            try {
                if (cmd.type === 'search_history') { if (holdSearch) { delayedSearch = { ws, cmd, sm: current }; return; } return reply(ws, cmd, searchHistory(current, cmd, { settled: true })); }
                if (cmd.type === 'get_history_entry') { if (holdPreview) { delayedPreview = { ws, cmd, sm: current }; return; } return reply(ws, cmd, previewHistory(current, cmd, { settled: true })); }
                if (cmd.type === 'set_history_bookmark') { labelCalls++; const data = setHistoryBookmark(current, cmd, current.appendLabelChange.bind(current)); ws.send(JSON.stringify({ type: 'gateway_history_changed', entryId: cmd.entryId })); return reply(ws, cmd, data); }
            } catch (e) { return reply(ws, cmd, null, e.message); }
            throw Error('Unexpected RPC ' + cmd.type);
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    await page.locator('#pi-input').fill('Keep the main draft');
    const original = JSON.stringify(sm.getEntries()), leaf = sm.getLeafId();
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-history-tab').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length === 30);
    assert.equal(JSON.stringify(sm.getEntries()), original); assert.equal(sm.getLeafId(), leaf);
    await page.locator('#pi-history-next').click(); await page.waitForFunction(() => document.querySelector('#pi-history-status').textContent.includes('31–60'));
    const query = page.locator('#pi-history-query');
    // Exercise the actual typing focus ring at the clipping edges, not just body overflow.
    await query.fill('演'); await query.press('End'); await page.keyboard.type('示');
    await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length === 3);
    assert.equal(await page.locator(`[data-history-id="${roleProgress}"]`).getAttribute('data-reply-stage'), 'progress');
    assert.equal(await page.locator(`[data-history-id="${roleFinal}"]`).getAttribute('data-reply-stage'), 'final');
    assert.match(await page.locator(`[data-history-id="${roleFinal}"] .pi-tree-stage`).innerText(), /最终回复/);
    assert.equal(await page.locator('#pi-history-results time').count(), 3);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await query.focus();
        const geometry = await page.evaluate(({ roleUser, roleProgress, roleFinal }) => {
            const q = document.querySelector('#pi-history-query'), r = q.getBoundingClientRect(), style = getComputedStyle(q);
            const out = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
            const clipped = [];
            for (let p = q.parentElement; p; p = p.parentElement) {
                if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX)) {
                    const b = p.getBoundingClientRect(), left = b.left + p.clientLeft, right = left + p.clientWidth;
                    if (r.left - out < left - .5 || r.right + out > right + .5) clipped.push(p.id || p.tagName);
                }
            }
            const color = (id, selector) => getComputedStyle(document.querySelector(`[data-history-id="${id}"] ${selector}`)).color;
            return { focus: q.matches(':focus-visible'), outline: parseFloat(style.outlineWidth), out, clipped, shadow: style.boxShadow,
                user: color(roleUser, '.pi-tree-role'), ai: color(roleFinal, '.pi-tree-role'),
                final: color(roleFinal, '.pi-tree-stage'), progress: color(roleProgress, '.pi-tree-stage'),
                overflow: [...document.querySelectorAll('#pi-history, #pi-history-browse, #pi-history-results, #pi-history-results .pi-tree-heading')].some(n => n.scrollWidth > n.clientWidth + 1) };
        }, { roleUser, roleProgress, roleFinal });
        assert.equal(geometry.focus, true); assert.ok(geometry.outline > 0); assert.equal(geometry.out, 0); assert.equal(geometry.shadow, 'none'); assert.deepEqual(geometry.clipped, []);
        assert.notEqual(geometry.user, geometry.ai); assert.notEqual(geometry.final, geometry.progress); assert.equal(geometry.overflow, false);
        await page.screenshot({ path: `/tmp/pi-history-presentation-${viewport.width}-${theme}.png` });
    }
    await query.fill('进展演示'); await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length === 1);
    assert.equal(await page.locator(`[data-history-id="${roleProgress}"]`).getAttribute('data-reply-stage'), 'progress');
    await page.locator(`[data-history-id="${roleProgress}"]`).click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
    assert.match(await page.locator('#pi-history-preview-title').innerText(), /过程回复/);
    await page.locator('#pi-history-preview-close').click();
    await query.fill('old decision'); await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length === 1);
    assert.equal(await page.locator('#pi-history-results img').count(), 0);
    await page.locator(`[data-history-id="${target}"]`).click();
    await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
    assert.match(await page.locator('#pi-history-text').textContent(), /old decision 中文 <img/);
    assert.equal(await page.locator('#pi-history-text img').count(), 0); assert.equal(sm.getLeafId(), leaf);
    await page.locator('#pi-history-bookmark-details summary').click();
    await page.locator('#pi-history-label').fill('已验证方案'); await page.locator('#pi-history-bookmark-save').click();
    await page.waitForFunction(() => document.querySelector('#pi-history-bookmark-state').textContent === '书签已保存');
    assert.equal(sm.getLabel(target), '已验证方案'); assert.equal(labelCalls, 1);
    await page.locator('#pi-history-preview-close').click();
    await page.locator('#pi-history-bookmarks').check();
    await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length === 1);
    assert.equal(await page.locator('#pi-input').inputValue(), 'Keep the main draft');
    await page.locator(`[data-history-id="${target}"]`).click();
    // Another client changes the native label. This view must retain its draft and reject its old revision.
    await page.locator('#pi-history-label').fill('Unsaved local label'); sm.appendLabelChange(target, 'Changed elsewhere');
    socket.send(JSON.stringify({ type: 'gateway_history_changed', entryId: target }));
    await page.waitForFunction(() => document.querySelector('#pi-history-bookmark-state').textContent.includes('其他操作'));
    assert.equal(await page.locator('#pi-history-label').inputValue(), 'Unsaved local label');
    await page.locator('#pi-history-bookmark-save').click();
    await page.waitForFunction(() => document.querySelector('#pi-history-bookmark-state').textContent.includes('其他页面'));
    assert.equal(sm.getLabel(target), 'Changed elsewhere');
    page.once('dialog', d => d.accept()); await page.locator('#pi-history-preview-reload').click();
    await page.waitForFunction(() => document.querySelector('#pi-history-label').value === 'Changed elsewhere');
    await page.locator('#pi-history-bookmark-remove').click();
    await page.waitForFunction(() => document.querySelector('#pi-history-bookmark-state').textContent.includes('已移除'));
    assert.equal(sm.getLabel(target), undefined);
    await page.waitForFunction(() => document.querySelectorAll('[data-history-id]').length === 0);
    await page.locator('#pi-history-preview-close').click();
    await page.locator('#pi-history-bookmarks').uncheck();
    await query.fill('abandoned branch'); await page.waitForFunction(() => document.querySelector('#pi-history-status').textContent === '没有匹配的记录');
    await page.locator('#pi-history-scope').selectOption('all'); await page.locator(`[data-history-id="${abandoned}"]`).waitFor();
    assert.match(await page.locator('#pi-history-results').textContent(), /其他分支/);
    await query.fill('deep-needle'); await page.locator(`[data-history-id="${long}"]`).waitFor(); await page.locator(`[data-history-id="${long}"]`).click();
    await page.waitForFunction(() => document.querySelector('#pi-history-text').textContent.includes('deep-needle'));
    assert.match(await page.locator('#pi-history-text-page').textContent(), /16001/);
    await page.locator('#pi-history-copy').click(); assert.match(await page.evaluate(() => navigator.clipboard.readText()), /deep-needle/);
    await page.locator('#pi-history-text-prev').click(); await page.waitForFunction(() => document.querySelector('#pi-history-text-page').textContent.startsWith('1–'));
    await page.locator('#pi-history-preview-close').click();
    holdSearch = true; await query.fill('old decision'); while (!delayedSearch) await page.waitForTimeout(10);
    await query.fill('abandoned branch'); holdSearch = false;
    reply(delayedSearch.ws, delayedSearch.cmd, searchHistory(delayedSearch.sm, delayedSearch.cmd));
    await page.locator(`[data-history-id="${abandoned}"]`).waitFor(); assert.doesNotMatch(await page.locator('#pi-history-results').textContent(), /old decision/);
    holdPreview = true; await page.locator(`[data-history-id="${abandoned}"]`).click(); while (!delayedPreview) await page.waitForTimeout(10);
    await page.locator('#pi-close-inspector').click(); if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator('[data-session-id="b"] .pi-session-main').click(); await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b' && !document.querySelector('#pi-input').disabled);
    try { reply(delayedPreview.ws, delayedPreview.cmd, previewHistory(delayedPreview.sm, delayedPreview.cmd)); } catch {}
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-history-tab').click();
    await page.waitForFunction(() => document.querySelector('#pi-history-results').textContent.includes('second thread'));
    assert.equal(await page.locator('#pi-history-preview').isVisible(), false); assert.equal(await query.inputValue(), '');
    assert.ok(!commands.some(c => ['prompt', 'steer', 'follow_up', 'compact'].includes(c.type))); assert.deepEqual(writes, []);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        assert.deepEqual(await page.evaluate(() => ['body', '#pi-inspector', '#pi-history', '#pi-history-results'].filter(s => { const n = document.querySelector(s); return n.scrollWidth > n.clientWidth + 1; })), []);
        await page.screenshot({ path: `/tmp/pi-history-${viewport.width}-${theme}.png` });
    }
    assert.deepEqual(errors, []); console.log(`PASS ${viewport.width}: search/pagination/preview, old branches, native label conflicts, long text, late query/thread responses, three themes`);
    await context.close();
}
(async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport, SessionManager); }
    finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
