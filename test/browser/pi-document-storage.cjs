const assert = require('node:assert/strict');
const path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
async function run(browser, base, width) {
    const context = await browser.newContext({ viewport: { width, height: 852 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], calls = [];
    page.on('pageerror', e => errors.push(e.message));
    const id = 'a'.repeat(64), ref = { id, revision: 'b'.repeat(64), name: '<img src=x onerror=alert(1)>'.repeat(6) + '.docx', format: 'docx', size: 2000, sessionId: 'source-thread' };
    let cleanupCount = 0, lose = false, deleted = false, failScan = false;
    const usage = cwd => ({ cwd, totalBytes: 4000, count: deleted ? 1 : 2, limits: { bytes: 2 * 1024 ** 3, count: 10000 }, complete: !failScan,
        warning: failScan ? '无法完整核对保存引用，暂不能清理附件' : null,
        items: deleted ? [] : [{ ...ref, name: cwd === '/fresh' ? 'fresh-project.docx' : ref.name, savedReference: failScan ? 'unverified' : 'not-found' },
            { ...ref, id: 'c'.repeat(64), name: 'saved.docx', savedReference: 'protected' }, ...Array.from({ length: 30 }, (_, i) => ({ ...ref, id: i.toString(16).padStart(64, '0'), name: `Saved ${i}.docx`, savedReference: 'protected' }))] });
    await page.route('**/api/pi/uploads/storage/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname.split('/').at(-1), body = req.postDataJSON(); calls.push({ endpoint, body });
        if (endpoint === 'usage') return route.fulfill({ json: usage(body.cwd) });
        if (endpoint === 'preview') return route.fulfill({ json: { ticket: 'preview-ticket', revision: 'preview-revision', item: ref } });
        if (endpoint === 'cleanup') {
            cleanupCount++; assert.equal(body.confirmed, true); assert.equal(body.ticket, 'preview-ticket'); assert.ok(body.requestId);
            assert.deepEqual(body.draftIds, ['d'.repeat(64)], 'fresh current-page drafts accompany final confirmation');
            deleted = true; if (lose) return route.abort(); return route.fulfill({ json: { state: 'deleted', id } });
        }
        if (endpoint === 'status') return route.fulfill({ json: { state: 'deleted', id } });
        throw new Error('Unexpected storage call ' + endpoint);
    });
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
        window.currentCwd = '/project'; window.drafts = []; window.deletedIds = [];
        window.manager = PiDocumentStorage.mount({
            getContext: () => ({ cwd: currentCwd }), getDraftIds: () => drafts,
            onDeleted: ids => deletedIds.push(...ids),
            request: async (endpoint, options) => {
                if (window.holdUsage && endpoint.endsWith('/usage')) return new Promise(resolve => { window.releaseHeldUsage = resolve; });
                const response = await fetch('/api/pi' + endpoint, { method: options.method, signal: options.signal,
                    headers: { 'Content-Type': 'application/json' }, body: options.body && JSON.stringify(options.body) });
                const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status }); return body;
            }
        }); manager.open();
    });
    const dialog = page.locator('.pi-document-storage'); await dialog.locator('[data-document-id]').first().waitFor();
    assert.equal(await dialog.locator('img').count(), 0, 'unsafe filenames render as text');
    assert.equal(await dialog.getByRole('button', { name: '预览清理', exact: true }).nth(1).isDisabled(), true);
    assert.equal(await dialog.locator('[data-storage-content]').evaluate(n => n.scrollHeight > n.clientHeight), true, 'list scrolls internally');
    const measure = async () => {
        const result = await dialog.evaluate(n => ({ width: n.getBoundingClientRect().width, scroll: n.scrollWidth, client: n.clientWidth,
            overflow: [...n.querySelectorAll('*')].filter(c => c.clientWidth && c.scrollWidth > c.clientWidth + 1).map(c => c.tagName),
            smallInputs: [...n.querySelectorAll('button,input')].filter(c => parseFloat(getComputedStyle(c).fontSize) < 16).length }));
        assert.ok(result.width <= width, JSON.stringify(result)); assert.ok(result.scroll <= result.client + 1, JSON.stringify(result)); assert.deepEqual(result.overflow, []); assert.equal(result.smallInputs, 0);
        assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
    };
    await measure();
    await dialog.getByRole('button', { name: '预览清理', exact: true }).first().click();
    await dialog.getByRole('checkbox').waitFor(); assert.equal(await dialog.getByRole('button', { name: '永久删除原件' }).isDisabled(), true); await measure();
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.locator('[data-document-id]').first().waitFor(); assert.equal(cleanupCount, 0);
    // A late, uncancellable read from another project must never replace the
    // current project, even when the host callback ignores AbortSignal.
    await page.evaluate(() => { holdUsage = true; manager.open('/late'); });
    await page.waitForFunction(() => Boolean(window.releaseHeldUsage));
    await page.evaluate(() => { holdUsage = false; manager.open('/fresh'); });
    await dialog.getByText('fresh-project.docx', { exact: true }).waitFor();
    await page.evaluate(data => releaseHeldUsage(data), usage('/late'));
    assert.equal(await dialog.getByText('fresh-project.docx', { exact: true }).count(), 1);
    assert.equal(await dialog.getByText(ref.name, { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: '预览清理', exact: true }).first().click(); await dialog.getByRole('checkbox').waitFor();
    await dialog.getByRole('checkbox').check(); await page.evaluate(() => { drafts = ['d'.repeat(64)]; }); lose = true;
    // Dispatch duplicate clicks synchronously: only one irreversible request.
    await dialog.getByRole('button', { name: '永久删除原件' }).evaluate(n => { n.click(); n.click(); });
    await dialog.getByRole('button', { name: '查询清理结果', exact: true }).waitFor(); assert.equal(cleanupCount, 1);
    await dialog.getByRole('button', { name: '查询清理结果', exact: true }).click();
    await dialog.getByText('当前项目没有办公附件。', { exact: true }).waitFor(); assert.equal(cleanupCount, 1); assert.deepEqual(await page.evaluate(() => deletedIds), [id]);
    assert.equal(calls.filter(c => c.endpoint === 'status').length, 1);
    failScan = true; deleted = false;
    await dialog.getByRole('button', { name: '刷新用量', exact: true }).click(); await dialog.getByText('无法完整核对保存引用，暂不能清理附件', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '预览清理', exact: true }).first().isDisabled(), true);
    await measure(); assert.deepEqual(errors, []);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); assert.equal(await dialog.isVisible(), false);
    console.log(`attachment storage ${width}: confirmation/cancel, protected/incomplete, duplicate click, lost response/status, late project read, safe DOM, inner scroll and 16px controls passed`);
    await context.close();
}
(async () => {
    const app = express();
    app.get('/', (req, res) => res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Storage fixture</title><script src="/pi-document-storage.js"></script>'));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 393, 320]) await run(browser, `http://127.0.0.1:${server.address().port}`, width); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
