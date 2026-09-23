const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.PI_FILE_TEST_URL || 'http://127.0.0.1:3118';
const cwd = '/srv/file-viewer-fixture';
const session = { id: 'files', cwd, name: '文件查看', messageCount: 12 }, other = { ...session, id: 'other', name: '另一个线程' };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const report1 = '# 最初写入\n\n旧版内容\n';
const report2 = '# 写入报告\n\n这是当时的完整报告。\n\n[详细说明](details.md)\n\n<img src="https://invalid.test/private.png" onerror="window.badFile=true"><script>window.badFile=true</script>\n';
const code = 'const title = "中文";\n// a comment\nconst line = 3;\nconst long = "' + 'long'.repeat(160) + '";\n';
const patch = '--- src/app.js\n+++ src/app.js\n@@ -1 +1 @@\n-old\n+new\n';
let timestamp = 1;
const user = text => ({ role: 'user', content: text, timestamp: timestamp++ });
const assistant = text => ({ role: 'assistant', content: text, timestamp: timestamp++, stopReason: 'stop' });
const tool = (name, id, file, content, error = false) => [
    { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path: file, ...(content !== undefined ? { content } : {}) } }], timestamp: timestamp++ },
    { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: error ? 'Failed' : 'Success' }], isError: error, details: name === 'edit' ? { patch } : {}, timestamp: timestamp++ }
];
async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900 });
    const page = await context.newPage(), errors = [], writes = [], reads = [], remoteImages = [], commands = [];
    let socket, active = session.id, busy = false, legacy = false, diskReport = '# 磁盘版本 1\n\n[详细说明](details.md)\n', pending = null, hold = false;
    let messages = [user('创建报告并修改程序'), ...tool('write', 'w1', 'docs/report.md', report1), ...tool('write', 'w2', 'docs/report.md', report2),
        ...tool('edit', 'e1', cwd + '/src/app.js'), ...tool('write', 'w3', 'empty.txt', ''), ...tool('write', 'w4', '脚本 空格.py', 'print("你好")\n'),
        ...tool('write', 'bad', 'failed.txt', 'not written', true), ...tool('write', 'secret', '.env', 'FIXTURE_PRIVATE'), ...tool('bash', 'shell', 'shell.txt', 'unknown'),
        assistant('已处理文件。\n\n[查看程序](/srv/file-viewer-fixture/src/app.js:3) · [项目说明](README.md:2) · [带空格的文件](%E8%84%9A%E6%9C%AC%20%E7%A9%BA%E6%A0%BC.py) · [百分号文件](notes%25.txt) · [外部文档](https://example.test/README.md) · [不存在的文件](missing.txt)')];
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    const emit = e => socket.send(JSON.stringify(e));
    const fileResult = file => ({ cwd, path: file, absolutePath: file.startsWith('/') ? file : cwd + '/' + file, content: /report\.md$/.test(file) ? diskReport : /details\.md$/.test(file) ? '# 相对路径详情\n' : /README/.test(file) ? '# 项目说明\n第二行\n' : /\.py$/.test(file) ? 'print("磁盘 Python")\n' : code, size: 100, revision: 'fixture-revision', readAt: new Date().toISOString(), modifiedAt: '2026-09-09T06:00:00Z' });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => { if (request.url().startsWith('https://invalid.test/')) remoteImages.push(request.url()); });
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id);
        window.__copies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
        if (request.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }); }
        if (endpoint === '/api/pi/files/content') {
            const file = url.searchParams.get('path'); assert.equal(url.searchParams.get('cwd'), cwd); reads.push(file);
            if (/missing/.test(file)) return route.fulfill({ status: 404, json: { error: '文件不存在或已被移走' } });
            if (hold) { pending = { route, file }; return; }
            return route.fulfill({ json: fileResult(file) });
        }
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, fileViewer: !legacy, sideChat: true, historySearch: true, projectRoots: ['/srv'] } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Files', sessionCount: 2 }], roots: ['/srv'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, other] } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (endpoint.includes('history') || endpoint === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd.type);
            const state = { model, thinkingLevel: 'off', isStreaming: busy, isCompacting: false };
            if (cmd.type === 'open_session') {
                active = cmd.sessionId;
                return reply(ws, cmd, { session: active === session.id ? session : other, state, messages: { messages: active === session.id ? messages : [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: active === session.id ? messages : [] });
            if (cmd.type === 'get_state') return reply(ws, cmd, state);
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
            throw new Error(`Unexpected RPC ${cmd.type}`);
        });
    });
    if (process.env.PI_FILE_LAYOUT_BASELINE) {
        for (const name of ['index.html', 'pi-turn-edits.js', 'pi-file-viewer.js', 'pi-turn-edits.css', 'pi-file-viewer.css']) {
            await page.route(base + (name === 'index.html' ? '/' : '/' + name), route => route.fulfill({
                contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
                body: fs.readFileSync(path.join(process.env.PI_FILE_LAYOUT_BASELINE, 'public', name), 'utf8')
            }));
        }
    }
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('.pi-turn-edits'));
    const windowsLinks = await page.evaluate(() => {
        const target = window.PiFileViewer.linkTarget;
        return [target('C:\\Users\\Example\\project\\file.ts:12'), target('file:///C:/Users/Example/project/file.ts#L4'), target('sub\\file.md', 'C:/Users/Example/project/README.md'), target('javascript:alert(1)'), target('C:/Users/Example/file.md:secret')];
    });
    assert.deepEqual(windowsLinks, [{ path: 'C:/Users/Example/project/file.ts', line: 12 }, { path: 'C:/Users/Example/project/file.ts', line: 4 }, { path: 'C:/Users/Example/project/sub/file.md', line: null }, null, null]);
    assert.deepEqual(reads, []);
    const card = page.locator('.pi-turn-edits');
    assert.match(await card.textContent(), /4 个文件/); assert.doesNotMatch(await card.textContent(), /failed.txt|\.env|shell.txt/);
    await card.locator('[data-edit-path="docs/report.md"]').click();
    await page.locator('#pi-file-body h1').waitFor();
    assert.equal(await page.locator('#pi-file-body h1').textContent(), '写入报告');
    assert.match(await page.locator('#pi-file-status').textContent(), /本次成功写入/);
    assert.equal(await page.locator('#pi-file-diff-tab').isDisabled(), true);
    assert.deepEqual(reads, []); assert.equal(await page.locator('#pi-file-body script, #pi-file-body img').count(), 0);
    assert.equal(await page.evaluate(() => window.badFile), undefined); assert.deepEqual(remoteImages, []);
    await page.locator('#pi-file-copy').click(); assert.equal(await page.evaluate(() => window.__copies.at(-1)), report2);
    await page.locator('#pi-file-source').selectOption('write:w1'); assert.equal(await page.locator('#pi-file-body h1').textContent(), '最初写入');
    await page.locator('#pi-file-source').selectOption('current');
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('磁盘版本 1'));
    assert.equal(reads.length, 1);
    diskReport = '# 磁盘版本 2\n\n<a href="details.md">详细说明</a>\n' + '\n## 阅读内容\n\n需要保留充分的空间检查整份报告。\n'.repeat(40);
    emit({ type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelector('#pi-composer-status').textContent === 'Pi Agent 已就绪');
    assert.match(await page.locator('#pi-file-body').textContent(), /磁盘版本 1/); assert.equal(reads.length, 1, 'snapshot redraw does not reread disk');
    await page.locator('#pi-file-refresh').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('磁盘版本 2'));
    assert.equal(reads.length, 2);
    await page.locator('#pi-file-preview').click();
    assert.match(await page.locator('#pi-file-body').textContent(), /# 磁盘版本 2/);
    await page.locator('#pi-file-preview').click();
    const geometry = await page.evaluate(() => {
        const pane = document.querySelector('#pi-inspector').getBoundingClientRect();
        const node = document.querySelector('#pi-file-body'), body = node.getBoundingClientRect();
        return { paneHeight: pane.height, bodyHeight: body.height, clientHeight: node.clientHeight, fraction: body.height / pane.height, bottomGap: pane.bottom - body.bottom };
    });
    console.log(`LAYOUT ${viewport.width}: ${JSON.stringify(geometry)}`);
    if (process.env.PI_FILE_LAYOUT_BASELINE) {
        await page.screenshot({ path: path.join(require('node:os').tmpdir(), `pi-file-panel-${viewport.width}-before.png`) }); await context.close(); return;
    }
    // The project navigation adds one toolbar. Preserve the reader on short
    // phones while keeping source selection and file controls reachable.
    assert.ok(geometry.fraction >= (geometry.paneHeight < 620 ? .58 : .66), 'full text retains usable space beneath file navigation');
    assert.ok(Math.abs(geometry.bottomGap) <= 2, 'reader fills the remaining panel height');
    assert.equal(await page.locator('#pi-changes-tab').textContent(), '文件');
    assert.equal(await page.locator('#pi-changes-file-list').evaluate(n => n.open), false, 'file navigation starts collapsed on every viewport');
    assert.equal(await page.locator('#pi-file-notice').isVisible(), false, 'ready metadata does not reserve a row');
    await page.locator('#pi-file-body').evaluate(n => n.scrollTop = 180);
    const readTop = await page.locator('#pi-file-body').evaluate(n => n.scrollTop);
    const beforeMenus = reads.length;
    await page.locator('#pi-file-info > summary').click();
    await page.locator('#pi-file-status').waitFor({ state: 'visible' });
    await checkPopup(page, '.pi-file-info-panel');
    assert.match(await page.locator('#pi-file-status').textContent(), /读取于/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-file-info').evaluate(n => n.open), false);
    assert.equal(await page.locator('#pi-inspector').evaluate(n => n.classList.contains('open')), true);
    await page.locator('#pi-changes-file-list > summary').click();
    await page.locator('#pi-changes-round').waitFor({ state: 'visible' });
    await checkPopup(page, '.pi-file-picker-panel');
    assert.equal(await page.locator('#pi-file-body').evaluate(n => n.clientHeight), geometry.clientHeight, 'navigation overlays rather than shrinks the reader');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-changes-file-list').evaluate(n => n.open), false);
    assert.equal(await page.locator('#pi-file-body').evaluate(n => n.scrollTop), readTop);
    assert.equal(reads.length, beforeMenus, 'opening navigation or metadata never reads a file');
    await page.locator('#pi-changes-file-list > summary').click();
    await page.locator('#pi-file-body').focus();
    assert.equal(await page.locator('#pi-changes-file-list').evaluate(n => n.open), false, 'leaving the popup by keyboard focus closes it');
    await page.locator('#pi-file-body').evaluate(n => n.scrollTop = 0);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await checkWidth(page);
        await page.screenshot({ path: path.join(require('node:os').tmpdir(), `pi-file-viewer-${viewport.width}-${theme}-markdown.png`) });
    }
    await page.locator('#pi-file-body a').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('相对路径详情'));
    assert.equal(reads.at(-1), cwd + '/docs/details.md', 'preview links resolve against the viewed file directory');
    await page.locator('#pi-close-inspector').click();
    await card.locator(`[data-edit-path="${cwd}/src/app.js"]`).click();
    assert.equal(await page.locator('#pi-changes-diffs').isVisible(), true);
    assert.equal(await page.locator('#pi-changes-title').textContent(), 'src/app.js');
    assert.equal(await page.locator('#pi-changes-title').getAttribute('title'), cwd + '/src/app.js');
    const diffFraction = await page.locator('#pi-changes-diffs').evaluate(n => n.clientHeight / document.querySelector('#pi-inspector').clientHeight);
    assert.ok(diffFraction >= (viewport.height < 780 && viewport.width <= 900 ? .64 : .72), 'diff also gets the majority of the panel');
    const count = reads.length; await page.locator('#pi-file-full-tab').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('const title'));
    assert.equal(reads.length, count + 1);
    assert.ok(await page.locator('#pi-file-body .hljs-keyword').count() > 0, 'syntax highlighting is locally available');
    assert.equal(await page.locator('#pi-file-body .pi-file-line').count(), code.split('\n').length);
    await page.locator('#pi-file-copy').click(); assert.equal(await page.evaluate(() => window.__copies.at(-1)), code);
    await page.locator('#pi-file-wrap').click();
    assert.equal(await page.locator('#pi-file-body').evaluate(n => n.scrollWidth <= n.clientWidth + 1), true);
    await checkWidth(page);
    await page.screenshot({ path: path.join(require('node:os').tmpdir(), `pi-file-viewer-${viewport.width}-code.png`) });
    await page.locator('#pi-file-diff-tab').click(); await page.locator('#pi-file-full-tab').click();
    assert.equal(reads.length, count + 1, 'reopening the same snapshot uses its labelled cached read');
    // No false diff or fake new-file claim for a write to an existing or empty file.
    await page.locator('#pi-changes-file-list > summary').click();
    await page.locator('#pi-changes-files [data-edit-path="empty.txt"]').click();
    assert.equal(await page.locator('#pi-changes-file-list').evaluate(n => n.open), false);
    assert.equal(await page.locator('#pi-file-copy').isDisabled(), true);
    assert.match(await page.locator('#pi-file-body').textContent(), /空文件（0 字符）/);
    await page.locator('#pi-close-inspector').click();
    const link = page.getByRole('link', { name: '查看程序', exact: true });
    await link.click();
    await page.waitForFunction(() => document.querySelector('.pi-file-target-line'));
    assert.equal(await page.locator('.pi-file-target-line').getAttribute('data-line'), '3');
    assert.equal(reads.at(-1), cwd + '/src/app.js');
    await page.locator('#pi-close-inspector').click();
    await page.getByRole('link', { name: '项目说明', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('第二行'));
    assert.equal(reads.at(-1), 'README.md', 'basename plus line number survives Markdown sanitization');
    assert.equal(await page.getByRole('link', { name: '外部文档' }).getAttribute('href'), 'https://example.test/README.md');
    await page.locator('#pi-close-inspector').click();
    await page.getByRole('link', { name: '带空格的文件' }).click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('磁盘 Python'));
    assert.equal(reads.at(-1), '脚本 空格.py');
    await page.locator('#pi-close-inspector').click();
    await page.getByRole('link', { name: '百分号文件' }).click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body').textContent.includes('const title'));
    assert.equal(reads.at(-1), 'notes%.txt', 'encoded file links are decoded exactly once');
    await page.locator('#pi-close-inspector').click();
    await page.getByRole('link', { name: '不存在的文件' }).click();
    await page.waitForFunction(() => document.querySelector('#pi-file-status').textContent.includes('不存在'));
    assert.equal(await page.locator('#pi-file-notice').isVisible(), true, 'errors remain visible outside collapsed file information');
    assert.equal(await page.locator('#pi-file-copy').isDisabled(), true); assert.equal(await page.locator('#pi-file-body').textContent(), '');
    // Late reads cannot replace a historical write selected while the request was pending.
    await page.locator('#pi-close-inspector').click(); await card.locator('[data-edit-path="docs/report.md"]').click();
    hold = true; await page.locator('#pi-file-source').selectOption('current'); await until(() => pending);
    await page.locator('#pi-file-source').selectOption('write:w1');
    await pending.route.fulfill({ json: { ...fileResult(pending.file), content: 'LATE_WRONG_FILE' } }).catch(() => {}); pending = null; hold = false;
    assert.equal(await page.locator('#pi-file-body h1').textContent(), '最初写入');
    // Reload derives successful writes from the native snapshot, with old-backend fallback.
    legacy = true; await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => document.querySelector('.pi-turn-edits'));
    const noReads = reads.length; await card.locator('[data-edit-path="docs/report.md"]').click();
    assert.equal(await page.locator('#pi-file-body h1').textContent(), '写入报告');
    await page.locator('#pi-file-source').selectOption('current'); assert.match(await page.locator('#pi-file-status').textContent(), /尚未启用/);
    assert.equal(reads.length, noReads);
    legacy = false; await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => document.querySelector('.pi-turn-edits'));
    await card.locator('[data-edit-path="docs/report.md"]').click(); hold = true;
    await page.locator('#pi-file-source').selectOption('current'); await until(() => pending);
    await page.locator('#pi-close-inspector').click();
    if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="other"] .pi-session-main').click(); await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
    await pending.route.fulfill({ json: { ...fileResult(pending.file), content: 'LATE_OTHER_THREAD' } }).catch(() => {});
    assert.equal(await page.locator('#pi-file-body').textContent(), ''); assert.equal(await page.locator('.pi-turn-edits').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(remoteImages, []);
    assert.ok(commands.every(c => ['open_session', 'get_state', 'get_messages', 'get_session_stats'].includes(c)));
    console.log(`PASS ${viewport.width}: write records, historical/current distinction, explicit refresh, Markdown/source/highlight/lines/wrap/copy, links, missing file, late source/thread, reload, old backend and themes`);
    await context.close();
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 30)); } assert.ok(predicate()); }
async function checkPopup(page, selector) {
    const bounds = await page.locator(selector).evaluate(n => {
        const popup = n.getBoundingClientRect(), panel = document.querySelector('#pi-inspector').getBoundingClientRect();
        return { contained: popup.left >= panel.left - 1 && popup.right <= panel.right + 1 && popup.bottom <= panel.bottom + 1,
            overflow: n.scrollWidth > n.clientWidth + 1 };
    });
    assert.equal(bounds.contained, true, 'popup stays inside the inspector');
    assert.equal(bounds.overflow, false, 'popup contents do not overflow horizontally');
}
async function checkWidth(page) {
    const overflow = await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-content', '#pi-inspector', '#pi-changes', '#pi-changes-content', '#pi-file-viewer'].filter(s => {
        const n = document.querySelector(s); return n.clientWidth && n.scrollWidth > n.clientWidth + 1;
    })); assert.deepEqual(overflow, []);
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
