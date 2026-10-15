const assert = require('node:assert/strict');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require('express'), http = require('node:http'), path = require('node:path');
const { once } = require('node:events');
const cwd = '/projects/studio', related = '/projects/studio-notes', external = '/projects/reports';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
const session = id => ({ id, cwd, name: id === 'one' ? '跨目录文件协作' : '另一条会话', messageCount: 1 });
const document = root => root === related ? '# 私有维护笔记\n\n这里是关联目录中的 README，不是主项目文件。\n\n[详细记录](detail.md)\n\n## 发布准备\n\n保留源码与维护资料各自的位置，让阅读自然连接。\n' : root === external ? '# 任务报告\n\n仅打开此文件，不枚举父目录。' : '# 产品源码\n\n这个 README 属于主目录。';
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ locale, viewport: { width, height: width <= 900 ? 852 : 1000 } });
    const page = await context.newPage(), errors = [], requests = [], commands = [];
    let roots = [], revision = 0, active = 'one', held = null, holdRoot = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'one'); window.__copies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } }); }, { cwd });
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()); requests.push({ url: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method() });
        const json = data => route.fulfill({ json: data });
        if (url.pathname === '/api/pi/status') return json({ ok: true, fileViewer: true, fileBrowser: true, fileRoots: true, filePreviews: true, projectRoots: ['/projects'] });
        if (url.pathname === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Studio', sessionCount: 2 }], roots: ['/projects'] });
        if (url.pathname === '/api/pi/sessions') return json({ sessions: [session('one'), session('two')] });
        if (url.pathname === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname === '/api/pi/files/roots') {
            if (request.method() === 'POST') {
                assert.match(request.headers()['content-type'] || '', /^application\/json\b/, 'real express.json middleware must parse the request');
                const body = request.postDataJSON(); assert.equal(body.cwd, cwd);
                if (body.expectedRevision !== revision) return route.fulfill({ status: 409, json: { error: '关联目录已变化，请刷新后重试', code: 'FILE_ROOTS_CHANGED' } });
                roots = roots.filter(root => root !== body.root); if (body.action === 'add' && body.root !== cwd) roots.push(body.root); revision++;
            }
            return json({ cwd, roots, revision });
        }
        if (url.pathname === '/api/pi/files/directories') {
            const p = url.searchParams.get('path');
            if (p.includes('denied')) return route.fulfill({ status: 403, json: { error: '目录不可访问', code: 'FILE_PROJECT' } });
            return json({ current: p || null, parent: p && p !== '/projects' ? '/projects' : null,
                directories: !p ? [{ name: '/projects', path: '/projects' }] : p === '/projects' ? [cwd, related, external].map(path => ({ name: path.split('/').at(-1), path })) : [], partial: false });
        }
        if (url.pathname === '/api/pi/files/resolve') {
            const raw = url.searchParams.get('path');
            const absolute = raw.startsWith('/') ? path.posix.normalize(raw) : path.posix.resolve(cwd, raw);
            const root = absolute.startsWith(related + '/') ? related : absolute.startsWith(external + '/') ? external : cwd;
            return json({ root, path: path.posix.relative(root, absolute), absolutePath: absolute, associated: root === cwd || roots.includes(root), revision });
        }
        if (url.pathname === '/api/pi/files/list') {
            const root = url.searchParams.get('cwd');
            if (root === holdRoot) { held = route; return; }
            return json({ cwd: root, path: '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file' }, { name: 'detail.md', path: 'detail.md', kind: 'file' }], partial: false });
        }
        if (url.pathname === '/api/pi/files/search') return json({ cwd: url.searchParams.get('cwd'), entries: [{ name: 'detail.md', path: 'detail.md', kind: 'file' }], partial: false });
        if (url.pathname === '/api/pi/files/preview') {
            const root = url.searchParams.get('cwd'), p = url.searchParams.get('path');
            return json({ cwd: root, path: p, absolutePath: root + '/' + p, kind: 'markdown', mime: 'text/markdown', encoding: 'utf8', content: p === 'detail.md' ? '# 关联目录详情' : document(root), size: 100, revision: root + p, readAt: new Date().toISOString(), modifiedAt: new Date().toISOString() });
        }
        return json({});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw); commands.push(cmd); if (cmd.type === 'open_session') active = cmd.sessionId;
        const state = { model, thinkingLevel: 'off', isStreaming: false };
        const messages = [{ role: 'assistant', timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: `[外部报告](${external}/README.md) · [关联笔记](${related}/README.md)` }] }];
        const data = cmd.type === 'open_session' ? { session: session(active), state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : cmd.type === 'get_messages' ? { messages } : cmd.type === 'get_state' ? state : {};
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }));
    const zh = locale.startsWith('zh');
    const text = (a, b) => zh ? a : b;
    const dialog = page.locator('#pi-file-roots-dialog');
    const row = p => page.locator(`.pi-file-tree-row[data-path="${p}"]`);
    const checkWidth = async () => assert.deepEqual(await page.evaluate(() => ['body', '#pi-inspector', '#pi-file-roots-dialog', '.pi-file-roots', '.pi-roots-footer'].filter(s => { const n = document.querySelector(s); return n?.clientWidth && n.scrollWidth > n.clientWidth + 1; })), []);
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'one');
    await openInspector(page, 'changes'); await row('README.md').waitFor();
    const initialOpen = commands.filter(c => c.type === 'open_session').length;
    await page.locator('#pi-file-roots-manage').click(); await dialog.getByText('/projects', { exact: true }).last().waitFor();
    await page.locator('#pi-file-root-path').fill(related); await dialog.getByRole('button', { name: text('前往', 'Go'), exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.pi-roots-primary').disabled);
    await checkWidth(); await page.screenshot({ path: `/tmp/pivane-roots-${width}-${locale}-dialog.png` });
    await dialog.getByRole('button', { name: text('关联并打开', 'Link and open'), exact: true }).click();
    await page.waitForFunction(root => document.querySelector('#pi-file-root-select').value === root, related);
    await row('README.md').click(); await page.locator('#pi-file-body h1').filter({ hasText: '私有维护笔记' }).waitFor();
    assert.ok(requests.some(r => r.url === '/api/pi/files/preview' && r.query.cwd === related));
    await page.locator('#pi-file-copy-path').click(); assert.equal(await page.evaluate(() => window.__copies.at(-1)), related + '/README.md');
    assert.match(await page.locator('.pi-file-breadcrumb').textContent(), /studio-notes/);
    await page.locator('#pi-file-body a').filter({ hasText: '详细记录' }).click(); await page.locator('#pi-file-body h1').filter({ hasText: '关联目录详情' }).waitFor();
    assert.ok(requests.some(r => r.url === '/api/pi/files/preview' && r.query.cwd === related && r.query.path === 'detail.md'));
    await page.locator('#pi-files-browse').click();
    await page.locator('#pi-file-root-select').selectOption(cwd); await row('README.md').click(); await page.locator('#pi-file-body h1').filter({ hasText: '产品源码' }).waitFor();
    await page.locator('#pi-files-browse').click(); await page.locator('#pi-file-root-select').selectOption(related);
    await row('README.md').click(); await page.locator('#pi-file-body h1').filter({ hasText: '私有维护笔记' }).waitFor();
    for (const theme of ['daylight', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await checkWidth(); await page.screenshot({ path: `/tmp/pivane-roots-${width}-${locale}-${theme}.png` }); }
    assert.equal(commands.filter(c => c.type === 'open_session').length, initialOpen, 'changing browse roots does not change sessions');
    assert.ok(!commands.some(c => c.type === 'prompt'));
    // A single-file confirmation must not enumerate the external parent.
    const extLists = () => requests.filter(r => r.url === '/api/pi/files/list' && r.query.cwd === external).length;
    const before = extLists();
    await page.locator('#pi-transcript-content a').filter({ hasText: '外部报告' }).evaluate(n => n.click());
    await dialog.getByRole('button', { name: text('仅打开文件', 'Open file only'), exact: true }).waitFor(); await checkWidth();
    await dialog.getByRole('button', { name: text('仅打开文件', 'Open file only'), exact: true }).click(); await page.locator('#pi-file-body h1').filter({ hasText: '任务报告' }).waitFor();
    assert.equal(extLists(), before); assert.equal(await page.locator('#pi-file-locate').isVisible(), false); assert.equal(roots.includes(external), false);
    await page.locator('#pi-transcript-content a').filter({ hasText: '外部报告' }).evaluate(n => n.click());
    await dialog.getByRole('button', { name: text('关联目录并打开', 'Link folder and open'), exact: true }).click(); await page.locator('#pi-file-body h1').filter({ hasText: '任务报告' }).waitFor();
    assert.ok(roots.includes(external));
    await page.locator('#pi-file-locate').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-file-locate').isVisible(), true, 'promoting a single file restores folder navigation');
    assert.equal(await page.locator('.pi-file-breadcrumb button:disabled').count(), 0);
    // Persisted related folders are reloaded; current browsing defaults to the primary root.
    await page.reload(); await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'one'); await openInspector(page, 'changes');
    await page.locator('#pi-file-roots-manage').click(); await dialog.locator('.pi-roots-saved-row').filter({ hasText: related }).waitFor();
    await dialog.locator('.pi-roots-saved-row').filter({ hasText: related }).locator('.pi-files-icon').click();
    await page.waitForFunction(root => ![...document.querySelector('#pi-file-root-select').options].some(o => o.value === root), related);
    assert.ok(!roots.includes(related)); await page.keyboard.press('Escape');
    // A new temporary browsing root supports cancellation and late root response protection.
    await page.locator('#pi-file-roots-manage').click(); await page.locator('#pi-file-root-path').waitFor();
    await page.locator('#pi-file-root-path').fill(related); await dialog.getByRole('button', { name: text('前往', 'Go'), exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.pi-roots-primary').disabled);
    holdRoot = related;
    await dialog.getByRole('button', { name: text('临时打开', 'Open temporarily'), exact: true }).click();
    await page.waitForFunction(root => document.querySelector('#pi-file-root-select').value === root, related);
    await page.locator('#pi-file-root-select').selectOption(cwd); await row('README.md').waitFor();
    if (held) await held.fulfill({ json: { cwd: related, path: '', entries: [{ name: 'LATE.md', path: 'LATE.md', kind: 'file' }] } }).catch(() => {});
    assert.equal(await row('LATE.md').count(), 0); holdRoot = null;
    // Switching a native session closes pending confirmation and clears preview state.
    await page.locator('#pi-transcript-content a').filter({ hasText: '关联笔记' }).evaluate(n => n.click()); await dialog.waitFor({ state: 'visible' });
    await page.locator('[data-session-id="two"] .pi-session-main').evaluate(n => n.click());
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'two');
    assert.equal(await dialog.isVisible(), false); assert.equal(await page.locator('#pi-file-body').textContent(), '');
    await page.waitForFunction(root => [...document.querySelector('#pi-file-root-select').options].some(o => o.value === root), external);
    assert.deepEqual(errors, []); assert.ok(commands.filter(c => c.type === 'open_session').every(c => c.cwd === cwd));
    console.log(`PASS multi-root files ${width} ${locale}: linked roots, same-name files, links, persistence, no cwd mutation, single-file scope, late replies, session reset`);
    await context.close();
}
(async () => {
    const root = path.resolve(__dirname, '../..'), app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const width of [1440, 1024, 393, 320]) for (const locale of ['zh-CN', 'en']) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
