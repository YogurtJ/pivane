const test = require('node:test');
const assert = require('node:assert/strict');
const { REVIEWED_PI_VERSION } = require('../server/pi-reviewed-host');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-openrouter-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
// All catalog/provider traffic below is loopback, with synthetic credentials.
delete process.env.PI_OFFLINE;
const { PiSettingsService } = require('../server/pi-settings-service');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');

test('native OpenRouter refresh personalizes Key A/B, regional limits/prices and offline RPC cache', { timeout: 60000 }, async t => {
    const requests = [];
    let userStatus = 200;
    const fixtureModel = id => ({ provider: 'openrouter', id, name: id, api: 'openai-completions', reasoning: false,
        input: ['text'], baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 128000, maxTokens: 16384,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    const catalog = [fixtureModel('fixture/key-a'), fixtureModel('fixture/key-b')];
    const server = http.createServer((req, res) => {
        requests.push({ path: req.url, key: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/api/models/providers/')) {
            if (!req.url.startsWith('/api/models/providers/openrouter?')) { res.writeHead(404); return res.end('{}'); }
            res.setHeader('Last-Modified', 'Thu, 01 Jan 2099 00:00:00 GMT');
            return res.end(JSON.stringify({ models: catalog }));
        }
        assert.equal(req.url, '/us/api/v1/models/user', 'native personalization uses the configured regional base URL');
        if (userStatus === 'network') return req.socket.destroy();
        res.writeHead(userStatus);
        if (userStatus !== 200) return res.end(JSON.stringify({ error: 'Synthetic catalog rejection' }));
        const keyA = req.headers.authorization === 'Bearer synthetic-key-A';
        return res.end(JSON.stringify({ data: [{ id: keyA ? 'fixture/key-a' : 'fixture/key-b', context_length: 96000,
            top_provider: { context_length: keyA ? 32000 : 64000, max_completion_tokens: keyA ? 2048 : 4096 },
            pricing: { prompt: '0.000003', completion: '0.000006', input_cache_read: '0.0000003', input_cache_write: '0.0000006',
                overrides: [{ min_prompt_tokens: 20000, prompt: '0.000005', completion: '0.000010' },
                    { min_prompt_tokens: 1000, utc_start: '10:00', prompt: '0.000100' }] } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    const modelsPath = path.join(process.env.PI_CODING_AGENT_DIR, 'models.json');
    const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
    fs.writeFileSync(modelsPath, JSON.stringify({ $schema: 'https://example.invalid/models.schema.json', providers: {
        openrouter: { baseUrl: base + '/us/api/v1' }
    } }));
    const { ModelRuntime, VERSION } = await import('@earendil-works/pi-coding-agent');
    assert.equal(VERSION, REVIEWED_PI_VERSION, 'metadata must come from the lane package');
    assert.equal(fs.lstatSync(path.join(process.cwd(), 'node_modules')).isSymbolicLink(), false);
    const service = new PiSettingsService({ cwd: root });
    service.createModelRuntime = () => ModelRuntime.create({ catalogBaseUrl: base, allowModelNetwork: false });
    const supervisor = new PiAgentSupervisor();
    t.after(async () => {
        await supervisor.dispose(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const router = snapshot => snapshot.models.filter(model => model.provider === 'openrouter');
    await service.saveApiKey('openrouter', 'synthetic-key-A');
    assert.equal(requests.length, 0, 'credential save and ordinary snapshots use cached catalogs');
    assert.deepEqual((await service.refreshModels()).errors, []);
    let snapshot = await service.getModelSnapshot();
    let selected = router(snapshot);
    assert.deepEqual(selected.map(model => model.id), ['fixture/key-a']);
    assert.equal(selected[0].available, true);
    assert.equal(selected[0].contextWindow, 32000);
    assert.equal(selected[0].maxTokens, 2048);
    assert.deepEqual(selected[0].cost, { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0.6,
        tiers: [{ inputTokensAbove: 20000, input: 5, output: 10, cacheRead: 0.3, cacheWrite: 0.6 }] });
    await service.setModelPreferences({ defaultProvider: 'openrouter', defaultModel: 'fixture/key-a' });
    process.env.PI_OFFLINE = '1';
    const worker = await supervisor.createEphemeralWorker(root);
    const originalSelection = (await worker.request('get_state')).model;
    assert.equal(originalSelection.id, 'fixture/key-a');
    delete process.env.PI_OFFLINE;
    await service.saveApiKey('openrouter', 'synthetic-key-B');
    const beforeRefresh = requests.length;
    assert.deepEqual(router(await service.getModelSnapshot()).map(model => model.id), ['fixture/key-a']);
    assert.equal(requests.length, beforeRefresh, 'Key changes do not make snapshot reads network operations');
    assert.deepEqual((await service.refreshModels()).errors, []);
    snapshot = await service.getModelSnapshot();
    assert.deepEqual(router(snapshot).map(model => model.id), ['fixture/key-b']);
    assert.equal(router(snapshot)[0].contextWindow, 64000);
    assert.equal(router(snapshot)[0].maxTokens, 4096);
    assert.equal(snapshot.preferences.defaultModel, 'fixture/key-a', 'unavailable saved selection survives narrowing');
    const savedSettings = fs.readFileSync(settingsPath);
    await assert.rejects(service.setModelPreferences({ defaultProvider: 'openrouter', defaultModel: 'fixture/key-a' }), /Model not found/);
    assert.deepEqual(fs.readFileSync(settingsPath), savedSettings, 'a rejected unavailable selection never switches to another paid model');

    const beforeOffline = requests.length;
    process.env.PI_OFFLINE = '1';
    assert.deepEqual(router(await service.getModelSnapshot()).map(model => model.id), ['fixture/key-b']);
    const offlineRuntime = await service.createModelRuntime();
    assert.equal((await offlineRuntime.refresh({ allowNetwork: false })).errors.size, 0);
    assert.equal(requests.length, beforeOffline, 'offline refresh restores the native persisted catalog without traffic');
    assert.deepEqual((await worker.request('get_available_models')).models.filter(model => model.provider === 'openrouter').map(model => model.id), ['fixture/key-a'], 'an existing worker retains its cached catalog until explicit reload');
    const refreshed = await worker.modelCatalog.refresh();
    const available = refreshed.models.filter(model => model.provider === 'openrouter');
    assert.deepEqual(available.map(model => model.id), ['fixture/key-b']);
    assert.equal(available[0].maxTokens, 4096);
    assert.deepEqual((await worker.request('get_state')).model, originalSelection, 'catalog narrowing never automatically switches the session to another paid model');
    assert.equal(requests.length, beforeOffline, 'RPC catalog reads/reloads are cached');
    await service.setModelPreferences({ defaultProvider: 'openrouter', defaultModel: 'fixture/key-b' });
    await worker.dispose();
    delete process.env.PI_OFFLINE;

    for (const status of [401, 403, 404]) {
        userStatus = status;
        assert.deepEqual((await service.refreshModels()).errors, [], `native ${status} fallback is compatible with proxies`);
        const ids = router(await service.getModelSnapshot()).map(model => model.id);
        for (const model of catalog) assert.ok(ids.includes(model.id), `${status} returns the unpersonalized catalog`);
        assert.equal((await service.getModelSnapshot()).preferences.defaultModel, 'fixture/key-b');
    }
    userStatus = 200;
    await service.refreshModels();
    for (const status of [500, 'network']) {
        userStatus = status;
        const result = await service.refreshModels();
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].provider, 'openrouter');
        assert.match(result.errors[0].error, status === 500 ? /500/ : /fetch|network|socket/i);
        assert.deepEqual(router(await service.getModelSnapshot()).map(model => model.id), ['fixture/key-b'], 'failed refresh retains last successful native cache');
    }
    const userRequests = requests.filter(request => request.path === '/us/api/v1/models/user');
    assert.ok(userRequests.some(request => request.key === 'Bearer synthetic-key-A'));
    assert.ok(userRequests.some(request => request.key === 'Bearer synthetic-key-B'));
    assert.deepEqual(JSON.parse(fs.readFileSync(modelsPath)), { $schema: 'https://example.invalid/models.schema.json', providers: { openrouter: { baseUrl: base + '/us/api/v1' } } });
    assert.ok(fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models-store.json')), 'native ModelRuntime owns the only persisted catalog');
});
