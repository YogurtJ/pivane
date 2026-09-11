const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { MediaLabService, validateDefinition, validateParameters } = require('../server/media-lab-service');
const { loadMediaProfile, applyPromptPrefix } = require('../server/media-profile');
const { installMediaModel, modelInstructions } = require('../server/media-lab-models');
const { saveExternalMedia, mediaHistory, deleteMedia } = require('../server/media-lab-storage');
const { MiniMaxVideoService } = require('../server/minimax-video-service');
const { TtsProviderService } = require('../server/tts-provider-service');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-media-lab-test-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_TOKEN = 'lab-fixture-token';
process.env.PI_OFFLINE = '1';
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const definition = () => ({ id: 'fixture-image', name: 'Fixture image', kind: 'image', adapter: 'http-json',
    instructions: 'Fixture model-specific requirements', parameters: {
        prompt: { type: 'textarea', required: true, maxLength: 100 },
        quality: { type: 'select', choices: ['draft','high'], default: 'draft' },
        steps: { type: 'number', min: 1, max: 10, integer: true, default: 4 },
        watermark: { type: 'boolean', default: false },
        settings: { type: 'json', default: { palette: ['red', 'green'] } }
    }, connection: { url: 'http://127.0.0.1:8200/generate', parameterKey: 'input', fixedBody: { model: 'remote-fixture' }, outputPath: ['data', 0, 'b64_json'], mimeType: 'image/png' } });
function fixture() {
    const dataRoot = fs.mkdtempSync(path.join(root, 'instance-'));
    const profile = loadMediaProfile(path.join(__dirname, '..'), { PI_MEDIA_PROFILE: 'clean', PI_MEDIA_CONFIG_DIR: path.join(dataRoot, 'config') });
    profile.models.push(definition());
    const requests = [];
    const videoService = new MiniMaxVideoService({ rootDir: dataRoot, apiKeyResolver: async () => 'fixture' });
    const ttsService = new TtsProviderService({ rootDir: path.join(__dirname, '..'), gpuExec: '' });
    const service = new MediaLabService({ profile, videoService, ttsService,
        fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) }; },
        saveExternal: input => saveExternalMedia(dataRoot, input), history: kind => mediaHistory(dataRoot, kind),
        deleteMedia: (kind, id) => deleteMedia(dataRoot, kind, id),
        generateImage: async payload => ({ image: payload }), generateTts: async payload => ({ historyItem: payload }) });
    return { service, profile, requests, dataRoot };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('media definitions reject invalid types, unknown parameters, ranges, enums and conflicting request envelopes', () => {
    const model = definition();
    assert.doesNotThrow(() => validateDefinition(model));
    const values = validateParameters(model.parameters, { prompt: 'A poster' });
    assert.equal(values.steps, 4);
    assert.equal(values.watermark, false);
    assert.deepEqual(values.settings, { palette: ['red','green'] });
    for (const bad of [{ unknown: 1 }, { steps: '5' }, { steps: 99 }, { steps: 1.2 }, { quality: 'secret' }, { watermark: 'false' }, { settings: 'not-json' }, { prompt: '' }]) {
        assert.throws(() => validateParameters(model.parameters, { prompt: 'A poster', ...bad }));
    }
    assert.throws(() => validateParameters({ fixed: { type: 'number', const: 1 } }, { fixed: 2 }));
    assert.throws(() => validateParameters({ size: { type: 'number', step: 64 } }, { size: 480 }));
    assert.deepEqual(validateParameters({ count: { type: 'number', min: 1, step: 2 } }, { count: 3 }), { count: 3 });
    assert.throws(() => validateParameters({ count: { type: 'number', min: 1, step: 2 } }, { count: 2 }));
    assert.throws(() => validateDefinition({ ...model, connection: { ...model.connection, url: 'https://user:secret@example.invalid' } }));
    assert.throws(() => validateDefinition({ ...model, connection: { ...model.connection, url: 'http://localhost/generate?key=secret' } }));
    assert.throws(() => validateDefinition({ ...model, connection: { ...model.connection, fixedBody: { input: {} } } }));
    assert.throws(() => validateDefinition({ ...model, connection: { ...model.connection, mimeType: 'text/html' } }));
    assert.throws(() => validateDefinition({ ...model, parameters: JSON.parse('{"__proto__":{"type":"text"}}') }));
});

