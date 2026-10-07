const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-artifact-library-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project'), mediaRoot = path.join(root, 'media');
for (const p of [agent, cwd, path.join(mediaRoot, 'public/images')]) fs.mkdirSync(p, { recursive: true });
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_WEB_DEFERRED_FILE: path.join(agent, 'deferred.json') });
const { PiSessionStore, getSdk } = require('../server/pi-session-store'), { DeliverableStore, ENTRY } = require('../server/pi-deliverables'), { ArtifactsService } = require('../server/pi-artifacts');
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
