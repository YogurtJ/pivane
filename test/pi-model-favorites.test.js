const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-favorites-'));
Object.assign(process.env, { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_PROJECT_ROOTS: root, PI_WEB_TOKEN: 'favorites-fixture', PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json'), PI_OFFLINE: '1' });
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const a = { provider: 'one', modelId: 'same/model' }, b = { provider: 'two', modelId: 'same/model' };
const set = (model, favorite) => ({ action: 'set', model, favorite });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('favorites compose across devices, persist, preserve order and unrelated private preferences', () => {
    const filePath = path.join(root, 'prefs.json'), first = new WorkspacePreferencesService({ filePath }), second = new WorkspacePreferencesService({ filePath });
    first.writeDocument({ custom: { keep: true }, sessionTitles: { enabled: false } });
    assert.equal(first.getModelFavorites().revision, 0);
    first.changeModelFavorites(set(a, true)); second.changeModelFavorites(set(b, true)); first.changeModelFavorites(set(a, true));
    assert.deepEqual(second.getModelFavorites().favorites, [a, b]);
    second.changeModelFavorites(set(a, false));
    assert.deepEqual(new WorkspacePreferencesService({ filePath }).getModelFavorites().favorites, [b]);
    assert.deepEqual(first.readDocument().custom, { keep: true }); assert.equal(first.readDocument().sessionTitles.enabled, false);
    require('./private-file-helper.cjs').assertPrivateFile(filePath);
});
test('legacy imports are additive and idempotent, and cannot resurrect a removed favorite', () => {
    const service = new WorkspacePreferencesService({ filePath: path.join(root, 'migration.json') });
    const input = { action: 'import', migrationId: 'old-browser-00000001', models: [a, a, b] };
    const initial = service.changeModelFavorites(input);
    assert.deepEqual(initial.favorites, [a, b]);
    assert.deepEqual(service.changeModelFavorites(input), initial, 'repeated receipt does not mutate');
    service.changeModelFavorites(set(a, false));
    service.changeModelFavorites({ ...input, migrationId: 'another-browser-00002' });
    assert.deepEqual(service.getModelFavorites().favorites, [b]);
    service.changeModelFavorites(set(a, true));
    assert.deepEqual(service.getModelFavorites().favorites, [b, a], 'explicit re-add remains possible');
    const before = fs.readFileSync(service.filePath);
    for (const invalid of [{ action: 'set', model: a, favorite: 'true' }, { action: 'set', model: { ...a, secret: 'no' }, favorite: true },
        { action: 'import', migrationId: 'short', models: [a] }, { action: 'import', migrationId: 'browser-00000000001', models: Array(5001).fill(a) },
        { action: 'replace', favorites: [] }, { action: 'set', model: { provider: 'a', modelId: '\u0000' }, favorite: true }]) assert.throws(() => service.changeModelFavorites(invalid));
    assert.deepEqual(fs.readFileSync(service.filePath), before);
});
test('favorites HTTP requires identity/origin, returns no-store and starts no worker', async t => {
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway(), app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}/api/pi/settings/model-favorites`;
    const headers = { Authorization: 'Bearer favorites-fixture', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'http://untrusted.invalid' }, body: JSON.stringify(set(a, true)) })).status, 403);
    const read = await fetch(url, { headers }); assert.equal(read.headers.get('cache-control'), 'no-store');
    const responses = await Promise.all([a, b].map(model => fetch(url, { method: 'POST', headers, body: JSON.stringify(set(model, true)) })));
    assert.ok(responses.every(response => response.status === 200));
    const snapshot = await (await fetch(url, { headers })).json();
    assert.equal(snapshot.favorites.length, 2); assert.equal(snapshot.revision, 2);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"action":"replace"}' })).status, 400);
    assert.equal(gateway.supervisor.workers.size, 0);
});
