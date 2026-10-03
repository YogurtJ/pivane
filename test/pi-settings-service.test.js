const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertPrivateFile } = require('./private-file-helper.cjs');

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-agent-'));
const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-package-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-settings-project-'));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { PiSettingsService } = require('../server/pi-settings-service');

const service = new PiSettingsService({ cwd: projectDir });

test.after(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(packageDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
});

test('manages custom providers and API keys through Pi stores', async () => {
    await service.upsertCustomProvider({
        id: 'web-test-provider',
        baseUrl: 'http://127.0.0.1:65530/v1',
        api: 'openai-completions',
        authHeader: true
    });
    await service.upsertCustomModel('web-test-provider', {
        id: 'web-test-model',
        name: 'Web Test Model',
        reasoning: false,
        imageInput: false,
        contextWindow: 32768,
        maxTokens: 2048
    });

    let snapshot = await service.getModelSnapshot();
    const custom = snapshot.customProviders.find(item => item.id === 'web-test-provider');
    assert.equal(custom.models[0].id, 'web-test-model');
    assert.equal(custom.models[0].contextWindow, 32768);

    await service.saveApiKey('web-test-provider', 'test-secret-value');
    const mediaPreference = await service.setMediaAgentModel({ provider: 'web-test-provider', modelId: 'web-test-model' });
    assert.deepEqual(mediaPreference.mediaAgent, { provider: 'web-test-provider', modelId: 'web-test-model' });
    snapshot = await service.getModelSnapshot();
    assert.deepEqual(snapshot.preferences.mediaAgent, { provider: 'web-test-provider', modelId: 'web-test-model' });
    let provider = snapshot.providers.find(item => item.id === 'web-test-provider');
    assert.equal(provider.configured, true);
    assert.equal(provider.storedCredential, 'api_key');

    await service.logout('web-test-provider');
    snapshot = await service.getModelSnapshot();
    provider = snapshot.providers.find(item => item.id === 'web-test-provider');
    assert.equal(provider.storedCredential, null);

    await service.deleteCustomModel('web-test-provider', 'web-test-model');
    await service.deleteCustomProvider('web-test-provider');
    assert.deepEqual(await service.listCustomProviders(), []);
});

test('custom model edits take precedence over extension registrations and preserve unrelated settings', async () => {
    const providerId = 'extension-overlap-fixture';
    const modelId = 'fixture/model:version@latest';
    await service.upsertCustomProvider({ id: providerId, baseUrl: 'http://127.0.0.1:65530/v1', api: 'openai-completions', authHeader: true });
    const { modelsPath } = await service.paths();
    const data = service.readModelsFile(modelsPath);
    const otherOverride = { contextWindow: 64000, futureField: 'keep-other-model' };
    data.providers[providerId].models = [{ id: modelId, name: 'Original', reasoning: true, input: ['text'],
        contextWindow: 1050000, maxTokens: 128000, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        compat: { supportsStore: false }, futureField: { keep: true } }];
    data.providers[providerId].modelOverrides = { [modelId]: { contextWindow: 500000, compat: { supportsStore: false }, futureField: 'keep-target' }, other: otherOverride };
    data.providers[providerId].futureProviderField = 'keep-provider';
    await service.writeModelsFile(data);
    const runtime = await service.createModelRuntime();
    const extension = { baseUrl: 'http://127.0.0.1:65530/v1', api: 'openai-completions', apiKey: 'synthetic-fixture-key', models: [
        { id: modelId, name: 'Extension', reasoning: true, input: ['text'], contextWindow: 1050000, maxTokens: 128000,
            cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4 } }
    ] };
    runtime.registerProvider(providerId, extension);
    assert.equal(runtime.getModel(providerId, modelId).contextWindow, 500000);
    const custom = (await service.listCustomProviders()).find(p => p.id === providerId);
    assert.equal(custom.models[0].contextWindow, 500000, 'editor reads the existing effective user override');
    await service.upsertCustomModel(providerId, { id: modelId, name: 'User choice', reasoning: false, imageInput: true,
        contextWindow: 272000, maxTokens: 32000 });
    await runtime.refresh({ allowNetwork: false });
    runtime.registerProvider(providerId, extension); // Resource reload re-registers the same extension.
    const effective = runtime.getModel(providerId, modelId);
    assert.equal(effective.name, 'User choice');
    assert.equal(effective.reasoning, false);
    assert.deepEqual(effective.input, ['text', 'image']);
    assert.equal(effective.contextWindow, 272000);
    assert.equal(effective.maxTokens, 32000);
    assert.equal(effective.cost.input, 3, 'unsubmitted extension pricing is not pinned by the basic editor');
    const saved = service.readModelsFile(modelsPath).providers[providerId];
    assert.equal(saved.futureProviderField, 'keep-provider');
    assert.deepEqual(saved.models[0].futureField, { keep: true });
    assert.deepEqual(saved.models[0].cost, data.providers[providerId].models[0].cost);
    assert.deepEqual(saved.modelOverrides.other, otherOverride);
    assert.equal(saved.modelOverrides[modelId].futureField, 'keep-target');
    assert.deepEqual(saved.modelOverrides[modelId].compat, { supportsStore: false });
    assert.equal((await service.getModelSnapshot()).models.find(m => m.provider === providerId && m.id === modelId).contextWindow, 272000);
    await service.deleteCustomModel(providerId, modelId);
    const deleted = service.readModelsFile(modelsPath).providers[providerId];
    assert.deepEqual(deleted.modelOverrides[modelId], { compat: { supportsStore: false }, futureField: 'keep-target' });
    assert.deepEqual(deleted.modelOverrides.other, otherOverride);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel(providerId, modelId).contextWindow, 1050000, 'deleting the custom model clears its editor overrides');
    await service.upsertCustomModel(providerId, { id: modelId, contextWindow: 64000, maxTokens: 4096 });
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel(providerId, modelId).contextWindow, 64000, 'recreation cannot inherit an old window');
    await service.deleteCustomProvider(providerId);
});

