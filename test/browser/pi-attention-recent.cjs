const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_ATTENTION_TEST_URL || 'http://127.0.0.1:3001';
const cwdA = '/srv/work-fixture-a', cwdB = '/srv/work-fixture-b';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'] };
const make = (cwd, id, modified) => ({ cwd, id, name: id, firstMessage: `Fixture ${id}`, messageCount: 2, modified });
const sessions = [make(cwdA, 'active', '2020-01-01T00:00:00Z'), make(cwdA, 'old-visited', '2020-01-01T00:00:00Z'),
    ...Array.from({ length: 8 }, (_, i) => make(i % 2 ? cwdB : cwdA, `attention-${i + 1}`, '2026-09-22T00:00:00Z')),
    ...Array.from({ length: 8 }, (_, i) => make(i % 2 ? cwdB : cwdA, `processing-${i + 1}`, '2026-09-21T00:00:00Z')),
    ...Array.from({ length: 15 }, (_, i) => make(i % 2 ? cwdB : cwdA, `recent-${String(i + 1).padStart(2, '0')}`, new Date(Date.UTC(2026, 8, 20, 0, 30 - i)).toISOString()))];

async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [], writes = [], commands = [], loaded = [];
    let activityOk = true, ephemeralStreaming = false, ephemeralSocket;
    const phases = ['running', 'tool', 'compacting', 'retrying'];
    const runtimes = sessions.filter(item => item.id.startsWith('processing-')).map((item, index) => ({ cwd: item.cwd, sessionId: item.id, phase: phases[index % 4], busy: true }));
    runtimes.push({ cwd: cwdA, sessionId: 'attention-1', phase: 'running', busy: true },
        { cwd: cwdA, sessionId: 'attention-3', phase: 'error', busy: false },
        { cwd: cwdB, sessionId: 'attention-4', phase: 'waiting', busy: true });
    let notices = [1, 2].map(n => ({ cwd: n === 1 ? cwdA : cwdB, sessionId: `attention-${n}`, completionId: `notice-${n}`, completedAt: new Date().toISOString() }));
    const deferred = sessions.filter(item => /^attention-[5-8]$/.test(item.id)).map(item => ({ cwd: item.cwd, sessionId: item.id, count: 1, attention: true }));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(cwd => {
        localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem(`pi.web.session:${cwd}`, 'active');
        localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd]));
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.copied.push(text) } });
    }, cwdA);
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') {
            writes.push(url.pathname);
            if (url.pathname.endsWith('/unread')) {
                const session = sessions.find(item => item.id === url.pathname.split('/').at(-2));
                const notice = { cwd: session.cwd, sessionId: session.id, completionId: 'manual-1', completedAt: new Date().toISOString(), manual: true };
                notices.push(notice);
                return route.fulfill({ json: { notice } });
            }
            if (url.pathname.endsWith('/read')) {
                notices = notices.filter(item => item.completionId !== req.postDataJSON().completionId);
                return route.fulfill({ json: { ok: true } });
            }
            throw new Error(`Unexpected write: ${url.pathname}`);
        }
        if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/srv'], manualUnread: true } });
        if (url.pathname === '/api/pi/projects') return route.fulfill({ json: { roots: ['/srv'], pinnedProjects: [], hiddenProjects: ['/srv/hidden-fixture'], projects: [
            ...[cwdA, cwdB].map((cwd, index) => ({ cwd, name: `Project ${index ? 'B' : 'A'}`, sessionCount: sessions.filter(item => item.cwd === cwd).length })),
            { cwd: '/srv/hidden-fixture', name: 'Hidden project', sessionCount: 1 }
        ] } });
        if (url.pathname === '/api/pi/sessions') {
            loaded.push(url.searchParams.get('cwd'));
            return route.fulfill({ json: { sessions: sessions.filter(item => item.cwd === url.searchParams.get('cwd')).sort((a, b) => b.modified.localeCompare(a.modified)) } });
        }
        if (url.pathname === '/api/pi/activity') return route.fulfill({ status: activityOk ? 200 : 503,
            json: { runtimes, replyNotices: notices, pinnedProjects: [], hiddenProjects: ['/srv/hidden-fixture'], deferred: { sessions: deferred } } });
        if (url.pathname.includes('history')) return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', socket => {
        let session, ephemeral = false;
        socket.onMessage(raw => {
            const command = JSON.parse(raw);
            commands.push(command.type);
            const state = { model, isStreaming: ephemeral && ephemeralStreaming, thinkingLevel: 'off' };
            let data = {};
            if (command.type === 'open_session' || command.type === 'open_ephemeral') {
                ephemeral = command.type === 'open_ephemeral';
                if (ephemeral) { ephemeralSocket = socket; state.isStreaming = ephemeralStreaming; }
                session = ephemeral ? null : sessions.find(item => item.id === command.sessionId && item.cwd === command.cwd);
                data = { ...(session ? { session } : {}), state, messages: { messages: [] }, stats: {}, models: { models: [model] },
                    thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, completion: notices.find(item => item.sessionId === session?.id) || null };
            } else if (command.type === 'get_state') data = state;
            else if (command.type === 'get_messages') data = { messages: [], completion: notices.find(item => item.sessionId === session?.id) || null };
            socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    const drawer = async () => {
        if (viewport.width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.waitForFunction(() => document.getElementById('pi-session-pane').getBoundingClientRect().left >= -1);
    };
    const choose = filter => page.locator(`#pi-session-filters [data-filter="${filter}"]`).click();
    const section = kind => page.locator(`[data-work-section="${kind}"]`);
    const ids = kind => section(kind).locator('[data-session-id]').evaluateAll(rows => rows.map(row => row.dataset.sessionId));
    const expectIds = async (kind, expected) => {
        await page.waitForFunction(({ kind, expected }) => JSON.stringify([...document.querySelectorAll(`[data-work-section="${kind}"] [data-session-id]`)].map(row => row.dataset.sessionId)) === JSON.stringify(expected), { kind, expected });
    };
    const assertUnique = async () => {
        const keys = await page.locator('#pi-session-list [data-session-id]').evaluateAll(rows => rows.map(row => `${row.dataset.cwd}:${row.dataset.sessionId}`));
        assert.equal(new Set(keys).size, keys.length, 'each thread has one row');
    };
    const open = async id => {
        await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
        await page.waitForFunction(id => document.querySelector('.pi-session-item.active')?.dataset.sessionId === id && !document.getElementById('pi-input').disabled, id);
        await drawer();
    };
    await drawer();
    assert.deepEqual(await page.locator('#pi-session-filters button').allTextContents(), ['全部', '工作中']);
    assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-work-section]').count(), 0);
    await choose('work');
    await expectIds('recent', ['active', 'recent-01', 'recent-02', 'recent-03', 'recent-04', 'recent-05']);
    assert.equal((await ids('attention')).length, 8, 'attention is not capped');
    assert.equal((await ids('running')).length, 8, 'processing is not capped');
    assert.equal(await section('attention').locator('[data-session-id="attention-1"] .pi-session-activity').getAttribute('data-phase'), 'running');
    assert.equal((await ids('running')).includes('attention-1'), false, 'unread takes priority over processing');
    assert.ok(loaded.includes(cwdB));
    assert.equal(loaded.includes('/srv/hidden-fixture'), false);
    assert.equal(commands.filter(command => command === 'open_session').length, 1, 'loading metadata must not open other runtimes');
    const order = await page.locator('[data-work-section]:not([hidden])').evaluateAll(nodes => nodes.map(node => node.dataset.workSection));
    assert.deepEqual(order, ['attention', 'running', 'recent']);
    await assertUnique();

    const toggle = page.locator('[data-work-action="toggle-recent"]');
    await toggle.click();
    assert.equal((await ids('recent')).length, 12);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    const toggleGeometry = await toggle.boundingBox();
    const rowBottom = await section('recent').locator('[data-session-id]').last().boundingBox();
    assert.ok(toggleGeometry.y >= rowBottom.y + rowBottom.height, 'collapse control follows all recent rows');
    await toggle.focus();
    const scrollTop = await page.locator('#pi-session-list').evaluate(node => node.scrollTop);
    await page.waitForResponse('**/api/pi/activity');
    await page.waitForTimeout(100);
    assert.equal((await ids('recent')).length, 12, 'poll preserves expanded limit');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#pi-session-list').evaluate(node => node.scrollTop), scrollTop);
    await toggle.press('Enter');
    assert.equal((await ids('recent')).length, 6);
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);

    await choose('all');
    assert.equal(await page.locator('.pi-work-session').count(), 0);
    assert.equal(await page.locator('.pi-session-project:visible').count(), 0);
    const more = page.locator(`[data-project-cwd="${cwdA}"] [data-project-action="more-threads"]`);
    if (await more.count()) await more.click();
    await open('old-visited');
    await open('active');
    await choose('work');
    const stableIds = ['active', 'old-visited', 'recent-01', 'recent-02', 'recent-03', 'recent-04'];
    await expectIds('recent', stableIds);
    const chosen = section('recent').locator('[data-session-id="recent-02"]');
    await chosen.scrollIntoViewIfNeeded();
    const before = await chosen.boundingBox();
    await open('recent-02');
    await expectIds('recent', stableIds);
    assert.equal(await chosen.evaluate(node => node.classList.contains('active')), true);
    const after = await chosen.boundingBox();
    assert.ok(Math.abs(after.y - before.y) <= 1, 'selection keeps the row at the same pointer position');
    // A repeated click at the same coordinates must keep opening this thread.
    if (viewport.width >= 900) {
        await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
        await page.waitForTimeout(100);
        assert.equal(await chosen.evaluate(node => node.classList.contains('active')), true);
    }
    await page.waitForResponse('**/api/pi/activity');
    await expectIds('recent', stableIds);
    await toggle.click();
    assert.deepEqual((await ids('recent')).slice(0, 6), stableIds);
    await toggle.click();
    await expectIds('recent', stableIds);
    await section('recent').locator('[data-session-id="old-visited"] .pi-session-main').focus();
    await section('recent').locator('[data-session-id="old-visited"] .pi-session-main').press('Enter');
    await page.waitForFunction(() => document.querySelector('.pi-session-item.active')?.dataset.sessionId === 'old-visited');
    await drawer();
    await expectIds('recent', stableIds);
    await open('recent-02');
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const colors = await section('recent').locator('[data-session-id]').evaluateAll(rows => rows.map(row => ({ active: row.classList.contains('active'), color: getComputedStyle(row).backgroundColor })));
        assert.notEqual(colors.find(row => row.active).color, colors.find(row => !row.active).color, `${theme}: selected row is visibly distinct`);
        await chosen.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/pi-recent-selection-${viewport.width}-${theme}.png` });
    }
    const target = section('recent').locator('[data-session-id="active"] .pi-session-main');
    await target.focus();
    await target.press('Shift+F10');
    const menu = page.locator('.pi-thread-menu:not(.hidden)');
    await page.locator('#pi-session-list').evaluate(node => node.dispatchEvent(new Event('scroll')));
    assert.equal(await menu.isVisible(), true, 'queued scroll without position change must not dismiss the menu');
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
    await menu.getByRole('menuitem', { name: '会话 ID', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.copied), ['active']);
    await section('recent').locator('[data-session-id="active"] [data-action="menu"]').click();
    const previousScroll = await page.locator('#pi-session-list').evaluate(node => {
        const before = node.scrollTop;
        node.scrollTop += 12;
        if (node.scrollTop === before) node.scrollTop -= 12;
        if (node.scrollTop === before) throw new Error('Fixture must allow real scrolling');
        node.dispatchEvent(new Event('scroll'));
        return before;
    });
    assert.equal(await menu.count(), 0, 'real scrolling still dismisses the menu');
    await page.locator('#pi-session-list').evaluate((node, top) => { node.scrollTop = top; }, previousScroll);
    await section('recent').locator('[data-session-id="active"] [data-action="menu"]').click();
    await menu.getByRole('menuitem', { name: '标记为未读' }).click();
    await expectIds('recent', ['old-visited', 'recent-01', 'recent-02', 'recent-03', 'recent-04', 'recent-05']);
    assert.equal((await ids('attention')).length, 9);
    await assertUnique();
    await choose('all');
    await choose('work');
    await expectIds('recent', ['recent-02', 'old-visited', 'recent-01', 'recent-03', 'recent-04', 'recent-05']);

    // Running -> failure -> idle changes section, without cloning a thread.
    const running = runtimes.find(item => item.sessionId === 'processing-1');
    running.phase = 'error'; running.busy = false;
    await page.waitForFunction(() => document.querySelector('[data-work-section="attention"] [data-session-id="processing-1"]'));
    assert.equal((await ids('running')).length, 7);
    running.phase = 'idle';
    await page.waitForFunction(() => document.querySelector('[data-work-section="recent"] [data-session-id="processing-1"]'));
    await assertUnique();

    await page.locator('#pi-session-search-toggle').click();
    await page.locator('#pi-session-search').fill('processing-');
    assert.equal((await ids('running')).length, 7);
    assert.deepEqual(await ids('attention'), []);
    assert.deepEqual(await ids('recent'), ['processing-1']);
    assert.equal(await toggle.isVisible(), false, 'one recent needs no expansion');
    await page.locator('#pi-session-search').fill('no-such-thread');
    assert.equal(await page.locator('#pi-session-list [data-session-id]').count(), 0);
    assert.equal(await page.locator('.pi-filter-empty').innerText(), '没有匹配的工作会话');
    await page.locator('#pi-session-search').press('Escape');

    activityOk = false;
    await page.waitForFunction(() => document.querySelector('.pi-session-activity')?.dataset.phase === 'unknown');
    assert.equal(await page.locator('[data-work-section]').count(), 0);
    assert.ok(await page.locator('.pi-project-group:not([hidden])').count());
    activityOk = true;
    await page.waitForFunction(() => document.querySelector('[data-work-section="recent"] [data-session-id]'));
    await assertUnique();
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.locator('#pi-session-list').evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: `/tmp/pi-work-list-${viewport.width}-${theme}-top.png` });
        await toggle.click();
        await page.locator('#pi-session-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.screenshot({ path: `/tmp/pi-work-list-${viewport.width}-${theme}-recent.png` });
        assert.equal(await page.locator('#pi-session-pane, #pi-session-list, .pi-work-sessions').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth + 1)), false);
        await toggle.click();
    }
    ephemeralStreaming = true;
    await page.locator('#pi-temp-session').click();
    await drawer();
    await page.waitForFunction(() => document.querySelector('[data-work-section="running"] .ephemeral'));
    assert.equal(await section('recent').locator('.ephemeral').count(), 0);
    ephemeralStreaming = false;
    ephemeralSocket.send(JSON.stringify({ type: 'agent_settled' }));
    await page.waitForFunction(() => document.querySelector('.pi-session-item.ephemeral')?.hidden === true);
    assert.equal(await section('recent').locator('.ephemeral').count(), 0);
    await choose('all');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await drawer();
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'), 'true', 'reload defaults to all');
    assert.equal(await page.locator('[data-work-section]').count(), 0);
    await choose('work');
    await page.waitForFunction(() => document.querySelectorAll('[data-work-section="recent"] [data-session-id]').length === 6);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
    assert.equal(commands.some(command => ['prompt', 'steer', 'follow_up'].includes(command)), false);
    assert.ok(writes.every(path => /\/(unread|read)$/.test(path)));
    await context.close();
    console.log(`PASS ${viewport.width}: all default, stable active recent rows, priority/deduplication, unlimited attention/running, recent 6/12, focus, transitions, menus, search, unknown, ephemeral`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