test('private profile is external, clean profile ignores it, and model docs cannot escape its directory', () => {
    const { profile } = fixture();
    fs.mkdirSync(profile.directory, { recursive: true });
    fs.writeFileSync(path.join(profile.directory, 'profile.json'), JSON.stringify({ version: 1, image: { identity: 'private-fixture-prefix' }, unknown: { keep: true }, models: [] }));
    fs.writeFileSync(path.join(profile.directory, 'model.md'), 'Model-specific fixture rules');
    const privateProfile = loadMediaProfile(path.join(__dirname, '..'), { PI_MEDIA_CONFIG_DIR: profile.directory });
    const clean = loadMediaProfile(path.join(__dirname, '..'), { PI_MEDIA_CONFIG_DIR: profile.directory, PI_MEDIA_PROFILE: 'clean' });
    assert.equal(privateProfile.image.identity, 'private-fixture-prefix');
    assert.equal(JSON.stringify(clean).includes('private-fixture-prefix'), false);
    assert.equal(clean.privateProfile, false);
    assert.equal(modelInstructions({ instructionsFile: 'model.md' }, profile.directory), 'Model-specific fixture rules');
    assert.throws(() => modelInstructions({ instructionsFile: '../outside.md' }, profile.directory));
    fs.symlinkSync('/etc', path.join(profile.directory, 'escape'));
    assert.throws(() => modelInstructions({ instructionsFile: 'escape/passwd' }, profile.directory));
    const manual = { ...definition(), id: 'manual-added', adapter: 'manual', instructionsFile: 'model.md' };
    assert.throws(() => installMediaModel(privateProfile, { model: manual }));
    installMediaModel(privateProfile, { model: manual, confirmed: true });
    const saved = JSON.parse(fs.readFileSync(path.join(profile.directory, 'profile.json')));
    assert.deepEqual(saved.unknown, { keep: true });
    require('./private-file-helper.cjs').assertPrivateFile(path.join(profile.directory, 'profile.json'));
    assert.throws(() => installMediaModel(privateProfile, { model: manual, confirmed: true }));
    assert.ok(fs.readdirSync(profile.directory).some(file => file.startsWith('profile.json.bak-')));
    assert.equal(applyPromptPrefix('fixture, white background', 'fixture, studio portrait'), 'fixture, studio portrait, white background');
    assert.equal(applyPromptPrefix('fixture, studio portrait, white background', 'fixture, studio portrait'), 'fixture, studio portrait, white background');
});

test('plans and reviews never execute; confirmations execute only once and preserve structured values and legacy histories', async () => {
    const { service, requests, dataRoot } = fixture();
    const old = [{ id: 12, filename: 'old.png', imageUrl: '/images/old.png', prompt: 'Previous work' }];
    fs.writeFileSync(path.join(dataRoot, 'generation_history.json'), JSON.stringify(old));
    const input = { modelId: 'fixture-image', parameters: { prompt: 'New poster', settings: { layers: [{ opacity: .5 }] } } };
    const plan = await service.plan(input);
    const reviewed = await service.review(input);
    assert.equal(requests.length, 0);
    assert.equal(plan.execution.mode, 'manual');
    assert.equal(JSON.stringify(reviewed).includes('http://127.0.0.1:8200'), false);
    assert.equal(JSON.stringify(await service.catalog()).includes('fixedBody'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, 'generation_history.json'))), old);
    const result = await service.execute(reviewed.ticket);
    const repeated = await service.execute(reviewed.ticket);
    assert.equal(requests.length, 1);
    assert.deepEqual(result, repeated);
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.input.settings.layers, [{ opacity: .5 }]);
    assert.equal(body.model, 'remote-fixture');
    assert.equal(requests[0].options.redirect, 'error');
    const history = mediaHistory(dataRoot, 'image');
    assert.equal(history.length, 2);
    assert.equal(history[1].id, 12);
    assert.equal(history[0].labModelId, 'fixture-image');
    assert.ok(fs.readFileSync(path.join(dataRoot, 'public/images', history[0].filename)).equals(png));
    deleteMedia(dataRoot, 'image', history[0].id);
    assert.equal(mediaHistory(dataRoot, 'image').length, 1);
});

test('running, expired, unavailable, failed and uncertain requests never retry automatically', async () => {
    const { service, profile, requests } = fixture();
    let release;
    service.fetch = async (url, options) => { requests.push({ url, options }); await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) }; };
    const input = { modelId: 'fixture-image', parameters: { prompt: 'A poster' } };
    const review = await service.review(input);
    const running = service.execute(review.ticket);
    await assert.rejects(service.execute(review.ticket), /already running/);
    release(); await running;
    assert.equal(requests.length, 1);
    const expired = await service.review(input);
    service.tickets.get(expired.ticket).expiresAt = 0;
    await assert.rejects(service.execute(expired.ticket), /expired/);
    profile.models.push({ ...definition(), id: 'manual-only', adapter: 'manual' });
    const manual = await service.review({ ...input, modelId: 'manual-only' });
    await assert.rejects(service.execute(manual.ticket), /not configured/);
    service.fetch = async () => { throw new Error('secret endpoint details'); };
    const failed = await service.review(input);
    await assert.rejects(service.execute(failed.ticket), error => !error.message.includes('secret endpoint'));
    await assert.rejects(service.execute(failed.ticket), /uncertain/);
    assert.equal(service.inFlight, 0);
    service.fetch = async () => ({ ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('<html>bad</html>').toString('base64') }] }) });
    const badOutput = await service.review(input);
    await assert.rejects(service.execute(badOutput.ticket), /MIME type/);
});

