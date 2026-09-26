const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_DELETE_TEST_URL;
assert.ok(base, 'PI_DELETE_TEST_URL must select an isolated fixture origin');
const cwd = '/tmp/delete-ui-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const width of [1440, 393, 320]) for (const trashed of [true, false, undefined]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 } });
            const page = await context.newPage(), errors = [], opens = [];
            let deleted = false, releaseDelete, failDelete = false, deleteCount = 0;
            const sessions = ['initial', 'target'].map(id => ({ id, cwd, name: `线程 ${id}`, messageCount: 1, modified: '2026-09-11T00:00:00Z' }));
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(({ cwd }) => {
                localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'initial');
                localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd]));
            }, { cwd });
            await page.route('**/api/**', async route => {
                const request = route.request(), url = new URL(request.url());
                if (request.method() === 'DELETE') {
                    assert.equal(url.pathname, '/api/pi/sessions/target'); deleteCount++;
                    await new Promise(resolve => { releaseDelete = resolve; });
                    if (failDelete) return route.fulfill({ status: 400, json: { error: 'fixture deletion blocked' } });
                    deleted = true;
                    return route.fulfill({ json: { id: 'target', ...(trashed === undefined ? {} : { trashed }) } });
                }
                assert.equal(request.method(), 'GET');
                const data = url.pathname === '/api/pi/status' ? { projectRoots: ['/tmp'] }
                    : url.pathname === '/api/pi/projects' ? { roots: ['/tmp'], projects: [{ cwd, name: 'Fixture', sessionCount: deleted ? 1 : 2 }] }
                    : url.pathname === '/api/pi/sessions' ? { sessions: deleted ? sessions.slice(0, 1) : sessions }
                    : url.pathname === '/api/pi/activity' ? { runtimes: [], replyNotices: [] } : {};
                return route.fulfill({ json: data });
            });
            await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
                const command = JSON.parse(raw), state = { model, isStreaming: false, thinkingLevel: 'off' };
                if (command.type === 'open_session') {
                    opens.push(command.sessionId);
                    // Keep restoration pending so switching must cancel its open RPC silently.
                    if (command.sessionId === 'initial') return;
                }
                ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true,
                    data: command.type === 'open_session' ? { session: sessions[1], state, messages: { messages: [] }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : command.type === 'get_state' ? state : {} }));
            }));
            await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.querySelector('[data-session-id=initial].active'));
            if (width < 900) await page.locator('#pi-toggle-sessions').click();
            await page.locator('[data-filter=all]').click();
            await page.locator('[data-session-id=target] .pi-session-main').click();
            await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
            assert.ok( opens.includes('initial') && opens.includes('target'));
            assert.doesNotMatch(await page.locator('#pi-toast-region').textContent(), /Session changed/);
            await page.locator('#pi-input').fill('draft to delete');
            await page.locator('#pi-current-thread-menu').click();
            await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: '删除线程', exact: true }).click();
            const dialog = page.locator('.pi-session-delete-dialog');
            await dialog.waitFor();
            assert.equal(deleteCount, 0);
            await dialog.getByRole('button', { name: '取消', exact: true }).click();
            assert.equal(deleteCount, 0);
            await page.locator('#pi-current-thread-menu').click();
            await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: '删除线程', exact: true }).click();
            failDelete = true;
            await dialog.locator('.pi-delete-confirm').click();
            await dialog.getByText('正在停止运行并删除线程，请稍候…', { exact: true }).waitFor();
            assert.equal(await dialog.locator('.pi-delete-confirm').isDisabled(), true);
            await page.keyboard.press('Escape'); assert.equal(await dialog.evaluate(element => element.open), true);
            await page.waitForFunction(() => document.querySelector('.pi-delete-confirm[aria-busy=true]'));
            while (!releaseDelete) await new Promise(resolve => setTimeout(resolve, 10));
            releaseDelete(); releaseDelete = null;
            await dialog.getByRole('alert').waitFor(); assert.equal(deleted, false);
            assert.match(await dialog.getByRole('alert').textContent(), /删除未确认/);
            assert.equal(await page.locator('#pi-input').inputValue(), 'draft to delete');
            failDelete = false;
            await dialog.locator('.pi-delete-confirm').click();
            while (!releaseDelete) await new Promise(resolve => setTimeout(resolve, 10));
            releaseDelete();
            await dialog.getByText(trashed === true ? '会话已移入回收站' : trashed === false ? '会话已永久删除' : '会话已删除', { exact: true }).waitFor();
            assert.equal(deleteCount, 2); assert.ok(deleted);
            assert.equal(await page.locator('[data-session-id=target]').count(), 0);
            assert.equal(await page.locator('#pi-input').inputValue(), '');
            assert.equal(await page.evaluate(cwd => localStorage.getItem('pi.web.session:' + cwd), cwd), null);
            assert.ok(!new URL(page.url()).searchParams.has('sessionId'));
            assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
            await page.screenshot({ path: `/tmp/pi-session-delete-${width}-${trashed ?? 'unknown'}.png` });
            await dialog.getByRole('button', { name: '完成', exact: true }).click();
            assert.deepEqual(errors, []);
            assert.ok(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth + 1));
            console.log(JSON.stringify({ width, trashed: trashed ?? 'legacy-unknown', status: 'passed', pageerrors: 0 }));
            await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
