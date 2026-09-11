const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiProviderLoginService } = require('../server/pi-provider-login-service');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-login-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
const { PiSettingsService } = require('../server/pi-settings-service');
async function until(check) {
    for (let n = 0; n < 300; n++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Timed out waiting for auth state');
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('native runtime catalogs include unconfigured API, OAuth and ambient providers without secrets', async () => {
    const service = new PiSettingsService({ cwd: root });
    const snapshot = await service.getModelSnapshot();
    assert.ok(snapshot.providers.length > 20);
    assert.equal(snapshot.providers.find(p => p.id === 'openai').authMethods.apiKeyLogin, true);
    assert.equal(snapshot.providers.find(p => p.id === 'openai-codex').authMethods.oauth, true);
    assert.equal(snapshot.providers.find(p => p.id === 'google-vertex').authMethods.apiKey, true);
    assert.ok(snapshot.models.some(model => model.thinkingLevels.includes('max')));
    assert.ok(snapshot.providerLogin && snapshot.modelThinking);
});

test('multi-step native API key login persists literal key and provider fields, rejects stale answers and conflicting mutation', async () => {
    const service = new PiSettingsService({ cwd: root });
    const login = service.loginService;
    const initial = await login.start('cloudflare-ai-gateway', 'api_key');
    await assert.rejects(login.start('openai', 'api_key'), /完成或取消/);
    await assert.rejects(service.logout('cloudflare-ai-gateway'), /完成或取消/);
    let previous;
    for (const value of ['!test-$NOT_AN_ENV', 'fixture-account', 'fixture-gateway']) {
        const state = await until(() => { const state = login.snapshot(initial.id); return state.prompts.length ? state : null; });
        if (previous) assert.throws(() => login.answer(initial.id, { promptId: previous, value: 'repeat' }), /失效/);
        previous = state.prompts[0].id;
        login.answer(initial.id, { promptId: previous, value });
        assert.ok(!JSON.stringify(login.snapshot(initial.id)).includes(value));
    }
    await until(() => login.snapshot(initial.id).finished);
    assert.equal(login.snapshot(initial.id).status, 'success');
    const runtime = await service.createModelRuntime();
    const auth = await runtime.getAuth('cloudflare-ai-gateway');
    assert.equal(auth.auth.headers['cf-aig-authorization'], 'Bearer !test-$NOT_AN_ENV');
    assert.equal(auth.env.CLOUDFLARE_ACCOUNT_ID, 'fixture-account');
    assert.ok(!JSON.stringify(await service.getModelSnapshot()).includes('!test-$NOT_AN_ENV'));
    await service.logout('cloudflare-ai-gateway');
    await login.dispose();
});

test('OAuth bridge handles selection, device/link events, callback prompt cancellation and native credential commit', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    let callback;
    const runtime = await ModelRuntime.create({ authPath: path.join(root, 'fixture-auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider({ id: 'fixture-oauth', name: 'Fixture', getModels: () => [], stream() {}, streamSimple() {}, auth: { oauth: {
        name: 'Fixture OAuth',
        async login(interaction) {
            const method = await interaction.prompt({ type: 'select', message: 'Method', options: [{ id: 'browser', label: 'Browser' }] });
            assert.equal(method, 'browser');
            interaction.notify({ type: 'auth_url', url: 'https://example.com/authorize?state=fixture' });
            interaction.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://example.com/device' });
            interaction.notify({ type: 'auth_url', url: 'javascript:alert(1)' });
            const promptController = new AbortController();
            callback = () => promptController.abort();
            await interaction.prompt({ type: 'manual_code', message: 'Callback URL', signal: promptController.signal }).catch(() => {});
            return { type: 'oauth', access: 'private-access-fixture', refresh: 'private-refresh-fixture', expires: Date.now() + 1000000 };
        }, async refresh(value) { return value; }, async toAuth(value) { return { apiKey: value.access }; }
    } } });
    const login = new PiProviderLoginService(async () => runtime);
    const initial = await login.start('fixture-oauth', 'oauth');
    const prompt = await until(() => login.snapshot(initial.id).prompts[0]);
    assert.throws(() => login.answer(initial.id, { promptId: prompt.id, value: 'invalid' }), /selection/);
    login.answer(initial.id, { promptId: prompt.id, value: 'browser' });
    await until(() => login.snapshot(initial.id).prompts[0]?.type === 'manual_code');
    const waiting = login.snapshot(initial.id);
    assert.equal(waiting.events.length, 2);
    callback();
    await until(() => login.snapshot(initial.id).finished);
    const complete = login.snapshot(initial.id);
    assert.equal(complete.status, 'success');
    assert.equal(complete.prompts.length, 0);
    assert.ok(!JSON.stringify(complete).includes('private-'));
    assert.equal((await runtime.listCredentials()).find(item => item.providerId === 'fixture-oauth').type, 'oauth');
    assert.throws(() => login.answer(initial.id, { promptId: waiting.prompts[0].id, value: 'late-code' }), /失效/);
    await login.dispose();
});

