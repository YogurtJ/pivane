const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const express = require('express'), { once } = require('node:events');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/projects/delivery-fixture';
const id = 'a'.repeat(64), model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
// Use the existing brand PNG as a known browser-decodable fixture.
const image = fs.readFileSync(path.join(root, 'public/brand/logo-192.png'));
const html = '<!doctype html><html><head><style>body{font:18px sans-serif}button{padding:15px}</style></head><body><h1>Preview</h1><img src="https://invalid.test/remote-image"><iframe src="https://invalid.test/frame"></iframe><meta http-equiv="refresh" content="0;url=https://invalid.test/refresh"><button id="counter" onclick="this.textContent=\'Clicked\'">Click</button><script>try{parent.document.body.dataset.escaped="yes"}catch{};try{localStorage.setItem("escaped","yes")}catch{};fetch("https://invalid.test/leak").catch(()=>{});</script></body></html>';
const documents = [
    { name: '方案.md', kind: 'markdown', content: '\ufeff# 成果方案\r\n\n交付快照。\n', encoding: 'utf8', mime: 'text/plain; charset=utf-8' },
    { name: '截图.png', kind: 'image', base64: image.toString('base64'), encoding: 'base64', mime: 'image/png', width: 192, height: 192 },
    { name: 'prototype.html', kind: 'html', content: html, encoding: 'utf8', mime: 'text/plain; charset=utf-8' }
];
async function run(browser, base, width) {
    const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 1000 }, locale: 'zh-CN', acceptDownloads: true });
    const page = await context.newPage(), errors = [], network = [], writes = [], reads = [];
    let delayed, hold = false, active = 'delivery';
    page.on('pageerror', e => errors.push(e.message));
    // Playwright reports CSP-blocked image attempts as request events too. A
    // route is reached only if the browser actually tries network transport.
    await page.route('https://invalid.test/**', route => { network.push(route.request().url()); return route.abort(); });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, r => r.abort());
    await page.addInitScript(({ cwd }) => { if (window !== window.top) return; localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'delivery'); }, { cwd });
    const result = index => ({ ...documents[index], path: documents[index].name, absolutePath: '/external/outputs/' + documents[index].name,
        source: 'delivery', deliveryId: id, index, title: '设计成果', createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(), readAt: new Date().toISOString(), revision: 'b'.repeat(64), size: 100 });
    await page.route('**/api/**', async route => {
        const req = route.request(), u = new URL(req.url());
        if (req.method() !== 'GET') { writes.push(u.pathname); return route.fulfill({ json: {} }); }
        if (u.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, fileViewer: true, fileBrowser: true, filePreviews: true, deliverables: true, projectRoots: ['/projects'] } });
        if (u.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/projects'] } });
        if (u.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: ['delivery', 'other'].map(id => ({ id, cwd, name: id, messageCount: 1 })) } });
        if (u.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (u.pathname === '/api/pi/deliverables') {
            assert.equal(u.searchParams.get('sessionId'), active); reads.push(u.search);
            if (u.searchParams.has('id')) {
                if (hold) { delayed = route; return; }
                return route.fulfill({ json: result(Number(u.searchParams.get('index'))) });
            }
            const alias = u.searchParams.get('path');
            return route.fulfill({ json: { items: active === 'other' ? [] : documents.map((d, index) => ({ id, index, name: d.name, title: '设计成果', size: 100 })).filter(d => !alias || alias.endsWith(d.name)), partial: false } });
        }
        if (u.pathname === '/api/pi/files/list') return route.fulfill({ json: { cwd, path: '', entries: [{ name: 'local.png', path: 'local.png', kind: 'file' }], partial: false } });
        if (u.pathname === '/api/pi/files/preview') return route.fulfill({ json: { ...result(1), deliveryId: undefined, source: undefined, path: 'local.png' } });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw); if (cmd.type === 'open_session') active = cmd.sessionId;
        const state = { model, thinkingLevel: 'off', isStreaming: false };
        const messages = active === 'other' ? [] : [{ role: 'assistant', stopReason: 'stop', timestamp: 1, content: [{ type: 'text', text: `[方案](#pi-delivery=${id}/0) · [截图](#pi-delivery=${id}/1) · [网页](#pi-delivery=${id}/2) · [旧路径](/external/outputs/方案.md)` }] }];
        const data = cmd.type === 'open_session' ? { session: { id: active, cwd, name: active, messageCount: 1 }, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : cmd.type === 'get_messages' ? { messages } : cmd.type === 'get_state' ? state : {};
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const link = name => page.locator('#pi-transcript-content .assistant a').filter({ hasText: new RegExp('^' + name + '$') });
    await link('方案').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.equal(await page.locator('#pi-file-body h1').textContent(), '成果方案');
    assert.match(await page.locator('#pi-file-status').textContent(), /交付快照/);
    const readsBeforeReopen = reads.length;
    await page.locator('#pi-file-preview').click();
    await page.locator('#pi-close-inspector').click(); await openInspector(page, 'changes');
    assert.equal(await page.locator('#pi-file-body h1').count(), 0, 'reopen keeps the selected source view');
    assert.match(await page.locator('#pi-file-status').textContent(), /交付快照/);
    assert.equal(reads.length, readsBeforeReopen, 'reopen does not re-read delivery bytes');
    await page.locator('#pi-file-preview').click();
    const download = page.waitForEvent('download'); await page.locator('#pi-file-download').click();
    const d = await download; assert.equal(d.suggestedFilename(), '方案.md'); assert.equal(fs.readFileSync(await d.path(), 'utf8'), documents[0].content);
    await page.locator('#pi-close-inspector').click(); await link('截图').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body img')?.naturalWidth > 0);
    await page.locator('#pi-file-image-size').click(); assert.equal(await page.locator('.pi-file-image').evaluate(n => n.classList.contains('actual-size')), true);
    await page.locator('#pi-file-image-size').click();
    for (const theme of ['daylight', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await checkWidth(page); }
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-deliveries-${width}-image.png`) });
    await page.locator('#pi-close-inspector').click(); await link('网页').click();
    await page.locator('.pi-file-html').waitFor();
    const frame = page.frameLocator('.pi-file-html'); await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').textContent(), 'Click', 'scripts disabled until explicit action');
    await page.locator('#pi-file-run-html').click(); await frame.locator('#counter').click();
    assert.equal(await frame.locator('#counter').textContent(), 'Clicked');
    assert.equal(await page.evaluate(() => document.body.dataset.escaped), undefined);
    assert.equal(await page.evaluate(() => localStorage.getItem('escaped')), null);
    assert.equal(await page.locator('.pi-file-html').getAttribute('sandbox'), 'allow-scripts');
    await page.locator('#pi-close-inspector').click();
    await page.waitForFunction(() => document.querySelector('.pi-file-html')?.getAttribute('sandbox') === '');
    await link('网页').click(); await page.locator('.pi-file-html').waitFor();
    await page.locator('#pi-file-preview').click(); assert.match(await page.locator('#pi-file-body').textContent(), /<!doctype html>/);
    assert.equal(await page.locator('.pi-file-html').count(), 0); await checkWidth(page);
    await page.locator('#pi-files-deliveries').click(); await page.locator('.pi-delivery-card').first().waitFor();
    assert.equal(await page.locator('.pi-delivery-card').count(), 3); await checkWidth(page);
    const listReads = reads.length;
    await page.locator('#pi-close-inspector').click(); await openInspector(page, 'changes');
    assert.equal(await page.locator('#pi-deliveries-list').isVisible(), true);
    assert.equal(reads.length, listReads, 'reopen keeps the list instead of refreshing');
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-deliveries-${width}-list.png`) });
    await page.locator('#pi-close-inspector').click(); await link('旧路径').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.match(await page.locator('#pi-file-status').textContent(), /交付快照/);
    await page.locator('#pi-files-project').click(); await page.locator('[data-path="local.png"]').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body img')?.naturalWidth > 0);
    assert.match(await page.locator('#pi-file-status').textContent(), /当前文件快照/);
    await page.locator('#pi-close-inspector').click(); await openInspector(page, 'changes');
    assert.equal(await page.locator('#pi-file-body img').isVisible(), true, 'reopen keeps the project reader');
    await page.locator('#pi-close-inspector').click(); hold = true; await link('网页').click();
    await until(() => delayed);
    await page.locator('#pi-close-inspector').click();
    if (width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="other"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
    await delayed.fulfill({ json: result(2) }).catch(() => {});
    assert.equal(await page.locator('#pi-file-body').textContent(), ''); assert.equal(await page.locator('.pi-file-html').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(writes, []);
    console.log(`PASS deliveries ${width}: links, immutable source, exact download, image, HTML opt-in/sandbox, alias, list, project preview, late thread`);
    await context.close();
}
async function checkWidth(page) {
    assert.deepEqual(await page.evaluate(() => ['body', '#pi-inspector', '#pi-changes', '#pi-file-viewer', '#pi-files-toolbar', '.pi-file-actions'].filter(s => { const n = document.querySelector(s); return n && n.clientWidth && n.scrollWidth > n.clientWidth + 1; })), []);
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 30)); } assert.ok(predicate()); }
(async () => {
    const app = express();
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 1024, 393, 320]) await run(browser, `http://127.0.0.1:${server.address().port}`, width); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
