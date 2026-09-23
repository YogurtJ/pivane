const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_TRANSFER_TEST_URL || 'http://127.0.0.1:3112';
const cwd = '/srv/transfer-fixture', target = '/srv/目标项目-' + 'long-path-'.repeat(20);
const model = { provider: 'fixture', id: 'fixture', input: ['text', 'image'], name: 'Fixture' };
const original = { id: 'original-thread', cwd, name: '原线程', firstMessage: 'original', messageCount: 2, modified: new Date().toISOString() };
async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900, acceptDownloads: true });
    const page = await context.newPage(), errors = [], writes = [], opens = [];
    let imported = [], failExport = false, failImport = false, holdImport = false, releaseImport, oldBackend = false, ephemeralMode = false, streaming = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'original-thread');
        localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd])); sessionStorage.setItem('pi.web.token', 'fixture-token');
    }, { cwd });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') {
            const body = req.postDataJSON(); writes.push({ path: url.pathname, body });
            assert.equal(req.headers().authorization, 'Bearer fixture-token');
            if (url.pathname.endsWith('/export')) {
                if (failExport) return route.fulfill({ status: 409, json: { error: '会话正在运行，请等待空闲' } });
                return route.fulfill({ headers: { 'Content-Disposition': `attachment; filename="fixture.${body.format}"` },
                    contentType: body.format === 'html' ? 'text/html' : 'application/x-ndjson', body: body.format === 'html' ? '<!DOCTYPE html><html><body>fixture archive</body></html>' : '{"type":"session"}\n' });
            }
            if (url.pathname.endsWith('/import')) {
                if (failImport) return route.fulfill({ status: 400, json: { error: '会话树含失效父节点' } });
                if (holdImport) { holdImport = false; await new Promise(resolve => { releaseImport = resolve; }); }
                const session = { ...original, cwd: body.cwd, id: `imported-${imported.length}`, name: '<img src=x onerror=window.BAD=1> 导入线程' };
                imported.push(session); return route.fulfill({ status: 201, json: { session } });
            }
            throw Error(`Unexpected write ${url.pathname}`);
        }
        let json = {};
        if (url.pathname === '/api/pi/status') json = { ok: true, projectRoots: ['/srv'], sessionTransfer: !oldBackend, projectIdentity: true };
        else if (url.pathname === '/api/pi/projects') json = { projects: [{ cwd, name: '当前项目', sessionCount: 1 }, { cwd: target, name: '目标项目', sessionCount: imported.length }], roots: ['/srv'], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/projects/resolve') json = { cwd: url.searchParams.get('cwd') };
        else if (url.pathname === '/api/pi/sessions') json = { sessions: url.searchParams.get('cwd') === cwd ? [original] : imported };
        else if (url.pathname === '/api/pi/activity') json = { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] };
        else if (url.pathname.includes('history') || url.pathname === '/api/prompts') json = [];
        return route.fulfill({ json });
    });
    await page.routeWebSocket('**/api/pi/ws', socket => socket.onMessage(raw => {
        const command = JSON.parse(raw); let data = {};
        const state = { model, isStreaming: streaming, thinkingLevel: 'off' };
        if (command.type === 'open_session') {
            opens.push(command.sessionId);
            data = { session: { ...[original, ...imported].find(s => s.id === command.sessionId), ephemeral: ephemeralMode }, state,
                messages: { messages: [{ role: 'assistant', timestamp: 1, content: [{ type: 'text', text: '原回复' }], stopReason: 'stop' }] },
                stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        } else if (command.type === 'get_state') data = state;
        else if (['prompt', 'steer', 'follow_up'].includes(command.type)) throw Error('Must not send model requests');
        socket.send(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    const slash = async text => {
        await page.locator('#pi-input').fill(text);
        await page.locator('#pi-send-button').click();
    };
    for (const command of ['export', 'import']) {
        await slash(`/${command}`);
        await page.locator('#pi-transfer-dialog[open]').waitFor();
        await page.waitForFunction(() => document.getElementById('pi-input').value === '');
        assert.equal(writes.length, 0, 'opening a slash window does not submit an API operation');
        if (command === 'import') assert.equal(await page.locator('#pi-transfer-project').inputValue(), cwd);
        await page.keyboard.press('Escape');
        await slash(`/${command} /tmp/session.jsonl`);
        await page.waitForFunction(() => [...document.querySelectorAll('.pi-toast')].some(e => e.textContent.includes('不接收文件路径参数')));
        assert.equal(await page.locator('#pi-input').inputValue(), `/${command} /tmp/session.jsonl`);
        assert.equal(await page.locator('#pi-transfer-dialog[open]').count(), 0);
    }
    ephemeralMode = true; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    await slash('/export'); await page.getByText('请先打开一个已保存的线程再导出；命令草稿已保留', { exact: true }).waitFor();
    assert.equal(await page.locator('#pi-input').inputValue(), '/export');
    await slash('/import'); await page.locator('#pi-transfer-dialog[open]').waitFor(); await page.keyboard.press('Escape');
    ephemeralMode = false; streaming = true; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    await slash('/export'); await page.locator('#pi-transfer-dialog[open]').waitFor(); await page.keyboard.press('Escape');
    assert.equal(writes.length, 0, 'running slash entry only opens the window; export still checks idle on download');
    streaming = false; await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#pi-input:not([disabled])').waitFor();
    opens.length = 0; opens.push('original-thread');
    await page.locator('#pi-input').fill('保留主草稿');
    await page.locator('#pi-file-input').setInputFiles({ name: '保留附件.txt', mimeType: 'text/plain', buffer: Buffer.from('未发送附件') });
    await page.locator('#pi-attachments').getByText('保留附件.txt', { exact: true }).waitFor();
    const drawer = async () => {
        if (viewport.width < 900 && !await page.locator('#pi-session-pane').evaluate(e => e.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.waitForFunction(() => document.getElementById('pi-session-pane').getBoundingClientRect().left >= -1);
    };
    const menu = page.locator('.pi-thread-menu:not(.hidden)'), dialog = page.locator('#pi-transfer-dialog');
    const exportMenu = async () => {
        await drawer(); await page.locator('[data-session-id="original-thread"] [data-action="menu"]').click();
        await menu.getByRole('menuitem', { name: '历史与记录', exact: true }).click();
        await menu.getByRole('menuitem', { name: '导出记录', exact: true }).click(); await dialog.waitFor();
    };
    const importMenu = async () => {
        await drawer(); await page.locator(`[data-project-cwd="${cwd}"] [data-project-action="menu"]`).click();
        await menu.getByRole('menuitem', { name: '更多操作', exact: true }).click();
        await menu.getByRole('menuitem', { name: '导入 Pi 会话', exact: true }).click(); await dialog.waitFor();
    };
    const geometry = async () => {
        const bad = await page.evaluate(() => [...document.querySelectorAll('#pi-transfer-dialog, #pi-transfer-dialog .pi-transfer-body, #pi-transfer-dialog label, #pi-transfer-dialog select')]
            .filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.tagName + ':' + e.scrollWidth + '/' + e.clientWidth));
        if (bad.length) console.log(await page.locator('#pi-transfer-dialog').evaluate(d => [...d.querySelectorAll('*')].map(e => ({ tag:e.tagName, cls:e.className, x:e.getBoundingClientRect().x, width:e.getBoundingClientRect().width, sw:e.scrollWidth, css:getComputedStyle(e).minWidth })).filter(e=>e.width>500)));
        assert.deepEqual(bad, []); assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    };
    await exportMenu(); assert.match(await dialog.innerText(), /历史分支.*压缩前/);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await geometry();
        await page.screenshot({ path: `/tmp/pi-transfer-${viewport.width}-${theme}.png` });
    }
    for (const format of ['html', 'jsonl']) {
        await page.locator('#pi-transfer-format').selectOption(format);
        if (format === 'jsonl') assert.match(await dialog.innerText(), /不是完整会话树备份/);
        const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载记录' }).click();
        const download = await pending; assert.equal(download.suggestedFilename(), `pi-session-original-thread.${format}`);
        const content = fs.readFileSync(await download.path(), 'utf8'); assert.ok(content.length > 10);
        await page.waitForFunction(() => !document.querySelector('#pi-transfer-dialog footer button').disabled);
    }
    failExport = true; await dialog.getByRole('button', { name: '下载记录' }).click();
    await dialog.getByText('会话正在运行，请等待空闲', { exact: true }).waitFor(); failExport = false;
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#pi-input').inputValue(), '保留主草稿');
    await importMenu(); await page.locator('#pi-transfer-project').selectOption(target); await geometry();
    await page.screenshot({ path: `/tmp/pi-transfer-${viewport.width}-import.png` });
    await page.locator('#pi-transfer-file').setInputFiles({ name: 'wrong.html', mimeType: 'text/html', buffer: Buffer.from('wrong') });
    await dialog.getByRole('button', { name: '导入为新线程' }).click(); assert.match(await dialog.innerText(), /非空 .jsonl/);
    const fixture = { name: '会话.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from('{"fixture":"中文"}\n') };
    await page.locator('#pi-transfer-file').setInputFiles(fixture);
    await dialog.getByRole('button', { name: '导入为新线程' }).click(); await dialog.getByRole('button', { name: '打开新线程' }).waitFor();
    assert.deepEqual(opens, ['original-thread']); assert.equal(await page.locator('#pi-input').inputValue(), '保留主草稿');
    assert.equal(await page.locator('#pi-attachments').getByText('保留附件.txt', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.BAD), undefined); await geometry();
    assert.equal(writes.filter(w => w.path.endsWith('/import')).length, 1);
    assert.equal(writes.at(-1).body.cwd, target);
    await page.keyboard.press('Escape');
    // Project selector entry is also available without switching the active session.
    if (viewport.width < 900) await page.locator('#pi-toggle-sessions').click();
    if (viewport.width <= 680) { await page.locator('#pi-mobile-summary').click(); }
    else await page.locator('#pi-project-button').click();
    await page.locator('#pi-import-session').click();
    await dialog.waitFor(); await page.locator('#pi-transfer-project').selectOption('');
    await page.locator('#pi-transfer-path').fill('/srv/custom-project'); await geometry();
    await page.locator('#pi-transfer-file').setInputFiles(fixture); failImport = true;
    await dialog.getByRole('button', { name: '导入为新线程' }).click();
    await page.waitForFunction(() => document.querySelector('#pi-transfer-dialog .pi-transfer-status').textContent.includes('失效父节点'));
    assert.equal(await dialog.getByRole('button', { name: '导入为新线程' }).count(), 0); failImport = false;
    await page.keyboard.press('Escape'); await importMenu(); await page.locator('#pi-transfer-project').selectOption(target);
    await page.locator('#pi-transfer-file').setInputFiles(fixture); holdImport = true;
    await dialog.getByRole('button', { name: '导入为新线程' }).click();
    for (let n = 0; n < 100 && !releaseImport; n++) await page.waitForTimeout(20);
    assert.ok(releaseImport); await page.keyboard.press('Escape'); releaseImport();
    await page.waitForFunction(() => [...document.querySelectorAll('.pi-toast')].some(e => e.textContent.includes('已导入为新线程')));
    assert.deepEqual(opens, ['original-thread']); assert.equal(await page.locator('#pi-input').inputValue(), '保留主草稿');
    // A new deliberate import can explicitly open its independent thread.
    await importMenu(); await page.locator('#pi-transfer-project').selectOption(target); await page.locator('#pi-transfer-file').setInputFiles(fixture);
    await dialog.getByRole('button', { name: '导入为新线程' }).click(); await dialog.getByRole('button', { name: '打开新线程' }).click();
    await page.waitForFunction(() => document.querySelector('.pi-session-item.active')?.dataset.sessionId?.startsWith('imported-'));
    await page.locator('#pi-input:not([disabled])').waitFor();
    assert.ok(opens.at(-1).startsWith('imported-'));
    oldBackend = true; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor(); assert.equal(await page.locator('#pi-import-session').isVisible(), false);
    for (const command of ['import', 'export']) {
        await slash(`/${command}`);
        await page.waitForFunction(() => [...document.querySelectorAll('.pi-toast')].some(e => e.textContent.includes('当前后端尚未启用会话导入与导出')));
        assert.equal(await page.locator('#pi-input').inputValue(), `/${command}`);
        assert.equal(await page.locator('#pi-transfer-dialog[open]').count(), 0);
    }
    await drawer(); await page.locator(`[data-project-cwd="${cwd}"] [data-project-action="menu"]`).click();
    assert.equal(await menu.getByRole('menuitem', { name: '导入 Pi 会话' }).count(), 0);
    assert.deepEqual(errors, []); await context.close(); console.log(`transfer ${viewport.width}: passed`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport);
        if (fs.existsSync('/tmp/pi-transfer-native-fixture.html')) {
            const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
            await page.route('http**://**', route => route.abort());
            await page.goto('file:///tmp/pi-transfer-native-fixture.html', { waitUntil: 'load' });
            assert.match(await page.locator('body').innerText(), /current unique/); assert.equal(await page.evaluate(() => window.BAD), undefined);
            assert.deepEqual(errors, []); await page.close(); console.log('native HTML offline reading: passed');
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
