const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-media-connections-test-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'queue.json'); process.env.PI_WEB_TOKEN = 'connection-test-token'; process.env.PI_OFFLINE = '1';
const { MediaProviderService, normalizeModel, normalizeProvider } = require('../server/media-provider-service');
const { MediaProviderCredentials } = require('../server/media-provider-credentials');
const { MediaHttpExecutor, validateHttp, renderTemplate, readBounded } = require('../server/media-http-protocol');
const { connectionTemplates, validateConnectionDraft, redactDocumentation } = require('../server/media-connection-planner');
const { MediaLabService } = require('../server/media-lab-service');
const { saveExternalMedia, mediaHistory } = require('../server/media-lab-storage');
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const wav = Buffer.alloc(52); wav.write('RIFF'); wav.writeUInt32LE(44, 4); wav.write('WAVE', 8);
const mp4 = Buffer.concat([Buffer.from([0,0,0,16]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const secret = 'fixture-media-secret';
const copy = value => JSON.parse(JSON.stringify(value));
const definition = () => ({ ...copy(connectionTemplates()[0].model), id: 'image', name: 'Fixture Image', remoteModel: 'fixture-remote' });
const providerDefinition = baseUrl => ({ id: 'fixture', name: 'Fixture Provider', baseUrl, auth: { mode: 'bearer' }, probePath: '/models', modelsPath: '/models', downloadOrigins: [] });
function memoryCredentials() {
    const values = new Map();
    return { values, list: async () => new Set(values.keys()), get: async id => values.get(id) || '', save: async (id, key) => { values.set(id, key); }, remove: async id => { values.delete(id); } };
}
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(root, 'config-')), requests = [], cdnRequests = [];
    let resultMode = 'normal', release;
    const cdn = http.createServer((req, res) => { cdnRequests.push({ url: req.url, headers: req.headers }); res.setHeader('Content-Type','image/png'); res.end(png); });
    cdn.listen(0, '127.0.0.1'); await once(cdn, 'listening');
    const cdnUrl = `http://127.0.0.1:${cdn.address().port}`;
    let queries = 0;
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        requests.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/models') return res.end(JSON.stringify({ data: [{ id: 'fixture-remote', name: 'Fixture' }] }));
        if (req.url === '/api/images/generations') {
            if (resultMode === 'hold') await new Promise(resolve => { release = resolve; });
            if (resultMode === 'failure') { res.writeHead(400); return res.end(JSON.stringify({ error: secret })); }
            if (resultMode === 'redirect') { res.writeHead(307, { Location: '/api/images/generations' }); return res.end(); }
            return res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        }
        if (req.url === '/api/audio/speech' || req.url.startsWith('/api/voices/')) { res.setHeader('Content-Type','audio/wav'); return res.end(wav); }
        if (req.url === '/api/url') return res.end(JSON.stringify({ output: resultMode === 'untrusted' ? 'http://127.0.0.1:1/not-allowed' : resultMode === 'secret-url' ? cdnUrl + '/image?key=' + secret : '/api/redirect' }));
        if (req.url === '/api/redirect') { res.writeHead(302, { Location: cdnUrl + (resultMode === 'secret-redirect' ? '/image?key=' + secret : '/image?signature=fixture') }); return res.end(); }
        if (req.url === '/api/video/generations') { queries = 0; return res.end(JSON.stringify({ id: 'task-1' })); }
        if (req.url === '/api/tasks/task-1') {
            queries++;
            if (resultMode === 'failed-task') return res.end(JSON.stringify({ status: 'failed', error: secret }));
            if (resultMode === 'timeout' || queries === 1) return res.end(JSON.stringify({ status: 'running' }));
            return res.end(JSON.stringify({ status: 'succeeded', output: { url: '/api/video.mp4' } }));
        }
        if (req.url === '/api/video.mp4') { res.setHeader('Content-Type','video/mp4'); return res.end(mp4); }
        if (req.url === '/api/operation') { queries = 0; return res.end(JSON.stringify({ name: 'operations/fixture' })); }
        if (req.url === '/api/operations/fixture') { queries++; return res.end(JSON.stringify(queries === 1 ? {} : { done: true, output: { url: '/api/video.mp4' } })); }
        res.writeHead(404); res.end('{}');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const credentials = memoryCredentials();
    const providers = new MediaProviderService({ directory, credentials, clean: false });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    t.after(async () => { release?.(); server.closeAllConnections(); cdn.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => cdn.close(resolve))]); });
    const mutation = async extra => ({ ...(await providers.snapshot()), confirmed: true, expectedRevision: (await providers.snapshot()).revision, ...extra });
    await providers.saveProvider(await mutation({ provider: providerDefinition(baseUrl), create: true }));
    await providers.setKey('fixture', await mutation({ apiKey: secret }));
    const model = definition(); await providers.saveModel('fixture', await mutation({ model }));
    const lab = new MediaLabService({ profile: { directory, image: {}, models: [] }, providerService: providers, videoService: { getConfig: async () => ({ models: [] }) },
        ttsService: { getPublicConfig: () => ({ providers: [] }) }, httpExecutor: new MediaHttpExecutor({ delay: async () => {} }),
        saveExternal: input => saveExternalMedia(directory, input), history: kind => mediaHistory(directory, kind) });
    return { directory, requests, cdnRequests, cdnUrl, credentials, providers, baseUrl, lab, mutation, mode: value => { resultMode = value; }, release: () => release?.() };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('media credentials use native Pi login/logout, preserve literal keys and expose no chat models', async () => {
    const authPath = path.join(root, 'native', 'auth.json');
    const credentials = new MediaProviderCredentials({ authPath });
    await credentials.save('unrelated', 'another-fixture-key');
    const sentinel = path.join(root, 'must-not-execute');
    const key = '!touch ' + sentinel + ' $MEDIA_CONNECTION_FIXTURE';
    await credentials.save('target', key);
    assert.equal(await credentials.get('target'), key);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal((await credentials.runtime()).getModels('pi5-media:target').length, 0);
    require('./private-file-helper.cjs').assertPrivateFile(authPath);
    const fresh = new MediaProviderCredentials({ authPath }); assert.equal(await fresh.get('target'), key);
    await fresh.remove('target'); assert.equal(await credentials.get('target'), '');
    assert.equal(await credentials.get('unrelated'), 'another-fixture-key');
});

