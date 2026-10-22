'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-model-advanced-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
const { PiSettingsService } = require('../server/pi-settings-service');
const { compatSchema } = require('../server/pi-model-advanced');
const service = new PiSettingsService({ cwd: root });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A round trip through the native model store also checks that reset only clears
// the editable fields for this API, not provider-specific or future settings.
for (const api of ['openai-codex-responses', 'future-fixture-api']) {
    test(`${api} compatibility editing preserves fields outside the public projection`, async () => {
        const { modelsPath } = await service.paths();
        const preserved = { supportsStore: false, futureFlag: 'keep', chatTemplateKwargs: { fixture: true } };
        const originalCompat = { ...preserved, supportsMaxOutputTokens: true };
        await service.writeModelsFile({ providers: { fixture: { api, baseUrl: 'http://127.0.0.1:65530/v1',
            models: [{ id: 'model', name: 'Synthetic', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
                compat: originalCompat, futureModelField: { keep: true } }], futureProviderField: true } } });
        const info = await service.getModelAdvanced({ provider: 'fixture', modelId: 'model' });
        assert.equal(info.api, api);
        if (api === 'openai-codex-responses') {
            const native = await import('@earendil-works/pi-ai/providers/compat-schema');
            assert.deepEqual(info.compatSchema, await compatSchema('openai-responses'));
            assert.equal(info.compatSchema.supportsMaxOutputTokens.description,
                native.CompatSchemasByApi[api].properties.supportsMaxOutputTokens.description);
            assert.deepEqual(info.compat, { supportsMaxOutputTokens: true });
            await service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: info.revision,
                compat: { supportsMaxOutputTokens: false } });
            assert.equal((await service.getModelAdvanced({ provider: 'fixture', modelId: 'model' })).effectiveCompat.supportsMaxOutputTokens, false);
            await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: info.revision,
                compat: {} }), /变化/);
        } else {
            assert.deepEqual(info.compatSchema, {});
            assert.deepEqual(info.compat, {});
            assert.deepEqual(info.effectiveCompat, {});
        }
        const fresh = await service.getModelAdvanced({ provider: 'fixture', modelId: 'model' });
        for (const compat of [{ supportsStore: true }, { supportsMaxOutputTokens: 1 }, { chatTemplateKwargs: {} }, { futureFlag: null }]) {
            await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: fresh.revision, compat }), /兼容参数/);
        }
        await service.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: fresh.revision, compat: null });
        const saved = service.readModelsFile(modelsPath).providers.fixture;
        assert.deepEqual(saved.models[0].compat, api === 'openai-codex-responses' ? preserved : originalCompat);
        assert.deepEqual(saved.models[0].futureModelField, { keep: true });
        assert.equal(saved.futureProviderField, true);
    });
}

test('public API schemas expose boolean and literal controls with native descriptions', async () => {
    const completions = await compatSchema('openai-completions');
    assert.equal(completions.supportsStore.type, 'boolean');
    assert.deepEqual(completions.maxTokensField.choices, ['max_completion_tokens', 'max_tokens']);
    assert.equal(completions.chatTemplateKwargs, undefined);
    const native = await import('@earendil-works/pi-ai/providers/compat-schema');
    assert.equal(completions.maxTokensField.description, native.CompatSchemasByApi['openai-completions'].properties.maxTokensField.description);
    assert.deepEqual(await compatSchema('google-generative-ai'), {});
});
