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
const { pdf, wav } = require('../file-preview-fixtures.cjs');
const { representation } = require('../../server/pi-file-types');
const documents = [
    { name: '方案.md', kind: 'markdown', content: '\ufeff# 成果方案\r\n\n交付快照。\n', encoding: 'utf8', mime: 'text/plain; charset=utf-8' },
    { name: '截图.png', kind: 'image', base64: image.toString('base64'), encoding: 'base64', mime: 'image/png', width: 192, height: 192 },
    { name: 'prototype.html', kind: 'html', content: html, encoding: 'utf8', mime: 'text/plain; charset=utf-8' },
    { name: 'report.pdf', ...representation({ bytes: pdf() }, 'report.pdf') },
    { name: 'table.csv', ...representation({ bytes: Buffer.from('name,value\r\n"a,b","line1\nline2"\r\n"<img src=x onerror=alert(1)>",=1+1\r\n' + 'x,y\n'.repeat(100)) }, 'table.csv') },
    { name: 'drawing.svg', ...representation({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><script>parent.document.body.dataset.escaped="yes"</script><image href="https://invalid.test/svg-image"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject><rect width="100" height="80" fill="red"/><text x="5" y="40">SVG</text></svg>') }, 'drawing.svg') },
    { name: 'recording.wav', ...representation({ bytes: wav() }, 'recording.wav') },
    { name: 'broken.pdf', ...representation({ bytes: Buffer.from('%PDF-1.7\ninvalid') }, 'broken.pdf') }
];
async function run(browser, base, width, locale = 'zh-CN') {
    const t = (zh, en) => locale === 'en' ? en : zh;
    const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 1000 }, locale, deviceScaleFactor: 2, hasTouch: width < 900, acceptDownloads: true });
    const page = await context.newPage(), errors = [], network = [], writes = [], reads = [];
    let delayed, hold = false, active = 'delivery';
    const workerCount = { created: 0 };
    page.on('worker', () => workerCount.created++);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.text().startsWith('PDF preview:')) console.log(message.text()); });
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
        const messages = active === 'other' ? [] : [{ role: 'assistant', stopReason: 'stop', timestamp: 1, content: [{ type: 'text', text: `[方案](#pi-delivery=${id}/0) · [截图](#pi-delivery=${id}/1) · [网页](#pi-delivery=${id}/2) · [旧路径](/external/outputs/方案.md) · [PDF](#pi-delivery=${id}/3) · [CSV](#pi-delivery=${id}/4) · [SVG](#pi-delivery=${id}/5) · [音频](#pi-delivery=${id}/6) · [损坏PDF](#pi-delivery=${id}/7)` }] }];
        const data = cmd.type === 'open_session' ? { session: { id: active, cwd, name: active, messageCount: 1 }, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : cmd.type === 'get_messages' ? { messages } : cmd.type === 'get_state' ? state : {};
        ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input').fill('retained draft');
    const link = name => page.locator('#pi-transcript-content .assistant a').filter({ hasText: new RegExp('^' + name + '$') });
    await link('方案').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.equal(await page.locator('#pi-file-body h1').textContent(), '成果方案');
    assert.match(await page.locator('#pi-file-status').textContent(), /交付快照|Delivered snapshot/i);
    const readsBeforeReopen = reads.length;
    await page.locator('#pi-file-preview').click();
    await page.locator('#pi-close-inspector').click(); await openInspector(page, 'changes');
    assert.equal(await page.locator('#pi-file-body h1').count(), 0, 'reopen keeps the selected source view');
    assert.match(await page.locator('#pi-file-status').textContent(), /交付快照|Delivered snapshot/i);
    assert.equal(reads.length, readsBeforeReopen, 'reopen does not re-read delivery bytes');
    await page.locator('#pi-file-preview').click();
    const download = page.waitForEvent('download'); await page.locator('#pi-file-download').click();
    const d = await download; assert.equal(d.suggestedFilename(), '方案.md'); assert.equal(fs.readFileSync(await d.path(), 'utf8'), documents[0].content);
    await page.locator('#pi-close-inspector').click(); await link('截图').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body img')?.naturalWidth > 0);
    await page.locator('#pi-file-image-size').click(); assert.equal(await page.locator('.pi-file-image').evaluate(n => n.classList.contains('actual-size')), true);
    await page.locator('#pi-file-image-size').click();
    const imageReads = reads.length;
    await page.locator('#pi-file-body img').click({ timeout: 5000 }).catch(async error => {
        console.error('Image geometry', await page.evaluate(() => ['#pi-file-body', '.has-image-controls', '.pi-file-image-viewport', '.pi-file-image-viewport img'].map(s => { const n = document.querySelector(s), r = n.getBoundingClientRect(); return { s, x: r.x, y: r.y, w: r.width, h: r.height, css: n.getAttribute('style') }; })), errors); throw error;
    });
    await page.locator('#pi-file-fullscreen-dialog[open]').waitFor();
    await assertFullscreen(page);
    await page.getByRole('button', { name: t('放大图片', 'Zoom image in'), exact: true }).click();
    await page.locator('.pi-file-image-viewport').hover();
    const oldZoom = await page.locator('.has-image-controls .pi-file-preview-toolbar span').textContent();
    await page.mouse.wheel(0, -80);
    await page.waitForFunction(old => document.querySelector('.has-image-controls .pi-file-preview-toolbar span').textContent !== old, oldZoom);
    const scaled = await page.locator('.pi-file-image-viewport img').evaluate(n => n.getBoundingClientRect().width);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-file-fullscreen-dialog').evaluate(n => n.open), false);
    assert.ok(Math.abs(await page.locator('.pi-file-image-viewport img').evaluate(n => n.getBoundingClientRect().width) - scaled) < .1, 'image zoom survives return to sidebar within subpixel rounding');
    assert.equal(reads.length, imageReads, 'full-screen image reuses verified bytes');
    assert.equal(await page.locator('#pi-input').inputValue(), 'retained draft');
    assert.equal(await page.evaluate(() => document.querySelector('#pi-inspector').contains(document.activeElement)), true, 'focus returns to sidebar');
    await page.locator('#pi-file-fullscreen').click();
    await page.locator('.pi-file-image-viewport').focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press('+');
    const beforePan = await page.locator('.pi-file-image-viewport img').evaluate(n => n.style.transform);
    const rect = await page.locator('.pi-file-image-viewport').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 50, rect.y + rect.height / 2 + 40, { steps: 5 }); await page.mouse.up();
    assert.notEqual(await page.locator('.pi-file-image-viewport img').evaluate(n => n.style.transform), beforePan, 'drag pans zoomed image');
    if (width < 900) await pinch(context, page);
    await page.getByRole('button', { name: t('适应窗口', 'Fit window'), exact: true }).last().click();
    for (const theme of ['daylight', 'dark', 'slate']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await assertFullscreen(page);
    }
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-reading-${locale}-${width}-image.png`) });
    await page.getByRole('button', { name: t('返回侧栏', 'Back to sidebar'), exact: true }).click();
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
    await page.locator('#pi-close-inspector').click(); await link('PDF').click();
    await page.waitForFunction(() => document.querySelector('.pi-file-pdf-text pre')?.textContent.includes('Preview page one')).catch(async error => {
        console.error('PDF diagnostic', await page.locator('#pi-file-body').textContent(), errors); throw error;
    });
    assert.equal(await page.locator('.pi-file-pdf-paper canvas').evaluate(n => n.width * n.height <= 4 * 1024 * 1024 + 8192), true);
    await page.getByRole('button', { name: t('下一页', 'Next'), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pi-file-pdf-text pre')?.textContent.includes('Preview page two'));
    await page.getByRole('button', { name: t('放大', 'Zoom in'), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pi-file-pdf-text pre')?.textContent.includes('Preview page two'));
    const pdfReads = reads.length, pdfWorkers = workerCount.created;
    await page.locator('.pi-file-pdf-text summary').click();
    await page.locator('#pi-file-body').evaluate(n => { n.scrollTop = 100; });
    const sidebarCanvas = await page.locator('.pi-file-pdf-paper canvas').elementHandle();
    await page.locator('#pi-file-fullscreen').click();
    await assertFullscreen(page);
    await page.waitForFunction(() => document.querySelector('.pi-file-pdf-paper canvas')?.clientWidth > innerWidth - 80);
    assert.equal(await page.locator('.pi-file-pdf-text').evaluate(n => n.open), true);
    assert.equal(await page.getByRole('spinbutton', { name: t('页码', 'Page number') }).inputValue(), '2');
    assert.equal(await sidebarCanvas.evaluate(n => n === document.querySelector('.pi-file-pdf-paper canvas')), true, 'same live PDF canvas');
    assert.equal(workerCount.created, pdfWorkers, 'no second PDF worker');
    assert.equal(reads.length, pdfReads, 'no second PDF read');
    await page.setViewportSize({ width: width < 900 ? 1024 : 393, height: 768 });
    await assertFullscreen(page);
    assert.equal(await page.getByRole('spinbutton', { name: t('页码', 'Page number') }).inputValue(), '2');
    await page.setViewportSize({ width, height: width < 900 ? 852 : 1000 });
    await assertFullscreen(page);
    await page.locator('#pi-file-info > summary').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pi-file-fullscreen-dialog').evaluate(n => n.open), true, 'Escape closes metadata before full-screen');
    assert.equal(await page.locator('#pi-file-info').evaluate(n => n.open), false);
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-reading-${locale}-${width}-pdf.png`) });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#pi-file-fullscreen-dialog').open && document.querySelector('.pi-file-pdf-text pre')?.textContent.includes('Preview page two'));
    assert.equal(await page.getByRole('spinbutton', { name: t('页码', 'Page number') }).inputValue(), '2');
    assert.equal(workerCount.created, pdfWorkers);
    await checkWidth(page);
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-previews-${width}-pdf.png`) });
    await page.locator('#pi-close-inspector').click();
    await page.waitForFunction(() => document.querySelector('.pi-file-pdf-paper canvas')?.width === 0);
    await openInspector(page, 'changes');
    await page.waitForFunction(() => document.querySelector('.pi-file-pdf-text pre')?.textContent.includes('Preview page two'));
    await page.locator('#pi-close-inspector').click(); await link('CSV').click();
    await page.locator('.pi-file-data-table').waitFor();
    assert.equal(await page.locator('.pi-file-data-table tr').count(), 50);
    assert.match(await page.locator('.pi-file-data-table').textContent(), /a,b.*line1\nline2/);
    assert.equal(await page.locator('.pi-file-data-table img').count(), 0);
    await page.getByRole('button', { name: t('下一页', 'Next'), exact: true }).click();
    assert.equal(await page.locator('.pi-file-data-table th').first().textContent(), '51');
    await page.locator('#pi-file-fullscreen').click(); await assertFullscreen(page);
    assert.equal(await page.locator('.pi-file-data-table th').first().textContent(), '51');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.pi-file-data-table th').first().textContent(), '51');
    await page.locator('#pi-file-preview').click(); assert.match(await page.locator('#pi-file-body').textContent(), /"a,b"/);
    await page.locator('#pi-file-preview').click(); await checkWidth(page);
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-previews-${width}-csv.png`) });
    await page.locator('#pi-close-inspector').click(); await link('SVG').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body img')?.naturalWidth === 100);
    const cleanedSvg = await page.locator('#pi-file-body img').evaluate(async n => (await fetch(n.src)).text());
    assert.doesNotMatch(cleanedSvg, /script|foreignObject|invalid\.test|<image/i);
    assert.equal(await page.evaluate(() => document.body.dataset.escaped), undefined); await checkWidth(page);
    await page.locator('#pi-close-inspector').click(); await link('音频').click();
    await page.waitForFunction(() => document.querySelector('.pi-file-audio')?.readyState >= 1);
    assert.equal(await page.locator('.pi-file-audio').evaluate(n => n.paused), true);
    await page.locator('.pi-file-audio').evaluate(n => n.play());
    await page.locator('#pi-close-inspector').click();
    await page.waitForFunction(() => { const a = document.querySelector('.pi-file-audio'); return a?.paused && !a.getAttribute('src'); });
    await link('损坏PDF').click();
    await page.getByText(t('PDF 无法预览，可下载原文件', 'PDF cannot be previewed; download the original'), { exact: true }).waitFor();
    await page.locator('#pi-files-deliveries').click(); await page.locator('.pi-delivery-card').first().waitFor();
    assert.equal(await page.locator('.pi-delivery-card').count(), documents.length); await checkWidth(page);
    const listReads = reads.length;
    await page.locator('#pi-close-inspector').click(); await openInspector(page, 'changes');
    assert.equal(await page.locator('#pi-deliveries-list').isVisible(), true);
    assert.equal(reads.length, listReads, 'reopen keeps the list instead of refreshing');
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-deliveries-${width}-list.png`) });
    await page.locator('#pi-close-inspector').click(); await link('旧路径').click(); await page.locator('#pi-file-body h1').waitFor();
    assert.match(await page.locator('#pi-file-status').textContent(), /交付快照|Delivered snapshot/i);
    await page.locator('#pi-files-project').click(); await page.locator('[data-path="local.png"]').click();
    await page.waitForFunction(() => document.querySelector('#pi-file-body img')?.naturalWidth > 0);
    assert.match(await page.locator('#pi-file-status').textContent(), /当前文件快照|Current file snapshot/i);
    await page.locator('#pi-close-inspector').click(); await openInspector(page, 'changes');
    await page.waitForFunction(() => document.querySelector('#pi-file-body img')?.naturalWidth > 0);
    await page.locator('#pi-file-body img').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-file-body img').isVisible(), true, 'reopen keeps the project reader');
    await page.locator('#pi-file-fullscreen').click();
    await page.locator('[data-session-id="other"] .pi-session-main').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
    assert.equal(await page.locator('#pi-file-fullscreen-dialog').evaluate(n => n.open), false, 'context reset closes modal');
    assert.equal(await page.locator('#pi-file-body').textContent(), '');
    await page.locator('[data-session-id="delivery"] .pi-session-main').dispatchEvent('click');
    await link('网页').waitFor();
    await page.locator('#pi-close-inspector').click(); hold = true; await link('网页').click();
    await until(() => delayed);
    await page.locator('#pi-close-inspector').click();
    if (width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="other"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
    await delayed.fulfill({ json: result(2) }).catch(() => {});
    assert.equal(await page.locator('#pi-file-body').textContent(), ''); assert.equal(await page.locator('.pi-file-html').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(writes, []);
    console.log(`PASS deliveries ${locale} ${width}: full-screen, image pan/zoom, PDF state/worker reuse, table position, links/downloads/sandbox, late thread`);
    await context.close();
}
async function assertFullscreen(page) {
    const metrics = await page.locator('#pi-file-fullscreen-dialog').evaluate(n => {
        const r = n.getBoundingClientRect(); return { open: n.open, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight, overflow: n.scrollWidth > n.clientWidth + 1 };
    });
    assert.equal(metrics.open, true); assert.ok(Math.abs(metrics.width - metrics.vw) <= 1); assert.ok(Math.abs(metrics.height - metrics.vh) <= 1); assert.equal(metrics.overflow, false);
    assert.equal(await page.locator('#pi-file-reader').count(), 1);
    for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.querySelector('#pi-file-fullscreen-dialog').contains(document.activeElement)), true, 'focus stays in modal');
    }
}
async function pinch(context, page) {
    const client = await context.newCDPSession(page), rect = await page.locator('.pi-file-image-viewport').boundingBox();
    const old = await page.locator('.has-image-controls .pi-file-preview-toolbar span').textContent();
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }] });
    for (const spread of [50, 40, 30, 25]) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.notEqual(await page.locator('.has-image-controls .pi-file-preview-toolbar span').textContent(), old, 'two-finger pinch changes zoom');
    await client.detach();
}
async function checkWidth(page) {
    assert.deepEqual(await page.evaluate(() => ['body', '#pi-inspector', '#pi-changes', '#pi-file-viewer', '#pi-files-toolbar', '.pi-file-actions'].filter(s => { const n = document.querySelector(s); return n && n.clientWidth && n.scrollWidth > n.clientWidth + 1; })), []);
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 30)); } assert.ok(predicate()); }
(async () => {
    const app = express();
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
    for (const directory of ['legacy/build', 'cmaps', 'standard_fonts', 'wasm']) app.use('/vendor/pdfjs/' + directory, express.static(path.join(root, 'node_modules/pdfjs-dist', directory)));
    app.use(express.static(path.join(process.env.PI_PREVIEW_ASSET_ROOT || root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const locale of ['zh-CN', 'en']) for (const width of [1440, 1024, 393, 320]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