test('Qwen speech template uses the native input envelope and URL response, with documented system voices', () => {
    const template = connectionTemplates().find(item => item.id === 'qwen-speech');
    const model = normalizeModel(template.model);
    assert.equal(model.remoteModel, 'qwen-tts');
    assert.equal(model.http.path, '/api/v1/services/aigc/multimodal-generation/generation');
    assert.deepEqual(renderTemplate(model.http.body, { input: '你好', voice: 'Cherry', language_type: 'Chinese' }, model.remoteModel), { model: 'qwen-tts', input: { text: '你好', voice: 'Cherry', language_type: 'Chinese' } });
    assert.deepEqual(model.http.response, { type: 'url', path: ['output','audio','url'], mimeType: 'audio/wav' });
    assert.ok(model.parameters.voice.choices.includes('Cherry'));
    assert.match(template.help, /compatible-mode/);
    assert.equal(validateConnectionDraft({ model, summary: 'Qwen native' }).execution.count, 0);
});

test('common protocol templates execute single outputs with optional fields omitted and mixed Gemini parts', async () => {
    const { connectionSchema } = require('../server/media-connection-planner');
    const { validateParameters } = require('../server/media-lab-service');
    const { Response } = require('node-fetch');
    for (const preset of connectionSchema().providerTemplates) normalizeProvider(preset);
    for (const templateId of ['gpt-image','gpt-image-url','gemini-image','ark-image','ark-video']) {
        const template = connectionTemplates().find(item => item.id === (templateId === 'gpt-image-url' ? 'gpt-image' : templateId));
        const model = normalizeModel({ ...copy(template.model), remoteModel: 'user-model' });
        const parameters = validateParameters(model.parameters, { prompt: 'A fixture' });
        assert.deepEqual(parameters, { prompt: 'A fixture' });
        const calls = [];
        const executor = new MediaHttpExecutor({ delay: async () => {}, fetch: async (url, options) => {
            calls.push({ url: String(url), ...options });
            const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
            if (options.method === 'POST') {
                const body = JSON.parse(options.body);
                assert.equal(Object.hasOwn(body, 'size'), false);
                if (templateId === 'gpt-image-url') return json({ data: [{ url: 'https://cdn.example.invalid/output' }] });
                if (templateId === 'gpt-image') { assert.equal(body.model, 'user-model'); assert.equal(Object.hasOwn(body, 'response_format'), false); return json({ data: [{ b64_json: png.toString('base64') }] }); }
                if (templateId === 'gemini-image') {
                    assert.match(String(url), /\/models\/user-model:generateContent$/);
                    assert.equal(body.contents[0].parts[0].text, 'A fixture');
                    assert.equal(options.headers['x-goog-api-key'], secret);
                    return json({ candidates: [{ content: { parts: [{ text: 'Here is your image' }, { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] });
                }
                if (templateId === 'ark-image') return json({ data: [{ url: 'https://cdn.example.invalid/output' }] });
                assert.equal(body.content[0].text, 'A fixture'); assert.equal(Object.hasOwn(body, 'duration'), false);
                return json({ id: 'task-custom' });
            }
            if (String(url).endsWith('/contents/generations/tasks/task-custom')) return json({ status: 'succeeded', content: { video_url: 'https://cdn.example.invalid/output' } });
            assert.equal(options.headers.Authorization, undefined);
            return new Response(templateId === 'ark-video' ? mp4 : png);
        } });
        const provider = normalizeProvider({ ...providerDefinition('https://api.example.invalid/v1'), auth: templateId === 'gemini-image' ? { mode: 'header', header: 'x-goog-api-key' } : { mode: 'bearer' }, downloadOrigins: ['https://cdn.example.invalid'] });
        const result = await executor.execute({ provider, key: secret, model, parameters });
        assert.ok(result.bytes.equals(templateId === 'ark-video' ? mp4 : png));
        assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    }
});

test('laboratory catalog excludes legacy image/video adapters even when configured and retains user models', async () => {
    const { loadMediaProfile } = require('../server/media-profile');
    const profile = loadMediaProfile(path.join(__dirname, '..'), { PI_MEDIA_PROFILE: 'clean', PI_MEDIA_CONFIG_DIR: path.join(root, 'empty-profile') });
    const videoService = { getConfig: async () => ({ configured: false, models: [] }) };
    const lab = new MediaLabService({ profile, videoService, ttsService: { getPublicConfig: () => ({ providers: [] }) } });
    assert.deepEqual((await lab.catalog()).models, []);
    profile.models.push({ ...definition(), adapter: 'manual' });
    assert.deepEqual((await lab.catalog()).models.map(item => item.id), ['image']);
    lab.fluxBaseUrl = 'http://fixture.invalid';
    assert.equal((await lab.catalog('image')).models.some(item => item.id === 'flux-2-dev'), false);
    videoService.getConfig = async () => ({ configured: true, models: [{ id: 'MiniMax-H3', name: 'Legacy', resolutions: ['768P'], minDuration: 4, maxDuration: 15 }], ratios: ['16:9'] });
    assert.deepEqual((await lab.catalog('video')).models, []);
});

test('model protocols reject executable templates, credential fields, malformed paths and unsupported formats', () => {
    const model = definition();
    assert.equal(normalizeModel(model).http.response.type, 'base64');
    for (const body of [{ value: { $eval: 'arbitrary()' } }, { value: { $param: 'not-defined' } }, JSON.parse('{"__proto__":{}}'), { api_key: 'must-not-be-here' }]) {
        assert.throws(() => normalizeModel({ ...model, http: { ...model.http, body } }));
    }
    assert.throws(() => normalizeModel({ ...model, http: { ...model.http, path: 'https://other.invalid/run' } }));
    assert.throws(() => normalizeModel({ ...model, http: { ...model.http, path: '/run?key=literal-secret' } }));
    assert.throws(() => normalizeModel({ ...model, http: { ...model.http, response: { type: 'binary', mimeType: 'audio/wav' } } }));
    assert.throws(() => normalizeProvider({ ...providerDefinition('https://example.invalid/v1'), apiKey: 'forbidden' }));
    assert.throws(() => normalizeProvider({ ...providerDefinition('https://example.invalid?key=bad') }));
    assert.throws(() => normalizeProvider({ ...providerDefinition('https://example.invalid'), downloadOrigins: ['https://cdn.example.invalid/some/path'] }));
    assert.throws(() => normalizeProvider({ ...providerDefinition('https://example.invalid'), auth: { mode: 'header', header: 'Host' } }));
    const parameters = { nested: { tags: ['mint','navy'] }, flag: false, zero: 0 };
    assert.deepEqual(renderTemplate({ model: { $model: true }, data: { $param: 'nested' }, x: { $param: 'flag' }, n: { $param: 'zero' }, optional: { $param: 'missing' } }, parameters, 'remote'), { model: 'remote', data: parameters.nested, x: false, n: 0 });
    assert.throws(() => renderTemplate({ repeated: Array(200).fill({ $params: true }) }, { data: 'x'.repeat(64000) }, 'remote'), /4MiB/);
});

test('provider/model CRUD preserves private files, detects stale edits, and rebinds keys on origin changes', async t => {
    const f = await fixture(t);
    const privateFile = path.join(f.directory, 'profile.json'); fs.writeFileSync(privateFile, '{"private":"unchanged"}');
    const before = fs.readFileSync(privateFile);
    const old = await f.providers.snapshot();
    assert.equal(old.providers[0].keyConfigured, true);
    assert.equal(JSON.stringify(old).includes(secret), false);
    assert.equal(fs.readFileSync(f.providers.file, 'utf8').includes(secret), false);
    require('./private-file-helper.cjs').assertPrivateFile(f.providers.file);
    await assert.rejects(f.providers.saveProvider({ expectedRevision: old.revision, confirmed: false, provider: providerDefinition(f.baseUrl) }), /confirmation/);
    await f.providers.saveProvider({ expectedRevision: old.revision, confirmed: true, provider: { ...providerDefinition('https://new-origin.invalid/api'), name: 'Changed origin' } });
    await assert.rejects(f.providers.setKey('fixture', { expectedRevision: old.revision, confirmed: true, apiKey: 'replacement' }), /changed/);
    let state = await f.providers.snapshot(); assert.equal(state.providers[0].keyConfigured, false); assert.equal(state.providers[0].keyNeedsRebind, true);
    await f.providers.setKey('fixture', await f.mutation({ apiKey: 'replacement' }));
    state = await f.providers.snapshot(); assert.equal(state.providers[0].keyConfigured, true);
    await assert.rejects(f.providers.removeProvider('fixture', await f.mutation({})), /models first/);
    await f.providers.removeProvider('fixture', await f.mutation({ removeModels: true }));
    assert.equal((await f.providers.snapshot()).providers.length, 0); assert.equal(f.credentials.values.has('fixture'), false);
    assert.ok(fs.readFileSync(privateFile).equals(before));
    for (const file of fs.readdirSync(f.directory).filter(file => file.includes('.bak-'))) require('./private-file-helper.cjs').assertPrivateFile(path.join(f.directory, file));
});

test('review shows the mapped request, execution is once-only, and provider mutations cannot redirect reviewed/running tasks', async t => {
    const f = await fixture(t); const input = { modelId: 'media:fixture:image', parameters: { prompt: 'A fixture landscape', size: '1024x1024' } };
    const initial = [{ id: 'old', filename: 'old.png', imageUrl: '/images/old.png' }];
    fs.writeFileSync(path.join(f.directory, 'generation_history.json'), JSON.stringify(initial));
    const review = await f.lab.review(input);
    assert.equal(f.requests.length, 0); assert.equal(review.request.url, f.baseUrl + '/images/generations');
    assert.equal(review.request.body.model, 'fixture-remote'); assert.equal(review.request.body.n, 1); assert.equal(JSON.stringify(review).includes(secret), false);
    await f.providers.setKey('fixture', await f.mutation({ apiKey: secret }));
    await assert.rejects(f.lab.execute(review.ticket), /changed after review/); assert.equal(f.requests.length, 0);
    const next = await f.lab.review(input); f.mode('hold'); const generating = f.lab.execute(next.ticket);
    while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.lab.executionStatus(next.ticket).progress.stage, 'submitting');
    await assert.rejects(f.lab.execute(next.ticket), /already running/);
    await assert.rejects(f.providers.removeKey('fixture', await f.mutation({})), /being used/);
    f.release(); const result = await generating;
    assert.equal(f.requests[0].headers.authorization, `Bearer ${secret}`);
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
    assert.deepEqual(await f.lab.execute(next.ticket), result);
    assert.equal(result.result.asset.provider, 'fixture');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'generation_history.json')))[0], initial[0]);
    await f.providers.removeProvider('fixture', await f.mutation({ removeModels: true }));
    assert.ok(fs.existsSync(path.join(f.directory, 'public/images', result.result.asset.filename)));
});

