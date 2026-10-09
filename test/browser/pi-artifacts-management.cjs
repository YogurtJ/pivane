const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const express = require('express'), { once } = require('node:events'), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), key = n => n.toString(16).padStart(64, '0'), cwd = '/projects/library-fixture';
const source = { key: key(1), source: 'delivery', title: 'Delivered bundle', project: { key: 'project', name: 'Demo' }, origin: { sessionId: 'source-session' }, createdAt: '2026-10-08T01:00:00.000Z', saved: true,
 types: ['document', 'web'], files: [{ key: key(1), name: 'report.md', kind: 'document', size: 9 }, { key: key(2), name: 'site.html', kind: 'web', size: 20 }] };
async function run(browser, base, width, locale, theme) {
 const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 1000 }, locale, hasTouch: width < 900 });
 const page = await context.newPage(), errors = [], writes = [], reconciliations = [], previews = [];
 let saved = [], collections = [], sourceDeleted = false, revision = 0, loseReply = false, failFavorite = false, nextLibraryId = 101;
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
     if (input.action === 'favorite' && failFavorite === f.key) { results.push({ ok: false, key: f.key, code: 'ARTIFACT_CONFLICT', error: 'Fixture stale revision' }); continue; }
     let item = saved.find(i => i.key === f.key || i.sourceKey === f.key);
     if (input.action === 'purge') { assert.equal(input.confirmed, true); assert.ok(item, 'purge requires an existing library item'); assert.equal(f.key, item.key, 'purge requires the exact library ID'); assert.equal(f.revision, item.revision, 'purge requires the current revision'); saved = saved.filter(i => i !== item); results.push({ ok: true, key: f.key, deleted: true }); continue; }
     if (item) assert.equal(f.revision, item.revision, 'library mutations use current revisions');
     if (!item) { const libraryKey = key(nextLibraryId++); const file = source.files.find(sf => sf.key === f.key); item = { ...source, key: libraryKey, sourceKey: f.key, source: 'library', title: file.name, files: [{ ...file, key: libraryKey }], types: [file.kind], independent: true, favorite: false, collections: [], revision: 1, hiddenAt: null, trashedAt: null }; saved.push(item); }
     if (input.action === 'favorite') item.favorite = input.favorite;
     if (input.action === 'rename') { item.title = input.name; item.files[0].name = input.name; }
     if (input.action === 'collection-add') item.collections = [...new Set([...item.collections, input.collectionId])];
     if (input.action === 'collection-remove') item.collections = item.collections.filter(id => id !== input.collectionId);
     if (input.action === 'project') item.project = input.cwd ? { key: 'project', name: 'Demo' } : null;
     if (input.action === 'trash') { assert.equal(input.confirmed, true); item.trashedAt = new Date().toISOString(); }
     if (input.action === 'restore') item.trashedAt = null;
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
  if (u.pathname.startsWith('/api/pi/artifacts/operations/')) { assert.equal(req.method(), 'GET'); const id = u.pathname.split('/').at(-1); reconciliations.push(id); return route.fulfill({ json: outcomes.get(id) }); }
  if (u.pathname === '/api/pi/artifacts/library') return route.fulfill({ json: { items: saved, collections, revision, nextOffset: null, projects: [{ key: 'project', name: 'Demo', cwd }] } });
  if (u.pathname === '/api/pi/artifacts') return route.fulfill({ json: { items: sourceDeleted ? [] : [source], projects: [{ key: 'project', name: 'Demo', cwd }], snapshot: 'fixture', nextOffset: null, coverage: {} } });
  if (u.pathname.endsWith('/location')) return route.fulfill({ json: { independent: true, storagePath: '/private/artifacts/immutable.bin', sourcePath: cwd + '/report.md', originalName: 'report.md' } });
  if (u.pathname.endsWith('/origin')) return route.fulfill({ status: 404, json: { error: 'Source removed; saved artifact preserved' } });
  if (/\/artifacts\/.*\/preview$/.test(u.pathname)) { previews.push(u.pathname); return route.fulfill({ json: { kind: 'markdown', mime: 'text/plain', encoding: 'utf8', content: '# Durable', size: 9, revision: key(99) } }); }
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
 const dialog = () => page.locator('.artifacts-manage-dialog[open]');
 const confirm = () => dialog().locator('[data-dialog-action=ok]').click();
 const view = name => page.locator(`.artifacts-views [data-view="${name}"]`).click();
 const card = id => page.locator(`.artifacts-card[data-key="${id}"]`);
 const wrap = id => page.locator(`.artifacts-card-wrap[data-key="${id}"]`);
 const primary = action => page.locator(`#artifacts-batchbar .artifacts-bar-btn[data-action="${action}"]`).click();
 const menu = async action => { await page.locator('.artifacts-detail-actions [aria-haspopup=menu]').click(); await page.locator(`#artifacts-detail .artifacts-menu-item[data-action="${action}"]`).click(); };
 const more = async action => { await page.locator('.artifacts-batch-more > [aria-haspopup=menu]').click(); await page.locator(`#artifacts-batchbar .artifacts-menu-item[data-action="${action}"]`).click(); };
 const idle = () => page.waitForFunction(() => document.querySelector('#artifacts-select').getAttribute('aria-pressed') === 'false' && !document.querySelector('#artifacts-refresh').disabled);
 const selected = async id => { await page.locator('#artifacts-select').click(); await wrap(id).locator('.artifacts-check').click(); };
 const success = () => page.locator('.artifacts-toast[data-tone=success]:not(.is-leaving)').last();
 const toastAction = () => success().locator('.artifacts-toast-action');
 const screenshot = async name => { if (process.env.ARTIFACT_SCREENSHOT_DIR) { fs.mkdirSync(process.env.ARTIFACT_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.ARTIFACT_SCREENSHOT_DIR, `${name}-${width}-${locale}.png`) }); } };
 const deleteDialog = async trashed => {
  await dialog().locator('.artifacts-dialog-files li').waitFor();
  assert.equal(await dialog().evaluate(n => n.classList.contains('is-danger')), true);
  assert.equal(await dialog().locator('input').count(), 0, 'delete confirmation has no typed confirmation');
  assert.equal(await dialog().locator('[data-dialog-action=trash]').count(), trashed ? 0 : 1);
  assert.equal(await dialog().locator('[data-dialog-action=purge]').isDisabled(), false);
  await widths(page);
 };
 // The help panel stays inside the viewport, including next to the title on phones.
 await page.locator('.artifacts-help > summary').click();
 const help = await page.locator('.artifacts-help-panel').boundingBox();
 assert.ok(help.x >= 0 && help.x + help.width <= width + 1, `help panel inside viewport (${help.x}+${help.width} of ${width})`);
 await page.locator('.artifacts-help > summary').click();
 await page.locator('#artifacts-select').click();
 assert.equal(await page.locator('#artifacts-batchbar [data-action]:visible').count(), 0, 'no disabled action wall');
 await page.locator('.artifacts-file-chip[role=checkbox]').first().click();
 assert.equal(await page.locator('#artifacts-batchbar .artifacts-bar-btn[data-action]:visible').count(), 3);
 await primary('favorite'); await idle();
 assert.equal(saved.length, 1); assert.equal(saved[0].sourceKey, key(1)); assert.equal(saved[0].favorite, true);
 const kept = saved[0].key;
 await view('favorite'); assert.equal(await page.locator('.artifacts-card').count(), 1);
 await page.locator('#artifacts-collection').selectOption('__new__');
 await dialog().locator('input').fill('Useful'); await widths(page); await confirm();
 await page.waitForFunction(() => document.querySelector('#artifacts-collection').options.length === 3);
 await selected(kept); await primary('collection-add'); await confirm(); await idle();
 assert.equal(saved[0].collections[0], key(88));
 await card(kept).click(); await page.locator('#artifacts-preview-body h1').waitFor();
 // Collection removal raises a toast inside the drawer, and its Undo is clickable.
 let before = writes.length;
 await page.locator('#artifacts-detail .artifacts-detail-chips .artifacts-chip-remove').click();
 await page.locator('#artifacts-detail .artifacts-toast[data-tone=success] .artifacts-toast-action').last().waitFor();
 await page.waitForFunction(() => !document.querySelector('#artifacts-detail .artifacts-chip-remove'));
 assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).action, 'collection-remove'); assert.deepEqual(saved[0].collections, []);
 assert.equal(await success().evaluate(n => n.closest('dialog')?.open), true);
 await toastAction().click(); await page.locator('#artifacts-detail .artifacts-chip-remove').waitFor();
 assert.equal(writes.at(-1).action, 'collection-add'); assert.notEqual(writes.at(-1).requestId, writes.at(-2).requestId); assert.deepEqual(saved[0].collections, [key(88)]);
 await menu('rename'); await dialog().locator('input').fill('Kept report.md'); await confirm();
 await page.waitForFunction(() => document.querySelector('.artifacts-card h2').textContent === 'Kept report.md');
 await screenshot('library-detail'); await page.keyboard.press('Escape');
 sourceDeleted = true; await page.locator('#artifacts-refresh').click(); await page.locator('.artifacts-card h2').filter({ hasText: 'Kept report.md' }).waitFor();
 await card(kept).click(); await page.locator('#artifacts-preview-body h1').waitFor();
 await menu('location'); await dialog().locator('dl.artifacts-info-list').waitFor();
 assert.ok((await dialog().locator('dl').textContent()).includes('/private/artifacts/immutable.bin')); await confirm(); await page.keyboard.press('Escape');
 // The delete dialog's reversible choice, lost-response reconciliation, and explicit Undo.
 await selected(kept); await primary('delete'); await deleteDialog(false);
 loseReply = true; before = writes.length; const readsBefore = reconciliations.length;
 await dialog().locator('[data-dialog-action=trash]').click(); await idle();
 assert.equal(writes.length, before + 1, 'lost POST reconciled without replay'); assert.equal(writes.at(-1).action, 'trash'); assert.ok(saved[0].trashedAt);
 assert.deepEqual(reconciliations.slice(readsBefore), [writes.at(-1).requestId], 'one outcome GET, never another POST');
 const trashRequest = writes.at(-1);
 assert.equal(await toastAction().textContent(), locale === 'en' ? 'Undo' : '撤销');
 await toastAction().click(); await card(kept).waitFor();
 assert.equal(writes.length, before + 2); assert.equal(writes.at(-1).action, 'restore'); assert.notEqual(writes.at(-1).requestId, trashRequest.requestId); assert.equal(saved[0].trashedAt, null);
 // Retain the explicit trash-view restore path as well.
 await selected(kept); await primary('delete'); await dialog().locator('[data-dialog-action=trash]').click(); await idle();
 await view('trash'); assert.equal(await page.locator('.artifacts-card').count(), 1);
 await selected(kept); await primary('restore'); await idle(); assert.equal(saved[0].trashedAt, null);
 await view('saved'); await widths(page); await screenshot('library');
 // Quick-save the remaining unsaved file, one request, and use its View action.
 sourceDeleted = false; await page.locator('#artifacts-refresh').click(); await page.locator('#artifacts-refresh:not(:disabled)').waitFor(); await view('all');
 before = writes.length; await page.locator('.artifacts-quick[data-action=save]').click();
 await page.locator('.artifacts-card').waitFor({ state: 'detached' });
 assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).action, 'save'); assert.equal(saved.length, 2);
 assert.equal(await toastAction().textContent(), locale === 'en' ? 'View' : '查看'); await toastAction().click();
 await page.locator('.artifacts-views [data-view=saved][aria-current=page]').waitFor(); assert.equal(await page.locator('.artifacts-card').count(), 2);
 const second = saved.find(i => i.key !== kept).key;
 await wrap(second).locator('.artifacts-star').click(); await page.waitForFunction(id => document.querySelector(`.artifacts-card-wrap[data-key="${id}"] .artifacts-star`)?.getAttribute('aria-pressed') === 'true', second);
 assert.equal(writes.at(-1).action, 'favorite'); assert.equal(saved.find(i => i.key === second).favorite, true);
 await wrap(second).locator('.artifacts-star').click(); await page.waitForFunction(id => document.querySelector(`.artifacts-card-wrap[data-key="${id}"] .artifacts-star`)?.getAttribute('aria-pressed') === 'false', second);
 assert.equal(saved.find(i => i.key === second).favorite, false);
 // Undo reverses only what the request changed: kept was already starred and stays starred.
 assert.equal(saved.find(i => i.key === kept).favorite, true);
 await selected(kept); await wrap(second).locator('.artifacts-check').click(); await primary('favorite'); await idle();
 assert.equal(writes.at(-1).favorite, true); assert.equal(saved.find(i => i.key === second).favorite, true);
 before = writes.length; await toastAction().click();
 await page.waitForFunction(id => document.querySelector(`.artifacts-card-wrap[data-key="${id}"] .artifacts-star`)?.getAttribute('aria-pressed') === 'false', second);
 assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).favorite, false); assert.deepEqual(writes.at(-1).files.map(f => f.key), [second], 'Undo targets only the newly starred file');
 assert.equal(saved.find(i => i.key === kept).favorite, true, 'previously starred file stays starred');
 // A genuinely partial batch removes successful selections and retains only the failed file.
 await selected(kept); await wrap(second).locator('.artifacts-check').click();
 assert.equal(await page.locator('#artifacts-select').count(), 1, 'one selection toggle, not duplicated rows');
 assert.equal(await page.locator('#artifacts-batchbar .artifacts-bar-btn[data-action]:visible').count(), 3);
 await widths(page); await screenshot('library-selection');
 failFavorite = kept; await primary('favorite'); await page.getByText(/Fixture stale revision/).waitFor();
 await page.waitForFunction(() => document.querySelectorAll('.artifacts-check[aria-checked=true]').length === 1);
 assert.equal(await wrap(kept).locator('.artifacts-check').getAttribute('aria-checked'), 'true', 'failed item remains selected');
 assert.equal(await wrap(second).locator('.artifacts-check').getAttribute('aria-checked'), 'false', 'successful item leaves selection'); failFavorite = false;
 await more('export'); assert.ok((await dialog().locator('.artifacts-dialog-text').textContent()).includes(locale === 'en' ? 'server running Pivane' : '运行 Pivane 的服务器')); await widths(page); await page.keyboard.press('Escape');
 // Delete key opens confirmation from a selected card; cancellation never sends a write.
 await page.locator('.artifacts-manage-dialog').waitFor({ state: 'detached' });
 await wrap(kept).locator('.artifacts-check').focus();
 before = writes.length; await page.keyboard.press('Delete'); await deleteDialog(false); await page.keyboard.press('Escape'); await page.locator('.artifacts-manage-dialog').waitFor({ state: 'detached' });
 assert.equal(writes.length, before); assert.equal(saved.length, 2, 'cancel never deletes');
 await page.keyboard.press('Escape'); assert.equal(await page.locator('#artifacts-select').getAttribute('aria-pressed'), 'false', 'Escape exits selection');
 // Direct permanent deletion from Saved using the batch bar, without trash first.
 await selected(second); await primary('delete'); await deleteDialog(false);
 before = writes.length; await dialog().locator('[data-dialog-action=purge]').click(); await idle();
 assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).action, 'purge'); assert.equal(saved.length, 1); assert.equal(saved[0].key, kept);
 // Direct permanent deletion via the drawer's trash-can button, no typed confirmation.
 await card(kept).click(); await page.locator('#artifacts-preview-body h1').waitFor();
 await page.locator('.artifacts-detail-actions [data-action=delete]').click(); await deleteDialog(false);
 before = writes.length; await dialog().getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
 assert.equal(saved.length, 1, 'cancel never deletes'); assert.equal(writes.length, before);
 await page.locator('.artifacts-detail-actions [data-action=delete]').click(); await deleteDialog(false);
 await dialog().locator('[data-dialog-action=purge]').click(); await page.waitForFunction(() => !document.querySelector('#artifacts-detail').open);
 assert.equal(writes.at(-1).action, 'purge'); assert.equal(saved.length, 0);
 // Save one file into a newly created collection from the inline picker.
 await view('all'); await page.locator('#artifacts-select').click(); await page.locator('.artifacts-file-chip').first().click();
 await primary('collection-add'); await dialog().locator('select').selectOption('__new__'); await confirm();
 await dialog().locator('input').fill('Created inline'); await confirm(); await idle(); assert.equal(saved.length, 1); assert.ok(saved[0].collections.length);
 const last = saved[0].key;
 await page.keyboard.press('Escape'); assert.equal(await page.locator('#artifacts-select').getAttribute('aria-pressed'), 'false');
 await view('saved'); await selected(last); await more('trash'); await idle();
 await view('trash'); const previewCount = previews.length; await card(last).click(); await page.locator('.artifacts-detail-banner:not([hidden])').waitFor();
 assert.equal(await page.locator('#artifacts-preview-body h1').count(), 0, 'trash detail does not attempt a denied preview'); assert.equal(previews.length, previewCount, 'trash detail makes no preview request');
 await page.locator('.artifacts-detail-actions [data-action=purge]').click(); await deleteDialog(true);
 before = writes.length; await page.keyboard.press('Escape'); assert.equal(saved.length, 1, 'cancel never deletes'); assert.equal(writes.length, before);
 await page.locator('.artifacts-detail-actions [data-action=purge]').click(); await deleteDialog(true); await screenshot('library-purge');
 loseReply = true; const reconciliationBeforePurge = reconciliations.length; await dialog().locator('[data-dialog-action=purge]').click();
 await page.waitForFunction(() => !document.querySelector('#artifacts-detail').open); assert.equal(saved.length, 0); assert.equal(writes.length, before + 1, 'permanent delete never replays a lost response');
 assert.deepEqual(reconciliations.slice(reconciliationBeforePurge), [writes.at(-1).requestId]);
 // Saving the second file of a delivery keeps that tab selected; its reads then use the library copy.
 await view('all'); await page.locator('.artifacts-card').first().click(); await page.locator('#artifacts-preview-body h1').waitFor();
 const tab = name => page.locator('#artifacts-detail .artifacts-file-tab').filter({ hasText: name });
 await tab('site.html').click(); await page.waitForFunction(() => document.querySelector('#artifacts-detail .artifacts-file-tab[aria-selected=true]')?.textContent.includes('site.html'));
 await page.locator('.artifacts-detail-actions [data-action=save]').click();
 await tab('site.html').and(page.locator('.is-saved')).waitFor();
 assert.equal(await tab('site.html').getAttribute('aria-selected'), 'true', 'saved tab stays selected');
 const siteCopy = saved.find(i => i.sourceKey === key(2)).key;
 await tab('report.md').click(); await page.locator('#artifacts-preview-body h1').waitFor();
 await tab('site.html').click(); await page.waitForFunction(() => document.querySelector('#artifacts-preview-body h1'));
 assert.ok(previews.at(-1).includes(siteCopy), 'saved tab previews its library copy');
 await page.keyboard.press('Escape');
 if (process.env.ARTIFACT_SCREENSHOT_DIR) {
  const titles = locale === 'en' ? ['Research brief.md', 'Launch landing page.html', 'Interview notes.md', 'Product walkthrough.mp4', 'Campaign cover.png', 'Narration.wav'] : ['用户研究简报.md', '产品发布页.html', '访谈纪要.md', '功能演示.mp4', '活动封面.png', '旁白音频.wav'];
  saved = titles.map((name, index) => ({ ...source, key: key(200 + index), sourceKey: key(300 + index), source: 'library', independent: true, revision: 1, collections: [], title: name, favorite: index < 2, origin: null, types: [['document'], ['web'], ['document'], ['video'], ['image'], ['audio']][index], files: [{ key: key(200 + index), name, kind: ['document', 'web', 'document', 'video', 'image', 'audio'][index], size: 1024 * (index + 1) }] }));
  await view('saved'); await page.locator('#artifacts-refresh').click(); await page.locator('.artifacts-card').nth(5).waitFor(); await page.locator('#artifacts-tab').evaluate(n => { n.scrollTop = 0; });
  await widths(page); await screenshot('polished-gallery'); await selected(key(200)); await wrap(key(201)).locator('.artifacts-check').click();
  await page.locator('#artifacts-tab').evaluate(n => { n.scrollTop = 0; }); await widths(page); await screenshot('polished-batch');
 }
 assert.deepEqual(errors, []);
 console.log(`artifact management ${width}px ${locale} ${theme}: per-file save/favorite, collections, drawer toasts/Undo, rename, deleted origin, location, selection, quick save/View, direct delete, trash/restore and uncertain-response no replay passed`);
 await context.close();
}
async function widths(page) {
 await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.target?.matches('.artifacts-manage-dialog, #artifacts-detail')).every(a => a.playState === 'finished'));
 assert.deepEqual(await page.evaluate(() => ['body', '#artifacts-tab', '.artifacts-toolbar', '.artifacts-grid', '#artifacts-batchbar', '.artifacts-bar-actions', '#artifacts-detail', '.artifacts-detail-actions', '.artifacts-manage-dialog[open]'].filter(s => { const n = document.querySelector(s); if (!n || !n.clientWidth || n.scrollWidth <= n.clientWidth + 1) return false;
        // The phone filter scroller intentionally bleeds into the shell's 14px gutters.
        // Keep the toolbar check, but fail only if that bleed overflows the actual page.
        if (s === '.artifacts-toolbar') return n.getBoundingClientRect().right + n.scrollWidth - n.clientWidth > innerWidth + 1;
        return true; })), []);
 if (page.viewportSize().width < 680) assert.deepEqual(await page.locator('#artifacts-search, .artifacts-pill select, .artifacts-manage-dialog[open] input, .artifacts-manage-dialog[open] select').evaluateAll(ns => ns.filter(n => parseFloat(getComputedStyle(n).fontSize) < 16).map(n => n.id || n.name)), [], 'phone form fields stay at least 16px');
}
(async () => {
 const app = express(); for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
 app.use(express.static(path.join(root, 'public'))); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 try { for (const [width, locale, theme] of [[1440, 'zh-CN', 'daylight'], [1024, 'en', 'dark'], [393, 'zh-CN', 'dark'], [320, 'en', 'daylight']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale, theme); }
 finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
