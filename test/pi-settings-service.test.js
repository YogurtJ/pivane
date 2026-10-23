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

function replaceModelsData(target, modelsPath, next) {
    const data = target.readModelsFile(modelsPath);
    for (const key of Object.keys(data)) delete data[key];
    return Object.assign(data, next);
}

function barrier() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function modelsFixture(t, { absent = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-models-version-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const modelsPath = path.join(directory, 'models.json');
    const model = { id: 'model', api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 2048,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }, futureModel: { keep: true } };
    const data = { futureRoot: { keep: true }, providers: { fixture: { api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:65530/v1', futureProvider: 'keep', models: [model] } } };
    const bytes = Buffer.from(JSON.stringify(data, null, 3) + '\n\n');
    if (!absent) fs.writeFileSync(modelsPath, bytes);
    const target = new PiSettingsService({ cwd: directory });
    target.paths = async () => ({ modelsPath, agentDir: directory });
    target.createModelRuntime = async () => ({ getModel: () => model });
    return { service: target, directory, modelsPath, model, data, bytes,
        backups: () => fs.readdirSync(directory).filter(name => name.startsWith('models.json.bak-web-')),
        temporary: () => fs.readdirSync(directory).filter(name => name.startsWith('models.json.tmp-')) };
}

function syntheticSdk(t) {
    const store = require('../server/pi-session-store'), original = store.getSdk;
    const settings = { getGlobalSettings: () => ({}), flush: async () => {}, drainErrors: () => [] };
    const sdk = { ModelRuntime: { create: async () => ({ getProvider: () => ({}) }) },
        SettingsManager: { create: () => settings }, getAgentDir: () => agentDir };
    store.getSdk = async () => sdk;
    t.after(() => { store.getSdk = original; });
    return sdk;
}

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
    // Registration starts an asynchronous reload; settle it before changing the
    // file so a previous read cannot replace the next refresh's snapshot.
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel(providerId, modelId).contextWindow, 500000);
    const custom = (await service.listCustomProviders()).find(p => p.id === providerId);
    assert.equal(custom.models[0].contextWindow, 500000, 'editor reads the existing effective user override');
    await service.upsertCustomModel(providerId, { id: modelId, name: 'User choice', reasoning: false, imageInput: true,
        contextWindow: 272000, maxTokens: 32000 });
    await runtime.refresh({ allowNetwork: false });
    runtime.registerProvider(providerId, extension); // Resource reload re-registers the same extension.
    await runtime.refresh({ allowNetwork: false });
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
    try { await service.writeModelsFile(replaceModelsData(service, modelsPath, next)); } finally { backend.replaceFileSync = original; }
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
    try { await assert.rejects(service.writeModelsFile(replaceModelsData(service, modelsPath, { providers: {}, futureField: 'must-not-commit' })), error => error.statusCode === 409); }
    finally { backend.replaceFileSync = original; }
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(modelsPath), previous);
    assert.equal(fs.readdirSync(agentDir).some(name => name.startsWith('models.json.tmp-')), false);
});