test('committed credentials are reported separately from failed synchronization', async () => {
    const runtime = { getProvider: () => ({ auth: { oauth: { login() {} } } }),
        async login() { throw Object.assign(new Error('private synchronization details'), { name: 'CredentialSynchronizationError', credential: { access: 'private-access' } }); } };
    const login = new PiProviderLoginService(async () => runtime);
    const initial = await login.start('openai-codex', 'oauth');
    await until(() => login.snapshot(initial.id).finished);
    const result = login.snapshot(initial.id);
    assert.equal(result.status, 'committed');
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.match(result.message, /不要重复登录/);
    await login.dispose();
});

test('cancel, expiry and provider failure clear prompts and never expose provider errors or commit late credentials', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ authPath: path.join(root, 'cancel-auth.json'), modelsPath: null, refreshOnCreate: false });
    let late;
    runtime.registerNativeProvider({ id: 'cancel-fixture', name: 'Cancel', getModels: () => [], stream() {}, streamSimple() {}, auth: { apiKey: {
        name: 'Fixture', async login(interaction) {
            await interaction.prompt({ type: 'secret', message: 'Key' });
            await new Promise(resolve => { late = resolve; });
            return { type: 'api_key', key: 'late-private-key' };
        }, async resolve() { return undefined; }
    } } });
    const login = new PiProviderLoginService(async () => runtime);
    const initial = await login.start('cancel-fixture', 'api_key');
    const prompt = await until(() => login.snapshot(initial.id).prompts[0]);
    login.answer(initial.id, { promptId: prompt.id, value: 'secret-answer' });
    await until(() => late);
    login.cancel(initial.id);
    await until(() => login.snapshot(initial.id).finished);
    late();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await runtime.listCredentials()).length, 0);
    assert.equal(login.snapshot(initial.id).status, 'cancelled');
    const expires = new PiProviderLoginService(async () => runtime, { timeoutMs: 30 });
    const exp = await expires.start('cancel-fixture', 'api_key');
    await until(() => expires.snapshot(exp.id).finished);
    assert.equal(expires.snapshot(exp.id).status, 'expired');
    const errors = new PiProviderLoginService(async () => { throw new Error('secret-provider-token'); });
    const err = await errors.start('openai', 'api_key');
    await until(() => errors.snapshot(err.id).finished);
    assert.ok(!JSON.stringify(errors.snapshot(err.id)).includes('secret-provider-token'));
    await Promise.all([login.dispose(), expires.dispose(), errors.dispose()]);
});

