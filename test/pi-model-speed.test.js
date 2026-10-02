const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-speed-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root; process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const speed = require('../server/pi-model-speed');
const key = (provider, id) => JSON.stringify([provider, id]);
const wait = async fn => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw Error('fixture timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('capabilities use exact connections; explicit channel declarations and prices are validated', () => {
    const model = { provider: 'openai', api: 'openai-responses', id: 'gpt-6-astra', baseUrl: 'https://api.openai.com/v1' };
    assert.deepEqual(speed.speedCapability(model).levels, ['auto', 'standard', 'fast', 'ultrafast']);
    assert.deepEqual(speed.speedCapability({ ...model, provider: 'proxy' }).levels, []);
    assert.deepEqual(speed.speedCapability({ ...model, baseUrl: 'https://api.openai.com.evil.example/v1' }).levels, []);
    assert.deepEqual(speed.speedCapability({ ...model, id: 'gpt-6-astra-custom' }).levels, []);
    assert.deepEqual(speed.speedCapability({ ...model, api: 'anthropic-messages' }).levels, []);
    assert.deepEqual(speed.speedCapability(model, { [key('openai', model.id)]: { modes: {}, defaultLevel: 'auto' } }).levels, []);
    for (const value of [undefined, { modes: { fast: { serviceTier: 'ultrafast', costMultiplier: 2 } } },
        { modes: { fast: { serviceTier: 'fast', costMultiplier: 0 } } }, { modes: {}, defaultLevel: 'ultrafast' }]) assert.throws(() => speed.validateSpeed(value));
    assert.equal(speed.tierMultiplier('priority', { modes: { fast: { serviceTier: 'fast', costMultiplier: 2.5 } } }), 2.5);
});

test('GPT-5.6 and GPT-6 Fast coverage uses 2x pricing independently of advertised speedup', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) {
        for (const api of ['openai-responses', 'openai-completions']) {
            const model = { id, api, provider: 'openai', baseUrl: 'https://api.openai.com/v1' };
            const capability = speed.speedCapability(model);
            assert.ok(capability.levels.includes('fast'));
            assert.equal(speed.tierMultiplier('priority', capability), 2);
            assert.equal(speed.tierMultiplier('fast', capability), 2);
            assert.deepEqual(speed.speedCapability({ ...model, provider: 'tang' }).levels, []);
            const declared = { defaultLevel: 'auto', modes: { fast: { serviceTier: 'priority', costMultiplier: 2 } } };
            const channel = { ...model, provider: 'tang' };
            assert.deepEqual(speed.speedCapability(channel, { [key(channel.provider, id)]: declared }).levels, ['auto', 'standard', 'fast']);
        }
    }
});

test('actual tiers price once from token counts, including context tiers and provider downgrade', async () => {
    const { finalizeSpeedUsage } = await import('../server/pi-model-speed-runtime.mjs');
    const model = { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 4, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] } };
    const capability = { levels: ['auto', 'standard', 'fast', 'ultrafast'], modes: {
        fast: { serviceTier: 'priority', costMultiplier: 2.5 }, ultrafast: { serviceTier: 'ultrafast', costMultiplier: 6 } } };
    const message = { usage: { input: 6, output: 2, cacheRead: 1, cacheWrite: 0, cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 0, total: 2997 } } };
    const result = finalizeSpeedUsage(message, model, capability, 'ultrafast', 'ultrafast');
    assert.ok(Math.abs(result.usage.cost.total - 0.0000544 * 6) < 1e-12);
    assert.ok(Math.abs(finalizeSpeedUsage(message, model, capability, 'fast', 'default').usage.cost.total - 0.0000544) < 1e-12);
    assert.equal(finalizeSpeedUsage(message, model, capability, 'fast', undefined).pivaneSpeed.serviceTier, null);
    assert.equal(message.usage.cost.total, 2997, 'the source message is not mutated');
});