test('model edits preflight positive token fields and preserve schema, tiers, speed and unknown native fields', async () => {
    const { modelsPath } = await service.paths();
    const tiers = [{ inputTokensAbove: 10000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }];
    const speed = { defaultLevel: 'fast', modes: { fast: { serviceTier: 'priority', costMultiplier: 2 } }, futureSpeedField: true };
    const data = { $schema: 'https://example.invalid/models.schema.json', futureRoot: { keep: true }, providers: {
        preservation: { baseUrl: 'http://127.0.0.1:65530/v1', api: 'openai-completions', apiKey: 'synthetic', futureProvider: 'keep', models: [
            { id: 'model', contextWindow: 32000, maxTokens: 4096, pivaneSpeed: speed, futureModel: { keep: true },
                samplingParams: { temperature: 0.7, futureSampling: 42 }, samplingParamsByThinkingLevel: { high: { top_p: 0.9 } },
                cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, tiers } }
        ], modelOverrides: { model: { maxTokens: 2048, futureOverride: 'keep' } } }
    } };
    await service.writeModelsFile(replaceModelsData(service, modelsPath, data));
    for (const field of ['contextWindow', 'maxTokens']) {
        for (const invalid of [0, -1, null, '4096', NaN, Infinity]) {
            for (const section of ['models', 'modelOverrides']) {
                const candidate = structuredClone(data);
                (section === 'models' ? candidate.providers.preservation.models[0] : candidate.providers.preservation.modelOverrides.model)[field] = invalid;
                const previous = fs.readFileSync(modelsPath);
                const backups = fs.readdirSync(agentDir).filter(name => name.startsWith('models.json.bak-web-')).length;
                await assert.rejects(service.writeModelsFile(replaceModelsData(service, modelsPath, candidate)), /positive token count/);
                assert.deepEqual(fs.readFileSync(modelsPath), previous);
                assert.equal(fs.readdirSync(agentDir).filter(name => name.startsWith('models.json.bak-web-')).length, backups);
            }
        }
    }
    await assert.rejects(service.upsertCustomModel('preservation', { id: 'model', maxTokens: 1.5 }), /integer/);
    await service.upsertCustomModel('preservation', { id: 'model', name: 'Edited', contextWindow: 64000, maxTokens: 8192 });
    const info = await service.getModelAdvanced({ provider: 'preservation', modelId: 'model' });
    await service.saveModelAdvanced({ provider: 'preservation', modelId: 'model', expectedRevision: info.revision,
        samplingParams: { temperature: 0.3 }, cost: { input: 3 } });
    const saved = service.readModelsFile(modelsPath);
    assert.equal(saved.$schema, data.$schema);
    assert.deepEqual(saved.futureRoot, data.futureRoot);
    assert.equal(saved.providers.preservation.futureProvider, 'keep');
    const model = saved.providers.preservation.models[0];
    assert.deepEqual(model.futureModel, data.providers.preservation.models[0].futureModel);
    assert.deepEqual(model.pivaneSpeed, speed);
    assert.deepEqual(model.cost.tiers, tiers);
    assert.deepEqual(model.samplingParamsByThinkingLevel, { high: { top_p: 0.9 } });
    assert.deepEqual(model.samplingParams, { temperature: 0.3, futureSampling: 42 });
    assert.equal(saved.providers.preservation.modelOverrides.model.futureOverride, 'keep');
    const settingsPath = path.join(agentDir, 'settings.json');
    const settings = { $schema: 'https://example.invalid/settings.schema.json', futureSetting: { keep: true }, pivaneSpeed: { keep: true } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    await service.setModelPreferences({ defaultProvider: 'preservation', defaultModel: 'model' });
    const settingsSaved = JSON.parse(fs.readFileSync(settingsPath));
    for (const key of Object.keys(settings)) assert.deepEqual(settingsSaved[key], settings[key]);
});

test('explicit catalog refresh reserves the settings mutation boundary before awaiting', async () => {
    const isolated = new PiSettingsService({ cwd: projectDir });
    let release;
    isolated.createModelRuntime = () => new Promise(resolve => { release = () => resolve({ refresh: async () => ({ errors: new Map() }) }); });
    const refresh = isolated.refreshModels();
    assert.equal(isolated.mutating, true);
    await assert.rejects(isolated.logout('openrouter'), error => error.statusCode === 409);
    await assert.rejects(isolated.refreshModels(), error => error.statusCode === 409);
    release();
    assert.deepEqual(await refresh, { ok: true, aborted: false, errors: [], requiresRuntimeRestart: true });
    assert.equal(isolated.mutating, false);
});


test('model writer rejects objects without a read baseline before any writes', async t => {
    for (const absent of [false, true]) {
        const fixture = modelsFixture(t, { absent });
        await assert.rejects(fixture.service.writeModelsFile({ providers: {} }), /读取|baseline/i);
        assert.deepEqual(fs.readdirSync(fixture.directory), absent ? [] : ['models.json']);
        if (!absent) assert.deepEqual(fs.readFileSync(fixture.modelsPath), fixture.bytes);
    }
});

test('model read rejects replacement while capturing the parsed bytes and identity', t => {
    const fixture = modelsFixture(t), io = require('../server/pi-file-io');
    const openRead = io.openReadSync, read = fs.readSync, readFile = fs.readFileSync;
    let descriptor, replaced = false;
    const replace = () => {
        if (replaced) return;
        replaced = true;
        const foreign = fixture.modelsPath + '.external';
        fs.writeFileSync(foreign, fixture.bytes);
        require('../server/pi-win32-native').replaceFileSync(foreign, fixture.modelsPath);
    };
    io.openReadSync = file => {
        const fd = openRead(file);
        if (file === fixture.modelsPath) descriptor = fd;
        return fd;
    };
    fs.readSync = (fd, ...args) => {
        const result = read(fd, ...args);
        if (fd === descriptor) replace();
        return result;
    };
    fs.readFileSync = (file, ...args) => {
        const result = readFile(file, ...args);
        if (file === fixture.modelsPath) replace();
        return result;
    };
    try { assert.throws(() => fixture.service.readModelsFile(fixture.modelsPath), error => error.statusCode === 409); }
    finally { io.openReadSync = openRead; fs.readSync = read; fs.readFileSync = readFile; }
    assert.equal(replaced, true);
    assert.deepEqual(fs.readFileSync(fixture.modelsPath), fixture.bytes);
    assert.equal(fixture.backups().length, 0);
});

