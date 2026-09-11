// Sidebar regression: inline search header, project menu without duplicated open/collapse rows,
// and the capped thread list with explicit "show more" / "show less" control.
// Mocks REST/WebSocket only; never creates real sessions or sends model prompts.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseUrl = process.env.PI_SIDEBAR_TEST_URL || 'http://127.0.0.1:3101';
const cwd = '/srv/pi-sidebar-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
const session = (index, extra = {}) => ({
    id: `thread-${index}`,
    cwd,
    name: `Thread ${String(index).padStart(2, '0')}`,
    firstMessage: `needle fixture message ${String(index).padStart(2, '0')}`,
    messageCount: index,
    created: `2026-09-0${(index % 7) + 1}T00:00:0${index % 9}Z`,
    modified: `2026-09-0${(index % 7) + 1}T00:00:0${index % 9}Z`,
    ...extra
});
const sessions = Array.from({ length: 9 }, (_, index) => session(9 - index));
const activeSession = sessions[sessions.length - 1];

async function run(browser, viewport) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 900, isMobile: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    const rpc = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(data => {
        localStorage.setItem('pi.web.cwd', data.cwd);
        localStorage.setItem('pi.web.expandedProjects', JSON.stringify([data.cwd]));
        localStorage.setItem(`pi.web.session:${data.cwd}`, data.activeId);
    }, { cwd, activeId: activeSession.id });
    await page.route('**/api/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
            writes.push(path);
            return route.fulfill({ json: { ok: true, pinnedProjects: [], hiddenProjects: [] } });
        }
        if (path === '/api/pi/status') {
            return route.fulfill({ json: { ok: true, version: '0.85.0', projectRoots: ['/srv'], sessionWorkflows: true, replyFork: true } });
        }
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Sidebar fixture', sessionCount: sessions.length }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.startsWith('/api/pi/')) return route.fulfill({ json: {} });
        if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
        if (path.includes('/health')) return route.fulfill({ json: { ok: false, configured: false } });
        await route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            rpc.push(command.type);
            let data = {};
            if (command.type === 'open_session') {
                data = { session: activeSession, state: { model, isStreaming: false, thinkingLevel: 'off' },
                    messages: { messages: [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Fixture prompt' }] }] },
                    stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            } else if (command.type === 'get_state') data = { model, isStreaming: false, thinkingLevel: 'off' };
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Initial session activation closes the mobile drawer; wait before opening it.
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    if (viewport.width < 900) {
        await page.locator('#pi-toggle-sessions').click();
        await page.waitForFunction(() => document.getElementById('pi-session-pane').getBoundingClientRect().left >= -1);
    }
    await page.waitForFunction(() => document.querySelectorAll('#pi-session-list [data-project-cwd]').length === 1);
    await page.locator('#pi-session-filters [data-filter="all"]').click();
    await page.waitForFunction(id => document.querySelector('#pi-session-list .pi-session-item.active')?.dataset.sessionId === id, activeSession.id);
    const searchInput = page.locator('#pi-session-search');
    const searchToggle = page.locator('#pi-session-search-toggle');
    const title = page.locator('#pi-session-heading-title');
    const listTop = () => page.locator('#pi-session-list').evaluate(node => node.getBoundingClientRect().top);
    const checkHeader = async open => {
        const geometry = await page.locator('.pi-session-heading').evaluate(node => {
            const rect = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width }; };
            return { header: rect(node), children: [...node.children].filter(el => !el.hidden).map(el => ({
                ...rect(el), clipped: el.scrollWidth > el.clientWidth + 1
            })) };
        });
        for (const [index, box] of geometry.children.entries()) {
            assert.ok(box.x >= geometry.header.x && box.right <= geometry.header.right, 'header child stays inside pane');
            assert.ok(box.y >= geometry.header.y && box.bottom <= geometry.header.bottom, 'header stays one row');
            assert.equal(box.clipped, false, 'title and controls are not clipped');
            if (index) assert.ok(box.x >= geometry.children[index - 1].right, 'header children must not overlap');
        }
        assert.equal(await title.isVisible(), !open);
        assert.equal(await searchInput.isVisible(), open);
        assert.equal(await page.locator('#pi-temp-session').isVisible(), !open);
        assert.equal(await page.locator('#pi-new-session').isVisible(), true);
        assert.equal(await searchToggle.getAttribute('aria-expanded'), String(open));
        if (open) assert.ok((await searchInput.boundingBox()).width >= 90, 'usable search input even in narrow pane');
    };

    // Search replaces the title without moving the filters or thread list.
    for (const width of viewport.width > 900 ? [232, 278, 440] : [null]) {
        if (width) await page.locator('#pi-session-pane').evaluate((node, width) => node.style.setProperty('--split-size', `${width}px`), width);
        await checkHeader(false);
        const before = await listTop();
        for (const theme of ['daylight', 'mint', 'dark']) {
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
            await page.locator('#pi-session-pane').screenshot({ path: `/tmp/pi-sidebar-search-${viewport.width}-${width || 'drawer'}-${theme}-closed.png` });
            await searchToggle.click();
            await checkHeader(true);
            assert.equal(await listTop(), before, 'opening search must not move the list');
            assert.equal(await searchInput.evaluate(node => node === document.activeElement), true);
            if (viewport.width < 900) assert.ok(await searchInput.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
            await page.locator('#pi-session-pane').screenshot({ path: `/tmp/pi-sidebar-search-${viewport.width}-${width || 'drawer'}-${theme}-open.png` });
            await searchInput.press('Escape');
            await checkHeader(false);
            assert.equal(await listTop(), before);
            assert.equal(await searchToggle.evaluate(node => node === document.activeElement), true);
        }
    }
    if (viewport.width > 900) await page.locator('#pi-session-pane').evaluate(node => node.style.setProperty('--split-size', '278px'));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'daylight'; });

    // 2. Long thread lists are capped, the active thread stays visible, and more is explicit.
    await page.waitForFunction(() => document.querySelectorAll('#pi-session-list [data-session-id]').length > 0);
    const visibleIds = () => page.locator('#pi-session-list [data-session-id]').evaluateAll(rows => rows.map(row => row.dataset.sessionId));
    const overflowLabel = () => page.locator('#pi-session-list .pi-thread-more span').first().innerText();
    assert.deepEqual(await visibleIds(), [...sessions.slice(0, 6).map(item => item.id), activeSession.id],
        'exactly the preview limit plus the active thread may render');
    assert.equal(await overflowLabel(), '显示其余 2 个线程');
    assert.equal(await page.locator('#pi-session-list .pi-project-session-count').innerText(), '9');

    await page.locator('#pi-session-list .pi-thread-more').click();
    assert.equal((await visibleIds()).length, 9, 'show more renders every thread');
    assert.equal(await overflowLabel(), '仅显示前 6 个线程');

    await page.locator('#pi-session-list .pi-thread-more').click();
    assert.ok((await visibleIds()).length <= 7);
    assert.equal(await overflowLabel(), '显示其余 2 个线程');

    // 3. Search remains open on blur; close/Escape clear the query, not the status filter.
    await searchToggle.press('Enter');
    await searchInput.fill('needle');
    await page.waitForFunction(() => document.querySelectorAll('#pi-session-list [data-session-id]').length === 9);
    assert.equal(await page.locator('#pi-session-list .pi-thread-more').count(), 0, 'search results must not be truncated');
    await page.locator('#pi-session-filters [data-filter="all"]').click();
    assert.equal(await searchInput.inputValue(), 'needle', 'blur keeps active search visible');
    await searchInput.focus();
    await page.locator('#pi-session-filters [data-filter="all"]').dispatchEvent('click');
    assert.equal(await searchInput.evaluate(node => node === document.activeElement), true, 'list redraw preserves search focus');
    await searchInput.fill('no-match-anywhere');
    assert.equal(await page.locator('#pi-session-list [data-session-id]').count(), 0);
    await searchToggle.click();
    await checkHeader(false);
    assert.equal(await searchInput.inputValue(), '');
    assert.equal((await visibleIds()).length, 7);
    await searchToggle.click();
    await searchInput.fill('needle');
    await searchInput.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
    assert.equal(await searchInput.inputValue(), 'needle', 'IME Escape does not discard search');
    await searchInput.press('Escape');
    await checkHeader(false);
    assert.equal(await searchInput.inputValue(), '');
    await searchToggle.click();
    await searchInput.fill('needle');
    await searchInput.fill('');
    await checkHeader(true);
    await page.locator('#pi-session-filters [data-filter="work"]').click();
    await searchToggle.click();
    assert.equal(await page.locator('#pi-session-filters [data-filter="work"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#pi-session-filters [data-filter="all"]').click();
    assert.equal((await visibleIds()).length, 7);

    // 4. Collapsing and re-expanding restarts from the capped view.
    await page.locator('#pi-session-list .pi-thread-more').click();
    await page.locator('.pi-project-group-main').click();
    await page.waitForFunction(() => !document.querySelector('#pi-session-list .pi-project-group.expanded'));
    assert.equal(await page.locator('#pi-session-list [data-session-id]').count(), 0, 'collapsed project renders no threads');
    await page.locator('.pi-project-disclosure').click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-session-list [data-session-id]').length <= 7);
    assert.equal(await overflowLabel(), '显示其余 2 个线程', 're-expanding must restart capped');

    // 5. Project menu no longer duplicates open/collapse; row and chevron still toggle.
    await page.locator('[data-project-action="menu"]').click();
    const menuItems = await page.locator('.pi-thread-menu:not(.hidden) button span').allInnerTexts();
    assert.deepEqual(menuItems, ['新建线程', '置顶项目', '复制项目路径', '刷新线程', '从列表移除']);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.pi-thread-menu').classList.contains('hidden'));
    await page.locator('.pi-project-group-main').click();
    await page.waitForFunction(() => !document.querySelector('#pi-session-list .pi-project-group.expanded'));
    await page.locator('.pi-project-disclosure').click();
    await page.waitForFunction(() => document.querySelector('#pi-session-list .pi-project-group.expanded'));
    assert.equal(writes.length, 0, 'sidebar layout changes must not write to the API');
    assert.equal(rpc.includes('prompt'), false);

    await page.screenshot({ path: `/tmp/pi-sidebar-threads-${viewport.width}.png` });
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false,
        `no horizontal overflow allowed at ${viewport.width}px`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}x${viewport.height}: inline search header, capped threads, deduplicated project menu`);
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }, { width: 320, height: 740 }]) await run(browser, viewport);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
