const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_EDITS_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/srv/turn-edits-fixture';
const session = { id: 'edits', cwd, name: '编辑记录', messageCount: 20 };
const other = { ...session, id: 'other', name: '另一个线程' };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const path = 'src/' + 'very-long-directory/'.repeat(12) + '<img onerror=alert(1)>.js';
const patch = 'Index: code.js\n--- code.js\n+++ code.js\n@@ -1,2 +1,2 @@\n-old 中文\n+new <img src=x onerror=alert(1)>\n keep\n';
const reverse = '--- code.js\n+++ code.js\n@@ -1,2 +1,2 @@\n-new <img src=x onerror=alert(1)>\n+old 中文\n keep\n';
let time = 1;
const user = content => ({ role: 'user', content, timestamp: time++ });
const answer = (content = '修改完成。', stopReason = 'stop') => ({ role: 'assistant', content, stopReason, timestamp: time++ });
function edit(id, file, source = patch, options = {}) {
    return [
        { role: 'assistant', timestamp: time++, content: [{ type: 'toolCall', id, name: options.name || 'edit', arguments: { path: file, edits: [{ oldText: 'old', newText: 'new' }] } }] },
        { role: 'toolResult', toolCallId: id, toolName: options.name || 'edit', timestamp: time++, isError: Boolean(options.error), content: [{ type: 'text', text: options.error ? 'Failed' : 'Success' }], details: options.legacy ? { diff: source } : { patch: source } }
    ];
}
async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900 });
    const page = await context.newPage();
    const errors = [], writes = [], commands = [];
    let socket, sideSocket, busy = false, activeId = session.id, sideStarts = 0, sideCloses = 0, heldState = null, holdState = false;
    const initial = [user('调整界面'), ...edit('a', path), ...edit('b', path, reverse), ...edit('c', 'docs/说明.md'), ...edit('d', 'public/style.css'),
        ...edit('e', 'public/app.js'), ...edit('failed', 'failed.txt', patch, { error: true }), ...edit('write', 'write.txt', patch, { name: 'write' }),
        ...edit('bash', 'script.txt', patch, { name: 'bash' }), answer(), user('只回答问题'), answer('无需编辑'),
        user('旧版编辑后停止'), ...edit('legacy', 'legacy.txt', '-1 old\n+1 new', { legacy: true }), answer('', 'aborted')];
    // Repeated authoritative results must not double-count an edit.
    initial.splice(3, 0, structuredClone(initial[2]));
    let messages = initial;
    const runtime = () => ({ model, thinkingLevel: 'off', isStreaming: busy, isCompacting: false });
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    const emit = event => socket.send(JSON.stringify(event));
    const refresh = async () => {
        const count = commands.filter(c => c === 'get_messages').length;
        emit({ type: 'agent_settled' });
        await page.waitForFunction(() => document.querySelector('#pi-composer-status').textContent === 'Pi Agent 已就绪');
        await assertEventually(() => commands.filter(c => c === 'get_messages').length > count);
    };
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id);
        window.__copies = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
    }, { cwd, id: session.id });
    await page.route('**/api/**', route => {
        const request = route.request(), endpoint = new URL(request.url()).pathname;
        if (request.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }); }
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, sideChat: true, historySearch: viewport.width !== 320, projectRoots: ['/srv'] } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Edits', sessionCount: 2 }], roots: ['/srv'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, other] } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (endpoint.includes('history') || endpoint === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let side = false;
        ws.onClose(() => { if (side) sideCloses++; });
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd.type);
            if (cmd.type === 'open_side_chat') {
                side = true; sideSocket = ws; sideStarts++;
                return reply(ws, cmd, { state: runtime(), messages: [], stats: {}, limits: { messageCharacters: 8000 }, reference: { mode: 'blank', source: { name: 'Fixture' }, capturedAt: new Date().toISOString(), messageCount: 0 } });
            }
            if (cmd.type === 'open_session') {
                socket = ws; activeId = cmd.sessionId;
                return reply(ws, cmd, { session: activeId === session.id ? session : other, state: runtime(), messages: { messages: activeId === session.id ? messages : [] }, stats: {},
                    models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (cmd.type === 'prepare_side_chat') return reply(ws, cmd, { ticket: 'fixture-ticket', reference: { mode: 'blank', capturedAt: new Date().toISOString(), source: {} } });
            if (cmd.type === 'search_history') return reply(ws, cmd, { results: [], offset: 0, pageSize: 20, revision: 'fixture', hasMore: false, total: 0 });
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: side || activeId !== session.id ? [] : messages });
            if (cmd.type === 'get_state') {
                if (holdState && !side) { heldState = { ws, cmd }; return; }
                return reply(ws, cmd, runtime());
            }
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
            throw new Error(`Unexpected RPC ${cmd.type}`);
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 2);
    const cards = page.locator('.pi-turn-edits');
    assert.match(await cards.first().textContent(), /4 个文件/);
    assert.doesNotMatch(await cards.first().textContent(), /failed.txt|write.txt|script.txt/);
    assert.equal(await cards.first().locator(':scope > .pi-edit-file').count(), 3);
    assert.match(await cards.first().locator('.pi-edit-file').first().textContent(), /2 次 · \+2 −2/);
    assert.equal(await page.locator('#pi-inspector').evaluate(n => n.classList.contains('open')), false, 'completion does not open the panel');
    assert.equal(await cards.last().evaluate(n => n.previousElementSibling.textContent.includes('回复已停止')), true);
    await cards.first().locator('.pi-edits-more > summary').click();
    const more = cards.first().locator('.pi-edits-more'), collapse = more.locator('.pi-edits-collapse');
    await collapse.waitFor({ state: 'visible' });
    assert.equal(await more.locator(':scope > summary').isVisible(), false, 'expanded disclosure no longer interrupts the file list');
    assert.equal(await cards.first().evaluate(n => {
        const footer = n.querySelector('.pi-edits-collapse').getBoundingClientRect();
        return [...n.querySelectorAll('.pi-edit-file')].every(file => file.getBoundingClientRect().bottom <= footer.top + 1);
    }), true, 'collapse control is below every file');
    await collapse.focus(); await page.keyboard.press('Space');
    assert.equal(await more.evaluate(n => n.open), false);
    assert.equal(await cards.first().locator('.pi-edit-file:visible').count(), 3);
    assert.equal(await more.locator('summary').evaluate(n => n === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.pi-edits-more > .pi-edit-file'));
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const colors = await cards.first().evaluate(n => ['.pi-edit-added', '.pi-edit-removed'].map(selector =>
            getComputedStyle(n.querySelector(selector)).color.match(/\d+/g).map(Number)));
        assert.ok(colors[0][1] > colors[0][0] && colors[0][1] > colors[0][2], 'added count is green');
        assert.ok(colors[1][0] > colors[1][1] && colors[1][0] > colors[1][2], 'removed count is red');
        await checkWidth(page);
        await cards.first().screenshot({ path: `/tmp/pi-file-card-${viewport.width}-${theme}.png` });
    }
    await cards.first().scrollIntoViewIfNeeded();
    const readingTop = await cards.first().evaluate(n => n.getBoundingClientRect().top);
    await refresh();
    await page.waitForFunction(() => document.querySelector('.pi-edits-more').open);
    assert.ok(Math.abs(await cards.first().evaluate(n => n.getBoundingClientRect().top) - readingTop) < 2, 'snapshot preserves the main reading anchor');
    await cards.first().locator('.pi-edit-file').first().click();
    await page.locator('#pi-changes-content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-changes-files .pi-edit-file').count(), 4);
    assert.equal(await page.locator('#pi-changes-diffs .pi-edit-record').count(), 2);
    assert.equal(await page.locator('#pi-changes-diffs .pi-edit-diff img').count(), 0);
    assert.equal(await page.locator('#pi-changes-title').evaluate(n => n === document.activeElement), true);
    const records = page.locator('#pi-changes-diffs .pi-edit-record');
    await records.first().getByRole('button', { name: '复制 patch' }).click();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), patch);
    await records.nth(1).locator(':scope > summary').click();
    await records.nth(1).getByRole('button', { name: '复制 patch' }).click();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), reverse, 'multiple edits remain separate including reversions');
    await page.locator('#pi-changes-diffs').evaluate(n => n.scrollTop = 60);
    const diffTop = await page.locator('#pi-changes-diffs').evaluate(n => n.scrollTop);
    await refresh();
    await page.waitForFunction(() => document.querySelectorAll('#pi-changes-diffs .pi-edit-record[open]').length === 2);
    assert.equal(await page.locator('#pi-changes-diffs').evaluate(n => n.scrollTop), diffTop);
    socket.close({ code: 1012, reason: 'Fixture reconnect' });
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('中断'));
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('已连接'));
    assert.equal(await records.nth(1).evaluate(n => n.open), true);
    assert.equal(await page.locator('#pi-changes-diffs').evaluate(n => n.scrollTop), diffTop);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await checkWidth(page);
        await page.screenshot({ path: `/tmp/pi-turn-edits-${viewport.width}-${theme}.png` });
    }
    if (viewport.width > 900) {
        const divider = page.locator('#pi-inspector-split'); await divider.focus(); await page.keyboard.press('ArrowLeft');
        await checkWidth(page);
    } else assert.ok(await page.locator('#pi-inspector').evaluate(n => n.clientWidth) >= viewport.width - 16, 'diff uses nearly the full mobile width');
    // Native tab navigation now includes the third pane, without starting side chat just to view changes.
    await page.locator('#pi-changes-tab').focus(); await page.keyboard.press('Home');
    assert.equal(await page.locator('#pi-details-tab').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End');
    assert.equal(await page.locator('#pi-changes-tab').getAttribute('aria-selected'), 'true');
    assert.equal(sideStarts, 0);
    if (viewport.width !== 320) {
        await page.locator('#pi-history-tab').click();
        await page.locator('#pi-history').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#pi-changes').isVisible(), false);
        await page.locator('#pi-toggle-inspector').click();
        assert.equal(await page.locator('#pi-inspector-details').isVisible(), true, 'details button selects details from any pane');
        await page.locator('#pi-changes-tab').click();
        assert.equal(await page.locator('#pi-history').isVisible(), false);
        assert.equal(await page.locator('#pi-inspector-tabs [aria-selected="true"]').count(), 1);
        await checkWidth(page);
    }
    await page.locator('#pi-side-tab').click();
    await page.waitForFunction(() => !document.querySelector('#pi-side-input').disabled);
    await page.locator('#pi-side-input').fill('保留侧聊草稿');
    await page.locator('#pi-changes-tab').click(); await page.locator('#pi-side-tab').click();
    assert.equal(await page.locator('#pi-side-input').inputValue(), '保留侧聊草稿');
    assert.equal(sideStarts, 1); assert.equal(sideCloses, 0); assert.ok(sideSocket);
    await page.locator('#pi-changes-tab').click(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-inspector').evaluate(n => n.classList.contains('open')), false);
    assert.equal(await cards.first().locator('.pi-edit-file').first().evaluate(n => n === document.activeElement), true);
    await cards.last().locator('.pi-edit-file').click();
    assert.match(await page.locator('#pi-changes-diffs').textContent(), /原始差异/);
    assert.equal(await page.locator('#pi-changes-diffs button').count(), 0, 'legacy display diff cannot be copied as a patch');
    await page.locator('#pi-close-inspector').click();
    await selectMessageView(page, 'full');
    assert.equal(await cards.count(), 2); assert.equal(await cards.last().isVisible(), true);
    await selectMessageView(page, 'reading');
    // Live tail: message_end and agent_end are not a settled round; completed earlier cards stay.
    const tailUser = user('工具完成但回复出错'), tailEdit = edit('live', 'new.txt'), tailAnswer = answer('', 'error');
    busy = true; messages = [...messages, tailUser, ...tailEdit];
    emit({ type: 'agent_start' }); emit({ type: 'message_end', message: tailUser });
    emit({ type: 'message_start', message: { ...tailEdit[0], content: [] } }); emit({ type: 'message_end', message: tailEdit[0] });
    emit({ type: 'message_end', message: tailEdit[1] }); emit({ type: 'agent_end' });
    assert.equal(await cards.count(), 2);
    // Running reconnect must not reveal the unfinished tail.
    socket.close({ code: 1012, reason: 'Running reconnect' });
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('中断'));
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('执行'));
    assert.equal(await cards.count(), 2);
    messages.push(tailAnswer); busy = false; await refresh();
    await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 3);
    assert.match(await cards.last().textContent(), /new.txt/);
    // Tool-only settled tails also keep the card outside folded execution records.
    messages = [...messages, user('只有工具结果'), ...edit('tool-only', 'only.txt')]; await refresh();
    await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 4);
    assert.equal(await cards.last().isVisible(), true);
    // A large patch is still complete; unknown counts are not fabricated for malformed hunks.
    const large = '--- big.txt\n+++ big.txt\n@@ -0,0 +1,4100 @@\n' + '+large line\n'.repeat(4100);
    messages = [...messages, user('大文件'), ...edit('big', 'big.txt', large), ...edit('malformed', 'bad.txt', '@@ -1 +1 @@\n+incomplete\n'), answer()];
    await refresh(); await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 5);
    await cards.last().locator('.pi-edit-file').first().click();
    assert.equal(await page.locator('#pi-changes-diffs .pi-diff-line').count(), 0);
    assert.equal(await page.locator('#pi-changes-diffs .pi-diff-code').textContent(), large);
    assert.match(await cards.last().textContent(), /行数未知/);
    assert.equal(await cards.last().locator('[data-edit-path="bad.txt"] .pi-edit-added, [data-edit-path="bad.txt"] .pi-edit-removed').count(), 0);
    // Context replacement removes unavailable records, without re-reading current disk content.
    messages = [{ role: 'compactionSummary', summary: '已压缩', timestamp: time++ }, ...edit('orphan', 'orphan.txt'), user('压缩后的问题'), answer()];
    await refresh(); await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 0);
    assert.equal(await page.locator('#pi-changes-diffs').textContent(), '');
    messages = initial; await refresh(); await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.pi-turn-edits').length === 2);
    assert.equal(await cards.first().locator('.pi-edits-more').evaluate(n => n.open), false, 'reload derives records without persisting UI expansion');
    await cards.first().locator('.pi-edit-file').first().click();
    holdState = true; emit({ type: 'agent_settled' }); await assertEventually(() => heldState !== null);
    await page.locator('#pi-close-inspector').click();
    if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="other"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
    try { reply(heldState.ws, heldState.cmd, runtime()); } catch {}
    assert.equal(await page.locator('#pi-changes-diffs').textContent(), '');
    assert.equal(await cards.count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    assert.ok(commands.every(type => ['open_session', 'get_messages', 'get_state', 'get_session_stats', 'prepare_side_chat', 'open_side_chat', 'search_history'].includes(type)));
    console.log(`PASS ${viewport.width}: grouping, deduplication, failed/unsupported edits, separate patches, counts, legacy/large, settled, reconnect, compaction, side draft, focus, themes and thread isolation`);
    await context.close();
}
async function assertEventually(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.ok(predicate(), 'expected fixture request');
}
async function checkWidth(page) {
    const overflow = await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-content', '#pi-inspector', '#pi-changes', '#pi-changes-content', '#pi-changes-files', '#pi-changes-diffs', '.pi-turn-edits'].filter(selector =>
        [...document.querySelectorAll(selector)].some(n => n.clientWidth && n.scrollWidth > n.clientWidth + 1)));
    assert.deepEqual(overflow, []);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