test('settings HTTP login handles are protected, non-cacheable and do not start session workers', async t => {
    process.env.PI_PROJECT_ROOTS = root;
    process.env.PI_WEB_TOKEN = 'provider-http-fixture';
    process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
    const express = require('express');
    const { once } = require('node:events');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway();
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi/settings`;
    const request = (url, method = 'GET', body, extra = {}) => fetch(base + url, { method,
        headers: { Authorization: 'Bearer provider-http-fixture', 'Content-Type': 'application/json', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await fetch(base + '/providers/openai/login', { method: 'POST' })).status, 401);
    assert.equal((await request('/providers/openai/login', 'POST', { method: 'api_key' }, { Origin: 'https://untrusted.invalid' })).status, 403);
    const initialResponse = await request('/providers/openai/login', 'POST', { method: 'api_key' });
    assert.equal(initialResponse.status, 200);
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store');
    const initial = await initialResponse.json();
    assert.equal((await request('/providers/openai/login', 'POST', { method: 'api_key' })).status, 409);
    assert.equal((await request('/providers/openai/credential', 'DELETE')).status, 409);
    assert.equal((await request('/login/unknown')).status, 404);
    let promptState;
    for (let n = 0; n < 100; n++) {
        promptState = await (await request(`/login/${initial.id}`)).json();
        if (promptState.prompts.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(promptState.prompts[0].type, 'secret');
    assert.equal((await request(`/login/${initial.id}/answer`, 'POST', { promptId: 'stale', value: 'key' })).status, 409);
    assert.equal((await request(`/login/${initial.id}/answer`, 'POST', { promptId: promptState.prompts[0].id, value: 'x'.repeat(32769) })).status, 400);
    await request(`/login/${initial.id}`, 'DELETE');
    assert.equal(gateway.supervisor.workers.size, 0);
    const snapshot = await (await request('/models')).json();
    assert.equal((await request('/models/thinking', 'PUT', { provider: 'openai', modelId: 'missing', expectedRevision: snapshot.revision })).status, 400);
    assert.equal((await request('/models/thinking', 'PUT', { provider: 'openai', modelId: 'missing', expectedRevision: 'stale' })).status, 409);
    assert.equal((await request('/models/thinking', 'PUT', [])).status, 400);
});

test('thinking defaults and maps use native stores, preserve metadata, support slash IDs and reject stale/invalid configurations', async () => {
    const service = new PiSettingsService({ cwd: root });
    await service.upsertCustomProvider({ id: 'thinking-fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:65530' });
    await service.upsertCustomModel('thinking-fixture', { id: 'org/model:free', reasoning: true, imageInput: true, thinkingLevelMap: { low: null, xhigh: null, max: 'maximum' } });
    await service.setModelPreferences({ defaultProvider: 'thinking-fixture', defaultModel: 'org/model:free' });
    const configPath = path.join(root, 'models.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.providers['thinking-fixture'].models[0].compat = { supportsDeveloperRole: false };
    config.unknown = 'preserved';
    fs.writeFileSync(configPath, JSON.stringify(config));
    let snapshot = await service.getModelSnapshot();
    await service.saveModelThinking({ provider: 'thinking-fixture', modelId: 'org/model:free', defaultThinkingLevel: 'max', expectedRevision: snapshot.revision });
    await assert.rejects(service.saveModelThinking({ provider: 'thinking-fixture', modelId: 'org/model:free', defaultThinkingLevel: 'high', expectedRevision: snapshot.revision }), /配置已变化/);
    snapshot = await service.getModelSnapshot();
    assert.equal(snapshot.preferences.modelThinkingLevels['thinking-fixture/org/model:free'], 'max');
    await assert.rejects(service.saveModelThinking({ provider: 'thinking-fixture', modelId: 'org/model:free', thinkingLevelMap: { max: null }, expectedRevision: snapshot.revision }), /默认/);
    await service.saveModelThinking({ provider: 'thinking-fixture', modelId: 'org/model:free', thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', max: 'maximum' }, expectedRevision: snapshot.revision });
    const runtime = await service.createModelRuntime();
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
    assert.deepEqual(getSupportedThinkingLevels(runtime.getModel('thinking-fixture', 'org/model:free')), ['high', 'max']);
    await service.saveApiKey('thinking-fixture', 'fixture-only-key');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const supervisor = new PiAgentSupervisor();
    try {
        const worker = await supervisor.createEphemeralWorker(root);
        const state = await worker.request('get_state');
        assert.equal(state.model.id, 'org/model:free');
        assert.equal(state.thinkingLevel, 'max');
        assert.deepEqual((await worker.request('get_available_thinking_levels')).levels, ['high', 'max']);
        assert.equal(state.sessionFile, undefined);
    } finally { await supervisor.dispose(); }
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.unknown, 'preserved');
    assert.equal(saved.providers['thinking-fixture'].models[0].compat.supportsDeveloperRole, false);
    require('./private-file-helper.cjs').assertPrivateFile(configPath);
    snapshot = await service.getModelSnapshot();
    const native = snapshot.models.find(item => item.provider === 'openai' && item.reasoning && item.thinkingLevels.includes('high'));
    const originalMap = native.thinkingLevelMap;
    await service.saveModelThinking({ provider: native.provider, modelId: native.id, thinkingLevelMap: { high: null }, expectedRevision: snapshot.revision });
    snapshot = await service.getModelSnapshot();
    assert.ok(!snapshot.models.find(item => item.provider === native.provider && item.id === native.id).thinkingLevels.includes('high'));
    await service.saveModelThinking({ provider: native.provider, modelId: native.id, thinkingLevelMap: null, expectedRevision: snapshot.revision });
    snapshot = await service.getModelSnapshot();
    assert.deepEqual(snapshot.models.find(item => item.provider === native.provider && item.id === native.id).thinkingLevelMap, originalMap);
    await assert.rejects(service.saveModelThinking({ provider: native.provider, modelId: native.id, thinkingLevelMap: { surprise: 'bad' }, expectedRevision: snapshot.revision }), /Invalid/);
    const model = snapshot.models.find(item => item.provider === 'thinking-fixture');
    await assert.rejects(service.saveModelThinking({ provider: model.provider, modelId: model.id, thinkingLevelMap: Object.fromEntries(snapshot.thinkingMapKeys.map(key => [key, null])), expectedRevision: snapshot.revision }), /至少保留/);
});