test('installs, resolves, and removes local packages with the Pi package manager', async () => {
    const skillDir = path.join(packageDir, 'skills', 'package-test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
        name: 'pi-web-local-test-package',
        version: '1.0.0',
        keywords: ['pi-package'],
        pi: { skills: ['./skills'] }
    }, null, 2));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: package-test-skill\ndescription: Skill from a temporary local package.\n---\n\n# Test\n`);

    await service.packageAction({ action: 'install', source: packageDir, cwd: projectDir });
    let resources = await service.getResourceSnapshot(projectDir);
    assert.equal(resources.packages.some(item => item.installedPath === packageDir), true);
    assert.equal(resources.skills.some(item => item.name === 'package-test-skill'), true);

    await service.packageAction({ action: 'remove', source: packageDir, cwd: projectDir });
    resources = await service.getResourceSnapshot(projectDir);
    assert.equal(resources.packages.some(item => item.installedPath === packageDir), false);
});

test('creates, discovers, and deletes standard user skills', async () => {
    await service.createSkill({
        name: 'web-test-skill',
        description: 'A temporary skill used by the Web settings test.',
        body: '# Web Test Skill\n\nReturn the requested test value.'
    });
    let resources = await service.getResourceSnapshot(projectDir);
    const skill = resources.skills.find(item => item.name === 'web-test-skill');
    assert.equal(skill.manageable, true);
    assert.equal(path.basename(skill.filePath), 'SKILL.md');
    assert.equal(path.basename(path.dirname(skill.filePath)), 'web-test-skill');

    await service.deleteSkill('web-test-skill');
    resources = await service.getResourceSnapshot(projectDir);
    assert.equal(resources.skills.some(item => item.name === 'web-test-skill'), false);
});

test('model replacement yields to Windows readers and preserves one private backup', async () => {
    const backend = require('../server/pi-win32-native'), original = backend.replaceFileSync;
    const { modelsPath } = await service.paths();
    const backups = () => fs.readdirSync(agentDir).filter(name => name.startsWith('models.json.bak-web-'));
    const before = backups().length, next = { providers: {}, futureField: 'replacement-fixture' };
    let calls = 0;
    backend.replaceFileSync = (source, target) => {
        if (++calls < 3) throw Object.assign(new Error('synthetic sharing failure'), { code: 'FILE_REPLACE', win32Code: 5 });
        return original(source, target);
    };
    try { await service.writeModelsFile(next); } finally { backend.replaceFileSync = original; }
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(modelsPath, 'utf8')), next);
    assert.equal(backups().length, before + 1);
    assertPrivateFile(modelsPath);
    assert.equal(fs.readdirSync(agentDir).some(name => name.startsWith('models.json.tmp-')), false);
});

test('model replacement rejects a foreign file identity even when every byte is unchanged', async () => {
    const backend = require('../server/pi-win32-native'), original = backend.replaceFileSync;
    const { modelsPath } = await service.paths(), previous = fs.readFileSync(modelsPath);
    let calls = 0;
    backend.replaceFileSync = (_source, target) => {
        calls++;
        const foreign = target + '.external-fixture';
        fs.writeFileSync(foreign, previous);
        original(foreign, target);
        throw Object.assign(new Error('synthetic sharing failure'), { code: 'FILE_REPLACE', win32Code: 5 });
    };
    try { await assert.rejects(service.writeModelsFile({ providers: {}, futureField: 'must-not-commit' }), error => error.statusCode === 409); }
    finally { backend.replaceFileSync = original; }
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(modelsPath), previous);
    assert.equal(fs.readdirSync(agentDir).some(name => name.startsWith('models.json.tmp-')), false);
});
