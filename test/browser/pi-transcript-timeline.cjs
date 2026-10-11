const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openInspector, selectMessageView } = require('./pi-mobile-view-helper.cjs');
const { searchHistory, previewHistory, setHistoryBookmark } = require('../../server/pi-history-model');
const base = process.env.PI_TIMELINE_TEST_URL || 'http://127.0.0.1:3001';
const shots = process.env.PIVANE_TEST_SCREENSHOT_DIR || '/tmp/pi-transcript-timeline';
const cwd = '/srv/timeline-fixture';
fs.mkdirSync(shots, { recursive: true });

function fixture(SessionManager) {
    const sm = SessionManager.inMemory(cwd), ids = [], questions = [], branchBookmarks = [];
    let abandoned, processEntry, timestamp = Date.parse('2026-10-11T08:00:00Z');
    const appendTurn = (question, pureTool = false) => {
        const id = sm.appendMessage({ role: 'user', content: question, timestamp: ++timestamp });
        const call = `call-${timestamp}`, toolCall = { type: 'toolCall', id: call, name: 'bash', arguments: { command: pureTool ? 'printf hidden-process-needle' : 'printf fixture' } };
        const assistantEntry = sm.appendMessage({ role: 'assistant', content: pureTool ? [toolCall] : [{ type: 'text', text: 'Checking the fixture.' }, toolCall], timestamp: ++timestamp, stopReason: 'toolUse', model: 'fixture' });
        if (pureTool) processEntry = assistantEntry;
        sm.appendMessage({ role: 'toolResult', toolCallId: call, toolName: 'bash', content: [{ type: 'text', text: 'Synthetic tool result' }], timestamp: ++timestamp, isError: false });
        sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Final **verified** reply for ${question}.\n\n- List item alpha\n- List item beta\n\n\`\`\`js\nCODE_FENCE_SENTINEL();\n\`\`\`\n\nReady to review.` }], timestamp: ++timestamp, stopReason: 'stop', model: 'fixture' });
        return id;
    };
    for (let i = 0; i < 14; i++) {
        questions.push(`Question ${String(i + 1).padStart(2, '0')}: 请核对😀这个问题的完整说明和最终回复`);
        ids.push(appendTurn(questions[i], i === 9));
        if (i === 2) {
            const fork = sm.getLeafId();
            abandoned = appendTurn('Abandoned branch question');
            // More than one bookmark page, without adding marked current turns.
            for (let j = 0; j < 31; j++) branchBookmarks.push(sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Other-branch note ${j}` }], timestamp: ++timestamp, stopReason: 'stop', model: 'fixture' }));
            sm.branch(fork);
        }
    }
    for (const id of branchBookmarks) sm.appendLabelChange(id, 'Other-branch native bookmark');
    sm.appendLabelChange(ids[1], 'Native review bookmark');
    sm.appendLabelChange(ids[4], 'Cleared before opening');
    sm.appendLabelChange(ids[4], undefined);
    // Forks may retain native entry IDs. Reuse three turns without their labels so
    // an obsolete first-thread bookmark map would visibly corrupt the second.
    const copied = structuredClone(sm.getBranch().filter(e => e.type === 'message').slice(0, 12));
    for (const e of copied) if (e.message.role === 'user') e.message.content = `Second thread: ${e.message.content}`;
    const other = SessionManager.inMemory(cwd, undefined, [
        { type: 'session', version: 3, id: 'timeline-second-native', timestamp: new Date(timestamp + 1).toISOString(), cwd }, ...copied
    ]);
    assert.equal(other.getBranch().filter(e => e.message?.role === 'user').length, 3);
    assert.equal(other.getLabel(ids[1]), undefined);
    const dense = SessionManager.inMemory(cwd);
    for (let i = 0; i < 120; i++) {
        dense.appendMessage({ role: 'user', content: `Long outline question ${i + 1}`, timestamp: ++timestamp });
        dense.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Long outline answer ${i + 1}` }], timestamp: ++timestamp, stopReason: 'stop', model: 'fixture' });
    }
    return { sm, other, dense, ids, questions, abandoned, processEntry };
}
function transcript(sm, compacted = false) {
    const messages = [], webAnchors = [];
    for (const e of sm.getBranch()) if (e.type === 'message') {
        messages.push(e.message); webAnchors.push([e.id, e.message.role, e.message.timestamp, e.message.toolCallId || '']);
    }
    // A compacted context starts with its summary; it has no message anchor and no bookmark.
    if (compacted) messages.unshift({ role: 'compactionSummary', summary: 'Earlier turns summary', tokensBefore: 4096, timestamp: messages[0].timestamp - 1 });
    return { messages, webAnchors };
}
const clipped = text => [...text].length > 24 ? [...text].slice(0, 24).join('').trimEnd() + '…' : text;
const tick = (page, index) => page.locator(`.pi-timeline-tick[data-index="${index}"]`);
const user = (page, index) => page.locator('#pi-transcript-content > .pi-message.user').nth(index);
async function hoverTick(page, index) {
    const box = await tick(page, index).boundingBox(); assert.ok(box, 'tick has a pointer target');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(i => !document.querySelector('.pi-timeline-card').hidden && document.querySelector(`.pi-timeline-tick[data-index="${i}"]`).classList.contains('is-hovered'), index);
}
async function located(page, index) {
    await page.waitForFunction(i => {
        const node = document.querySelectorAll('#pi-transcript-content > .pi-message.user')[i];
        const distance = node.getBoundingClientRect().top - document.querySelector('#pi-transcript').getBoundingClientRect().top;
        return distance >= 0 && distance <= 40 && node.classList.contains('pi-transcript-located');
    }, index);
}
async function markState(page, index, pressed) {
    await page.waitForFunction(({ index, pressed }) => {
        const button = document.querySelectorAll('#pi-transcript-content > .pi-message.user')[index]?.querySelector('.pi-message-bookmark');
        return button && button.getAttribute('aria-pressed') === String(pressed) && button.getAttribute('aria-busy') === 'false';
    }, { index, pressed });
}
async function screenshot(page, name) { await page.screenshot({ path: path.join(shots, name + '.png') }); }
async function noOverflow(page, selectors) {
    assert.deepEqual(await page.evaluate(selectors => selectors.filter(s => {
        const n = document.querySelector(s); return n.scrollWidth > n.clientWidth + 1;
    }), selectors), [], 'no horizontal overflow');
}
async function run(browser, viewport, SessionManager) {
    const mobile = viewport.width < 900;
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [], writes = [], commands = [], failures = [], bookmarkSnapshots = [];
    const { sm, other, dense, ids, questions, abandoned, processEntry } = fixture(SessionManager);
    const managers = { a: sm, b: other, c: dense };
    const sessions = [{ id: 'a', cwd, name: 'Timeline fixture', messageCount: 56 }, { id: 'b', cwd, name: 'Second thread', messageCount: 12 }, { id: 'c', cwd, name: 'Long outline', messageCount: 240 }];
    const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
    let socket, current = sm, holdMarks = false, delayedMarks, holdWrite = false, delayedWrite, uncertainWrite = false;
    const reply = (ws, cmd, data, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error: error?.message, errorCode: error?.code }));
    const markCommands = () => commands.filter(c => c.type === 'set_history_bookmark');
    const markReads = () => commands.filter(c => c.type === 'search_history' && c.bookmarked);
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a');
        localStorage.setItem('pi.workspace.theme', 'daylight');
        // Retain the browser transport to deliver a queued old-connection event
        // even after thread switching closes that connection.
        window.__timelineSockets = [];
        const nativeAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, ...args) {
            if (type === 'message' && this.url?.endsWith('/api/pi/ws') && !window.__timelineSockets.includes(this)) window.__timelineSockets.push(this);
            return nativeAddEventListener.call(this, type, ...args);
        };
    }, { cwd });
    await page.route('**/api/**', route => {
        const request = route.request(), p = new URL(request.url()).pathname;
        if (request.method() !== 'GET') { writes.push(`${request.method()} ${p}`); return route.fulfill({ json: {} }); }
        if (p === '/api/pi/status') return route.fulfill({ json: { ok: true, historySearch: true, historyBody: true, sessionTree: true, historyPresentation: true, treePresentation: true, sessionWorkflows: true, projectRoots: ['/srv'] } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Timeline fixture', sessionCount: 3 }], roots: ['/srv'] } });
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
            if (cmd.type === 'open_session') {
                current = managers[cmd.sessionId];
                return reply(ws, cmd, { session: sessions.find(s => s.id === cmd.sessionId), state: { model, isStreaming: false }, messages: transcript(current, current === other), models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} });
            }
            if (cmd.type === 'get_state') return reply(ws, cmd, { model, isStreaming: false });
            if (cmd.type === 'get_messages') return reply(ws, cmd, transcript(current, current === other));
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
            try {
                if (cmd.type === 'search_history') {
                    const data = searchHistory(current, cmd, { settled: true });
                    if (holdMarks && current === sm && cmd.bookmarked && cmd.offset === 30) { delayedMarks = { ws, cmd, data }; holdMarks = false; return; }
                    if (cmd.bookmarked && !data.hasMore) bookmarkSnapshots.push({ manager: current, revision: data.revision });
                    return reply(ws, cmd, data);
                }
                if (cmd.type === 'get_history_entry') return reply(ws, cmd, previewHistory(current, cmd, { settled: true }));
                if (cmd.type === 'set_history_bookmark') {
                    if (uncertainWrite) {
                        uncertainWrite = false;
                        return reply(ws, cmd, null, new Error('未收到历史操作确认，请重新读取记录核对；未自动重试'));
                    }
                    const data = setHistoryBookmark(current, cmd, current.appendLabelChange.bind(current));
                    if (holdWrite) { delayedWrite = { ws, cmd, data }; holdWrite = false; return; }
                    ws.send(JSON.stringify({ type: 'gateway_history_changed', entryId: cmd.entryId }));
                    return reply(ws, cmd, data);
                }
            } catch (e) { failures.push({ type: cmd.type, entryId: cmd.entryId, code: e.code }); return reply(ws, cmd, null, e); }
            failures.push({ type: cmd.type, code: 'UNEXPECTED_RPC' });
            return reply(ws, cmd, null, new Error('Unexpected RPC ' + cmd.type));
        });
    });
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#pi-input').disabled && document.querySelectorAll('.pi-timeline-tick').length === 14);
        await markState(page, 1, true);
        assert.equal(await page.locator('.pi-timeline-tick').count(), await page.locator('#pi-transcript-content > .pi-message.user, #pi-transcript-content > .pi-agent-turn-start').count());
        assert.equal(await page.locator('.pi-timeline-tick.is-marked').count(), 1);
        assert.ok(markReads().every(c => c.q === '' && c.scope === 'all' && c.filter === 'all'));
        assert.ok(markReads().some(c => c.offset === 30 && /^[a-f0-9]{64}$/.test(c.revision)), 'bookmark pages use native snapshot revision');
        await page.locator('#pi-input').fill('Keep my timeline draft 😀');
        if (mobile) {
            assert.equal(await page.locator('nav.pi-timeline').getAttribute('hidden'), '');
            assert.equal(await page.locator('nav.pi-timeline').isVisible(), false);
            assert.equal(await page.locator('.pi-transcript-shell.pi-has-outline').count(), 0);
            await user(page, 6).scrollIntoViewIfNeeded();
            const button = user(page, 6).locator('.pi-message-bookmark');
            assert.equal(await button.isVisible(), true);
            assert.equal(await button.evaluate(n => getComputedStyle(n).opacity), '1');
            const before = markCommands().length;
            await button.click(); await markState(page, 6, true); await settleBookmarks();
            assert.equal(sm.getLabel(ids[6]), clipped(questions[6]));
            assert.equal(markCommands().length, before + 1);
            assert.equal(markCommands().at(-1).expectedBookmarkRevision, 'none');
            await screenshot(page, `${viewport.width}-daylight-mobile-bookmarked-header`);
            await button.click(); await markState(page, 6, false); await settleBookmarks();
            assert.equal(sm.getLabel(ids[6]), undefined); assert.equal(markCommands().length, before + 2);
            await historyScenario(page, ids, questions, abandoned, true);
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
                await user(page, 6).scrollIntoViewIfNeeded();
                await noOverflow(page, ['body', '#pi-transcript', '#pi-transcript-content']);
                await screenshot(page, `${viewport.width}-${theme}-mobile-header`);
            }
        } else {
            await desktopScenario();
        }
        assert.deepEqual(errors, [], 'no pageerror');
        assert.deepEqual(writes, [], 'no non-GET REST writes');
        assert.ok(!commands.some(c => ['prompt', 'steer', 'follow_up', 'compact'].includes(c.type)), 'no conversation mutation RPC');
        assert.deepEqual(failures.filter(f => f.code !== 'BOOKMARK_CONFLICT'), [], 'only intentional native CAS conflict');
        console.log(`PASS ${viewport.width}: ${mobile ? 'mobile header bookmarks, History overlay locate, three themes, no overflow' : 'outline, native CAS/deferred/uncertain writes, hidden-process History locate, overflowing-rail keyboard, late thread response, three themes'}; no pageerror or forbidden writes`);
    } catch (error) {
        await screenshot(page, `${viewport.width}-failure`);
        console.error('Timeline failure state', await page.evaluate(() => ({
            users: document.querySelectorAll('#pi-transcript-content > .pi-message.user').length,
            ticks: document.querySelectorAll('.pi-timeline-tick').length,
            header: document.querySelector('#pi-transcript-content > .pi-message.user header')?.outerHTML,
            navHidden: document.querySelector('.pi-timeline')?.hidden
        })));
        throw error;
    } finally { await context.close(); }

    async function desktopScenario() {
        assert.equal(await page.locator('nav.pi-timeline').isVisible(), true);
        assert.equal(await page.locator('.pi-transcript-shell.pi-has-outline').count(), 1);
        assert.ok(await page.locator('.pi-timeline-tick.is-visible').count() > 0);
        assert.equal(await page.locator('.pi-timeline-tick[aria-current="location"][tabindex="0"]').count(), 1);
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.locator('#pi-session-pane').waitFor({ state: 'visible' });
        await page.waitForFunction(() => !document.querySelector('.pi-timeline').hidden && parseFloat(getComputedStyle(document.querySelector('#pi-transcript-content')).paddingLeft) >= 48);
        assert.ok(await page.locator('#pi-session-pane').evaluate(n => n.getBoundingClientRect().width) > 100, 'sessions pane stays open');
        await screenshot(page, '1024-daylight-rest');
        await page.setViewportSize(viewport);
        await screenshot(page, '1440-daylight-rest');
        await hoverTick(page, 6);
        assert.equal(await page.locator('.pi-timeline-title').innerText(), questions[6]);
        const excerpt = await page.locator('.pi-timeline-reply').innerText();
        assert.match(excerpt, /Final verified reply/); assert.match(excerpt, /List item alpha/);
        assert.doesNotMatch(excerpt, /```|\*\*|CODE_FENCE_SENTINEL|Checking the fixture/);
        assert.equal(await page.locator('.pi-timeline-reply ul li').count(), 2);
        await screenshot(page, '1440-daylight-hover');
        const card = page.locator('.pi-timeline-card'), mark = page.locator('.pi-timeline-mark');
        await card.hover();
        const before = markCommands().length;
        await mark.click(); await markState(page, 6, true); await settleBookmarks();
        assert.equal(markCommands().length, before + 1);
        assert.deepEqual({ entryId: markCommands().at(-1).entryId, label: markCommands().at(-1).label, revision: markCommands().at(-1).expectedBookmarkRevision }, { entryId: ids[6], label: clipped(questions[6]), revision: 'none' });
        assert.equal(sm.getLabel(ids[6]), clipped(questions[6]));
        assert.match(await tick(page, 6).getAttribute('class'), /is-marked/);
        await screenshot(page, '1440-daylight-bookmarked-hover');
        await mark.click(); await markState(page, 6, false); await settleBookmarks();
        assert.equal(markCommands().length, before + 2); assert.equal(sm.getLabel(ids[6]), undefined);
        assert.doesNotMatch(await tick(page, 6).getAttribute('class'), /is-marked/);
        await hoverTick(page, 4);
        const commandStart = commands.length, clearedRevision = previewHistory(sm, { entryId: ids[4] }).bookmarkRevision;
        await mark.click(); await markState(page, 4, true); await settleBookmarks();
        const clearedCommands = commands.slice(commandStart);
        const previewIndex = clearedCommands.findIndex(c => c.type === 'get_history_entry' && c.entryId === ids[4]);
        assert.ok(previewIndex >= 0 && previewIndex < clearedCommands.findIndex(c => c.type === 'set_history_bookmark' && c.entryId === ids[4]));
        assert.equal(markCommands().at(-1).expectedBookmarkRevision, clearedRevision);
        assert.notEqual(clearedRevision, 'none'); assert.equal(sm.getLabel(ids[4]), clipped(questions[4]));
        // No broadcast: the UI deliberately retains the old revision for this click.
        sm.appendLabelChange(ids[4], 'Changed elsewhere');
        const conflictWrites = markCommands().length, conflictReads = markReads().length;
        await mark.click();
        await page.locator('#pi-toast-region .pi-toast.error').filter({ hasText: '其他页面或终端修改' }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelector('.pi-timeline-mark').title.includes('Changed elsewhere'));
        assert.equal(markCommands().length, conflictWrites + 1, 'CAS failure is never retried');
        assert.ok(markReads().length > conflictReads, 'CAS failure refreshes native bookmarks');
        assert.deepEqual(failures.filter(f => f.code === 'BOOKMARK_CONFLICT'), [{ type: 'set_history_bookmark', entryId: ids[4], code: 'BOOKMARK_CONFLICT' }]);
        assert.equal(sm.getLabel(ids[4]), 'Changed elsewhere');
        const broadcastReads = markReads().length;
        sm.appendLabelChange(ids[4], 'Broadcast label'); socket.send(JSON.stringify({ type: 'gateway_history_changed', entryId: ids[4] }));
        await page.waitForFunction(() => document.querySelector('.pi-timeline-mark').title.includes('Broadcast label'));
        assert.ok(markReads().length > broadcastReads);
        await page.locator('#pi-input').focus();
        await tick(page, 6).click(); await located(page, 6);
        assert.equal(await page.locator('#pi-input').inputValue(), 'Keep my timeline draft 😀');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'pi-input');
        // Card-body jump follows the same scrolling/focus contract.
        await hoverTick(page, 8); await page.locator('.pi-timeline-title').click(); await located(page, 8);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'pi-input');
        await hoverTick(page, 7); await page.mouse.move(1400, 100);
        await card.waitFor({ state: 'hidden' });
        // Enter the roving tick with real Tab input before testing arrow keys.
        await page.locator('.pi-timeline-tick[aria-current="location"]').focus();
        await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.matches('.pi-timeline-tick[aria-current="location"]:focus-visible')), true);
        const start = Number(await page.evaluate(() => document.activeElement.dataset.index));
        await page.keyboard.press('ArrowDown');
        const initial = Number(await page.evaluate(() => document.activeElement.dataset.index));
        assert.equal(initial, start + 1);
        await page.keyboard.press('ArrowUp');
        assert.equal(Number(await page.evaluate(() => document.activeElement.dataset.index)), initial - 1);
        await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '0');
        await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '13');
        await page.keyboard.press('ArrowUp'); assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '12');
        assert.equal(await card.isVisible(), true); assert.equal(await card.getAttribute('data-input'), 'keyboard');
        await page.keyboard.press('Enter'); await located(page, 12);
        await page.keyboard.press('Escape'); await card.waitFor({ state: 'hidden' });
        await page.locator('#pi-input').focus(); await tick(page, 5).click(); await located(page, 5);
        await hoverTick(page, 5);
        const scrollTop = await page.locator('#pi-transcript').evaluate(n => n.scrollTop);
        await page.mouse.wheel(0, 300);
        await page.waitForFunction(top => document.querySelector('#pi-transcript').scrollTop > top + 100, scrollTop);
        assert.equal(markCommands().length, conflictWrites + 1, 'no deferred retry after navigation');
        await historyScenario(page, ids, questions, abandoned, false);
        for (const theme of ['daylight', 'mint', 'dark']) {
            await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
            await page.locator('#pi-input').focus(); await page.mouse.move(1400, 100); await card.waitFor({ state: 'hidden' });
            await screenshot(page, `1440-${theme}-rest`);
            await hoverTick(page, 6); await noOverflow(page, ['.pi-timeline-card']);
            await screenshot(page, `1440-${theme}-hover`);
            await hoverTick(page, 1); await noOverflow(page, ['.pi-timeline-card']);
            assert.equal(await mark.getAttribute('aria-pressed'), 'true');
            assert.match(await page.locator('.pi-timeline-meta').innerText(), /Native review bookmark/);
            await screenshot(page, `1440-${theme}-bookmarked-hover`);
        }
        holdMarks = true; socket.send(JSON.stringify({ type: 'gateway_history_changed', entryId: ids[1] }));
        await assertEventually(() => delayedMarks, page, 'first-thread bookmark read held');
        assert.ok(delayedMarks.data.results.some(r => r.entryId === ids[1]));
        await page.locator('[data-filter="all"]').click();
        await page.locator('[data-session-id="b"] .pi-session-main').click();
        await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b' && !document.querySelector('#pi-input').disabled && document.querySelectorAll('.pi-timeline-tick').length === 4);
        await markState(page, 1, false);
        const lateRecord = JSON.stringify({ type: 'response', id: delayedMarks.cmd.id, command: delayedMarks.cmd.type, success: true, data: delayedMarks.data });
        // A real thread switch closes its socket; send through the mock, then
        // deliver the already queued message on the retained old browser socket.
        delayedMarks.ws.send(lateRecord);
        assert.equal(await page.evaluate(record => {
            const old = window.__timelineSockets[0]; let delivered = 0;
            old.addEventListener('message', () => delivered++, { once: true });
            old.dispatchEvent(new MessageEvent('message', { data: record })); return delivered;
        }, lateRecord), 1);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('.pi-timeline-tick.is-marked').count(), 0, 'late first-thread marks cannot contaminate a fork sharing entry IDs');
        assert.equal(await page.locator('.pi-timeline-tick').count(), 4);
        await hoverTick(page, 2); assert.match(await page.locator('.pi-timeline-title').innerText(), /^Second thread:/);
        // The compaction summary is a ring marker: no bookmark, a bridge to History search, click opens it in place.
        assert.equal(await tick(page, 0).evaluate(n => n.classList.contains('is-summary')), true);
        await hoverTick(page, 0);
        assert.equal(await page.locator('.pi-timeline-title').innerText(), '上下文已压缩');
        assert.equal(await page.locator('.pi-timeline-card .pi-timeline-mark').isVisible(), false);
        assert.equal(await page.locator('.pi-timeline-history').isVisible(), true);
        await tick(page, 0).click();
        await page.waitForFunction(() => document.querySelector('#pi-transcript-content > .pi-summary-notice').open);
        await hoverTick(page, 0); await page.locator('.pi-timeline-history').click();
        await page.locator('#pi-history').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.pi-timeline-card').isVisible(), false);
        await page.locator('#pi-close-inspector').click();
        await deferredAndUncertainWrites();
        await hiddenProcessLocate();
        await overflowingRailKeyboard();
    }

    async function settleBookmarks() {
        // Let a broadcast's entire paged read finish before the next intentional
        // native mutation, so that mutation cannot invalidate the previous page.
        const manager = current, revision = searchHistory(manager, { bookmarked: true }).revision;
        await assertEventually(() => bookmarkSnapshots.some(snapshot => snapshot.manager === manager && snapshot.revision === revision), page, 'bookmark snapshot finished at current native revision');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }

    async function switchThread(id, count) {
        await page.locator('[data-filter="all"]').click();
        await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
        await page.waitForFunction(({ id, count }) => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled && document.querySelectorAll('.pi-timeline-tick').length === count, { id, count });
    }

    async function deferredAndUncertainWrites() {
        await switchThread('a', 14); await markState(page, 1, true);
        const before = markCommands().length;
        holdWrite = true;
        const button = user(page, 10).locator('.pi-message-bookmark');
        await user(page, 10).scrollIntoViewIfNeeded(); await button.click();
        await assertEventually(() => delayedWrite, page, 'native write applied, response held');
        assert.equal(await button.getAttribute('aria-busy'), 'true'); assert.equal(await button.isDisabled(), true);
        assert.equal(sm.getLabel(ids[10]), clipped(questions[10]));
        const originalSocket = delayedWrite.ws;
        await switchThread('b', 4); await markState(page, 1, false);
        assert.notEqual(socket, originalSocket, 'thread switch creates a new transport');
        reply(originalSocket, delayedWrite.cmd, delayedWrite.data);
        assert.equal(markCommands().length, before + 1, 'deferred write submitted once');
        assert.equal(await page.locator('.pi-timeline-tick.is-marked').count(), 0);
        const freshReads = markReads().length;
        await switchThread('a', 14); await markState(page, 10, true);
        assert.ok(markReads().length > freshReads, 'returning thread reads native bookmarks afresh');
        assert.equal(await button.isDisabled(), false); assert.equal(await button.getAttribute('aria-busy'), 'false');
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(markCommands().length, before + 1, 'late acknowledgement causes no replay');

        const uncertain = user(page, 7).locator('.pi-message-bookmark');
        await user(page, 7).scrollIntoViewIfNeeded(); await markState(page, 7, false);
        const uncertainWrites = markCommands().length, uncertainReads = markReads().length;
        uncertainWrite = true; await uncertain.click();
        await page.locator('#pi-toast-region .pi-toast.error').filter({ hasText: '未收到历史操作确认，请重新读取记录核对；未自动重试' }).waitFor({ state: 'visible' });
        await assertEventually(() => markReads().length > uncertainReads, page, 'uncertain write triggers native bookmark reread');
        await markState(page, 7, false);
        assert.equal(await uncertain.isDisabled(), false);
        assert.equal(sm.getLabel(ids[7]), undefined, 'uncertain response did not apply the label');
        assert.equal(markCommands().length, uncertainWrites + 1);
        assert.equal(markCommands().at(-1).entryId, ids[7]);
        await page.waitForTimeout(1100);
        assert.equal(markCommands().length, uncertainWrites + 1, 'uncertain write is not automatically retried within one second');
    }

    async function hiddenProcessLocate() {
        await selectMessageView(page, 'compact');
        const message = sm.getEntry(processEntry).message;
        assert.ok(message.content.every(block => block.type === 'toolCall'), 'fixture is a pure tool-call assistant record');
        const key = JSON.stringify([message.role, message.timestamp, '']);
        const article = page.locator(`#pi-transcript-content > .pi-message.assistant[data-message-key='${key}']`);
        await page.waitForFunction(key => [...document.querySelectorAll('#pi-transcript-content > .pi-message.assistant')].some(n => n.dataset.messageKey === key && n.hidden), key);
        assert.equal(await article.isVisible(), false);
        assert.ok(await user(page, 9).evaluate(node => {
            for (let next = node.nextElementSibling; next && !next.matches('.pi-message.user'); next = next.nextElementSibling) if (next.matches('.pi-turn-group') && !next.open) return true;
            return false;
        }), 'hidden process belongs to a closed turn group');
        assert.ok(await article.locator('.pi-tool-row').evaluate(node => node.hidden), 'its tool row is also folded in a process group');
        await openInspector(page, 'history');
        // A retained preview from the earlier History scenario must be closed first.
        if (await page.locator('#pi-history-preview').isVisible()) await page.locator('#pi-history-preview-close').click();
        await page.locator('#pi-history-query').fill('hidden-process-needle');
        await page.locator('#pi-history-filter').selectOption('tool');
        const row = page.locator(`[data-history-id="${processEntry}"]`); await row.waitFor(); await row.click();
        await page.locator('#pi-history-locate').waitFor({ state: 'visible' });
        const unavailable = page.locator('#pi-toast-region .pi-toast').filter({ hasText: '不在当前显示的对话中' });
        assert.equal(await unavailable.count(), 0);
        await page.locator('#pi-history-locate').click();
        await page.waitForFunction(key => {
            const node = [...document.querySelectorAll('#pi-transcript-content > .pi-message.assistant')].find(n => n.dataset.messageKey === key);
            const distance = node.getBoundingClientRect().top - document.querySelector('#pi-transcript').getBoundingClientRect().top;
            return !node.hidden && node.getClientRects().length > 0 && distance >= 0 && distance <= 40;
        }, key);
        assert.equal(await article.isVisible(), true); assert.equal(await unavailable.count(), 0);
        await page.locator('#pi-close-inspector').click();
    }

    async function overflowingRailKeyboard() {
        await switchThread('c', 120);
        await page.waitForFunction(() => {
            const rail = document.querySelector('.pi-timeline-rail'); return rail.classList.contains('is-dense') && rail.scrollHeight > rail.clientHeight;
        });
        await page.locator('.pi-timeline-tick[aria-current="location"]').focus();
        for (const [key, index] of [['Home', 0], ['End', 119]]) {
            await page.keyboard.press(key);
            const geometry = await page.evaluate(() => {
                const rail = document.querySelector('.pi-timeline-rail'), node = document.activeElement;
                const outer = rail.getBoundingClientRect(), inner = node.getBoundingClientRect();
                return { index: Number(node.dataset.index), top: inner.top, bottom: inner.bottom, left: inner.left, right: inner.right,
                    railTop: outer.top, railBottom: outer.bottom, railLeft: outer.left, railRight: outer.right,
                    tabStops: [...rail.querySelectorAll('.pi-timeline-tick')].filter(t => t.tabIndex === 0).length };
            });
            assert.equal(geometry.index, index); assert.equal(geometry.tabStops, 1);
            assert.ok(geometry.top >= geometry.railTop - 1 && geometry.bottom <= geometry.railBottom + 1, `${key} target stays vertically inside overflowing rail`);
            assert.ok(geometry.left >= geometry.railLeft - 1 && geometry.right <= geometry.railRight + 1, `${key} target stays horizontally inside rail`);
        }
        await page.keyboard.press('Escape');
    }
}
async function assertEventually(predicate, page, message) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await page.waitForTimeout(20);
    assert.ok(predicate(), message);
}
async function historyScenario(page, ids, questions, abandoned, mobile) {
    await openInspector(page, 'history');
    await page.locator('#pi-history-query').fill(questions[3]);
    const row = page.locator(`[data-history-id="${ids[3]}"]`); await row.waitFor(); await row.click();
    await page.locator('#pi-history-locate').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-history-locate').getAttribute('hidden'), null);
    await page.locator('#pi-history-locate').click(); await located(page, 3);
    if (mobile) assert.equal(await page.locator('#pi-inspector').evaluate(n => n.classList.contains('open')), false, 'locate closes overlay drawer');
    await openInspector(page, 'history');
    await page.locator('#pi-history-preview-close').click();
    await page.locator('#pi-history-query').fill('Abandoned branch question');
    await page.locator('#pi-history-scope').selectOption('all');
    const otherRow = page.locator(`[data-history-id="${abandoned}"]`); await otherRow.waitFor(); await otherRow.click();
    await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-history-locate').getAttribute('hidden'), '');
    assert.equal(await page.locator('#pi-history-locate').isVisible(), false);
    await page.locator('#pi-close-inspector').click();
}
(async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport, SessionManager); }
    finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