test('model edits keep their read version across official pricing waits', async t => {
    const pricing = require('../server/pi-usage-pricing'), original = pricing.officialPrices;
    t.after(() => { pricing.officialPrices = original; });
    for (const change of ['edit', 'remove', 'replace', 'unchanged']) {
        await t.test(change, async t => {
            const fixture = modelsFixture(t), entered = barrier(), release = barrier();
            pricing.officialPrices = async () => { entered.resolve(); await release.promise; return new Map(); };
            const pending = fixture.service.upsertCustomModel('fixture', { id: 'added', name: 'Added' });
            await entered.promise;
            let external = fixture.bytes;
            if (change === 'edit') {
                external = Buffer.from(JSON.stringify({ ...fixture.data, outside: { exact: 'keep external bytes' } }, null, 4) + '\n \n');
                fs.writeFileSync(fixture.modelsPath, external);
            } else if (change === 'remove') fs.unlinkSync(fixture.modelsPath);
            else if (change === 'replace') {
                const foreign = fixture.modelsPath + '.external';
                fs.writeFileSync(foreign, external);
                require('../server/pi-win32-native').replaceFileSync(foreign, fixture.modelsPath);
            }
            const result = change === 'unchanged' ? pending : assert.rejects(pending, error => error.statusCode === 409);
            release.resolve();
            await result;
            if (change === 'unchanged') {
                const saved = JSON.parse(fs.readFileSync(fixture.modelsPath));
                assert.deepEqual(saved.futureRoot, fixture.data.futureRoot);
                assert.equal(saved.providers.fixture.futureProvider, 'keep');
                assert.deepEqual(saved.providers.fixture.models[0], fixture.model);
                assert.equal(saved.providers.fixture.models[1].id, 'added');
                assert.equal(fixture.backups().length, 1);
                assert.deepEqual(fs.readFileSync(path.join(fixture.directory, fixture.backups()[0])), fixture.bytes);
                assertPrivateFile(fixture.modelsPath);
                assertPrivateFile(path.join(fixture.directory, fixture.backups()[0]));
            } else {
                assert.equal(fixture.backups().length, 0, 'conflict is checked before backup creation');
                if (change === 'remove') assert.equal(fs.existsSync(fixture.modelsPath), false);
                else assert.deepEqual(fs.readFileSync(fixture.modelsPath), external);
            }
            assert.deepEqual(fixture.temporary(), []);
        });
    }
});

test('provider deletion retains its read version across SDK, runtime and logout waits', async t => {
    const sdk = syntheticSdk(t);
    for (const wait of ['builtin-catalog', 'runtime', 'logout']) {
        await t.test(wait, async t => {
            const fixture = modelsFixture(t), entered = barrier(), release = barrier();
            const pause = async stage => { if (wait === stage) { entered.resolve(); await release.promise; } };
            sdk.ModelRuntime.create = async () => { await pause('builtin-catalog'); return { getProvider: () => undefined }; };
            let logouts = 0;
            fixture.service.createModelRuntime = async () => {
                await pause('runtime');
                return { getProvider: () => ({}), logout: async () => { logouts++; await pause('logout'); } };
            };
            const pending = fixture.service.deleteCustomProvider('fixture');
            await entered.promise;
            const external = Buffer.from(JSON.stringify({ ...fixture.data, outside: 'during-' + wait }, null, 4) + '\n');
            fs.writeFileSync(fixture.modelsPath, external);
            const rejected = assert.rejects(pending, error => error.statusCode === 409);
            release.resolve();
            await rejected;
            assert.equal(logouts, 1);
            assert.deepEqual(fs.readFileSync(fixture.modelsPath), external);
            assert.deepEqual(fixture.backups(), []);
            assert.deepEqual(fixture.temporary(), []);
        });
    }
});

