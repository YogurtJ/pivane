const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const express = require('express'), { once } = require('node:events');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/projects/artifacts-fixture';
const key = n => n.toString(16).padStart(64, '0');
const image = fs.readFileSync(path.join(root, 'public/brand/logo-192.png'));
const { pdf, wav } = require('../file-preview-fixtures.cjs');
const { representation } = require('../../server/pi-file-types');
const html = '<!doctype html><h1>Safe preview</h1><script>parent.document.body.dataset.escaped="yes"</script><a href="https://invalid.test/navigate">Remote</a><img src="https://invalid.test/image"><iframe src="https://invalid.test/frame"></iframe><meta http-equiv="refresh" content="0;url=https://invalid.test/refresh"><button onclick="parent.bad=true">Click</button>';
const raw = [Buffer.from('\ufeff# Report\r\nOriginal bytes\n[local](../secret.md)\n![remote](https://invalid.test/md.png)'), Buffer.from(html), image, wav(), pdf(), Buffer.from('name,value\r\n"<img src=x onerror=alert(1)>",=1+1\r\n')];
raw.push(Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0, ...Buffer.from('isommp42')]));
const names = ['report.md', 'prototype.html', 'image.png', 'recording.wav', 'report.pdf', 'table.csv', 'clip.mp4'];
const data = raw.map((bytes, i) => representation({ bytes, size: bytes.length, revision: 'b'.repeat(64) }, names[i]));
Object.assign(data[6], { kind: 'video', mime: 'video/mp4' });
const createdAt = '2026-10-07T08:00:00.000Z';
const group = (id, title, indices, types, linked = true) => ({ key: key(id), title, source: linked ? 'delivery' : 'media', project: linked ? { key: 'project-key', name: 'Demo project' } : null,
    origin: linked ? { sessionId: 'delivery' } : null, saved: linked, createdAt, types, files: indices.map(i => ({ key: key(i + 1), name: names[i], kind: types[0], size: raw[i].length })) });
