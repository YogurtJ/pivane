const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const express = require('express');
const { PiTranscriptionService, transcriptionModels, mountTranscriptionRoutes, audioBytes } = require('../server/pi-transcription-service');
const mimo = { provider: 'fixture-mimo', id: 'mimo-v2.5', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' };
const openai = { provider: 'fixture-asr', id: 'whisper-1', baseUrl: 'http://127.0.0.1:1234/v1' };
const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
const audio = { format: 'wav', data: wav.toString('base64') };
const response = value => ({ ok: true, body: Readable.from([Buffer.from(JSON.stringify(value))]) });
function fixture(options = {}) {
    const models = options.models || [mimo]; let calls = 0, request;
    const runtime = { getModels: () => models, getAvailable: async () => models, getAuth: async () => ({ auth: { apiKey: 'fixture-credential' } }) };
    const service = new PiTranscriptionService({ createModelRuntime: async () => runtime, fetch: async (url, options) => { calls++; request = { url: String(url), ...options }; return response({ choices: [{ finish_reason: 'stop', message: { content: ' 转录文字 ' } }] }); }, ...options });
    const input = async () => { const catalog = await service.catalog(); return { requestId: 'fixture-request-0001', modelId: catalog.models[0].id, revision: catalog.revision, language: 'auto', audio, confirmed: true, cwd: '/fixture' }; };
    return { service, input, runtime, calls: () => calls, request: () => request };
}
test('ASR catalog uses configured authenticated providers and explicit supported audio protocols', () => {
    const models = transcriptionModels([mimo, openai, { ...mimo, provider: 'missing' }, { ...mimo, provider: 'evil', baseUrl: 'https://token-plan-cn.xiaomimimo.com.evil/v1' }, { ...mimo, provider: 'userinfo', baseUrl: 'https://key@api.xiaomimimo.com/v1' }], [mimo, openai, { provider: 'evil' }, { provider: 'userinfo' }]);
    assert.deepEqual(models.map(model => [model.provider, model.modelId, model.protocol]), [['fixture-mimo', 'mimo-v2.5-asr', 'mimo'], ['fixture-asr', 'whisper-1', 'openai']]);
});
test('MiMo transcribes once, binds the upload to its request ID, and protects the in-flight lifecycle', async () => {
    let release, auth;
    const f = fixture({ fetch: async (url, options) => { auth = options.headers; await new Promise(resolve => release = resolve); return response({ choices: [{ finish_reason: 'stop', message: { content: '转录文字' } }] }); } });
    const input = await f.input(); const pending = f.service.transcribe(input);
    assert.ok(f.service.active > 0); assert.equal(f.service.transcribe(input), pending);
    assert.throws(() => f.service.transcribe({ ...input, language: 'zh' }), /标识/);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(auth['api-key'], 'fixture-credential');
    release(); assert.deepEqual(await pending, { text: '转录文字', model: { provider: 'fixture-mimo', id: 'mimo-v2.5-asr' } });
    assert.equal(f.service.active, 0); assert.equal(f.service.transcribe(input), pending);
    await f.service.dispose(); assert.throws(() => f.service.transcribe(input), /关闭/);
});
test('transcription validates confirmation, format, model revision and credentials before uploading', async () => {
    const f = fixture(), input = await f.input();
    assert.throws(() => f.service.transcribe({ ...input, confirmed: false }), /请求无效/);
    assert.throws(() => f.service.transcribe({ ...input, audio: { format: 'mp3', data: audio.data } }), /格式不符/);
    assert.throws(() => f.service.transcribe({ ...input, audio: { format: 'wav', data: '$invalid' } }), /格式无效/);
    await assert.rejects(f.service.transcribe({ ...input, revision: 'old' }), /配置已变化/);
    assert.equal(f.calls(), 0);
    f.runtime.getAuth = async () => undefined;
    await assert.rejects(f.service.transcribe({ ...input, requestId: 'fixture-request-0002' }), /API Key/);
    assert.equal(f.calls(), 0);
});
test('two-minute and maximum-sized recordings validate without recursive regular expressions', () => {
    for (const size of [120 * 16000 * 2 + 44, 7_500_000]) {
        const bytes = Buffer.alloc(size); bytes.write('RIFF'); bytes.write('WAVE', 8);
        assert.equal(audioBytes({ format: 'wav', data: bytes.toString('base64') }).length, size);
    }
    assert.throws(() => audioBytes({ format: 'wav', data: audio.data.replace(/.$/, '=') + '=' }), /格式无效/);
});

test('OpenAI compatible ASR sends multipart audio to the configured endpoint', async () => {
    const f = fixture({ models: [openai], fetch: async (url, options) => {
        assert.equal(String(url), 'http://127.0.0.1:1234/v1/audio/transcriptions');
        assert.equal(options.headers.Authorization, 'Bearer fixture-credential');
        assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
        assert.ok(options.body.includes(wav)); assert.match(options.body.toString(), /name="model"\r\n\r\nwhisper-1/);
        return response({ text: 'multipart transcript' });
    } });
    assert.equal((await f.service.transcribe(await f.input())).text, 'multipart transcript');
});
test('network failures are sanitized and repeated uncertain requests are not replayed', async () => {
    let calls = 0;
    const f = fixture({ fetch: async () => { calls++; throw new Error('fixture-credential in transport internals'); } }), input = await f.input();
    const pending = f.service.transcribe(input);
    await assert.rejects(pending, error => /未自动重试/.test(error.message) && !error.message.includes('fixture-credential'));
    await assert.rejects(f.service.transcribe(input), /未自动重试/); assert.equal(calls, 1);
});
test('transcription routes validate the project and do not start a session worker', async () => {
    const f = fixture(), app = express(); app.use(express.json());
    mountTranscriptionRoutes(app, f.service, { resolveProject: cwd => { if (cwd !== '/fixture') throw Object.assign(new Error('Invalid project'), { statusCode: 400 }); return cwd; } });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const catalog = await fetch(base + '/composer/transcription'); assert.equal(catalog.headers.get('cache-control'), 'no-store');
        const input = await f.input();
        const invalid = await fetch(base + '/composer/transcription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, cwd: '/invalid' }) });
        assert.equal(invalid.status, 400); assert.equal(f.calls(), 0);
        const result = await fetch(base + '/composer/transcription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        assert.equal((await result.json()).text, '转录文字'); assert.equal(f.calls(), 1);
    } finally { server.close(); await f.service.dispose(); }
});

function managedFixture(t, fetch) {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-asr-settings-'));
    const values = new Map();
    const credentials = { list: async () => new Set(values.keys()), save: async (id, key) => { values.set(id, key); }, get: async id => values.get(id), remove: async id => { values.delete(id); } };
    const { MediaProviderService } = require('../server/media-provider-service');
    const providers = new MediaProviderService({ directory, credentials, clean: false });
    fs.writeFileSync(providers.file, JSON.stringify({ version: 1, providers: [], unrelated: { preserved: true } }));
    const runtime = { getModels: () => [], getAvailable: async () => [], getAuth: async () => { throw Error('Managed speech must not need a chat provider'); } };
    const service = new PiTranscriptionService({ createModelRuntime: async () => runtime, providerService: providers, fetch });
    t.after(async () => { await service.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    const stamp = async () => ({ confirmed: true, expectedRevision: (await providers.snapshot()).revision });
    const model = { id: 'custom-asr', providerId: 'speech', name: 'Custom speech', remoteModel: 'arbitrary-audio-model', protocol: 'openai' };
    const provider = { id: 'speech', name: 'Speech', baseUrl: 'https://speech.fixture.invalid/v1', auth: { mode: 'bearer' }, downloadOrigins: [] };
    const input = async requestId => { const catalog = await service.catalog(); return { requestId, modelId: catalog.models[0].id, revision: catalog.revision, language: 'auto', audio, confirmed: true }; };
    return { service, providers, values, stamp, model, provider, input };
}

test('independent ASR models share native media credentials without registering a chat model or exposing a Key', async t => {
    let uploaded = 0;
    const f = managedFixture(t, async (url, options) => {
        uploaded++; assert.equal(String(url), 'https://speech.fixture.invalid/v1/audio/transcriptions');
        assert.equal(options.headers.Authorization, 'Bearer synthetic-speech-key');
        assert.match(options.body.toString(), /arbitrary-audio-model/);
        return response({ text: 'independent transcription' });
    });
    const saved = await f.service.saveModel({ ...await f.stamp(), model: f.model, provider: f.provider, apiKey: 'synthetic-speech-key' });
    assert.equal(saved.modelId, 'asr:speech:custom-asr');
    assert.equal(JSON.stringify(await f.service.configuration()).includes('synthetic-speech-key'), false);
    assert.equal(f.providers.read().document.unrelated.preserved, true);
    assert.deepEqual(await f.providers.catalogModels(), [], 'ASR models remain outside the generation/chat catalogs');
    f.service.createModelRuntime = async () => { throw Error('Unrelated chat model configuration is unavailable'); };
    assert.equal((await f.service.configuration()).nativeCatalogUnavailable, true, 'independent ASR setup remains usable without the legacy chat catalog');
    assert.equal((await f.service.transcribe(await f.input('managed-request-0001'))).text, 'independent transcription');
    assert.equal(uploaded, 1);
    await assert.rejects(f.providers.removeProvider('speech', { ...await f.stamp() }), /Remove the provider models/);
    await f.service.removeModel('custom-asr', await f.stamp());
    assert.equal((await f.service.catalog()).models.length, 0);
    assert.equal(f.values.get('speech'), 'synthetic-speech-key', 'removing an ASR model preserves its shared service credential');
});

test('registered ASR binds the shared service revision and holds mutation exclusion through its upload', async t => {
    let release, calls = 0;
    const f = managedFixture(t, async () => { calls++; await new Promise(resolve => { release = resolve; }); return response({ text: 'done' }); });
    await f.service.saveModel({ ...await f.stamp(), model: f.model, provider: f.provider, apiKey: 'synthetic-key' });
    const input = await f.input('managed-request-0001'), pending = f.service.transcribe(input);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.providers.active, 1);
    await assert.rejects(f.service.saveModel({ ...await f.stamp(), model: { ...f.model, remoteModel: 'changed' } }), /finish the current operation/);
    release(); await pending; assert.equal(f.providers.active, 0);
    await f.service.saveModel({ ...await f.stamp(), model: { ...f.model, remoteModel: 'changed' } });
    await assert.rejects(f.service.transcribe({ ...input, requestId: 'managed-request-0002' }), /配置已变化/);
    assert.equal(calls, 1, 'stale model configuration never sends the audio');
});

test('shared speech origin rebinding disables ASR until the credential is explicitly rebound', async t => {
    let calls = 0;
    const f = managedFixture(t, async () => { calls++; return response({ text: 'done' }); });
    await f.service.saveModel({ ...await f.stamp(), model: f.model, provider: f.provider, apiKey: 'synthetic-key' });
    const input = await f.input('managed-request-0001');
    await f.providers.saveProvider({ ...await f.stamp(), provider: { ...f.provider, baseUrl: 'https://other.fixture.invalid/v1' } });
    const config = await f.service.configuration(); assert.equal(config.availableModels.length, 0); assert.equal(config.providers[0].keyNeedsRebind, true);
    await assert.rejects(f.service.transcribe(input), /配置已变化/); assert.equal(calls, 0);
    await f.providers.setKey('speech', { ...await f.stamp(), apiKey: 'rebound-synthetic-key' });
    assert.equal((await f.service.catalog()).models.length, 1);
});
