const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-artifact-library-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project'), mediaRoot = path.join(root, 'media');
for (const p of [agent, cwd, path.join(mediaRoot, 'public/images')]) fs.mkdirSync(p, { recursive: true });
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_WEB_DEFERRED_FILE: path.join(agent, 'deferred.json') });
const { PiSessionStore, getSdk } = require('../server/pi-session-store'), { DeliverableStore, ENTRY } = require('../server/pi-deliverables'), { ArtifactsService } = require('../server/pi-artifacts');
const { artifactHash } = require('../server/pi-artifacts-library');
const store = new PiSessionStore(), objects = new DeliverableStore(store), supervisor = { getActiveWorker: () => null };
const options = { store, supervisor, mediaRoot }, service = new ArtifactsService(options);
let session, receipt, key, saved, counter = 0;
const run = (action, files, extra = {}) => service.management.batch({ requestId: 'fixture-operation-' + (++counter), action, ...(files ? { files } : {}), ...extra });
test.before(async () => {
 const { SessionManager } = await getSdk(); session = await store.createSession(cwd, 'Save independently'); const manager = SessionManager.open(session.path);
 fs.writeFileSync(path.join(cwd, 'report.md'), '\ufeff# Independent report\n');
 receipt = await objects.publish({ cwd, sessionId: session.id }, { requestId: 'independent-save', title: 'Report', files: ['report.md'] });
 manager.appendCustomEntry(ENTRY, receipt.reference);
 const result = await service.list({ cwd }); key = result.items[0].key;
});
test.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
test('favorite saves original bytes as an independent library file and retry is idempotent', async () => {
 const input = { requestId: 'favorite-stable-id', action: 'favorite', files: [{ key }], favorite: true };
 const result = await service.management.batch(input); assert.equal(result.results[0].ok, true); saved = result.results[0].item;
 assert.equal(saved.independent, true); assert.equal(saved.favorite, true); assert.equal(saved.sourceKey, key);
 assert.deepEqual(await service.management.batch(input), result);
 await assert.rejects(service.management.batch({ ...input, favorite: false }), { code: 'ARTIFACT_CONFLICT' });
 assert.equal((await service.preview(saved.key)).content, '\ufeff# Independent report\n');
 const location = await service.management.location(saved.key); assert.ok(location.storagePath.startsWith(path.join(agent, 'pivane-artifacts'))); assert.equal(location.sourcePath, path.join(cwd, 'report.md'));
 if (process.platform !== 'win32') assert.equal(fs.statSync(location.storagePath).mode & 0o777, 0o600);
});
test('delete native session and original delivery objects: saved bytes survive restart; origin is navigation only', async () => {
 await store.deleteSession(cwd, session.id);
 fs.rmSync(path.join(await objects.root(), receipt.reference.id), { recursive: true }); fs.unlinkSync(path.join(cwd, 'report.md'));
 await assert.rejects(service.preview(key));
 const fresh = new ArtifactsService(options);
 try { assert.equal((await fresh.preview(saved.key)).content, '\ufeff# Independent report\n'); assert.equal((await fresh.library.list()).items[0].key, saved.key); await assert.rejects(fresh.origin(saved.key), { code: 'ARTIFACT_ORIGIN' }); }
 finally { await fresh.dispose(); }
});
test('organization changes have revisions and provenance stays unchanged; export never overwrites', async () => {
 let item = (await service.library.list()).items[0];
 const conflict = await run('rename', [{ key: item.key, revision: item.revision + 1 }], { name: 'wrong.md' }); assert.equal(conflict.results[0].code, 'ARTIFACT_CONFLICT');
 const rename = await run('rename', [{ key: item.key, revision: item.revision }], { name: 'kept.md' }); item = rename.results[0].item; assert.equal(item.title, 'kept.md');
 const collections = (await run('collection-create', null, { name: 'Useful' })).collections; assert.equal(collections.length, 1);
 await run('collection-add', [{ key: item.key }], { collectionId: collections[0].id });
 await run('project', [{ key: item.key }], { cwd: null }); assert.equal((await service.library.list()).items[0].project, null);
 assert.equal((await service.management.location(item.key)).origin.sessionId, session.id);
 const exported = await run('export', [{ key: item.key }], { cwd, directory: '.', confirmed: true }); assert.equal(exported.results[0].ok, true);
 assert.equal(fs.readFileSync(path.join(cwd, 'kept.md'), 'utf8'), '\ufeff# Independent report\n');
 const same = await run('export', [{ key: item.key }], { cwd, directory: '.', confirmed: true }); assert.equal(same.results[0].code, 'ARTIFACT_CONFLICT');
 await run('collection-delete', null, { collectionId: collections[0].id, confirmed: true }); assert.equal((await service.library.list()).items[0].collections.length, 0);
});
test('trash and hidden state affect only library copies; restore keeps bytes and favorites', async () => {
 await run('hide', [{ key: saved.key }]); assert.ok((await service.library.list()).items[0].hiddenAt);
 await assert.rejects(run('trash', [{ key: saved.key }]), { code: 'ARTIFACT_CONFIRM' });
 await run('trash', [{ key: saved.key }], { confirmed: true }); await assert.rejects(service.preview(saved.key), { code: 'ARTIFACT_TRASHED' });
 assert.ok(fs.existsSync(path.join(cwd, 'kept.md'))); await run('restore', [{ key: saved.key }]);
 const item = (await service.library.list()).items[0]; assert.equal(item.trashedAt, null); assert.equal(item.hiddenAt, null); assert.equal(item.favorite, true);
 assert.equal((await service.preview(saved.key)).content, '\ufeff# Independent report\n');
});
test('operation reservation is durable, pending ids never replay, and batch failures are per file', async () => {
 const catalog = await service.library.catalog(true), reserved = { id: 'pending-reservation-id', hash: require('../server/pi-artifacts-library').artifactHash(JSON.stringify({ requestId: 'pending-reservation-id', action: 'favorite', files: [{ key: saved.key }], favorite: false })), result: null };
 await service.library.reserveOperation(reserved);
 await assert.rejects(service.management.batch({ requestId: reserved.id, action: 'favorite', files: [{ key: saved.key }], favorite: false }), { code: 'ARTIFACT_INCOMPLETE' });
 assert.equal((await service.management.result(reserved.id)).noReplay, true);
 const mixed = await run('favorite', [{ key: saved.key }, { key: 'f'.repeat(64) }], { favorite: true });
 assert.equal(mixed.results[0].ok, true); assert.equal(mixed.results[1].ok, false);
 assert.equal(catalog.entries[0].id, saved.key);
});
test('media save is independent of existing history and untrusted references are never adopted', async () => {
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
 const history = path.join(mediaRoot, 'generation_history.json'), file = path.join(mediaRoot, 'public/images/test.png'); fs.writeFileSync(file, png); fs.writeFileSync(history, JSON.stringify([{ id: 'test', filename: 'test.png', createdAt: new Date().toISOString() }]));
 const key = (await service.list({})).items.find(i => i.source === 'media').key;
 const data = await run('save', [{ key }]); assert.equal(data.results[0].ok, true);
 fs.writeFileSync(history, '[]'); fs.unlinkSync(file); assert.equal((await service.preview(data.results[0].item.key)).mime, 'image/png');
 const bad = await run('save', [{ key: 'e'.repeat(64) }]); assert.equal(bad.results[0].ok, false);
});
test('storage redirection and byte tamper fail closed and exports reject linked target directories', async () => {
 const location = await service.management.location(saved.key), raw = fs.readFileSync(location.storagePath);
 fs.writeFileSync(location.storagePath, 'tampered'); await assert.rejects(service.preview(saved.key), { code: 'ARTIFACT_STORAGE' }); fs.writeFileSync(location.storagePath, raw);
 const target = path.join(cwd, 'linked'); fs.symlinkSync(root, target, process.platform === 'win32' ? 'junction' : 'dir');
 const exported = await run('export', [{ key: saved.key }], { cwd, directory: 'linked', confirmed: true }); assert.equal(exported.results[0].ok, false); fs.unlinkSync(target);
});
test('source-key organization never bypasses revoked history merely because a library copy exists', async () => {
 const result = await run('favorite', [{ key }], { favorite: false }); assert.equal(result.results[0].ok, false);
 assert.equal((await service.library.catalog()).entries.find(e => e.id === saved.key).favorite, true);
});
test('HTTP management stays authenticated, same-origin, JSON/no-store and explicit confirmation only', async t => {
 const express = require('express'), http = require('node:http'), { once } = require('node:events'), { WorkspaceAccessService } = require('../server/workspace-access-service');
 process.env.PI_WEB_TOKEN = 'library-fixture-token'; const access = new WorkspaceAccessService(), app = express(); app.use(express.json()); app.use(access.middleware());
 const router = express.Router(), mounted = require('../server/pi-artifacts-routes').mountArtifacts(router, options); app.use('/api/pi', router);
 const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { await mounted.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
 const base = `http://127.0.0.1:${server.address().port}`, url = base + '/api/pi/artifacts', headers = { Authorization: 'Bearer library-fixture-token', Origin: base, 'Content-Type': 'application/json' };
 assert.equal((await fetch(url + '/library')).status, 401);
 assert.equal((await fetch(url + '/batch', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.test' }, body: '{}' })).status, 403);
 const list = await fetch(url + '/library', { headers }); assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'no-store');
 const body = await list.json(); assert.ok(!JSON.stringify(body.items).includes(agent));
 const unconfirmed = await fetch(url + '/batch', { method: 'POST', headers, body: JSON.stringify({ requestId: 'http-unconfirmed-id', action: 'trash', files: [{ key: saved.key }] }) }); assert.equal(unconfirmed.status, 409);
 const response = await fetch(url + '/batch', { method: 'POST', headers, body: JSON.stringify({ requestId: 'http-favorite-once', action: 'favorite', files: [{ key: saved.key }], favorite: true }) }); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /sandbox/);
 const result = await response.json(); assert.equal(result.results[0].ok, true);
 assert.deepEqual(await (await fetch(url + '/operations/http-favorite-once', { headers })).json(), result);
});
test('batch is reserved before await, canceled clients do not release write ownership or replay uncertain operations', async () => {
 const read = service.management.source, controller = new AbortController(); let release;
 service.management.source = async () => { await new Promise(r => release = r); throw Object.assign(Error('source'), { status: 409, code: 'ARTIFACT_SOURCE' }); };
 const input = { requestId: 'blocked-batch-once', action: 'save', files: [{ key: 'a'.repeat(64) }] }, promise = service.management.batch(input, controller.signal);
 while (!release) await new Promise(r => setImmediate(r)); controller.abort(); assert.equal(service.busy, true);
 await assert.rejects(run('favorite', [{ key: saved.key }], { favorite: false }), { code: 'ARTIFACT_BUSY' });
 release(); const result = await promise; assert.equal(result.results[0].ok, false); assert.equal(service.busy, false); service.management.source = read;
 assert.deepEqual(await service.management.result(input.requestId), result);
 await assert.rejects(run('rename', [{ key: saved.key }], { name: '../escape.md' }), { code: 'ARTIFACT_INPUT' });
});
test('direct permanent deletion requires confirmation, exact saved ID and current revision; preserves originals and never revives an old ID', async () => {
 const bytes = Buffer.from('fixture permanent copy'), sourceKey = 'c'.repeat(64);
 const save = () => service.library.mutation(c => service.library.save(c, sourceKey, bytes, { name: 'purge.txt', kind: 'document' }));
 const entry = await save(), file = (await service.management.location(entry.id)).storagePath;
 await assert.rejects(run('purge', [{ key: entry.id, revision: entry.revision }]), { code: 'ARTIFACT_CONFIRM' });
 await assert.rejects(run('purge', [{ key: entry.id }], { confirmed: true }), { code: 'ARTIFACT_CONFLICT' });
 const sourcePurge = (await run('purge', [{ key: sourceKey, revision: entry.revision }], { confirmed: true })).results[0];
 assert.equal(sourcePurge.code, 'ARTIFACT_MISSING'); assert.equal(sourcePurge.error, '只能永久删除已保存到成果库的文件');
 assert.deepEqual((await service.library.catalog()).entries.find(e => e.id === entry.id), entry, 'rejected requests do not change the saved entry');
 const item = (await run('rename', [{ key: entry.id, revision: entry.revision }], { name: 'purge-renamed.txt' })).results[0].item;
 assert.ok(item.revision > entry.revision);
 assert.equal((await run('purge', [{ key: entry.id, revision: entry.revision }], { confirmed: true })).results[0].code, 'ARTIFACT_CONFLICT');
 const before = await service.library.list(), input = { requestId: 'permanent-deletion-once', action: 'purge', files: [{ key: entry.id, revision: item.revision }], confirmed: true };
 assert.equal(before.items.find(i => i.key === entry.id).trashedAt, null);
 const result = await service.management.batch(input); assert.deepEqual(result.results, [{ key: entry.id, ok: true, deleted: true }]);
 assert.equal(fs.existsSync(file), false); const after = await service.library.list(); assert.equal(after.bytes, before.bytes - bytes.length); assert.ok(after.savedSources.includes(sourceKey));
 assert.ok(!after.items.some(i => i.key === entry.id)); assert.ok(fs.existsSync(path.join(cwd, 'kept.md')));
 assert.equal((await service.library.catalog()).deletedVersions[sourceKey], entry.id);
 assert.deepEqual(await service.management.batch(input), result, 'same request returns receipt, not another delete');
 const again = await save(); assert.notEqual(again.id, entry.id, 'fresh save cannot revive stale library ID');
 assert.deepEqual(await service.management.batch(input), result); assert.equal((await service.library.content(again)).bytes.toString(), bytes.toString());
 const againTrash = (await run('trash', [{ key: again.id }], { confirmed: true })).results[0].item;
 assert.equal((await run('purge', [{ key: again.id, revision: againTrash.revision }], { confirmed: true })).results[0].deleted, true);
 const third = await save(); assert.ok(![entry.id, again.id].includes(third.id));
 const uncertainKey = '7'.repeat(64), uncertainID = require('../server/pi-artifacts-library').artifactHash('saved:' + uncertainKey), uncertainPath = path.join(await service.library.root(), uncertainID + '.bin');
 fs.writeFileSync(uncertainPath, 'reserved partial write');
 await assert.rejects(service.library.mutation(c => service.library.save(c, uncertainKey, bytes, { name: 'uncertain.txt', kind: 'document' })), { code: 'ARTIFACT_INCOMPLETE' });
 assert.equal(fs.readFileSync(uncertainPath, 'utf8'), 'reserved partial write');
});
test('hidden starred library entries can be permanently deleted without moving to trash', async () => {
 const entry = await service.library.mutation(c => service.library.save(c, '6'.repeat(64), Buffer.from('hidden copy'), { name: 'hidden.txt', kind: 'document' }));
 await run('favorite', [{ key: entry.id }], { favorite: true });
 const item = (await run('hide', [{ key: entry.id }])).results[0].item, file = (await service.management.location(entry.id)).storagePath;
 assert.ok(item.hiddenAt); assert.equal(item.favorite, true); assert.equal(item.trashedAt, null);
 const result = await run('purge', [{ key: item.key, revision: item.revision }], { confirmed: true });
 assert.deepEqual(result.results, [{ key: item.key, ok: true, deleted: true }]); assert.equal(fs.existsSync(file), false);
 assert.ok(!(await service.library.list()).items.some(i => i.key === item.key));
});
test('direct purge rejects links and hash mismatch without trashing entries, and reports mixed results without touching unrelated files', async () => {
 const make = sourceKey => service.library.mutation(c => service.library.save(c, sourceKey, Buffer.from('verified'), { name: 'copy.txt', kind: 'document' }));
 const a = await make('d'.repeat(64)), b = await make('e'.repeat(64));
 const file = (await service.management.location(a.id)).storagePath, raw = fs.readFileSync(file), target = path.join(cwd, 'kept.md');
 fs.unlinkSync(file); fs.symlinkSync(target, file);
 assert.equal((await run('purge', [{ key: a.id, revision: a.revision }], { confirmed: true })).results[0].ok, false); assert.ok(fs.existsSync(target));
 assert.deepEqual((await service.library.catalog()).entries.find(e => e.id === a.id), a, 'identity failure leaves the entry unchanged');
 fs.unlinkSync(file); fs.writeFileSync(file, 'tampered');
 assert.equal(fs.statSync(file).size, a.size, 'same-size tampering reaches hash verification');
 const mixed = await run('purge', [a, b].map(e => ({ key: e.id, revision: e.revision })), { confirmed: true });
 assert.equal(mixed.results[0].code, 'ARTIFACT_STORAGE'); assert.equal(mixed.results[0].error, '成果字节已变化，未删除');
 assert.equal(mixed.results[1].deleted, true); assert.equal(fs.readFileSync(file, 'utf8'), 'tampered');
 assert.deepEqual((await service.library.catalog()).entries.find(e => e.id === a.id), a, 'hash failure leaves the non-trashed entry exactly unchanged');
 assert.equal((await service.library.list()).items.find(i => i.key === a.id).deletionPending, false); fs.writeFileSync(file, raw);
});
test('purge rechecks descriptor identity after durable intent and refuses replacement at unlink boundary', async () => {
 const entry = await service.library.mutation(c => service.library.save(c, '8'.repeat(64), Buffer.from('boundary'), { name: 'boundary.txt', kind: 'document' }));
 const item = service.library.item(entry), file = (await service.management.location(entry.id)).storagePath;
 const target = path.join(cwd, 'kept.md'), before = fs.readFileSync(target), commit = service.library.commit; let swapped = false;
 service.library.commit = async function(catalog) { await commit.call(this, catalog); if (!swapped && catalog.entries.find(e => e.id === entry.id)?.deletingAt) { swapped = true; fs.renameSync(file, file + '.held'); fs.symlinkSync(target, file); } };
 try { const result = await run('purge', [{ key: entry.id, revision: item.revision }], { confirmed: true }); assert.equal(result.results[0].ok, false); assert.deepEqual(fs.readFileSync(target), before); assert.ok(fs.lstatSync(file).isSymbolicLink()); }
 finally { service.library.commit = commit; if (swapped) { fs.unlinkSync(file); fs.renameSync(file + '.held', file); } }
 const pending = (await service.library.list()).items.find(i => i.key === entry.id), durable = (await service.library.catalog()).entries.find(e => e.id === entry.id);
 assert.ok(pending.trashedAt); assert.equal(pending.deletionPending, true); assert.equal(durable.trashedAt, durable.deletingAt);
 const restore = (await run('restore', [{ key: entry.id }])).results[0];
 assert.equal(restore.code, 'ARTIFACT_INCOMPLETE'); assert.equal(restore.error, '此成果删除结果待核对，请重新确认永久删除');
 assert.equal((await run('purge', [{ key: entry.id, revision: item.revision }], { confirmed: true })).results[0].deleted, true);
});
test('interrupted purge never restores missing bytes and requires a new confirmed request to reconcile', async () => {
 const entry = await service.library.mutation(c => service.library.save(c, '9'.repeat(64), Buffer.from('recover intent'), { name: 'intent.txt', kind: 'document' }));
 const item = service.library.item(entry), file = (await service.management.location(entry.id)).storagePath;
 const commit = service.library.commit; let failed = false;
 service.library.commit = async function(catalog) { if (!failed && !catalog.entries.some(e => e.id === entry.id)) { failed = true; throw Error('injected catalog failure after unlink'); } return commit.call(this, catalog); };
 const input = { requestId: 'purge-crash-fixture', action: 'purge', files: [{ key: entry.id, revision: item.revision }], confirmed: true };
 try { const r = await service.management.batch(input); assert.equal(r.results[0].ok, false); } finally { service.library.commit = commit; }
 assert.equal(fs.existsSync(file), false); assert.equal((await service.management.batch(input)).results[0].ok, false, 'failed request is not replayed');
 const durable = (await service.library.catalog()).entries.find(e => e.id === entry.id), pending = (await service.library.list()).items.find(i => i.key === entry.id);
 assert.ok(durable, 'final commit failure rolls back the in-memory entry removal');
 assert.equal(durable.trashedAt, durable.deletingAt); assert.ok(pending.trashedAt); assert.equal(pending.deletionPending, true);
 assert.equal(pending.revision, item.revision);
 assert.ok(!(await service.library.catalog()).deletedSources.includes(entry.sourceKey), 'failed final commit rolls back deletedSources');
 assert.equal((await service.library.catalog()).deletedVersions[entry.sourceKey], undefined, 'failed final commit rolls back deletedVersions');
 assert.equal((await run('restore', [{ key: entry.id }])).results[0].code, 'ARTIFACT_INCOMPLETE');
 assert.equal((await run('purge', [{ key: entry.id, revision: item.revision }], { confirmed: true })).results[0].deleted, true);
});

function isolatedLibrary(t, label) {
 const libraryRoot = path.join(root, label), fixture = new ArtifactsService({ ...options, libraryRoot });
 t.after(() => fixture.dispose());
 return { fixture, library: fixture.library, libraryRoot };
}
function catalogEntry(index, collections = []) {
 const sourceKey = artifactHash('budget-source:' + index);
 return { id: artifactHash('saved:' + sourceKey), sourceKey, sha256: artifactHash('x'), size: 1, revision: 1,
  name: 'report-' + index + '-' + '界'.repeat(60) + '.txt', originalName: 'original-' + index + '.txt', kind: 'document',
  savedAt: '2026-10-23T00:00:00.000Z', favorite: false, collections, trashedAt: null, hiddenAt: null };
}
test('catalog rejects actual JSON bytes over 16 MiB even when compact JSON fits, preserving the readable previous catalog', async t => {
 const { library, libraryRoot } = isolatedLibrary(t, 'catalog-byte-budget'), catalog = await library.catalog(true);
 const saved = await library.save(catalog, artifactHash('previous readable file'), Buffer.from('previous readable bytes'), { name: 'previous.txt', kind: 'document' });
 const file = path.join(libraryRoot, 'catalog.json'), previous = fs.readFileSync(file), revision = catalog.revision;
 catalog.collections = Array.from({ length: 75 }, (_, i) => ({ id: artifactHash('budget-collection:' + i), name: 'Collection ' + i }));
 const ids = catalog.collections.map(c => c.id);
 catalog.entries = Array.from({ length: 50 }, (_, i) => catalogEntry(i, [...ids]));
 catalog.operations = ids.map((id, i) => ({ id: 'legacy-budget-' + i, hash: id, at: '2026-10-23T00:00:00.000Z', result: {
  requestId: 'legacy-budget-' + i, results: catalog.entries.map(e => ({ key: e.id, ok: true, item: library.item({ ...e, collections: ids.slice(0, i + 1) }) }))
 } }));
 const compact = Buffer.byteLength(JSON.stringify(catalog)), actual = Buffer.byteLength(JSON.stringify(catalog, null, 2) + '\n');
 assert.ok(compact < 16 * 1024 ** 2, 'fixture fits the old compact budget: ' + compact);
 assert.ok(actual > 16 * 1024 ** 2, 'fixture exceeds the on-disk budget: ' + actual);
 t.diagnostic('catalog budget fixture: compact=' + compact + ' bytes; actual=' + actual + ' bytes');
 await assert.rejects(library.commit(catalog), { code: 'ARTIFACT_LIMIT', status: 413 });
 assert.deepEqual(fs.readFileSync(file), previous);
 assert.equal(catalog.revision, revision, 'failed commit does not advance the in-memory revision');
 assert.equal((await library.catalog()).revision, revision);
 assert.equal((await library.list()).total, 1);
 assert.equal((await library.content(saved)).bytes.toString(), 'previous readable bytes');
});
test('operation reservation and completion enforce their own actual 1 MiB budget without replacing pending evidence', async t => {
 const { library } = isolatedLibrary(t, 'operation-byte-budget'), id = 'operation-budget-once';
 const pending = { id, hash: artifactHash('operation budget'), at: '2026-10-23T00:00:00.000Z', result: null };
 await library.reserveOperation(pending);
 const file = await library.operationPath(id), previous = fs.readFileSync(file), ids = Array.from({ length: 100 }, (_, i) => artifactHash('operation-collection:' + i));
 const result = { requestId: id, results: Array.from({ length: 50 }, (_, i) => ({ key: artifactHash('operation-file:' + i), ok: true, item: library.item(catalogEntry(i, ids)) })) };
 const completed = { ...pending, result }, limit = 1024 ** 2;
 result.results[0].item.model = '界'.repeat(Math.floor((limit - Buffer.byteLength(JSON.stringify(completed)) - 100) / 3));
 assert.ok(Buffer.byteLength(JSON.stringify(completed)) < limit);
 assert.ok(Buffer.byteLength(JSON.stringify(completed, null, 2) + '\n') > limit);
 t.diagnostic('operation budget fixture: compact=' + Buffer.byteLength(JSON.stringify(completed)) + ' bytes; actual=' + Buffer.byteLength(JSON.stringify(completed, null, 2) + '\n') + ' bytes');
 await assert.rejects(library.finishOperation(completed), { code: 'ARTIFACT_LIMIT', status: 413 });
 assert.deepEqual(fs.readFileSync(file), previous);
 assert.deepEqual(await library.operation(id), pending);
 const oversized = { ...completed, id: 'oversized-reservation-once' };
 await assert.rejects(library.reserveOperation(oversized), { code: 'ARTIFACT_LIMIT', status: 413 });
 assert.equal(fs.existsSync(await library.operationPath(oversized.id)), false);
 const receipt = { requestId: id, results: [{ key: artifactHash('operation-file:0'), ok: false, error: '明确失败' }] };
 await library.finishOperation({ ...pending, result: receipt });
 assert.deepEqual((await library.operation(id)).result, receipt);
});
test('real batches grow fifty files through seventy-five collections while keeping results only in durable operation files', async t => {
 const { fixture, library, libraryRoot } = isolatedLibrary(t, 'collection-growth');
 const entries = await library.mutation(async catalog => {
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push(await library.save(catalog, artifactHash('growth-source:' + i), Buffer.from('x'), { name: 'file-' + i + '.txt', kind: 'document', createdAt: '2026-10-23T00:00:00.000Z' }));
  return entries;
 });
 const files = entries.map(e => ({ key: e.id })); let firstInput, firstResult, lastResult, collectionId;
 for (let i = 0; i < 75; i++) {
  const created = await fixture.management.batch({ requestId: 'growth-create-' + i, action: 'collection-create', name: 'Collection ' + i });
  assert.equal(created.collections.length, i + 1); collectionId = created.collections[i].id;
  const input = { requestId: 'growth-add-' + i, action: 'collection-add', files, collectionId };
  lastResult = await fixture.management.batch(input);
  assert.equal(lastResult.results.length, 50);
  assert.ok(lastResult.results.every(r => r.ok && r.item.collections.length === i + 1));
  const catalog = await library.catalog();
  assert.ok(catalog.operations.every(o => !Object.hasOwn(o, 'result')), 'catalog contains summaries; full results remain in operation files');
  assert.deepEqual((await library.operation(input.requestId)).result, lastResult);
  if (i === 0) { firstInput = input; firstResult = lastResult; }
 }
 // Roll the catalog summary window past the original request without losing its
 // durable result or allowing the old request to act on the current entries.
 for (let i = 0; i < 52; i++) await fixture.management.batch({ requestId: 'growth-rename-' + i, action: 'collection-rename', collectionId, name: 'Renamed ' + i });
 const catalog = await library.catalog(), file = path.join(libraryRoot, 'catalog.json'), previous = fs.readFileSync(file);
 assert.equal(catalog.operations.length, 200); assert.equal(catalog.operations.some(o => o.id === firstInput.requestId), false);
 assert.equal(catalog.collections.length, 75); assert.ok(catalog.entries.every(e => e.collections.length === 75));
 assert.equal(fs.readdirSync(path.join(libraryRoot, 'operations')).length, 202);
 assert.ok(previous.length < 1024 ** 2, 'bounded catalog without repeated response snapshots');
 t.diagnostic('real growth: 50 files, 75 collections, 202 operation files; catalog=' + previous.length + ' bytes');
 const restarted = new ArtifactsService({ ...options, libraryRoot }); t.after(() => restarted.dispose());
 assert.deepEqual(await restarted.management.batch(firstInput), firstResult);
 assert.deepEqual(await restarted.management.result('growth-add-74'), lastResult);
 await assert.rejects(restarted.management.batch({ ...firstInput, collectionId: artifactHash('different collection') }), { code: 'ARTIFACT_CONFLICT' });
 assert.deepEqual(fs.readFileSync(file), previous);
});
test('legacy inline operation results stay readable and intact when new summaries are committed', async t => {
 const { fixture, library, libraryRoot } = isolatedLibrary(t, 'legacy-operation-results');
 const input = { requestId: 'legacy-completed-once', action: 'collection-create', name: 'Legacy' };
 const result = { requestId: input.requestId, results: [], collections: [{ id: artifactHash('legacy collection'), name: input.name }] };
 const operation = { id: input.requestId, hash: artifactHash(JSON.stringify(input)), at: '2026-10-23T00:00:00.000Z', result };
 await library.reserveOperation({ ...operation, result: null }); await library.finishOperation(operation);
 const catalog = await library.catalog(true); catalog.collections = result.collections; catalog.operations.push(operation); await library.commit(catalog);
 const operationBytes = fs.readFileSync(await library.operationPath(input.requestId));
 assert.deepEqual(await fixture.management.batch(input), result);
 await fixture.management.batch({ requestId: 'new-summary-once', action: 'collection-create', name: 'New' });
 assert.deepEqual((await library.catalog()).operations.find(o => o.id === operation.id), operation, 'legacy result is not silently discarded or migrated');
 assert.deepEqual(fs.readFileSync(await library.operationPath(input.requestId)), operationBytes);
 const restarted = new ArtifactsService({ ...options, libraryRoot }); t.after(() => restarted.dispose());
 assert.deepEqual(await restarted.management.result(input.requestId), result);
});
test('interrupted completion after saving bytes leaves a pending request that never replays after restart', async t => {
 const { fixture, library, libraryRoot } = isolatedLibrary(t, 'save-before-receipt');
 const bytes = Buffer.from('durable before receipt'), sourceKey = artifactHash('interrupted source'); let reads = 0;
 fixture.management.source = async () => { reads++; return { bytes, metadata: { name: 'interrupted.txt', kind: 'document' } }; };
 const finish = library.finishOperation;
 library.finishOperation = async () => { throw Error('injected completion failure after durable save'); };
 const input = { requestId: 'interrupted-save-once', action: 'save', files: [{ key: sourceKey }] };
 try { await assert.rejects(fixture.management.batch(input), /injected completion failure/); }
 finally { library.finishOperation = finish; }
 const catalog = await library.catalog(), entry = catalog.entries[0], file = path.join(libraryRoot, 'catalog.json'), previous = fs.readFileSync(file);
 assert.equal(catalog.entries.length, 1); assert.equal(reads, 1);
 assert.deepEqual((await library.content(entry)).bytes, bytes);
 assert.equal((await library.operation(input.requestId)).result, null);
 assert.ok(!Object.hasOwn(catalog.operations[0], 'result'));
 const restarted = new ArtifactsService({ ...options, libraryRoot }); t.after(() => restarted.dispose());
 restarted.management.source = async () => { throw Error('pending request must not read source again'); };
 await assert.rejects(restarted.management.batch(input), { code: 'ARTIFACT_INCOMPLETE' });
 await assert.rejects(restarted.management.batch({ ...input, action: 'favorite', favorite: true }), { code: 'ARTIFACT_CONFLICT' });
 assert.deepEqual(await restarted.management.result(input.requestId), { requestId: input.requestId, pending: true, noReplay: true });
 assert.deepEqual(fs.readFileSync(file), previous);
 assert.deepEqual((await restarted.library.content(entry)).bytes, bytes);
});