const items = [group(1, 'Research report', [0, 1, 4, 5], ['document', 'web']), group(3, 'Generated image', [2], ['image'], false), group(4, 'Narration', [3], ['audio'], false), group(7, 'Motion study', [6], ['video'], false)];
async function run(browser, base, width, locale, theme) {
    const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 1000 }, locale, hasTouch: width < 900, acceptDownloads: true });
    const page = await context.newPage(), errors = [], network = [], writes = [], previews = [];
    let listError = false, partial = false, hold = false, delayed, revoke = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://invalid.test/**', r => { network.push(r.request().url()); return r.abort(); });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, r => r.abort());
    await page.addInitScript(({ cwd, theme }) => { if (window !== window.top) return; localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'delivery'); localStorage.setItem('pi.workspace.theme', theme); }, { cwd, theme });
    await page.route('**/api/**', async route => {
        const req = route.request(), u = new URL(req.url());
        if (req.method() !== 'GET') { writes.push(u.pathname); return route.fulfill({ json: {} }); }
        if (u.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, artifacts: true, fileViewer: true, fileBrowser: true, filePreviews: true, deliverables: true, projectRoots: ['/projects'] } });
        if (u.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Demo project', sessionCount: 1 }], roots: ['/projects'] } });
        if (u.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [{ id: 'delivery', cwd, name: 'Fixture', messageCount: 1 }] } });
        if (u.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (u.pathname === '/api/pi/artifacts/library') return route.fulfill({ json: { items: [], collections: [], projects: [], revision: 0, nextOffset: null } });
        if (u.pathname === '/api/pi/artifacts') {
            if (listError) return route.fulfill({ status: 503, json: { error: 'Fixture source unavailable' } });
            return route.fulfill({ json: { items: u.searchParams.has('cwd') ? [items[0]] : items, projects: [{ key: 'project-key', name: 'Demo project', cwd }], snapshot: 'fixture', nextOffset: null, partial, coverage: { scannedSessions: 1 } } });
        }
        if (u.pathname.endsWith('/origin')) return route.fulfill({ json: { cwd, sessionId: 'delivery' } });
        const preview = /\/artifacts\/([a-f0-9]{64})\/(?:preview|cover)$/.exec(u.pathname);
        if (preview) {
            previews.push(preview[1]); if (hold) { delayed = route; return; }
            if (revoke) return route.fulfill({ status: 403, json: { error: 'Source branch revoked' } });
            return route.fulfill({ json: data[parseInt(preview[1], 16) - 1] });
        }
        if (u.pathname === '/api/pi/deliverables') return route.fulfill({ json: { items: [{ id: key(99), index: 0, name: 'report.md', title: 'Research report', size: raw[0].length }] } });
        if (u.pathname === '/api/pi/files/list') return route.fulfill({ json: { entries: [], partial: false } });
        if (u.pathname === '/api/pi/media/lab') return route.fulfill({ json: { models: [], defaults: {} } });
        if (u.pathname === '/api/pi/media/lab/history') return route.fulfill({ json: { items: [] } });
        return route.fulfill({ json: {} });
    });
    const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), state = { model, thinkingLevel: 'off', isStreaming: false };
        const response = cmd.type === 'open_session' ? { session: { id: 'delivery', cwd, name: 'Fixture', messageCount: 1 }, state, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : cmd.type === 'get_state' ? state : {};
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: response }));
    }));
    await page.goto(base + '/#/artifacts', { waitUntil: 'domcontentloaded' });
    await page.locator('.artifacts-views [data-view="all"]').click();
    const card = title => page.locator('.artifacts-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await card('Research report').waitFor(); assert.equal(await page.locator('.artifacts-card').count(), 4);
    assert.equal(await page.locator('#artifacts-tab').evaluate(n => n.classList.contains('active')), true);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await widths(page);
    assert.equal(await page.locator('audio[autoplay],video[autoplay]').count(), 0);
    await page.locator('#artifacts-search').fill('no-match'); await page.getByText(locale === 'en' ? 'No matching artifacts' : '没有匹配的成果', { exact: true }).waitFor();
    await page.locator('#artifacts-search').fill('');
    await page.locator('.artifacts-types [data-kind="image"]').click(); assert.equal(await page.locator('.artifacts-card').count(), 1);
    await page.locator('.artifacts-types [data-kind="all"]').click();
    await page.locator('#artifacts-project').selectOption('unknown'); assert.equal(await page.locator('.artifacts-card').count(), 3);
    await page.locator('#artifacts-project').selectOption('');
    await card('Research report').click(); await page.locator('#artifacts-preview-body h1').waitFor();
    assert.equal(await page.locator('#artifacts-preview-body h1').textContent(), 'Report');
    assert.equal(await page.locator('#artifacts-preview-body a[href^="#pi-file"]').count(), 0);
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: locale === 'en' ? 'Download to device' : '下载到设备', exact: true }).click();
    const downloaded = await download; assert.equal(downloaded.suggestedFilename(), names[0]); assert.deepEqual(fs.readFileSync(await downloaded.path()), raw[0]); assert.ok(previews.filter(k => k === key(1)).length >= 2, 'download revalidates source');
    await page.locator('.artifacts-file-tab[role=tab]').filter({ hasText: 'prototype.html' }).click();
    await page.locator('#artifacts-preview-body iframe').waitFor();
    assert.equal(await page.locator('#artifacts-preview-body iframe').getAttribute('sandbox'), '');
    const frame = page.frameLocator('#artifacts-preview-body iframe'); await frame.locator('h1').waitFor();
    assert.equal(await frame.locator('a').getAttribute('href'), null); assert.equal(await page.locator('body').getAttribute('data-escaped'), null);
    await widths(page);
    await page.locator('.artifacts-file-tab[role=tab]').filter({ hasText: 'table.csv' }).click(); await page.locator('#artifacts-preview-body table').waitFor();
    assert.equal(await page.locator('#artifacts-preview-body img').count(), 0);
    await page.locator('.artifacts-file-tab[role=tab]').filter({ hasText: 'report.pdf' }).click(); await page.locator('#artifacts-preview-body canvas').waitFor();
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#artifacts-detail').evaluate(n => n.open), false);
    assert.equal(await card('Research report').evaluate(n => n === document.activeElement), true);
    await card('Narration').click(); await page.locator('#artifacts-preview-body audio').waitFor();
    assert.equal(await page.locator('#artifacts-preview-body audio').evaluate(n => n.paused), true);
    await page.keyboard.press('Escape'); await page.locator('#artifacts-preview-body audio').waitFor({ state: 'detached' }); assert.equal(await page.locator('#artifacts-preview-body audio').count(), 0);
    await card('Motion study').click(); await page.locator('#artifacts-preview-body video').waitFor();
    assert.equal(await page.locator('#artifacts-preview-body video').evaluate(n => n.paused), true);
    await page.keyboard.press('Escape'); await page.locator('#artifacts-preview-body video').waitFor({ state: 'detached' }); assert.equal(await page.locator('#artifacts-preview-body video').count(), 0);
    await card('Generated image').click(); await page.waitForFunction(() => document.querySelector('#artifacts-preview-body img')?.naturalWidth > 0);
    await widths(page); await page.keyboard.press('Escape');
    revoke = true; await card('Research report').click(); await page.locator('.artifacts-preview-state.is-error').getByText('Source branch revoked', { exact: true }).waitFor();
    await page.locator('.artifacts-preview-state.is-error').getByRole('button', { name: locale === 'en' ? 'Retry' : '重试', exact: true }).waitFor();
    assert.equal(await page.locator('.artifacts-detail-actions [data-action=download]').isDisabled(), true);
    await page.keyboard.press('Escape'); revoke = false;
    hold = true; await card('Research report').click(); await page.waitForFunction(() => document.querySelector('#artifacts-preview-body .artifacts-preview-state')?.textContent.includes('…'));
    await until(() => Boolean(delayed));
    await page.evaluate(() => PiWorkspaceRoute.navigate('chat')); assert.equal(await page.locator('#artifacts-detail').evaluate(n => n.open), false);
    await delayed.fulfill({ json: data[0] }).catch(() => {}); hold = false;
    await page.locator('#pi-input').fill('retained draft');
    if (width < 681) { await page.locator('#workspace-more-toggle').click(); await page.locator('[data-more-tab="artifacts"]').click(); }
    else await page.locator('.nav-btn[data-tab="artifacts"]').click();
    await card('Research report').waitFor();
    await page.evaluate(() => PiWorkspaceRoute.navigate('media'));
    await page.locator('#media-tab.active').waitFor();
    assert.equal(await page.locator('#media-tab').evaluate(n => n.classList.contains('active')), true);
    await page.locator('#lab-open-artifacts').click(); await card('Research report').waitFor();
    await page.goBack(); await page.locator('#media-tab.active').waitFor();
    await page.goForward(); await card('Research report').waitFor();
    await card('Research report').click(); await page.locator('#artifacts-preview-body h1').waitFor();
    await page.locator('.artifacts-detail-actions [aria-haspopup=menu]').click();
    await page.locator('.artifacts-menu-item[data-action=origin]').click();
    await page.locator('#chat-tab.active').waitFor(); assert.equal(await page.locator('#pi-input').inputValue(), 'retained draft');
    await openInspector(page, 'changes'); await page.locator('#pi-files-deliveries').click();
    await page.locator('.pi-deliveries-heading').getByRole('button', { name: locale === 'en' ? 'Artifacts' : '成果中心', exact: true }).click();
    await card('Research report').waitFor();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('cwd'), cwd);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('sessionId'), 'delivery');
    assert.equal(await page.locator('#pi-input').inputValue(), 'retained draft');
    partial = true; await page.evaluate(() => PiWorkspaceRoute.navigate('artifacts')); await page.locator('.artifacts-notice:not([hidden])').waitFor();
    listError = true; await page.locator('#artifacts-refresh').click(); await page.getByText('Fixture source unavailable', { exact: true }).waitFor();
    if (process.env.ARTIFACT_SCREENSHOT_DIR) { fs.mkdirSync(process.env.ARTIFACT_SCREENSHOT_DIR, { recursive: true }); listError = partial = false; await page.locator('#artifacts-refresh').click(); await card('Research report').waitFor(); await page.locator('#artifacts-tab').evaluate(n => { n.scrollTop = 0; }); await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `artifacts-${width}-${locale}.png`) }); }
    assert.deepEqual(network, []); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`artifacts: ${width}px ${locale} ${theme} passed`); await context.close();
}
async function widths(page) {
    await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.target?.matches('.artifacts-manage-dialog, #artifacts-detail')).every(a => a.playState === 'finished'));
    assert.deepEqual(await page.evaluate(() => ['body', '#artifacts-tab', '.artifacts-toolbar', '.artifacts-grid', '#artifacts-detail', '.artifacts-detail-actions'].filter(s => { const n = document.querySelector(s); if (!n || !n.clientWidth || n.scrollWidth <= n.clientWidth + 1) return false;
        // The phone filter scroller intentionally bleeds into the shell's 14px gutters.
        // Keep the toolbar check, but fail only if that bleed overflows the actual page.
        if (s === '.artifacts-toolbar') return n.getBoundingClientRect().right + n.scrollWidth - n.clientWidth > innerWidth + 1;
        return true; })), []);
    if (page.viewportSize().width < 680) assert.ok(await page.locator('#artifacts-search').evaluate(n => parseFloat(getComputedStyle(n).fontSize)) >= 16);
}
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } assert.ok(fn()); }
(async () => {
    const app = express();
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
    for (const directory of ['legacy/build', 'cmaps', 'standard_fonts', 'wasm']) app.use('/vendor/pdfjs/' + directory, express.static(path.join(root, 'node_modules/pdfjs-dist', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, locale, theme] of [[1440, 'zh-CN', 'daylight'], [1024, 'en', 'dark'], [393, 'zh-CN', 'dark'], [320, 'en', 'daylight']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale, theme); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
