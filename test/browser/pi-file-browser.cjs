const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require('express'), http = require('node:http'), path = require('node:path');
const { once } = require('node:events');
const cwd = '/projects/studio';
const session = { id: 'files', cwd, name: '项目文件浏览', messageCount: 0 }, other = { ...session, id: 'other', name: '另一个线程' };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
const file = (name, prefix = '', kind = 'file') => ({ name, path: prefix + name, kind });
const folders = {
    '': [file('docs', '', 'directory'), file('src', '', 'directory'), file('assets', '', 'directory'), file('README.md'), file('package.json')],
    docs: [file('guides', 'docs/', 'directory'), file('design.md', 'docs/'), file('notes.md', 'docs/')],
    'docs/guides': [file('getting-started.md', 'docs/guides/')],
    src: [file('app.js', 'src/'), file('styles.css', 'src/')], assets: []
};
const markdown = '# 更自然地阅读项目\n\n从目录中找到文件，让对话和项目内容相互连接。\n\n## 清晰的文件导航\n\n按需展开目录，直接查看当前文件。\n\n| 能力 | 使用方式 |\n| --- | --- |\n| 项目文件 | 浏览目录和查找路径 |\n| 本轮文件 | 查看成功编辑与写入 |\n\n' + '### 阅读与记录\n\n保持正文的呼吸感，宽屏并排阅读，手机随时继续。\n\n'.repeat(15);
async function run(browser, base, width, language) {
    const context = await browser.newContext({ locale: language, viewport: { width, height: width <= 900 ? 852 : 1000 } });
    const page = await context.newPage(), errors = [], requests = [], writes = [], commands = [];
    let holdSearch = false, pendingSearch, legacy = false;
    page.on('pageerror', e => errors.push(e.message));
    // Keep the fixture independent of remote font availability.
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd);
        window.__copies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
    }, { cwd });
    await page.route('**/api/**', async route => {
        const r = route.request(), url = new URL(r.url()); requests.push(url.pathname + url.search);
        if (r.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ json: {} }); }
        if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, fileViewer: true, fileBrowser: !legacy, sideChat: true, projectRoots: ['/projects'] } });
        if (url.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Studio', sessionCount: 2 }], roots: ['/projects'] } });
        if (url.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, other] } });
        if (url.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (url.pathname === '/api/pi/files/list') {
            const relative = url.searchParams.get('path');
            const entries = [...(folders[relative] || [])];
            if (!relative && url.searchParams.get('hidden') === 'true') entries.push(file('.gitignore'));
            return route.fulfill({ json: { cwd, path: relative, entries, partial: false } });
        }
        if (url.pathname === '/api/pi/files/search') {
            if (holdSearch) { pendingSearch = route; return; }
            return route.fulfill({ json: { cwd, entries: [file('getting-started.md', 'docs/guides/')], partial: url.searchParams.get('q') === 'partial' } });
        }
        if (url.pathname === '/api/pi/files/content') {
            const relative = url.searchParams.get('path');
            return route.fulfill({ json: { cwd, path: relative, absolutePath: cwd + '/' + relative, content: /\.md$/.test(relative) ? markdown : 'const message = "Hello";\n', readAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), revision: 'fixture' } });
        }
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw); commands.push(cmd.type);
        const state = { model, thinkingLevel: 'off', isStreaming: false };
        const data = cmd.type === 'open_session' ? { session: cmd.sessionId === 'other' ? other : session, state, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : cmd.type === 'get_messages' ? { messages: [] } : cmd.type === 'get_state' ? state : {};
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('[data-session-id="files"]').waitFor({ state: 'attached' });
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-changes-tab').click();
    const row = relative => page.locator('.pi-file-tree-row').and(page.locator(`[data-path="${relative}"]`));
    await row('README.md').waitFor();
    assert.equal(requests.filter(r => r.startsWith('/api/pi/files/content')).length, 0, 'browsing does not read file contents');
    await row('docs').click(); await row('docs/design.md').waitFor();
    const indentation = await page.evaluate(() => ['docs', 'docs/design.md'].map(p => Number.parseFloat(getComputedStyle([...document.querySelectorAll('.pi-file-tree-row')].find(n => n.dataset.path === p)).paddingLeft)));
    assert.ok(indentation[1] > indentation[0], 'nested folders retain their visible indentation');
    await page.screenshot({ path: `/tmp/pivane-files-tree-${width}-${language}.png` });
    await row('docs/design.md').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.equal(await page.locator('#pi-file-explorer').isVisible(), false);
    assert.equal(await page.locator('#pi-file-source').inputValue(), 'current');
    await page.locator('#pi-file-copy-path').click(); assert.equal(await page.evaluate(() => window.__copies.at(-1)), 'docs/design.md');
    await page.locator('#pi-file-body').evaluate(n => n.scrollTop = 240);
    const savedTop = await page.locator('#pi-file-body').evaluate(n => n.scrollTop);
    await page.locator('#pi-files-browse').click(); await row('README.md').click(); await page.locator('#pi-file-body h1').waitFor();
    await page.locator('#pi-files-browse').click(); await row('docs/design.md').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.equal(await page.locator('#pi-file-body').evaluate(n => n.scrollTop), savedTop);
    await page.locator('#pi-file-locate').click(); await row('docs/design.md').waitFor();
    assert.equal(await row('docs').getAttribute('aria-expanded'), 'true');
    await page.locator('.pi-explorer-search input').fill('getting');
    await row('docs/guides/getting-started.md').waitFor(); await row('docs/guides/getting-started.md').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.ok(requests.some(r => r.includes('/files/search?') && r.includes('q=getting')));
    await page.locator('#pi-file-locate').click(); await row('docs/guides/getting-started.md').waitFor();
    await row('docs/guides/getting-started.md').focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.path), 'docs/guides');
    await page.locator('.pi-explorer-search input').fill('partial'); await page.locator('.pi-explorer-status').filter({ hasText: language.startsWith('zh') ? '部分' : 'partial' }).waitFor();
    await page.locator('.pi-explorer-search input').fill('');
    await page.locator('.pi-explorer-heading button').first().click(); await row('.gitignore').waitFor();
    await row('README.md').click(); await page.locator('#pi-file-body h1').waitFor();
    await page.locator('#pi-file-body').evaluate(n => n.scrollTop = 0);
    if (width >= 1440) {
        await page.locator('#pi-files-expand').click(); await page.locator('#pi-files-browse').click();
        await page.waitForFunction(() => document.querySelector('#pi-changes').classList.contains('files-wide'));
        assert.equal(await page.locator('#pi-file-reader').isVisible(), true);
        assert.equal(await page.locator('#pi-file-explorer').isVisible(), true);
    }
    for (const theme of ['daylight', 'dark']) {
        await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
        const overflowing = await page.evaluate(() => ['body', '#pi-changes', '#pi-file-reader', '#pi-file-explorer', '#pi-files-toolbar', '#pi-inspector'].filter(s => { const n = document.querySelector(s); return n.clientWidth && n.scrollWidth > n.clientWidth + 1; }));
        assert.deepEqual(overflowing, []);
        await page.screenshot({ path: `/tmp/pivane-files-${width}-${language}-${theme}.png` });
    }
    assert.deepEqual(commands, [], 'project browsing and preview work without opening any session');
    // Abandoned project searches cannot populate another thread's file navigation.
    if (!(await page.locator('#pi-file-explorer').isVisible())) await page.locator('#pi-files-browse').click();
    holdSearch = true; await page.locator('.pi-explorer-search input').fill('late');
    for (let i = 0; i < 50 && !pendingSearch; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(pendingSearch);
    await page.locator('#pi-close-inspector').click();
    if (width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="other"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
    await pendingSearch.fulfill({ json: { entries: [file('LATE_OTHER_THREAD.txt')] } }).catch(() => {});
    assert.equal(await page.locator('#pi-file-body').textContent(), '');
    assert.equal(await page.locator('[data-path="LATE_OTHER_THREAD.txt"]').count(), 0);
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-changes-tab').click(); await row('README.md').waitFor();
    const listsBefore = requests.filter(r => r.startsWith('/api/pi/files/list?')).length;
    // Exercise a coordinator context change while the file panel remains open.
    await page.locator('[data-session-id="files"] .pi-session-main').evaluate(n => n.click());
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'files');
    await row('README.md').waitFor();
    assert.ok(requests.filter(r => r.startsWith('/api/pi/files/list?')).length > listsBefore);
    legacy = true; await page.reload(); await page.locator('#pi-input:not([disabled])').waitFor();
    await page.locator('#pi-toggle-inspector').click(); await page.locator('#pi-changes-tab').click();
    assert.match(await page.locator('.pi-explorer-status').textContent(), language.startsWith('zh') ? /尚未启用/ : /not available/);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.ok(!commands.includes('prompt'));
    console.log(`PASS file browser ${width} ${language}`); await context.close();
}
(async () => {
    const root = path.resolve(__dirname, '../..'), app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const width of [1440, 1024, 393, 320]) for (const language of ['zh-CN', 'en']) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
