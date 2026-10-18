// Synthetic Chromium regression: native SessionManager is the only history source.
// No real gateway, provider, session files or service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const { searchHistory, previewHistory, setHistoryBookmark } = require('../../server/pi-history-model');
const { historyArchive } = require('../../server/pi-history-archive');
const base = process.env.PI_ARCHIVE_TEST_URL || 'http://127.0.0.1:3001';
const shots = process.env.PIVANE_TEST_SCREENSHOT_DIR || '/tmp/pi-transcript-archive';
const cwd = '/srv/archive-browser-fixture';
const themes = ['daylight', 'mint', 'dark'];
fs.mkdirSync(shots, { recursive: true });
const section = (page, index) => page.locator(`.pi-archive-turn[data-archive-index="${index}"]`);
const tick = (page, index) => page.locator(`.pi-timeline-tick[data-index="${index}"]`);
const clipped = text => [...text].length > 24 ? [...text].slice(0, 24).join('').trimEnd() + '…' : text;
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function eventually(page, predicate, message) {
    const end = Date.now() + 5000;
    while (!predicate() && Date.now() < end) await page.waitForTimeout(20);
    assert.ok(predicate(), message);
}
async function screenshot(page, name) { await page.screenshot({ path: path.join(shots, name + '.png') }); }
async function noOverflow(page) {
    assert.deepEqual(await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-archive'].filter(selector => {
        const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1;
    })), [], 'body, transcript and archive have no horizontal overflow');
}
async function located(page, index) {
    await page.waitForFunction(index => {
        const node = document.querySelector(`.pi-archive-turn[data-archive-index="${index}"] > .pi-archive-head-node`);
        if (!node) return false;
        const distance = node.getBoundingClientRect().top - document.querySelector('#pi-transcript').getBoundingClientRect().top;
        return distance >= 0 && distance <= 40 && node.classList.contains('pi-transcript-located');
    }, index);
}
async function hover(page, index) {
    const box = await tick(page, index).boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(index => !document.querySelector('.pi-timeline-card').hidden && document.querySelector(`.pi-timeline-tick[data-index="${index}"]`).classList.contains('is-hovered'), index);
    // The card transitions its position for 110ms and its transform for 160ms.
    // Keep the pointer on the tick until it settles, before moving onto a button.
    await page.waitForFunction(() => !document.querySelector('.pi-timeline-card').getAnimations().some(animation => animation.playState === 'running'));
}
async function topOf(page, selector, offset = 16) {
    await page.locator(selector).evaluate((node, offset) => {
        const view = document.querySelector('#pi-transcript');
        view.scrollTop += node.getBoundingClientRect().top - view.getBoundingClientRect().top - offset;
    }, offset);
    await frames(page);
}
const ARCHIVE_NOTICES = [
    ['subagent_supervisor_request', 'Subagent needs a supervisor decision.\n\nRun: synthetic-run\nAgent: worker\n\n**Review scope**\n\n' + 'Long decision details. '.repeat(400) + '<img src=x onerror="window.__archiveXss=1">'],
    ['subagent-supervisor-blocked', 'Supervisor request is blocked.\n\n' + 'Pending decision. '.repeat(80)],
    ['subagent_watchdog_clarification', 'Watchdog needs clarification.\n\n' + 'Clarification details. '.repeat(80)],
    ['subagent_control_notice', 'Subagent needs attention: worker\n\nRun: synthetic-run step 1\nSignal: worker needs attention after repeated mutating tool failures\n\n' + 'Inspect status before guiding the worker. '.repeat(45)],
    ['pivane-agent-message', '[Agent message from thread synthetic-peer]\n\n' + 'Archived Agent message <img src=x onerror="window.__archiveXss=1">\n'.repeat(80)],
    ['pivane-agent-task-result', 'Archived Agent task result\n\n' + 'Result details. '.repeat(100)],
    ['pivane-agent-task-message', 'Archived Agent task handoff\n\n' + 'Task details. '.repeat(100)],
    ['pivane-agent-task-receipt', 'Archived Agent creation receipt\n\n' + 'Receipt details. '.repeat(100)]
];
function fixture(sdk, count = 60, notices = false) {
    const { SessionManager, buildContextEntries } = sdk;
    const sm = SessionManager.inMemory(cwd), ids = [], questions = [];
    let time = Date.parse('2026-10-11T08:00:00Z');
    const append = (manager, question, long = false) => {
        const id = manager.appendMessage({ role: 'user', content: question, timestamp: ++time });
        const call = `archive-call-${time}`;
        manager.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'ARCHIVE_THINKING_SENTINEL' }, { type: 'text', text: 'Checking synthetic records.' }, { type: 'toolCall', id: call, name: 'bash', arguments: { command: 'printf archive-fixture' } }], timestamp: ++time, stopReason: 'toolUse', model: 'fixture' });
        manager.appendMessage({ role: 'toolResult', toolCallId: call, toolName: 'bash', content: [{ type: 'text', text: 'ARCHIVE_TOOL_RESULT_SENTINEL' }], timestamp: ++time, isError: false });
        manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: long ? 'Long archived reply. ' + '完整回复😀 '.repeat(4000) : `Final **verified** archive reply for ${question}.\n\n- Synthetic result alpha\n- Synthetic result beta\n\nReady to review.` }], timestamp: ++time, stopReason: 'stop', model: 'fixture' });
        return id;
    };
    for (let i = 0; i < count; i++) {
        questions.push(`Archived question ${String(i).padStart(3, '0')}: 请核对😀合成记录`);
        ids.push(append(sm, questions[i], i === 3));
        if (i === 10) sm.appendCustomMessageEntry('scheduled-task', 'Synthetic Agent notice: archive task finished.', true);
        if (i === 15) sm.appendCompaction('Older compaction inside archive', ids[8], 12000);
    }
    if (notices) for (const [type, text] of ARCHIVE_NOTICES) sm.appendCustomMessageEntry(type, text, true);
    const kept = append(sm, 'Live retained question one');
    append(sm, 'Live retained question two');
    sm.appendCompaction('Latest compaction: synthetic history only', kept, 48000);
    append(sm, 'Live question after latest compaction');
    const other = SessionManager.inMemory(cwd); append(other, 'Second thread live question'); append(other, 'Second thread live question two');
    const index = historyArchive(sm, { view: 'index' });
    const items = [...index.turns];
    while (items.length < index.total) items.push(...historyArchive(sm, { view: 'index', offset: items.length, revision: index.revision }).turns);
    const branch = sm.getBranch(), ci = branch.findLastIndex(e => e.type === 'compaction'), cut = branch.findIndex(e => e.id === branch[ci].firstKeptEntryId);
    const contextIds = new Set(buildContextEntries(sm.getEntries(), sm.getLeafId()).map(e => e.id));
    assert.ok(branch.slice(0, cut).every(e => !contextIds.has(e.id)), 'archive prefix is outside native model context');
    assert.ok(branch.slice(cut, ci).filter(e => e.type === 'message').every(e => contextIds.has(e.id)), 'kept messages remain in native context');
    assert.equal(items.filter(t => t.kind === 'user').length, count);
    assert.equal(items.filter(t => t.kind === 'agent').length, 1 + (notices ? ARCHIVE_NOTICES.length : 0));
    assert.equal(items.filter(t => t.kind === 'summary').length, 1);
    return { sm, other, ids, questions, items, total: index.total, kept, append };
}
// Mirror supervisor get_messages: use Pi's compaction-aware mapping, including webAnchors.
function transcript(sdk, manager) {
    const messages = [], webAnchors = [];
    for (const entry of sdk.buildContextEntries(manager.getEntries(), manager.getLeafId())) {
        const mapped = sdk.sessionEntryToContextMessages(entry), first = mapped[0];
        if (entry.type === 'message' && first?.timestamp != null) webAnchors.push([entry.id, first.role, first.timestamp, first.toolCallId || '']);
        messages.push(...mapped);
    }
    return { messages, webAnchors };
}
function snapshot(manager) {
    return { entries: structuredClone(manager.getEntries().filter(e => e.type !== 'label')), context: structuredClone(manager.buildSessionContext()) };
}
async function setup(browser, sdk, { width = 1440, height = 1000, count = 60, enabled = true, indexFailures = 0, refreshDelay = 0, operationRefusals = 0, notices = false, language = 'zh-CN' } = {}) {
    const mobile = width < 900, data = fixture(sdk, count, notices);
    const context = await browser.newContext({ locale: language, viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), commands = [], errors = [], writes = [], failures = [];
    const ctl = { hold: false, held: null, busy: 0, indexFailures, operationRefusals, refreshing: false, readsDuringRefresh: 0, socket: null, maxBackground: 0, current: data.sm };
    const baseline = snapshot(data.sm), otherBaseline = snapshot(data.other), backgroundRequests = new Set();
    const sessions = [{ id: 'a', cwd, name: 'Compacted archive fixture', messageCount: count * 4 }, { id: 'b', cwd, name: 'Second thread', messageCount: 8 }];
    const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
    const archiveRequests = view => commands.filter(c => c.type === 'get_history_archive' && (!view || c.view === view));
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd, language }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a'); localStorage.setItem('pi.workspace.theme', 'daylight');
        localStorage.setItem('pi.workspace.language', language);
        window.__archiveSockets = [];
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, ...args) {
            if (type === 'message' && this.url?.endsWith('/api/pi/ws') && !window.__archiveSockets.includes(this)) window.__archiveSockets.push(this);
            return add.call(this, type, ...args);
        };
    }, { cwd, language });
    await page.route('**/api/**', route => {
        const r = route.request(), p = new URL(r.url()).pathname;
        if (r.method() !== 'GET') { writes.push(`${r.method()} ${p}`); return route.fulfill({ json: {} }); }
        if (p === '/api/pi/status') return route.fulfill({ json: { ok: true, ...(refreshDelay ? { modelCatalog: true } : {}), historySearch: true, ...(enabled ? { historyArchive: true } : {}), historyBody: true, sessionTree: true, historyPresentation: true, treePresentation: true, sessionWorkflows: true, projectRoots: ['/srv'] } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Archive fixture', sessionCount: 2 }], roots: ['/srv'] } });
        if (p === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (p === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] } });
        if (p.endsWith('/deferred')) return route.fulfill({ json: { jobs: [] } });
        if (p.endsWith('/workflow')) return route.fulfill({ json: { prompts: [], replies: [], versions: [] } });
        return route.fulfill({ json: p.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ctl.socket = ws;
        let manager = data.sm;
        // A closed transport no longer owns a client request; held late responses
        // are still delivered below to exercise generation rejection independently.
        ws.onClose(() => { for (const request of backgroundRequests) if (request.ws === ws) backgroundRequests.delete(request); });
        const reply = (cmd, response, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data: response, error: error?.message, errorCode: error?.code }));
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd);
            if (cmd.type === 'open_session') {
                manager = cmd.sessionId === 'b' ? data.other : data.sm; ctl.current = manager;
                return reply(cmd, { session: sessions.find(s => s.id === cmd.sessionId), state: { model, isStreaming: false }, messages: transcript(sdk, manager), models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} });
            }
            if (cmd.type === 'refresh_models') {
                ctl.refreshing = true;
                setTimeout(() => { ctl.refreshing = false; reply(cmd, { models: [model] }); }, refreshDelay);
                return;
            }
            if (ctl.refreshing && ['get_history_archive', 'search_history'].includes(cmd.type)) {
                ctl.readsDuringRefresh++;
                return reply(cmd, null, new Error('会话正在执行命令、切换或重新加载，请稍后查询历史'));
            }
            if (cmd.type === 'get_state') return reply(cmd, { model, isStreaming: false });
            if (cmd.type === 'get_messages') return reply(cmd, transcript(sdk, manager));
            if (cmd.type === 'get_session_stats') return reply(cmd, {});
            const isBackground = cmd.type === 'get_history_archive' || (cmd.type === 'search_history' && cmd.bookmarked === true);
            const pending = { ws, cmd };
            if (isBackground) { backgroundRequests.add(pending); ctl.maxBackground = Math.max(ctl.maxBackground, backgroundRequests.size); }
            const source = manager;
            const finish = (response, error) => { backgroundRequests.delete(pending); reply(cmd, response, error); };
            const run = () => {
                try {
                    if (cmd.type === 'get_history_archive') {
                        if (cmd.view === 'index' && ctl.operationRefusals > 0) { ctl.operationRefusals--; throw new Error('会话正在执行命令、切换或重新加载，请稍后查询历史'); }
                        if (cmd.view === 'index' && ctl.indexFailures > 0) { ctl.indexFailures--; throw new Error('Synthetic index failure'); }
                        if (cmd.view === 'turns' && ctl.busy > 0) { ctl.busy--; throw new Error('历史查询正在进行，请稍后重试'); }
                        const response = historyArchive(source, cmd);
                        if (cmd.view === 'turns' && ctl.hold) { ctl.hold = false; ctl.held = { ws, cmd, response, finish }; return; }
                        return finish(response);
                    }
                    if (cmd.type === 'search_history') return finish(searchHistory(source, cmd, { settled: true }));
                    if (cmd.type === 'get_history_entry') return finish(previewHistory(source, cmd, { settled: true }));
                    if (cmd.type === 'set_history_bookmark') {
                        const response = setHistoryBookmark(source, cmd, source.appendLabelChange.bind(source));
                        ws.send(JSON.stringify({ type: 'gateway_history_changed', entryId: cmd.entryId })); return finish(response);
                    }
                    throw new Error('Unexpected RPC ' + cmd.type);
                } catch (e) { failures.push({ type: cmd.type, view: cmd.view, message: e.message, code: e.code }); finish(null, e); }
            };
            setTimeout(run, 70);
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled && document.querySelectorAll('.pi-timeline-tick').length >= 4);
    if (enabled) {
        if (indexFailures) await page.locator('.pi-archive-head .pi-archive-link').waitFor();
        else await page.waitForFunction(total => document.querySelectorAll('.pi-timeline-tick').length === total + 4, data.total);
    }
    await eventually(page, () => commands.some(c => c.type === 'search_history' && c.bookmarked), 'outline bookmark snapshot requested');
    await page.waitForTimeout(120); await frames(page);
    const harness = { page, context, data, ctl, commands, archiveRequests, errors, failures, mobile, width,
        async unchanged() { assert.deepEqual(snapshot(data.sm), baseline, 'archive reads and native labels preserve non-label entries and buildSessionContext'); assert.deepEqual(snapshot(data.other), otherBaseline); },
        async safe() {
            assert.deepEqual(errors, [], 'no pageerror'); assert.deepEqual(writes, [], 'no non-GET REST');
            assert.ok(!commands.some(c => ['prompt', 'steer', 'follow_up', 'compact'].includes(c.type)), 'no conversational mutation RPC');
            assert.ok(ctl.maxBackground <= 1, `background archive and bookmark reads are serialized (maximum ${ctl.maxBackground})`);
            assert.ok(!failures.some(f => f.message.startsWith('Unexpected RPC')), 'mock rejects unexpected RPCs');
        },
        async close() { await context.close(); }
    };
    return harness;
}
async function searchLocate(h, questionNumber) {
    const { page, data } = h, index = data.items.findIndex(t => t.entryId === data.ids[questionNumber]);
    assert.equal(await section(page, index).count(), 0, 'History target starts unloaded');
    const before = h.archiveRequests('turns').length;
    await openInspector(page, 'history');
    if (await page.locator('#pi-history-preview').isVisible()) await page.locator('#pi-history-preview-close').click();
    await page.locator('#pi-history-query').fill(data.questions[questionNumber]);
    const row = page.locator(`[data-history-id="${data.ids[questionNumber]}"]`); await row.waitFor(); await row.click();
    await page.locator('#pi-history-locate').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-history-locate').getAttribute('hidden'), null);
    await page.locator('#pi-history-locate').click(); await located(page, index);
    assert.ok(h.archiveRequests('turns').slice(before).some(c => c.start <= index && c.end > index), 'History locate loads the archived target');
    if (h.mobile) assert.equal(await page.locator('#pi-inspector').evaluate(n => n.classList.contains('open')), false, 'mobile History locate closes overlay');
    else await page.locator('#pi-close-inspector').click();
    return index;
}
async function bookmark(h, index) {
    const { page, data, commands } = h, item = data.items[index];
    const before = commands.filter(c => c.type === 'set_history_bookmark').length;
    if (h.mobile) {
        await section(page, index).locator('.pi-message.user').scrollIntoViewIfNeeded();
        await section(page, index).locator('.pi-message-bookmark').click();
    } else {
        await hover(page, index); await page.locator('.pi-timeline-card').hover(); await page.locator('.pi-timeline-mark').click();
    }
    await page.waitForFunction(index => document.querySelector(`.pi-timeline-tick[data-index="${index}"]`).classList.contains('is-marked'), index);
    await eventually(page, () => data.sm.getLabel(item.entryId) === clipped(item.title), 'bookmark persisted in native label');
    const writes = commands.filter(c => c.type === 'set_history_bookmark');
    assert.equal(writes.length, before + 1);
    assert.deepEqual({ entryId: writes.at(-1).entryId, revision: writes.at(-1).expectedBookmarkRevision, label: writes.at(-1).label }, { entryId: item.entryId, revision: 'none', label: clipped(item.title) });
    await page.waitForFunction(index => {
        const button = document.querySelector(`.pi-archive-turn[data-archive-index="${index}"] .pi-message-bookmark`);
        return !button || (button.getAttribute('aria-busy') === 'false' && button.getAttribute('aria-pressed') === 'true');
    }, index);
}
async function core(browser, sdk, viewport) {
    const h = await setup(browser, sdk, viewport), { page, data, archiveRequests } = h;
    try {
        assert.ok(archiveRequests().every(c => c.view === 'index'), 'opening only loads the archive index');
        assert.equal(await page.locator('.pi-archive-turn').count(), 0);
        assert.match(await page.locator('.pi-archive-head-text').innerText(), new RegExp(`${data.total - 1} 个问题`));
        const liveCount = await page.locator('#pi-transcript-content > .pi-message.user, #pi-transcript-content > .pi-agent-turn-start, #pi-transcript-content > .pi-summary-notice').count();
        assert.equal(await page.locator('.pi-timeline-tick').count(), data.total + liveCount);
        assert.equal(await tick(page, data.items.findIndex(t => t.kind === 'summary')).evaluate(n => n.classList.contains('is-summary')), true);
        if (!h.mobile) {
            // Summaries are landmarks: their preview offers no bookmark action.
            await hover(page, data.items.findIndex(t => t.kind === 'summary'));
            assert.equal(await page.locator('.pi-timeline-card .pi-timeline-mark').isVisible(), false, 'archived summary is not bookmarkable');
            await page.mouse.move(1, 1);
        }
        await topOf(page, '.pi-archive-head', 16);
        await page.waitForTimeout(250);
        assert.equal(archiveRequests('turns').length, 0, 'programmatic scrolling does not arm archive loading');
        if (h.mobile) {
            for (const theme of themes) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
                const geometry = await page.locator('.pi-archive-head').evaluate(node => {
                    const head = node.getBoundingClientRect(), title = node.querySelector('.pi-archive-head-text').getBoundingClientRect(), note = node.querySelector('.pi-archive-head-note').getBoundingClientRect();
                    return { direction: getComputedStyle(node).flexDirection, titleCenter: (title.left + title.right) / 2, noteCenter: (note.left + note.right) / 2, center: (head.left + head.right) / 2, titleBottom: title.bottom, noteTop: note.top, noteHeight: note.height, lineHeight: parseFloat(getComputedStyle(node.querySelector('.pi-archive-head-note')).lineHeight) };
                });
                assert.equal(geometry.direction, 'column'); assert.ok(geometry.noteTop >= geometry.titleBottom);
                assert.ok(Math.abs(geometry.titleCenter - geometry.center) <= 2 && Math.abs(geometry.noteCenter - geometry.center) <= 2, 'head is two centered lines');
                assert.ok(geometry.noteHeight <= geometry.lineHeight + 1, 'note fits on one line');
                await noOverflow(page); await screenshot(page, `${h.width}-${theme}-rest`);
            }
            await page.locator('.pi-archive-load').click();
            await page.waitForFunction(() => document.querySelectorAll('.pi-archive-turn').length >= 12);
            assert.deepEqual([archiveRequests('turns')[0].start, archiveRequests('turns')[0].end], [data.total - 12, data.total], 'mobile pill loads newest segment');
            const index = await searchLocate(h, 20); await bookmark(h, index);
            for (const theme of themes) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
                await section(page, index).scrollIntoViewIfNeeded(); await noOverflow(page); await screenshot(page, `${h.width}-${theme}-loaded-bookmark`);
            }
        } else {
            await hover(page, 0);
            assert.equal(await page.locator('.pi-timeline-title').innerText(), data.items[0].title);
            assert.match(await page.locator('.pi-timeline-reply').innerText(), /Final verified archive reply/);
            assert.equal(archiveRequests('turns').length, 0, 'hover uses index excerpts without loading body');
            await page.mouse.move(1400, 100);
            for (const theme of themes) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme); await screenshot(page, `1440-${theme}-rest`);
            }
            // Hold the first real wheel-triggered response, then measure the same surviving
            // live summary before and after insertion. Wheel motion is excluded from the delta.
            await topOf(page, '#pi-transcript-content > .pi-summary-notice', -20);
            h.ctl.hold = true;
            const box = await page.locator('#pi-transcript').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + 40); await page.mouse.wheel(0, -1);
            await eventually(page, () => h.ctl.held, 'wheel-up arms newest archive segment');
            await frames(page);
            const anchor = page.locator('#pi-transcript-content > .pi-summary-notice');
            const before = await anchor.evaluate(n => n.getBoundingClientRect().top);
            const markReadsBefore = h.commands.filter(c => c.type === 'search_history' && c.bookmarked).length;
            h.ctl.socket.send(JSON.stringify({ type: 'gateway_history_changed', entryId: data.ids[0] }));
            await page.waitForTimeout(120);
            assert.equal(h.commands.filter(c => c.type === 'search_history' && c.bookmarked).length, markReadsBefore, 'bookmark read waits behind held archive read');
            h.ctl.held.finish(h.ctl.held.response); h.ctl.held = null;
            await page.waitForFunction(() => document.querySelectorAll('.pi-archive-turn').length >= 12); await frames(page);
            assert.ok(Math.abs(await anchor.evaluate(n => n.getBoundingClientRect().top) - before) <= 2, 'insertion preserves the top viewport anchor within two pixels');
            const first = archiveRequests('turns')[0]; assert.deepEqual([first.start, first.end], [data.total - 12, data.total]);
            // The next upper pill loads the next segment backwards. Clicking does not arm
            // an otherwise fresh archive; here the reader has already explicitly scrolled up.
            await page.locator('.pi-archive-gap[data-start="0"] .pi-archive-load').evaluate(n => n.click());
            await eventually(page, () => archiveRequests('turns').length >= 2, 'second backward segment requested');
            assert.equal(archiveRequests('turns')[1].end, first.start);
            await page.waitForFunction(total => document.querySelector(`.pi-archive-turn[data-archive-index="${total - 24}"]`), data.total);
            await topOf(page, `.pi-archive-turn[data-archive-index="${data.total - 10}"]`, -60);
            for (const theme of themes) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme); await screenshot(page, `1440-${theme}-scrolled`);
            }
            assert.equal(await section(page, 0).count(), 0);
            const jumpBefore = archiveRequests('turns').length;
            await tick(page, 0).click(); await located(page, 0);
            assert.ok(archiveRequests('turns').slice(jumpBefore).some(c => c.start === 0 && c.end > 0), 'unloaded oldest tick loads containing segment');
            for (const theme of themes) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme); await screenshot(page, `1440-${theme}-jump`);
            }
            const middle = page.locator('.pi-archive-gap:not([data-start="0"])').first();
            assert.match(await middle.innerText(), /显示中间的 \d+ 个问题/);
            const start = Number(await middle.getAttribute('data-start')), end = Number(await middle.getAttribute('data-end'));
            assert.ok(await middle.evaluate(n => n.getBoundingClientRect().top > document.querySelector('#pi-transcript').getBoundingClientRect().bottom), 'middle gap is below the reader');
            const middleBefore = archiveRequests('turns').length;
            // Activate the offscreen pill without Playwright's scrollIntoView moving the
            // reader to its other side; portion() must use its current below-reader geometry.
            await middle.locator('button').evaluate(n => n.click());
            await eventually(page, () => archiveRequests('turns').length > middleBefore, 'middle gap requested');
            assert.deepEqual([archiveRequests('turns')[middleBefore].start, archiveRequests('turns')[middleBefore].end], [start, Math.min(start + 12, end)], 'below-reader middle gap loads START of its run');
            await section(page, start).waitFor();
            await section(page, data.items.findIndex(t => t.kind === 'agent')).locator('.pi-archive-agent').waitFor();
            assert.match(await section(page, data.items.findIndex(t => t.kind === 'agent')).innerText(), /Synthetic Agent notice/);
            assert.equal(await section(page, data.items.findIndex(t => t.kind === 'summary')).locator('.compactionSummary').count(), 1, 'older archive compaction renders as a summary');
            const process = section(page, 0).locator('.pi-archive-process');
            await process.locator('summary').click(); await process.locator('.pi-archive-step').first().waitFor();
            assert.ok(archiveRequests('process').some(c => c.index === 0));
            assert.equal(await process.locator('.pi-archive-step').count(), historyArchive(data.sm, { view: 'process', index: 0, revision: first.revision }).total);
            for (const theme of themes) {
                await page.evaluate(t => document.documentElement.dataset.theme = t, theme); await screenshot(page, `1440-${theme}-process`);
            }
            const step = process.locator('.pi-archive-step.is-tool').first(), stepId = await step.getAttribute('data-entry-id');
            await step.click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
            assert.ok(h.commands.some(c => c.type === 'get_history_entry' && c.entryId === stepId && c.view === 'record'), 'process step opens native record preview');
            assert.match(await page.locator('#pi-history-text').innerText(), /ARCHIVE_TOOL_RESULT_SENTINEL/);
            await page.locator('#pi-close-inspector').click();
            const longIndex = data.items.findIndex(t => t.entryId === data.ids[3]);
            const full = section(page, longIndex).getByRole('button', { name: '内容较长，在历史中查看全文', exact: true });
            await full.click(); await page.locator('#pi-history-preview').waitFor({ state: 'visible' });
            assert.ok(h.commands.some(c => c.type === 'get_history_entry' && c.entryId === data.items[longIndex].reply.entryId && c.view === 'body'), 'truncated reply opens native body preview');
            await page.locator('#pi-close-inspector').click();
            const index = await searchLocate(h, 25); await bookmark(h, index);
            await noOverflow(page);
        }
        const actions = await page.locator('.pi-archive-turn .pi-message.user header button').evaluateAll(nodes => nodes.map(n => ({ className: n.className, title: n.title })));
        assert.ok(actions.length > 0);
        assert.ok(actions.every(n => /pi-message-bookmark|pi-message-copy/.test(n.className)), 'archived question headers offer only copy/bookmark');
        assert.equal(await page.locator('#pi-transcript-archive [data-workflow-action], #pi-transcript-archive .pi-workflow-action').count(), 0, 'no archive edit/retry/fork workflow controls');
        assert.doesNotMatch(await page.locator('#pi-transcript-archive').innerText(), /ARCHIVE_THINKING_SENTINEL|ARCHIVE_TOOL_RESULT_SENTINEL/);
        await h.unchanged(); await h.safe();
        console.log(`PASS ${h.width}: index-only open, merged outline, ${h.mobile ? 'two-line head, pill, mobile History locate/header bookmark' : 'index hover, wheel/backward loads, ±2px anchor, oldest tick jump, middle START, process record/full-text preview, History locate/outline bookmark'}, three themes, no overflow, native read-only; background maximum ${h.ctl.maxBackground}`);
    } catch (e) { await screenshot(page, `${h.width}-failure`); throw e; }
    finally { await h.close(); }
}
async function boundaries(browser, sdk) {
    for (const options of [{ refreshDelay: 1800 }, { operationRefusals: 1 }]) {
        const firstOpen = await setup(browser, sdk, options);
        try {
            assert.match(await firstOpen.page.locator('.pi-archive-head-text').innerText(), /个问题/);
            assert.equal(await firstOpen.page.getByRole('button', { name: '重试', exact: true }).count(), 0);
            assert.equal(firstOpen.ctl.readsDuringRefresh, 0, 'background history waits for model refresh to release the operation lock');
            assert.equal(firstOpen.archiveRequests('index').length, options.operationRefusals ? 2 : 1);
            assert.equal(firstOpen.archiveRequests('turns').length, 0);
            await firstOpen.unchanged(); await firstOpen.safe();
        } finally { await firstOpen.close(); }
    }
    console.log('PASS first open: delayed model refresh and transient operation refusal recover without clicking retry');
    // Index failure is recoverable only through its visible head retry control.
    let h = await setup(browser, sdk, { indexFailures: 1 });
    try {
        assert.match(await h.page.locator('.pi-archive-head').innerText(), /Synthetic index failure/);
        assert.equal(h.archiveRequests('index').length, 1);
        await h.page.getByRole('button', { name: '重试', exact: true }).click();
        await h.page.waitForFunction(() => document.querySelector('.pi-archive-head-text').textContent.includes('个问题'));
        assert.equal(h.archiveRequests('index').length, 2); assert.equal(h.archiveRequests('turns').length, 0);
        await h.unchanged(); await h.safe(); console.log('PASS index failure: head error, explicit retry succeeds');
    } finally { await h.close(); }
    // Busy refusal: exactly one delayed retry, then a manual gap retry, with no loop.
    for (const times of [1, 2]) {
        h = await setup(browser, sdk);
        try {
            h.ctl.busy = times;
            if (times === 2) {
                await topOf(h.page, '#pi-transcript-content > .pi-summary-notice', -20);
                const box = await h.page.locator('#pi-transcript').boundingBox();
                await h.page.mouse.move(box.x + 100, box.y + 40); await h.page.mouse.wheel(0, -1);
            } else await h.page.locator('.pi-archive-load').evaluate(n => n.click());
            if (times === 1) await h.page.waitForFunction(() => document.querySelectorAll('.pi-archive-turn').length === 12);
            else await h.page.locator('.pi-archive-error').waitFor();
            assert.equal(h.archiveRequests('turns').length, 2, 'busy read retries exactly once');
            assert.deepEqual(h.archiveRequests('turns')[0], { ...h.archiveRequests('turns')[1], id: h.archiveRequests('turns')[0].id }, 'retry repeats identical read');
            await h.page.waitForTimeout(1500);
            assert.equal(h.archiveRequests('turns').length, 2, 'no additional automatic retry');
            if (times === 2) {
                assert.match(await h.page.locator('.pi-archive-error').innerText(), /历史查询正在进行，请稍后重试/);
                await h.page.getByRole('button', { name: '重新加载', exact: true }).click();
                await h.page.waitForFunction(() => document.querySelectorAll('.pi-archive-turn').length >= 12);
                const failed = h.archiveRequests('turns')[0];
                assert.equal(h.archiveRequests('turns').filter(c => c.start === failed.start && c.end === failed.end).length, 3, 'explicit retry submits the failed range once; an armed reader may then load another segment');
            }
            await h.unchanged(); await h.safe(); console.log(`PASS busy ${times}: one retry, ${times === 2 ? 'gap error/manual recovery/no loop' : 'success'}, background maximum ${h.ctl.maxBackground}`);
        } finally { await h.close(); }
    }
    h = await setup(browser, sdk);
    try {
        const old = historyArchive(h.data.sm, { view: 'index' }).revision;
        h.data.sm.appendCompaction('New native compaction while old index is displayed', h.data.kept, 49000);
        const fresh = historyArchive(h.data.sm, { view: 'index' }).revision, afterCompaction = snapshot(h.data.sm);
        assert.notEqual(old, fresh);
        await h.page.locator('.pi-archive-load').evaluate(n => n.click());
        await eventually(h.page, () => h.archiveRequests('index').length === 2, 'HISTORY_STALE reloads index');
        await h.page.waitForFunction(() => document.querySelector('.pi-archive-head-text').textContent.includes('个问题'));
        assert.ok(h.failures.some(f => f.code === 'HISTORY_STALE'));
        assert.equal(h.archiveRequests('turns')[0].revision, old);
        assert.equal(await h.page.locator('.pi-archive-turn').count(), 0);
        await h.page.locator('.pi-archive-load').evaluate(n => n.click());
        await h.page.waitForFunction(() => document.querySelectorAll('.pi-archive-turn').length === 12);
        assert.equal(h.archiveRequests('turns').at(-1).revision, fresh);
        assert.deepEqual(snapshot(h.data.sm), afterCompaction, 'stale recovery makes no further native changes');
        await h.safe(); console.log('PASS stale: native new compaction invalidates turns, reloads index, fresh revision succeeds');
    } finally { await h.close(); }
    h = await setup(browser, sdk);
    try {
        h.ctl.hold = true; await h.page.locator('.pi-archive-load').evaluate(n => n.click());
        await eventually(h.page, () => h.ctl.held, 'turns response held before thread switch');
        const held = h.ctl.held;
        await h.page.locator('[data-filter="all"]').click();
        // The old thread's archive leaves with its transcript, before the new thread finishes opening.
        const immediate = await h.page.locator('[data-session-id="b"] .pi-session-main').evaluate(n => {
            n.click(); return { hidden: document.querySelector('#pi-transcript-archive').hidden, children: document.querySelector('#pi-transcript-archive').childElementCount };
        });
        assert.deepEqual(immediate, { hidden: true, children: 0 }, 'archive cleared synchronously on thread switch');
        await h.page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b' && !document.querySelector('#pi-input').disabled && document.querySelectorAll('.pi-timeline-tick').length === 2);
        const record = JSON.stringify({ type: 'response', id: held.cmd.id, command: held.cmd.type, success: true, data: held.response });
        held.finish(held.response);
        // Deliver an already queued message even though switching closes the old socket.
        await h.page.evaluate(record => window.__archiveSockets[0].dispatchEvent(new MessageEvent('message', { data: record })), record);
        await frames(h.page);
        assert.equal(await h.page.locator('.pi-archive-turn').count(), 0);
        assert.equal(await h.page.locator('#pi-transcript-archive').isVisible(), false);
        assert.equal(await h.page.locator('.pi-timeline-tick').count(), 2);
        assert.match(await h.page.locator('#pi-transcript-content').innerText(), /Second thread live question/);
        assert.doesNotMatch(await h.page.locator('#pi-transcript-content').innerText(), /Archived question/);
        await h.unchanged(); await h.safe(); console.log('PASS switch: held old turns cannot insert into new thread');
    } finally { await h.close(); }
    h = await setup(browser, sdk, { enabled: false });
    try {
        assert.equal(await h.page.locator('.pi-timeline-tick').count(), 4);
        await topOf(h.page, '#pi-transcript-content > .pi-summary-notice');
        const box = await h.page.locator('#pi-transcript').boundingBox(); await h.page.mouse.move(box.x + 100, box.y + 40); await h.page.mouse.wheel(0, -100);
        await hover(h.page, 1); assert.match(await h.page.locator('.pi-timeline-title').innerText(), /Live retained question one/);
        await tick(h.page, 1).click();
        await h.page.waitForFunction(() => document.querySelector('#pi-transcript-content > .pi-message.user').classList.contains('pi-transcript-located'));
        await h.page.waitForTimeout(250);
        assert.equal(h.archiveRequests().length, 0); await h.unchanged(); await h.safe(); console.log('PASS capability absent: no archive RPC, live outline hover/jump still works');
    } finally { await h.close(); }
    h = await setup(browser, sdk, { count: 150 });
    try {
        assert.equal(h.archiveRequests('index').length, 2, 'large archive index paginates');
        assert.deepEqual(h.archiveRequests('index').map(c => c.offset), [0, 100]);
        assert.equal(h.archiveRequests('index')[1].revision, h.archiveRequests('index')[0].revision || historyArchive(h.data.sm, { view: 'index' }).revision);
        const loadedCounts = [];
        for (let i = 0; i < 14; i++) {
            const gap = h.page.locator('.pi-archive-gap[data-start="0"]');
            if (!await gap.count()) break;
            const end = Number(await gap.getAttribute('data-end'));
            await gap.locator('button').evaluate(n => n.click());
            await h.page.waitForFunction(index => document.querySelector(`.pi-archive-turn[data-archive-index="${index}"]`), end - 1);
            await frames(h.page);
            const count = await h.page.locator('.pi-archive-turn').count(); loadedCounts.push(count);
            assert.ok(count <= 120, `loaded sections stay within DOM cap: ${count}`);
        }
        assert.ok(h.archiveRequests('turns').length >= 11, 'load enough segments to exceed untrimmed 120-section cap');
        assert.ok(Math.max(...loadedCounts) >= 108, 'cap exercised near capacity');
        const covered = new Set(h.archiveRequests('turns').flatMap(c => Array.from({ length: c.end - c.start }, (_, i) => c.start + i)));
        assert.ok(covered.size > 120);
        const evicted = await h.page.locator('.pi-archive-gap').evaluateAll(nodes => nodes.map(n => [Number(n.dataset.start), Number(n.dataset.end)]));
        assert.ok(evicted.some(([start, end]) => Array.from({ length: end - start }, (_, i) => start + i).some(i => covered.has(i))), 'previously loaded sections become placeholders');
        await h.unchanged(); await h.safe(); console.log(`PASS DOM cap: 150 archived questions, ${h.archiveRequests('turns').length} segments, maximum ${Math.max(...loadedCounts)} loaded sections, evicted placeholders`);
    } finally { await h.close(); }
}
async function agentNotices(browser, sdk, width, language) {
    const h = await setup(browser, sdk, { width, height: 900, count: 20, notices: true, language }), { page, data } = h;
    try {
        // Load the newest native segment through the real archive projection, as in the screenshot.
        await page.locator('.pi-archive-load').evaluate(node => node.click());
        const agents = data.items.filter(item => ARCHIVE_NOTICES.some(([type]) => type === item.customType));
        await section(page, agents.at(-1).index).waitFor();
        for (const item of agents) {
            const card = section(page, item.index).locator('.pi-archive-agent');
            assert.equal(await card.locator('details').count(), 1, `${item.customType} has a disclosure in archived history`);
            assert.equal(await card.locator('details').evaluate(node => node.open), false, `${item.customType} starts collapsed`);
            assert.ok(await card.evaluate(node => node.getBoundingClientRect().height) <= 100, `${item.customType} stays compact`);
        }
        const request = section(page, agents[0].index).locator('.pi-subagent-notice');
        assert.equal(await request.locator('summary strong').textContent(), language === 'en' ? 'Subagent needs guidance' : '子 Agent 请求指示');
        assert.equal(await request.locator('.pi-markdown').innerHTML(), '', 'archived notice Markdown stays lazy');
        await topOf(page, `.pi-archive-turn[data-archive-index="${agents[0].index}"]`, 16);
        await request.locator('summary').click();
        await request.locator('.pi-markdown strong').waitFor();
        assert.equal(await request.locator('.pi-markdown strong').textContent(), 'Review scope');
        const body = await request.locator('.pi-message-body').evaluate(node => ({ height: node.getBoundingClientRect().height, client: node.clientHeight, scroll: node.scrollHeight }));
        assert.ok(body.height <= 561 && body.scroll > body.client, 'archived supervisor request scrolls inside a bounded card');
        await screenshot(page, `agent-notice-open-${width}-${language}`);
        await request.locator('summary').click();
        const control = section(page, agents.find(item => item.customType === 'subagent_control_notice').index).locator('.pi-subagent-notice');
        assert.equal(await control.locator('summary strong').textContent(), language === 'en' ? 'Subagent status notice' : '子 Agent 状态提醒');
        assert.equal(await control.locator('details').evaluate(node => node.open), false, 'control notices from compacted history start collapsed');
        for (const item of agents.filter(item => item.customType.startsWith('pivane-'))) {
            const card = section(page, item.index).locator('.pi-archive-agent');
            await card.locator('summary').click();
            await page.waitForFunction(index => document.querySelector(`.pi-archive-turn[data-archive-index="${index}"] .pi-agent-card-content`)?.textContent.length > 0, item.index);
            assert.equal(await card.locator('.pi-agent-card-content').textContent(), ARCHIVE_NOTICES.find(([type]) => type === item.customType)[1], 'reduced archive records retain their source text');
            assert.equal(await card.locator('.pi-agent-card-content img').count(), 0, 'generic archived Agent text stays plain');
            await card.locator('summary').click();
        }
        await request.scrollIntoViewIfNeeded(); await screenshot(page, `agent-notices-collapsed-${width}-${language}`);
        await noOverflow(page);
        assert.deepEqual(await page.locator('.pi-archive-agent *').evaluateAll(nodes => nodes.filter(node => {
            const box = node.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
        }).map(node => node.className)), [], 'individual card contents fit the viewport');
        assert.equal(await page.evaluate(() => window.__archiveXss), undefined);
        assert.equal(await page.locator('.pi-archive-agent [onerror]').count(), 0);
        await h.unchanged(); await h.safe();
        console.log(`PASS archived Agent/subagent notices: ${width} ${language}`);
    } finally { await h.close(); }
}
(async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try {
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await agentNotices(browser, sdk, width, language);
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await core(browser, sdk, viewport);
        await boundaries(browser, sdk);
        console.log('PASS archive: all 16 scenario groups; desktop 1440/mobile 393/320, daylight/mint/dark; no pageerror or forbidden writes');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