test('every whole-file mutation preserves the read baseline through writer handoff', async t => {
    syntheticSdk(t);
    const operations = {
        upsertCustomProvider: target => target.upsertCustomProvider({ id: 'fixture', baseUrl: 'http://127.0.0.1:65530/new', api: 'openai-completions' }),
        deleteCustomProvider: target => target.deleteCustomProvider('fixture'),
        upsertCustomModel: target => target.upsertCustomModel('fixture', { id: 'model', name: 'Edited' }),
        deleteCustomModel: target => target.deleteCustomModel('fixture', 'model'),
        saveModelSpeed: async target => target.saveModelSpeed({ provider: 'fixture', modelId: 'model', expectedRevision: await target.configRevision(), speed: null }),
        saveModelAdvanced: async target => target.saveModelAdvanced({ provider: 'fixture', modelId: 'model', expectedRevision: await target.configRevision(), cost: { input: 3 } }),
        saveModelThinking: async target => target.saveModelThinking({ provider: 'fixture', modelId: 'model', expectedRevision: await target.configRevision(), thinkingLevelMap: { high: 'high' } })
    };
    for (const [name, operation] of Object.entries(operations)) {
        await t.test(name, async t => {
            const fixture = modelsFixture(t), entered = barrier(), release = barrier();
            const writer = fixture.service.writeModelsFile;
            fixture.service.writeModelsFile = async function (data) {
                entered.resolve(); await release.promise;
                return writer.call(this, data);
            };
            const pending = operation(fixture.service);
            await entered.promise;
            const external = Buffer.from(JSON.stringify({ ...fixture.data, outside: name }, null, 4) + '\n');
            fs.writeFileSync(fixture.modelsPath, external);
            const rejected = assert.rejects(pending, error => error.statusCode === 409);
            release.resolve();
            await rejected;
            assert.deepEqual(fs.readFileSync(fixture.modelsPath), external);
            assert.deepEqual(fixture.backups(), []);
            assert.deepEqual(fixture.temporary(), []);
        });
    }
});

test('absent model files stay bound to absence until replacement', async t => {
    for (const appeared of [false, true]) {
        const fixture = modelsFixture(t, { absent: true });
        const data = fixture.service.readModelsFile(fixture.modelsPath);
        data.providers.fixture = fixture.data.providers.fixture;
        if (appeared) fs.writeFileSync(fixture.modelsPath, fixture.bytes);
        const pending = fixture.service.writeModelsFile(data);
        if (appeared) {
            await assert.rejects(pending, error => error.statusCode === 409);
            assert.deepEqual(fs.readFileSync(fixture.modelsPath), fixture.bytes);
        } else {
            await pending;
            assert.deepEqual(JSON.parse(fs.readFileSync(fixture.modelsPath)), data);
            assertPrivateFile(fixture.modelsPath);
        }
        assert.deepEqual(fixture.backups(), []);
        assert.deepEqual(fixture.temporary(), []);
    }
});

test('Windows replacement retries reject edited or removed originals', async t => {
    const backend = require('../server/pi-win32-native'), original = backend.replaceFileSync;
    t.after(() => { backend.replaceFileSync = original; });
    for (const change of ['edit', 'remove']) {
        const fixture = modelsFixture(t), data = fixture.service.readModelsFile(fixture.modelsPath);
        data.futureRoot = 'must not commit';
        let calls = 0;
        backend.replaceFileSync = (_source, target) => {
            calls++;
            if (change === 'edit') fs.writeFileSync(target, 'external bytes\n');
            else fs.unlinkSync(target);
            throw Object.assign(new Error('synthetic sharing failure'), { code: 'FILE_REPLACE', win32Code: 32 });
        };
        await assert.rejects(fixture.service.writeModelsFile(data), error => error.statusCode === 409);
        assert.equal(calls, 1);
        if (change === 'remove') assert.equal(fs.existsSync(fixture.modelsPath), false);
        else assert.equal(fs.readFileSync(fixture.modelsPath, 'utf8'), 'external bytes\n');
        assert.deepEqual(fs.readFileSync(path.join(fixture.directory, fixture.backups()[0])), fixture.bytes);
        assert.deepEqual(fixture.temporary(), []);
    }
});


test('backup and staging retain the original bytes when the live file changes', async t => {
    const privateFiles = require('../server/pi-private-files'), original = privateFiles.writePrivateFileSync;
    t.after(() => { privateFiles.writePrivateFileSync = original; });
    for (const phase of ['backup', 'stage']) {
        const fixture = modelsFixture(t), data = fixture.service.readModelsFile(fixture.modelsPath);
        data.futureRoot = 'must not commit';
        let changed = false, staged = false;
        const external = Buffer.from('  {"providers":{}, "outside":"' + phase + '"}\n');
        privateFiles.writePrivateFileSync = (file, ...args) => {
            const result = original(file, ...args);
            const isStage = file.startsWith(fixture.modelsPath + '.tmp-');
            staged ||= isStage;
            if (phase === 'stage' ? isStage : file.startsWith(fixture.modelsPath + '.bak-web-')) {
                changed = true;
                fs.writeFileSync(fixture.modelsPath, external);
            }
            return result;
        };
        await assert.rejects(fixture.service.writeModelsFile(data), error => error.statusCode === 409);
        assert.equal(changed, true);
        assert.equal(staged, phase === 'stage');
        assert.deepEqual(fs.readFileSync(fixture.modelsPath), external);
        assert.equal(fixture.backups().length, 1);
        assert.deepEqual(fs.readFileSync(path.join(fixture.directory, fixture.backups()[0])), fixture.bytes);
        assert.deepEqual(fixture.temporary(), []);
    }
});