test('video first frame and TTS options are canonicalized through existing adapters before confirmation', async () => {
    const { service, dataRoot } = fixture();
    const source = { imageData: 'data:image/png;base64,' + png.toString('base64') };
    fs.mkdirSync(path.join(dataRoot, 'public/images'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'public/images', '首帧 fixture.png'), png);
    assert.equal(service.videoService.resolveSourceImage({ imageUrl: '/images/' + encodeURIComponent('首帧 fixture.png') }).dataUrl, source.imageData);
    fs.writeFileSync(path.join(dataRoot, 'outside.png'), png);
    fs.symlinkSync(path.join(dataRoot, 'outside.png'), path.join(dataRoot, 'public/images', 'escape.png'));
    assert.throws(() => service.videoService.resolveSourceImage({ imageUrl: '/images/escape.png' }));
    const video = await service.review({ modelId: 'MiniMax-H3', parameters: { prompt: 'Slow motion', ratio: '16:9' }, source });
    assert.equal(video.parameters.ratio, 'adaptive');
    assert.equal(video.source.selected, true);
    assert.ok(video.warnings.length);
    await assert.rejects(service.review({ modelId: 'fixture-image', parameters: { prompt: 'x' }, source }), /first frame/);
    let resolved;
    service.ttsService = {
        getPublicConfig: () => ({ defaultProvider: 'tts-test', providers: [{ id: 'tts-test', name: 'Speech fixture', configured: true, models: [{ id: 'voice-model', name: 'Voice', maxCharacters: 100, defaultVoice: 'a', defaultLanguage: 'en', voices: [{ id: 'a', name: 'A', options: { seed: 17 } }], languages: [{ id: 'en', name: 'English' }], controls: [{ id: 'seed', type: 'number', min: 0, max: 100, integer: true, default: 17 }] }] }] }),
        resolveRequest: payload => { resolved = payload; return { text: payload.text.trim(), voice: { id: payload.voice }, language: { id: payload.language }, speed: payload.speed, options: payload.options }; }
    };
    const speech = await service.review({ modelId: 'tts:tts-test:voice-model', parameters: { text: 'Hello', option_seed: 42 } });
    assert.deepEqual(resolved.options, { seed: 42 });
    assert.equal(speech.parameters.option_seed, 42);
    assert.equal(Object.hasOwn(resolved, 'option_seed'), false);
});

test('laboratory gateway requires auth, rejects overrides, checks project roots, and does not create Pi workers', async t => {
    const { service } = fixture();
    const gateway = createPiAgentGateway({ mediaLabService: service, mediaAgentService: { createLabPlan: async input => ({ input }) } });
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}/api/pi/media/lab`;
    const request = (suffix = '', body, headers = {}) => fetch(url + suffix, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer lab-fixture-token', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await request('', undefined, { Origin: 'http://untrusted.invalid' })).status, 403);
    assert.equal((await request()).status, 200);
    const preferenceUrl = url.replace('/media/lab', '/settings/reply-tts');
    assert.equal((await fetch(preferenceUrl)).status, 401);
    assert.equal((await fetch(preferenceUrl, { headers: { Authorization: 'Bearer lab-fixture-token', Origin: 'http://untrusted.invalid' } })).status, 403);
    const preference = await (await fetch(preferenceUrl, { headers: { Authorization: 'Bearer lab-fixture-token' } })).json();
    assert.ok(preference.revision);
    assert.equal((await fetch(preferenceUrl, { method: 'PUT', headers: { Authorization: 'Bearer lab-fixture-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: 'fixture-image', textParameter: 'prompt', parameters: {}, expectedRevision: preference.revision }) })).status, 400);
    assert.equal((await request('/execute', { ticket: 'missing', confirmed: false })).status, 400);
    assert.equal((await request('/execute', { ticket: 'missing', confirmed: true, parameters: {} })).status, 400);
    assert.equal((await request('/plan', { cwd: '/etc' })).status, 400);
    const collision = await request('/models', { model: { ...definition(), id: 'MiniMax-H3', adapter: 'manual' }, confirmed: true });
    assert.equal(collision.status, 409);
    const review = await (await request('/review', { modelId: 'fixture-image', parameters: { prompt: 'fixture' } })).json();
    assert.ok(review.ticket);
    assert.equal(gateway.supervisor.workers.size, 0);
});