test('binary audio, URL download and redirects retain file limits and never forward keys to CDN origins', async t => {
    const f = await fixture(t), provider = { ...normalizeProvider(providerDefinition(f.baseUrl)), downloadOrigins: [f.cdnUrl] };
    const executor = new MediaHttpExecutor();
    const speech = normalizeModel({ ...copy(connectionTemplates()[2].model), remoteModel: 'voice-fixture' });
    const audio = await executor.execute({ provider, key: secret, model: speech, parameters: { input: 'Hello', voice: 'voice-a', speed: 1, response_format: 'wav' } });
    assert.equal(audio.mimeType, 'audio/wav'); assert.ok(audio.bytes.equals(wav));
    const voicePathModel = normalizeModel({ ...speech, http: { ...speech.http, path: '/voices/{param:voice}' } });
    await executor.execute({ provider: { ...provider, auth: { mode: 'header', header: 'xi-api-key', prefix: 'Token ' } }, key: secret, model: voicePathModel, parameters: { input: 'Hello', voice: 'voice/a b', speed: 1, response_format: 'wav' } });
    assert.equal(f.requests.at(-1).url, '/api/voices/voice%2Fa%20b');
    assert.equal(f.requests.at(-1).headers['xi-api-key'], 'Token ' + secret); assert.equal(f.requests.at(-1).headers.authorization, undefined);
    const model = normalizeModel({ ...definition(), http: { path: '/url', body: { prompt: { $param: 'prompt' } }, response: { type: 'url', path: ['output'], mimeType: 'auto' } } });
    const image = await executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } });
    assert.ok(image.bytes.equals(png)); assert.equal(f.cdnRequests.length, 1); assert.equal(f.cdnRequests[0].headers.authorization, undefined);
    f.mode('untrusted'); await assert.rejects(executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } }), /origin is not allowed/);
    f.mode('secret-url'); await assert.rejects(executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } }), /must not contain/);
    f.mode('secret-redirect'); await assert.rejects(executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } }), /must not contain/);
    assert.equal(f.cdnRequests.length, 1);
    const response = new (require('node-fetch').Response)(Buffer.alloc(1024));
    await assert.rejects(readBounded(response, 100), /too large/);
});

