const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_THREAD_MENU_TEST_URL || 'http://127.0.0.1:3101';
const cwd = '/srv/thread-menu-fixture';
const emptyCwd = '/srv/storage';
const aliases = [emptyCwd + '/', '/srv/storage-link'];
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
const sessions = [1, 2].map(index => ({ id: `thread-${index}`, cwd, name: `线程 ${index}`, firstMessage: 'Fixture text',
    messageCount: 2, modified: '2026-09-07T10:00:00Z' }));
const messages = [{ role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'Fixture reply' }], stopReason: 'stop' }];

async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const errors = [], writes = [], rpc = [];
    let hidden = [], notices = [], serial = 0, oldBackend = false, failUnread = false;
    let holdActivity = false, heldActivity, holdProjects = false, heldProjects;
    const canonical = input => aliases.includes(input) ? emptyCwd : input;
    const activity = () => ({ runtimes: [], pinnedProjects: [], hiddenProjects: [...hidden], replyNotices: [...notices] });
    const projectData = recent => ({ projects: [{ cwd, name: 'Thread fixture', sessionCount: 2 }, { cwd: emptyCwd, name: 'storage', sessionCount: 0 }],
        roots: ['/srv'], pinnedProjects: [], hiddenProjects: [...hidden], projectAliases: recent.map(input => ({ input, cwd: canonical(input) })) });
    const waitHeld = async kind => {
        for (let index = 0; index < 100; index++) {
            if (kind === 'activity' ? heldActivity : heldProjects) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out holding ${kind}`);
    };
    async function mount(page, activeId) {
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ cwd, aliases, activeId }) => {
            localStorage.setItem('pi.web.cwd', cwd);
            localStorage.setItem('pi.web.recentProjects', JSON.stringify(aliases.map(cwd => ({ cwd, name: 'storage' }))));
            localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd]));
            if (activeId) localStorage.setItem(`pi.web.session:${cwd}`, activeId);
            window.copied = [];
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.copied.push(text) }, configurable: true });
        }, { cwd, aliases, activeId });
        await page.route('**/api/**', async route => {
            const req = route.request(), url = new URL(req.url()), method = req.method();
            if (method !== 'GET') {
                const body = req.postDataJSON();
                writes.push({ path: url.pathname, body });
                if (url.pathname.endsWith('/unread')) {
                    if (failUnread) return route.fulfill({ status: 500, json: { error: 'fixture unread failure' } });
                    const sessionId = url.pathname.split('/').at(-2);
                    const notice = { cwd, sessionId, completionId: `manual-${++serial}`, completedAt: new Date().toISOString(), manual: true };
                    notices = [notice];
                    return route.fulfill({ json: { notice } });
                }
                if (url.pathname.endsWith('/read')) {
                    notices = notices.filter(item => item.completionId !== body.completionId);
                    return route.fulfill({ json: { ok: true } });
                }
                if (url.pathname === '/api/pi/projects/visibility') {
                    hidden = body.hidden ? [canonical(body.cwd)] : [];
                    return route.fulfill({ json: { cwd: canonical(body.cwd), hiddenProjects: [...hidden], pinnedProjects: [] } });
                }
                throw new Error(`Unexpected write ${url.pathname}`);
            }
            if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/srv'], manualUnread: !oldBackend, projectIdentity: true } });
            if (url.pathname === '/api/pi/projects/resolve') return route.fulfill({ json: { cwd: canonical(url.searchParams.get('cwd')) } });
            if (url.pathname === '/api/pi/projects') {
                const json = projectData(JSON.parse(url.searchParams.get('recent') || '[]'));
                if (holdProjects) {
                    holdProjects = false;
                    await new Promise(resolve => { heldProjects = resolve; });
                }
                return route.fulfill({ json });
            }
            if (url.pathname === '/api/pi/activity') {
                const json = activity();
                if (holdActivity) {
                    holdActivity = false;
                    await new Promise(resolve => { heldActivity = resolve; });
                }
                return route.fulfill({ json });
            }
            if (url.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: url.searchParams.get('cwd') === cwd ? sessions : [] } });
            if (url.pathname.includes('history') || url.pathname === '/api/prompts') return route.fulfill({ json: [] });
            return route.fulfill({ json: {} });
        });
        await page.routeWebSocket('**/api/pi/ws', socket => {
            let sessionId;
            socket.onMessage(raw => {
                const command = JSON.parse(raw);
                rpc.push(command.type);
                const state = { model, thinkingLevel: 'off', isStreaming: false };
                let data = {};
                if (command.type === 'open_session') {
                    sessionId = command.sessionId;
                    data = { session: sessions.find(item => item.id === sessionId), state, messages: { messages }, stats: {},
                        models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] },
                        completion: notices.find(item => item.sessionId === sessionId) || null };
                } else if (command.type === 'get_state') data = state;
                else if (command.type === 'get_messages') data = { messages, completion: notices.find(item => item.sessionId === sessionId) || null };
                socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
            });
        });
    }
    const page = await context.newPage();
    await mount(page, 'thread-1');
    const drawer = async () => {
        if (viewport.width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.waitForFunction(() => document.getElementById('pi-session-pane').getBoundingClientRect().left >= -1);
        await page.locator('#pi-session-filters [data-filter="all"]').click();
    };
    const menu = page.locator('.pi-thread-menu:not(.hidden)');
    const menuButton = id => page.locator(`[data-session-id="${id}"] [data-action="menu"]`);
    const unreadBadge = page.locator('[data-session-id="thread-1"] .pi-session-unread');
    const emptyGroup = page.locator(`#pi-session-list [data-project-cwd="${emptyCwd}"]`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.pi-session-item.active'));
    await drawer();
    assert.equal(await emptyGroup.count(), 1, 'canonical project and both aliases must merge to one row');
    for (const alias of aliases) assert.equal(await page.locator(`#pi-session-list [data-project-cwd="${alias}"]`).count(), 0);

    await menuButton('thread-1').click();
    assert.deepEqual(await menu.locator('button span').allTextContents(), ['重命名', '标记为未读', '复制', '删除线程']);
    await menu.getByRole('menuitem', { name: '复制', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await menu.locator('button span').allTextContents(), ['返回', '线程名称', '会话 ID']);
    await page.keyboard.press('Escape');
    assert.equal(await menu.getByRole('menuitem', { name: '复制', exact: true }).evaluate(node => node === document.activeElement), true);
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
    await menu.getByRole('menuitem', { name: '返回', exact: true }).click();
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
    await menu.getByRole('menuitem', { name: '线程名称', exact: true }).click();
    assert.equal(await menuButton('thread-1').evaluate(node => node === document.activeElement), true);
    await menuButton('thread-1').click();
    await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
    await menu.getByRole('menuitem', { name: '会话 ID', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.copied), ['线程 1', 'thread-1']);

    // A poll captured before the manual action cannot erase the newly stored marker.
    holdActivity = true;
    await waitHeld('activity');
    await menuButton('thread-1').click();
    await menu.getByRole('menuitem', { name: '标记为未读' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-session-id="thread-1"] .pi-session-unread').hidden);
    const activityResponse = page.waitForResponse('**/api/pi/activity');
    heldActivity(); heldActivity = null;
    await activityResponse;
    await page.waitForTimeout(100);
    assert.equal(await unreadBadge.isVisible(), true);
    assert.equal((await unreadBadge.innerText()).trim(), '未读');
    assert.equal(writes.some(item => item.path.endsWith('/read')), false, 'current rendered view must not acknowledge a newly marked token');
    failUnread = true;
    await menuButton('thread-1').click();
    await menu.getByRole('menuitem', { name: '标记为未读' }).click();
    await page.getByText('fixture unread failure', { exact: true }).waitFor();
    assert.equal(notices.length, 1, 'failed mutation leaves existing mark intact');
    failUnread = false;

    const otherContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
    const other = await otherContext.newPage();
    await mount(other, 'thread-2');
    await other.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await other.waitForFunction(() => document.querySelector('[data-session-id="thread-1"] .pi-session-unread')?.hidden === false);
    assert.equal(notices.length, 1, 'another device sees unread without clearing it');
    await otherContext.close();

    // Reading another thread then explicitly reopening the marked thread clears only that token.
    await page.locator('[data-session-id="thread-2"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('.pi-session-item.active')?.dataset.sessionId === 'thread-2');
    await drawer();
    await page.locator('[data-session-id="thread-1"] .pi-session-main').click();
    if (viewport.width < 900) await page.waitForFunction(() => !document.getElementById('pi-session-pane').classList.contains('open'));
    for (let i = 0; notices.length && i < 60; i++) await page.waitForTimeout(100);
    assert.equal(notices.length, 0);
    await drawer();

    // Both old projects and activity responses must be ignored after a successful removal.
    holdActivity = true;
    await waitHeld('activity');
    holdProjects = true;
    await page.locator('#pi-refresh-sessions').click();
    await waitHeld('projects');
    await emptyGroup.locator('[data-project-action="menu"]').click();
    await menu.getByRole('menuitem', { name: '从列表移除' }).click();
    await emptyGroup.waitFor({ state: 'detached' });
    const responses = Promise.all([page.waitForResponse('**/api/pi/activity'), page.waitForResponse(response => new URL(response.url()).pathname === '/api/pi/projects')]);
    heldActivity(); heldActivity = null;
    heldProjects(); heldProjects = null;
    await responses;
    await page.waitForTimeout(200);
    assert.equal(await emptyGroup.count(), 0, 'stale refresh must not resurrect removed project');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.pi-session-item.active'));
    await drawer();
    assert.equal(await emptyGroup.count(), 0, 'removed project remains absent after reload');
    await page.locator('#pi-project-button').click();
    const pickerRow = page.locator(`#pi-project-list [data-cwd="${emptyCwd}"]`);
    assert.equal(await pickerRow.count(), 0, 'picker hides removed projects by default');
    await page.locator('#pi-show-hidden-projects').check();
    assert.equal(await pickerRow.locator('em').innerText(), '已移出');
    await pickerRow.click();
    await emptyGroup.waitFor();
    assert.deepEqual(hidden, [], 'explicit project picker restores project');

    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await drawer();
        await menuButton('thread-1').click();
        await menu.getByRole('menuitem', { name: '复制', exact: true }).click();
        const box = await menu.boundingBox();
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
        await page.screenshot({ path: `/tmp/pi-thread-menu-${viewport.width}-${theme}.png` });
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Escape');
    }
    oldBackend = true;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.pi-session-item.active'));
    await drawer();
    await menuButton('thread-1').click();
    assert.equal(await menu.getByRole('menuitem', { name: '标记为未读' }).count(), 0, 'old backend must not expose unsupported unread action');
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    assert.deepEqual(errors, []);
    assert.equal(rpc.some(command => ['prompt', 'steer', 'follow_up'].includes(command)), false);
    assert.equal(writes.every(item => /\/(unread|read|visibility)$/.test(item.path)), true);
    console.log(`PASS ${viewport.width}: copy submenu, manual unread, cross-device/reopen, aliases/removal/restore, stale responses, old backend`);
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
