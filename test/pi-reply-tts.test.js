const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaLabService } = require('../server/media-lab-service');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const { PiReplyTtsService } = require('../server/pi-reply-tts-service');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reply-tts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const preferences = new WorkspacePreferencesService({ agentDir: root });
    preferences.writeDocument({ mediaAgent: { provider: 'keep', modelId: 'keep' }, unknown: { keep: true } });
    let executions = 0, resolves = 0;
    const external = { id: 'http-speech', name: 'HTTP Speech', adapter: 'http-json', kind: 'tts', parameters: {
        input: { type: 'textarea', required: true, maxLength: 100 },
        voice: { type: 'select', choices: ['a', 'b'], default: 'a' },
        speed: { type: 'number', min: 0.5, max: 2, default: 1 },
        options: { type: 'json', default: { quality: 'standard' } }
    }, connection: { url: 'https://example.invalid/tts', outputPath: ['audio'], mimeType: 'audio/wav' } };
    const lab = new MediaLabService({ profile: { models: [external], directory: root }, videoService: { getConfig: async () => ({ models: [] }) },
        ttsService: {
            getPublicConfig: () => ({ defaultProvider: 'native', providers: [{ id: 'native', name: 'Native Speech', configured: true,
                models: [{ id: 'model', name: 'Model', maxCharacters: 100, defaultVoice: 'a', defaultLanguage: 'en',
                    voices: [{ id: 'a', name: 'A' }], languages: [{ id: 'en', name: 'English' }],
                    controls: [{ id: 'seed', type: 'number', min: 0, max: 99, integer: true, default: 17 }] }] }] }),
            resolveRequest: input => { resolves++; return { text: input.text.trim(), voice: { id: input.voice }, language: { id: input.language }, speed: input.speed, options: input.options }; }
        }, generateTts: async () => { executions++; }, fetch: async () => { executions++; throw Error('Not expected'); } });
    const service = new PiReplyTtsService(lab, preferences);
    return { service, lab, preferences, external, executions: () => executions, resolves: () => resolves };
}

test('reply speech defaults use live models and persist only mapped configuration, preserving other preferences', async t => {
    const f = fixture(t), snapshot = await f.service.snapshot();
    assert.equal(snapshot.defaults, null);
    assert.deepEqual(snapshot.models.find(m => m.id === 'http-speech').textFields, ['input']);
    assert.equal(JSON.stringify(snapshot).includes('https://example.invalid'), false);
    const saved = await f.service.save({ modelId: 'http-speech', textParameter: 'input', parameters: { voice: 'b', speed: 1.5, options: { quality: 'high' } }, expectedRevision: snapshot.revision });
    assert.deepEqual((await f.service.snapshot()).defaults, saved.defaults);
    assert.equal(f.preferences.readDocument().unknown.keep, true);
    assert.equal(f.preferences.readDocument().mediaAgent.provider, 'keep');
    assert.equal(Object.hasOwn(saved.defaults.parameters, 'input'), false);
    require('./private-file-helper.cjs').assertPrivateFile(f.preferences.filePath);
    assert.equal(f.executions(), 0); assert.equal(f.lab.tickets.size, 0);
    await assert.rejects(f.service.save({ modelId: 'http-speech', textParameter: 'input', parameters: {}, expectedRevision: snapshot.revision }), e => e.statusCode === 409);
});

test('reply speech defaults reject reply text, invalid fields/types/ranges and non-speech models', async t => {
    const f = fixture(t), snapshot = await f.service.snapshot();
    const valid = { modelId: 'http-speech', textParameter: 'input', parameters: {}, expectedRevision: snapshot.revision };
    for (const parameters of [{ input: 'Private reply' }, { apiKey: 'not-a-real-key' }, { speed: 10 }, { voice: 'removed' }, { options: 'invalid' }]) {
        await assert.rejects(f.service.save({ ...valid, parameters }));
    }
    for (const bad of [null, [], { ...valid, text: 'Private reply' }, { ...valid, textParameter: 'speed' }, { ...valid, modelId: 'missing' }]) await assert.rejects(f.service.save(bad));
    f.lab.profile.models.push({ ...f.external, id: 'image', kind: 'image', connection: { ...f.external.connection, mimeType: 'image/png' } });
    await assert.rejects(f.service.save({ ...valid, modelId: 'image' }));
    assert.equal(f.preferences.readDocument().replyTts, undefined);
    assert.equal(f.executions(), 0);
});

test('native defaults reuse TTS resolution; removed models and changed definitions invalidate saved preferences', async t => {
    const f = fixture(t), snapshot = await f.service.snapshot();
    await f.service.save({ modelId: 'tts:native:model', textParameter: 'text', parameters: { option_seed: 42 }, expectedRevision: snapshot.revision });
    assert.equal(f.resolves(), 1);
    assert.deepEqual(f.preferences.readDocument().replyTts.parameters, { voice: 'a', language: 'en', speed: 1, option_seed: 42 });
    f.lab.ttsService.getPublicConfig = () => ({ providers: [] });
    const removed = await f.service.snapshot();
    assert.equal(removed.defaults, null); assert.ok(removed.warning); assert.equal(removed.hasSavedDefaults, true);
    assert.equal(f.executions(), 0);
});

test('simultaneous saves with the same revision accept only one browser', async t => {
    const f = fixture(t), snapshot = await f.service.snapshot();
    const results = await Promise.allSettled([1.1, 1.2].map(speed => f.service.save({ modelId: 'http-speech', textParameter: 'input', parameters: { speed }, expectedRevision: snapshot.revision })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
});

test('catalog or another browser changing during validation cannot overwrite newer reply speech defaults', async t => {
    const f = fixture(t), snapshot = await f.service.snapshot();
    const validate = f.lab.validate.bind(f.lab);
    f.lab.validate = async input => {
        const result = await validate(input);
        f.external.parameters.speed.max = 1.2;
        return result;
    };
    await assert.rejects(f.service.save({ modelId: 'http-speech', textParameter: 'input', parameters: {}, expectedRevision: snapshot.revision }), e => e.statusCode === 409);
    assert.equal(f.preferences.readDocument().replyTts, undefined);
});