test('settings, live requests, cross-browser conflicts, model switches and native restoration', { timeout: 90000 }, async t => {
    const requests = []; let downgrade = false;
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); requests.push(input);
        const tier = downgrade ? 'default' : input.service_tier || 'default';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ id: 'fixture-' + requests.length, service_tier: tier,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'SPEED_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const { PiSettingsService } = require('../server/pi-settings-service');
    const settings = new PiSettingsService({ cwd: root });
    await settings.upsertCustomProvider({ id: 'speed-fixture', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', authHeader: true });
    await settings.upsertCustomModel('speed-fixture', { id: 'accelerated', contextWindow: 32000, maxTokens: 1000 });
    await settings.upsertCustomModel('speed-fixture', { id: 'gpt-6-astra', contextWindow: 32000, maxTokens: 1000 });
    await settings.saveApiKey('speed-fixture', 'synthetic-key');
    const configPath = path.join(process.env.PI_CODING_AGENT_DIR, 'models.json');
    const data = JSON.parse(fs.readFileSync(configPath)); data.extraFutureField = { keep: true };
    data.providers['speed-fixture'].models[0].cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    fs.writeFileSync(configPath, JSON.stringify(data));
    const snapshot = await settings.getModelSnapshot();
    assert.deepEqual(snapshot.models.find(m => m.provider === 'speed-fixture' && m.id === 'gpt-6-astra').speed.levels, []);
    const configured = { defaultLevel: 'fast', modes: { fast: { serviceTier: 'priority', costMultiplier: 2.5 }, ultrafast: { serviceTier: 'ultrafast', costMultiplier: 6 } } };
    await settings.saveModelSpeed({ provider: 'speed-fixture', modelId: 'accelerated', expectedRevision: snapshot.revision, speed: configured });
    await assert.rejects(settings.saveModelSpeed({ provider: 'speed-fixture', modelId: 'accelerated', expectedRevision: snapshot.revision, speed: null }), { statusCode: 409 });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).extraFutureField, { keep: true });
    const gateway = createPiAgentGateway(), app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); gateway.attachWebSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`, sockets = [];
    t.after(async () => { for (const ws of sockets) ws.terminate(); await gateway.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); provider.closeAllConnections(); await new Promise(r => provider.close(r)); });
    const session = await gateway.store.createSession(root, 'Speed fixture');
    const connect = async () => {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/pi/ws', { origin: base }); sockets.push(ws);
        const pending = new Map(), events = []; let sequence = 0;
        ws.on('message', raw => { const event = JSON.parse(raw); const item = event.type === 'response' && pending.get(event.id);
            if (item) { clearTimeout(item.timer); pending.delete(event.id); event.success ? item.resolve(event.data) : item.reject(Object.assign(Error(event.error), { code: event.errorCode })); } else events.push(event); });
        await once(ws, 'open');
        const call = (type, input = {}) => new Promise((resolve, reject) => { const id = String(++sequence), timer = setTimeout(() => reject(Error('timeout ' + type)), 20000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, type, ...input })); });
        return { ws, events, call, snapshot: await call('open_session', { cwd: root, sessionId: session.id }) };
    };
    const main = await connect(), other = await connect();
    await main.call('set_model', { provider: 'speed-fixture', modelId: 'accelerated' });
    const state = (await main.call('get_state')).webSpeed;
    assert.equal(state.level, 'fast'); assert.ok(state.levels.includes('ultrafast'));
    const settled = async (message) => { const count = main.events.filter(e => e.type === 'agent_settled').length; await main.call('prompt', { message }); await wait(() => main.events.filter(e => e.type === 'agent_settled').length > count); };
    await settled('Synthetic fast request'); assert.equal(requests.at(-1).service_tier, 'priority');
    let assistant = (await main.call('get_messages')).messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(assistant.pivaneSpeed.serviceTier, 'priority'); assert.ok(Math.abs(assistant.usage.cost.total - 0.000026 * 2.5) < 1e-12);
    const ultra = await main.call('set_model_speed', { runtimeId: state.runtimeId, revision: state.revision, provider: state.provider, modelId: state.modelId, level: 'ultrafast' });
    await assert.rejects(other.call('set_model_speed', { runtimeId: state.runtimeId, revision: state.revision, provider: state.provider, modelId: state.modelId, level: 'standard' }), /已变化/);
    await settled('Synthetic ultra request'); assert.equal(requests.at(-1).service_tier, 'ultrafast');
    assistant = (await main.call('get_messages')).messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(assistant.pivaneSpeed.costMultiplier, 6); assert.ok(Math.abs(assistant.usage.cost.total - 0.000026 * 6) < 1e-12);
    downgrade = true; await settled('Synthetic provider downgrade');
    assistant = (await main.call('get_messages')).messages.filter(m => m.role === 'assistant').at(-1); assert.equal(assistant.pivaneSpeed.serviceTier, 'default'); assert.ok(Math.abs(assistant.usage.cost.total - 0.000026) < 1e-12); downgrade = false;
    await main.call('set_model', { provider: 'speed-fixture', modelId: 'gpt-6-astra' });
    assert.deepEqual((await main.call('get_state')).webSpeed.levels, []);
    await settled('Synthetic ordinary request'); assert.equal(requests.at(-1).service_tier, undefined);
    await main.call('set_model', { provider: 'speed-fixture', modelId: 'accelerated' }); assert.equal((await main.call('get_state')).webSpeed.level, 'ultrafast');
    const fresh = (await main.call('get_state')).webSpeed;
    await main.call('set_model_speed', { ...Object.fromEntries(['runtimeId', 'revision', 'provider', 'modelId'].map(k => [k, fresh[k]])), level: 'standard' });
    await settled('Synthetic standard request'); assert.equal(requests.at(-1).service_tier, 'default');
    const all = (await main.call('get_entries')).entries;
    assert.ok(all.some(e => e.customType === speed.ENTRY && e.data.level === 'ultrafast'));
    assert.equal(requests.length, 5, 'speed and model controls never invoke the model');
    assert.ok(other.events.some(e => e.type === 'gateway_model_speed' && e.speed.level === 'ultrafast'));
    assert.ok(!JSON.stringify(main.events).includes('synthetic-key'));
    main.ws.terminate(); other.ws.terminate(); await gateway.supervisor.stopSession(session.path);
    const restored = await connect(); assert.equal(restored.snapshot.state.webSpeed.level, 'standard');
    assert.notEqual(restored.snapshot.state.webSpeed.runtimeId, ultra.runtimeId);
});

test('usage facts retain bounded speed metadata and reference-price fallback applies its multiplier once', () => {
    const { recordFromEntry } = require('../server/pi-usage-worker');
    const { estimateCost } = require('../server/pi-usage-pricing');
    const entry = { type: 'message', id: 'speed-fact', timestamp: '2026-10-01T00:00:00Z', message: { role: 'assistant', provider: 'proxy', model: 'gpt-6-astra',
        content: [{ type: 'text', text: 'PRIVATE_FIXTURE_TEXT' }],
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        pivaneSpeed: { requested: 'ultrafast', serviceTier: 'ultrafast', costMultiplier: 6, costBasis: 'reported-tier', extraSecret: 'PRIVATE_FIXTURE_SECRET' } } };
    const row = recordFromEntry(entry, new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }), { from: '0000-01-01', to: '9999-12-31' });
    assert.equal(row.speed.costMultiplier, 6); assert.doesNotMatch(JSON.stringify(row), /PRIVATE_FIXTURE/);
    const catalog = new Map([['gpt-6-astra', { rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }]]);
    const result = estimateCost(row, catalog); assert.ok(Math.abs(result.cost - 0.000026 * 6) < 1e-12);
    assert.equal(result.pricing.appliedRates.output, 60); assert.equal(result.pricing.speed.serviceTier, 'ultrafast');
    assert.deepEqual(estimateCost({ ...row, cost: 1 }, catalog), { cost: 1, pricing: null });
    assert.deepEqual(estimateCost({ ...row, speed: { ...row.speed, costMultiplier: null } }, catalog), { cost: 0, pricing: null });
});

test('defaults preserve old conversations and native branches; new children use their own model default', async () => {
    const { registerModelSpeed } = await import('../server/pi-model-speed-extension.mjs');
    const { SessionManager } = await require('../server/pi-session-store').getSdk();
    const dir = path.join(root, 'defaults'); fs.mkdirSync(dir);
    const configuration = { defaultLevel: 'fast', modes: { fast: { serviceTier: 'priority', costMultiplier: 2.5 }, ultrafast: { serviceTier: 'ultrafast', costMultiplier: 6 } } };
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture: { models: [{ id: 'model', pivaneSpeed: configuration }] } } }));
    const create = (old = false, options = {}) => {
        const manager = SessionManager.inMemory(root), handlers = new Map();
        if (old) manager.appendMessage({ role: 'user', content: 'Existing conversation', timestamp: 1 });
        const ctx = { model: { provider: 'fixture', id: 'model', api: 'openai-responses' }, sessionManager: manager, isIdle: () => true, hasPendingMessages: () => false };
        const api = { on: (name, handler) => handlers.set(name, handler), appendEntry: (name, data) => manager.appendCustomEntry(name, data) };
        const control = registerModelSpeed(api, { agentDir: dir, ...options }); handlers.get('session_start')({}, ctx);
        return { manager, handlers, ctx, control };
    };
    const old = create(true); assert.equal(old.control.snapshot(old.ctx).level, 'auto');
    const fresh = create(); assert.equal(fresh.control.snapshot(fresh.ctx).level, 'fast');
    fresh.handlers.get('before_agent_start')({}, fresh.ctx); const leaf = fresh.manager.getLeafId();
    const state = fresh.control.snapshot(fresh.ctx);
    fresh.control.control(fresh.ctx, { runtimeId: state.runtimeId, revision: state.revision, provider: 'fixture', modelId: 'model', level: 'ultrafast' });
    fresh.manager.branch(leaf); fresh.handlers.get('session_tree')({}, fresh.ctx); assert.equal(fresh.control.snapshot(fresh.ctx).level, 'fast');
    const child = create(true, { preserveExisting: false }); assert.equal(child.control.snapshot(child.ctx).level, 'fast');
    const side = create(true, { preserveExisting: false, inherited: { provider: 'fixture', modelId: 'model', level: 'standard' } });
    assert.equal(side.control.snapshot(side.ctx).level, 'standard');
    const { completeWithSpeed } = await import('../server/pi-model-speed-runtime.mjs');
    let payload;
    const response = await completeWithSpeed({ async completeSimple(model, context, options) {
        payload = await options.onPayload({ model: model.id }, model); await options.onProviderStreamEvent({ response: { service_tier: 'priority' } }, model);
        return { usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: {} } };
    } }, { ...fresh.ctx.model, cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } }, {}, {}, dir);
    assert.equal(payload.service_tier, 'priority'); assert.ok(Math.abs(response.usage.cost.total - 0.000026 * 2.5) < 1e-12);
});

test('side Responses API inherits main speed, allows independent switching and records actual service tiers', { timeout: 60000 }, async t => {
    const requests = [];
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
        const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SIDE_SPEED', annotations: [] }] };
        send({ type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress', output: [], service_tier: body.service_tier } });
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'SIDE_SPEED' });
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({ type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', output: [item], service_tier: body.service_tier,
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }); res.end();
    }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const { PiSettingsService } = require('../server/pi-settings-service'), { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const { PiSessionStore } = require('../server/pi-session-store'), { PiSideChatService } = require('../server/pi-side-chat');
    const settings = new PiSettingsService({ cwd: root });
    await settings.upsertCustomProvider({ id: 'response-fixture', api: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, authHeader: true });
    await settings.upsertCustomModel('response-fixture', { id: 'response-model', contextWindow: 32000, maxTokens: 1000 }); await settings.saveApiKey('response-fixture', 'synthetic-key');
    await settings.saveModelAdvanced({ provider: 'response-fixture', modelId: 'response-model', expectedRevision: await settings.configRevision(), cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const modes = { fast: { serviceTier: 'priority', costMultiplier: 2.5 }, ultrafast: { serviceTier: 'ultrafast', costMultiplier: 6 } };
    await settings.saveModelSpeed({ provider: 'response-fixture', modelId: 'response-model', expectedRevision: await settings.configRevision(), speed: { defaultLevel: 'ultrafast', modes } });
    const supervisor = new PiAgentSupervisor(), store = new PiSessionStore(), service = new PiSideChatService({ store, supervisor });
    t.after(async () => { await service.dispose(); await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    const events = [], owner = { readyState: 1 };
    const source = { model: { provider: 'response-fixture', id: 'response-model', name: 'Fixture', contextWindow: 32000, maxTokens: 1000, input: ['text'] },
        speed: { provider: 'response-fixture', modelId: 'response-model', level: 'fast' }, thinkingLevel: 'off', systemPrompt: 'Synthetic context',
        messages: [{ role: 'user', content: 'Existing main context', timestamp: 1 }], source: { cwd: root, sessionId: 'source', name: 'Synthetic main' } };
    const ticket = await service.prepare(owner, { cwd: root, captureContext: async () => structuredClone(source) }, { mode: 'context' }, () => true);
    const side = service.claim(ticket.ticket, { close() {} }, event => events.push(event)); const opened = await side.ready;
    assert.equal(opened.state.speed.level, 'fast');
    const prompt = async () => { const count = events.filter(e => e.type === 'agent_settled').length; await side.handle({ type: 'prompt', message: 'Synthetic side speed request' }); await wait(() => events.filter(e => e.type === 'agent_settled').length > count); };
    await prompt(); assert.equal(requests.at(-1).service_tier, 'priority');
    const state = (await side.handle({ type: 'get_state' })).speed;
    await side.handle({ type: 'set_side_speed', runtimeId: state.runtimeId, revision: state.revision, provider: state.provider, modelId: state.modelId, level: 'ultrafast' });
    await prompt(); assert.equal(requests.at(-1).service_tier, 'ultrafast');
    const assistant = (await side.handle({ type: 'get_messages' })).messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(assistant.pivaneSpeed.serviceTier, 'ultrafast'); assert.ok(Math.abs(assistant.usage.cost.total - 0.000026 * 6) < 1e-12);
    assert.equal(source.speed.level, 'fast'); assert.equal(requests.length, 2);
});

test('late private speed replies remain private and uncertainty disposes the exclusively reserved worker', async () => {
    const { PiModelSpeedControl } = require('../server/pi-model-speed-control'); let reserved = false, disposed = false;
    const worker = { navigationToken: 'fixture', _broadcast() {}, async dispose() { assert.equal(reserved, true); disposed = true; },
        async exclusive(fn) { reserved = true; try { return await fn(); } finally { reserved = false; } }, client: { async request(type) {
            if (type === 'get_commands') return { commands: [{ name: 'pivane-web-navigate', description: 'speed-v1' }] };
            throw Object.assign(Error('timeout'), { code: 'RPC_TIMEOUT' });
        } } };
    const control = new PiModelSpeedControl(worker); assert.equal(control.handle({ pivaneSpeedReply: 'unknown', success: true }), true);
    await assert.rejects(control.set({ level: 'fast' }), { code: 'RPC_TIMEOUT' }); assert.equal(disposed, true); assert.equal(control.pending.size, 0);
});
