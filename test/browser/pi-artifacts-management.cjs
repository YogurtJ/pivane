const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const express = require('express'), { once } = require('node:events'), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), key = n => n.toString(16).padStart(64, '0'), cwd = '/projects/library-fixture';
const source = { key: key(1), source: 'delivery', title: 'Delivered bundle', project: { key: 'project', name: 'Demo' }, origin: { sessionId: 'source-session' }, createdAt: '2026-10-08T01:00:00.000Z', saved: true,
 types: ['document', 'web'], files: [{ key: key(1), name: 'report.md', kind: 'document', size: 9 }, { key: key(2), name: 'site.html', kind: 'web', size: 20 }] };
async function run(browser, base, width, locale, theme) {
 const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 1000 }, locale, hasTouch: width < 900 });
 const page = await context.newPage(), errors = [], writes = [];
 let saved = [], collections = [], sourceDeleted = false, revision = 0, loseReply = false, failFavorite = false;
 const outcomes = new Map();
 page.on('pageerror', e => errors.push(e.message));
 await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, r => r.abort());
 await page.addInitScript(({ cwd, theme }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.workspace.theme', theme); }, { cwd, theme });
 await page.route('**/api/**', async route => {
  const req = route.request(), u = new URL(req.url());
  if (u.pathname === '/api/pi/artifacts/batch') {
   assert.equal(req.method(), 'POST'); const input = req.postDataJSON(); writes.push(input); assert.ok(!outcomes.has(input.requestId));
   let result;
   if (input.action === 'collection-create') { collections.push({ id: key(88 + collections.length), name: input.name }); result = { results: [], collections }; }
   else {
    const results = [];
    for (const f of input.files) {
     if (input.action === 'favorite' && failFavorite) { results.push({ ok: false, key: f.key, code: 'ARTIFACT_CONFLICT', error: 'Fixture stale revision' }); continue; }
     let item = saved.find(i => i.key === f.key || i.sourceKey === f.key);
     if (!item) { const file = source.files.find(sf => sf.key === f.key); item = { ...source, key: key(100 + parseInt(f.key, 16)), sourceKey: f.key, source: 'library', title: file.name, files: [{ ...file, key: key(100 + parseInt(f.key, 16)) }], types: [file.kind], independent: true, favorite: false, collections: [], revision: 1, hiddenAt: null, trashedAt: null }; saved.push(item); }
     if (input.action === 'favorite') item.favorite = input.favorite;
     if (input.action === 'rename') { item.title = input.name; item.files[0].name = input.name; }
     if (input.action === 'collection-add') item.collections = [input.collectionId];
     if (input.action === 'project') item.project = input.cwd ? { key: 'project', name: 'Demo' } : null;
     if (input.action === 'trash') { assert.equal(input.confirmed, true); item.trashedAt = new Date().toISOString(); }
     if (input.action === 'restore') item.trashedAt = null;
     if (input.action === 'purge') { assert.equal(input.confirmed, true); assert.ok(item.trashedAt); assert.equal(f.revision, item.revision); saved = saved.filter(i => i !== item); results.push({ ok: true, key: f.key, deleted: true }); continue; }
     if (input.action === 'hide') item.hiddenAt = new Date().toISOString();
     if (input.action === 'unhide') item.hiddenAt = null;
     item.revision++; results.push({ ok: true, key: f.key, item });
    }
    result = { requestId: input.requestId, results };
   }
   revision++; outcomes.set(input.requestId, result);
   if (loseReply) { loseReply = false; return route.abort(); }
   return route.fulfill({ json: result });
  }
  if (u.pathname.startsWith('/api/pi/artifacts/operations/')) return route.fulfill({ json: outcomes.get(u.pathname.split('/').at(-1)) });
  if (u.pathname === '/api/pi/artifacts/library') return route.fulfill({ json: { items: saved, collections, revision, nextOffset: null, projects: [{ key: 'project', name: 'Demo', cwd }] } });
  if (u.pathname === '/api/pi/artifacts') return route.fulfill({ json: { items: sourceDeleted ? [] : [source], projects: [{ key: 'project', name: 'Demo', cwd }], snapshot: 'fixture', nextOffset: null, coverage: {} } });
  if (u.pathname.endsWith('/location')) return route.fulfill({ json: { independent: true, storagePath: '/private/artifacts/immutable.bin', sourcePath: cwd + '/report.md', originalName: 'report.md' } });
  if (u.pathname.endsWith('/origin')) return route.fulfill({ status: 404, json: { error: 'Source removed; saved artifact preserved' } });
  if (/\/artifacts\/.*\/preview$/.test(u.pathname)) return route.fulfill({ json: { kind: 'markdown', mime: 'text/plain', encoding: 'utf8', content: '# Durable', size: 9, revision: key(99) } });
  if (u.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, artifacts: true, fileBrowser: true, fileViewer: true, filePreviews: true } });
  if (u.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Demo', sessionCount: 0 }], roots: ['/projects'] } });
  if (u.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
  if (u.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
  return route.fulfill({ json: {} });
 });
 await page.goto(base + '/#/artifacts', { waitUntil: 'domcontentloaded' });
 await page.locator('.artifacts-views [data-view="saved"][aria-current]').waitFor();
 assert.equal(await page.locator('.artifacts-card').count(), 0);
 await page.locator('.artifacts-views [data-view="all"]').click(); await page.locator('.artifacts-card').waitFor();
 const confirm = () => page.locator('.artifacts-manage-dialog button[type="submit"]').click();
 await page.locator('#artifacts-select').click();
 assert.equal(await page.locator('#artifacts-batchbar [data-action]:visible').count(), 0, 'no disabled action wall');
 await page.locator('.artifacts-file-choices input').first().check();
 assert.equal(await page.locator('#artifacts-batchbar [data-action]:visible').count(), 3);
 await page.locator('#artifacts-batchbar [data-action="favorite"]').click();
 await page.waitForFunction(() => document.querySelector('#artifacts-batchbar strong').textContent.includes('0'));
 assert.equal(saved.length, 1); assert.equal(saved[0].sourceKey, key(1)); assert.equal(saved[0].favorite, true);
 await page.locator('.artifacts-views [data-view="favorite"]').click(); assert.equal(await page.locator('.artifacts-card').count(), 1);
 await page.locator('.artifacts-filters summary').click(); await page.locator('.artifacts-collection-tools button').first().click();
 await page.locator('.artifacts-manage-dialog input').fill('Useful'); await confirm();
 await page.waitForFunction(() => document.querySelector('#artifacts-collection').options.length === 2);
 await page.locator('.artifacts-filters').evaluate(n => { n.open = false; }); await page.locator('#artifacts-select').click();
 await page.locator('.artifacts-file-choices input').check(); await page.locator('#artifacts-batchbar [data-action="collection-add"]').click(); await confirm();
 await page.waitForFunction(() => document.querySelector('#artifacts-batchbar strong').textContent.includes('0'));
 assert.equal(saved[0].collections[0], key(88));
 await page.locator('#artifacts-select').click(); await page.locator('.artifacts-card').click(); await page.locator('#artifacts-preview-body h1').waitFor();
 await page.locator('.artifacts-detail-management summary').click(); await page.locator('.artifacts-detail-actions [data-action="rename"]').click(); await page.locator('.artifacts-manage-dialog input').fill('Kept report.md'); await confirm();
 await page.waitForFunction(() => document.querySelector('.artifacts-card h2').textContent === 'Kept report.md');
 await page.keyboard.press('Escape');
 if (process.env.ARTIFACT_SCREENSHOT_DIR) {
  fs.mkdirSync(process.env.ARTIFACT_SCREENSHOT_DIR, { recursive: true });
  await page.locator('.artifacts-card').click(); await page.locator('#artifacts-preview-body h1').waitFor();
  await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `library-detail-${width}-${locale}.png`) }); await page.keyboard.press('Escape');
 }
 sourceDeleted = true; await page.locator('#artifacts-refresh').click(); await page.locator('.artifacts-card h2').filter({ hasText: 'Kept report.md' }).waitFor();
 await page.locator('.artifacts-card').click(); await page.locator('#artifacts-preview-body h1').waitFor();
 await page.locator('.artifacts-detail-management summary').click(); await page.locator('.artifacts-detail-actions [data-action="location"]').click(); await page.locator('.artifacts-manage-dialog').waitFor();
 assert.ok((await page.locator('.artifacts-manage-dialog p').textContent()).includes('/private/artifacts/immutable.bin')); await confirm(); await page.keyboard.press('Escape');
 await page.locator('#artifacts-select').click(); await page.locator('.artifacts-file-choices input').check();
 loseReply = true; const writesBefore = writes.length;
 await page.locator('#artifacts-batchbar [data-action="trash"]').click(); await page.locator('.artifacts-manage-dialog').waitFor(); await confirm();
 await page.waitForFunction(() => document.querySelector('#artifacts-batchbar strong').textContent.includes('0'));
 assert.equal(writes.length, writesBefore + 1, 'lost POST reconciled without replay'); assert.ok(saved[0].trashedAt);
 await page.locator('.artifacts-views [data-view="trash"]').click(); assert.equal(await page.locator('.artifacts-card').count(), 1);
 await page.locator('#artifacts-select').click(); await page.locator('.artifacts-file-choices input').check(); await page.locator('#artifacts-batchbar [data-action="restore"]').click();
 await page.waitForFunction(() => document.querySelector('#artifacts-batchbar strong').textContent.includes('0'));
 assert.equal(saved[0].trashedAt, null); await page.locator('.artifacts-views [data-view="saved"]').click();
 assert.deepEqual(await page.evaluate(() => ['body', '#artifacts-tab', '.artifacts-toolbar', '.artifacts-grid', '.artifacts-batchbar'].filter(s => { const n = document.querySelector(s); return n && n.clientWidth && n.scrollWidth > n.clientWidth + 1; })), []);
 assert.deepEqual(errors, []);
 if (process.env.ARTIFACT_SCREENSHOT_DIR) {
  fs.mkdirSync(process.env.ARTIFACT_SCREENSHOT_DIR, { recursive: true }); await page.locator('#artifacts-tab').evaluate(n => { n.scrollTop = 0; });
  await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `library-${width}-${locale}.png`) });
 }
 await page.locator('#artifacts-select').click(); await page.locator('.artifacts-file-choices input').check();
 assert.equal(await page.locator('#artifacts-select').count(), 1, 'one selection toggle, not duplicated rows');
 assert.equal(await page.locator('#artifacts-batchbar [data-action]:visible').count(), 3);
 assert.deepEqual(await page.evaluate(() => ['#artifacts-tab', '.artifacts-toolbar', '.artifacts-batchbar', '.artifacts-batch-actions'].filter(s => { const n = document.querySelector(s); return n && n.clientWidth && n.scrollWidth > n.clientWidth + 1; })), []);
 if (process.env.ARTIFACT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `library-selection-${width}-${locale}.png`) });
 failFavorite = true; await page.locator('#artifacts-batchbar [data-action="favorite"]').click();
 await page.getByText(/Fixture stale revision/).waitFor(); assert.equal(await page.locator('.artifacts-file-choices input:checked').count(), 1, 'failed items remain selected'); failFavorite = false;
 await page.locator('.artifacts-batch-more summary').click(); await page.locator('#artifacts-batchbar [data-action="export"]').click();
 assert.ok((await page.locator('.artifacts-manage-dialog p').textContent()).includes(locale === 'en' ? 'server running Pivane' : '运行 Pivane 的服务器')); await page.keyboard.press('Escape');
 await page.locator('#artifacts-batchbar [data-action="trash"]').click(); await confirm();
 await page.waitForFunction(() => document.querySelector('#artifacts-batchbar strong').textContent.includes('0'));
 await page.locator('.artifacts-views [data-view="trash"]').click(); await page.locator('.artifacts-card').click();
 assert.equal(await page.locator('#artifacts-preview-body h1').count(), 0, 'trash detail does not attempt a denied preview');
 await page.locator('.artifacts-detail-actions [data-action="purge"]').click();
 assert.equal(await page.locator('.artifacts-manage-dialog button[type="submit"]').isDisabled(), true);
 await page.keyboard.press('Escape'); assert.equal(saved.length, 1, 'cancel never deletes');
 await page.locator('.artifacts-detail-actions [data-action="purge"]').click();
 await page.locator('.artifacts-manage-dialog input').fill(locale === 'en' ? 'DELETE' : '删除');
 if (process.env.ARTIFACT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `library-purge-${width}-${locale}.png`) });
 loseReply = true; const beforeDelete = writes.length; await confirm();
 await page.waitForFunction(() => !document.querySelector('#artifacts-detail').open); assert.equal(saved.length, 0); assert.equal(writes.length, beforeDelete + 1, 'permanent delete never replays a lost response');
 await page.locator('.artifacts-views [data-view="all"]').click(); sourceDeleted = false; await page.locator('#artifacts-refresh').click(); await page.locator('.artifacts-card').waitFor();
 await page.locator('#artifacts-select').click(); await page.locator('.artifacts-file-choices input').first().check();
 await page.locator('#artifacts-batchbar [data-action="collection-add"]').click(); await page.locator('.artifacts-manage-dialog select').selectOption('__new__'); await confirm();
 await page.locator('.artifacts-manage-dialog input').fill('Created inline'); await confirm();
 await page.waitForFunction(() => document.querySelector('#artifacts-batchbar strong').textContent.includes('0')); assert.equal(saved.length, 1); assert.ok(saved[0].collections.length);
 await page.keyboard.press('Escape'); assert.equal(await page.locator('#artifacts-select').getAttribute('aria-pressed'), 'false');
 if (process.env.ARTIFACT_SCREENSHOT_DIR) {
  const titles = locale === 'en' ? ['Research brief.md', 'Launch landing page.html', 'Interview notes.md', 'Product walkthrough.mp4', 'Campaign cover.png', 'Narration.wav'] : ['用户研究简报.md', '产品发布页.html', '访谈纪要.md', '功能演示.mp4', '活动封面.png', '旁白音频.wav'];
  saved = titles.map((name, index) => ({ ...saved[0], key: key(200 + index), sourceKey: key(300 + index), title: name, favorite: index < 2, origin: null, types: [['document'], ['web'], ['document'], ['video'], ['image'], ['audio']][index], files: [{ key: key(200 + index), name, kind: ['document', 'web', 'document', 'video', 'image', 'audio'][index], size: 1024 * (index + 1) }] }));
  await page.locator('.artifacts-views [data-view="saved"]').click(); await page.locator('#artifacts-refresh').click(); await page.locator('.artifacts-card').nth(5).waitFor(); await page.locator('#artifacts-tab').evaluate(n => { n.scrollTop = 0; });
  await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `polished-gallery-${width}-${locale}.png`) });
  await page.locator('#artifacts-select').click(); await page.locator('.artifacts-file-choices input').nth(0).check(); await page.locator('.artifacts-file-choices input').nth(1).check();
  await page.locator('#artifacts-tab').evaluate(n => { n.scrollTop = 0; }); await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `polished-batch-${width}-${locale}.png`) });
 }
 assert.deepEqual(errors, []);
 console.log(`artifact management ${width}px ${locale} ${theme}: per-file save/favorite, collection, rename, deleted origin, location, selection, trash/restore and uncertain-response no replay passed`);
 await context.close();
}
(async () => {
 const app = express(); for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
 app.use(express.static(path.join(root, 'public'))); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 try { for (const [width, locale, theme] of [[1440, 'zh-CN', 'daylight'], [1024, 'en', 'dark'], [393, 'zh-CN', 'dark'], [320, 'en', 'daylight']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale, theme); }
 finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