test('asynchronous tasks poll by ID or response URL, preserve task IDs on failure/timeout, and never resubmit', async t => {
    const f = await fixture(t), provider = normalizeProvider(providerDefinition(f.baseUrl));
    const model = normalizeModel({ ...copy(connectionTemplates().find(template => template.id === 'async-video').model), remoteModel: 'video-fixture' });
    const executor = new MediaHttpExecutor({ delay: async () => {} }), progress = [];
    const result = await executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' }, progress: value => progress.push(value) });
    assert.equal(result.taskId, 'task-1'); assert.ok(result.bytes.equals(mp4)); assert.ok(progress.some(value => value.stage === 'polling' && value.taskId === 'task-1'));
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 1);
    f.mode('failed-task'); await assert.rejects(executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } }), error => error.taskId === 'task-1' && !error.message.includes(secret));
    const operation = normalizeModel({ ...model, http: { ...model.http, path: '/operation', poll: { idPath: ['name'], urlPath: ['name'], statusPath: ['done'], pending: [false, null], succeeded: [true], failed: ['error'], intervalMs: 1000 } } });
    const boolResult = await executor.execute({ provider, key: secret, model: operation, parameters: { prompt: 'fixture' } });
    assert.equal(boolResult.taskId, 'operations/fixture');
    f.mode('timeout'); const timed = normalizeModel({ ...model, http: { ...model.http, timeoutMs: 1000 } });
    await assert.rejects(new MediaHttpExecutor().execute({ provider, key: secret, model: timed, parameters: { prompt: 'fixture' } }), error => /timed out/.test(error.message) && error.taskId === 'task-1');
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 4);
});

test('submission HTTP failures and redirects do not retry or expose provider response bodies', async t => {
    const f = await fixture(t), executor = new MediaHttpExecutor(), provider = normalizeProvider(providerDefinition(f.baseUrl)), model = normalizeModel(definition());
    f.mode('failure'); await assert.rejects(executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } }), error => /HTTP 400/.test(error.message) && !error.message.includes(secret));
    f.mode('redirect'); await assert.rejects(executor.execute({ provider, key: secret, model, parameters: { prompt: 'fixture' } }), /HTTP 307/);
    assert.equal(f.requests.length, 2);
});

test('connection drafts validate unsupported protocols and redact documentation credentials', () => {
    const cleaned = redactDocumentation('Authorization: Bearer fixture-media-secret\napi_key="another-example-secret"\n说明 fixture-media-secret', secret);
    assert.equal(cleaned.includes(secret), false); assert.equal(cleaned.includes('another-example-secret'), false);
    assert.equal(validateConnectionDraft({ summary: 'Needs signing', unsupported: ['Request signing is unsupported'] }).model, null);
    assert.throws(() => validateConnectionDraft({ summary: 'Draft', model: definition() }, { kind: 'tts' }));
    assert.throws(() => validateConnectionDraft({ summary: 'Draft', model: definition() }, { remoteModel: 'another-model' }));
    assert.equal(validateConnectionDraft({ summary: 'Draft', model: definition() }).execution.count, 0);
});

test('connection gateway enforces token/origin, revision, project checks and no implicit generation or Pi workers', async t => {
    const f = await fixture(t), gateway = createPiAgentGateway({ mediaLabService: f.lab, mediaAgentService: {} });
    const app = express(); app.use(express.json()); gateway.mount(app); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi/media/lab`;
    const request = (route, body, headers = {}) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer connection-test-token', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await fetch(base + '/connections')).status, 401);
    assert.equal((await request('/connections', undefined, { Origin: 'https://other.invalid' })).status, 403);
    const snapshot = await (await request('/connections')).json(); assert.equal(snapshot.templates.length, connectionTemplates().length); assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal((await request('/connection-plan', { providerId: 'fixture', cwd: '/etc', kind: 'image', remoteModel: 'fixture', documentation: 'Docs' })).status, 400);
    assert.equal((await request('/providers/fixture/probe', { mode: 'models', confirmed: false })).status, 400);
    const models = await (await request('/providers/fixture/probe', { mode: 'models', confirmed: true })).json(); assert.equal(models.models[0].id, 'fixture-remote');
    assert.equal(f.requests.filter(item => item.method === 'POST').length, 0);
    assert.equal(gateway.supervisor.workers.size, 0);
});
