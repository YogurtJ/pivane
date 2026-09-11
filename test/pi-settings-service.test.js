const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-agent-'));
const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-settings-package-'));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { PiSettingsService } = require('../server/pi-settings-service');

const service = new PiSettingsService({ cwd: '/srv/Pi5_GUI' });

test.after(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(packageDir, { recursive: true, force: true });
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

    await service.packageAction({ action: 'install', source: packageDir, cwd: '/srv/Pi5_GUI' });
    let resources = await service.getResourceSnapshot('/srv/Pi5_GUI');
    assert.equal(resources.packages.some(item => item.installedPath === packageDir), true);
    assert.equal(resources.skills.some(item => item.name === 'package-test-skill'), true);

    await service.packageAction({ action: 'remove', source: packageDir, cwd: '/srv/Pi5_GUI' });
    resources = await service.getResourceSnapshot('/srv/Pi5_GUI');
    assert.equal(resources.packages.some(item => item.installedPath === packageDir), false);
});

test('creates, discovers, and deletes standard user skills', async () => {
    await service.createSkill({
        name: 'web-test-skill',
        description: 'A temporary skill used by the Web settings test.',
        body: '# Web Test Skill\n\nReturn the requested test value.'
    });
    let resources = await service.getResourceSnapshot('/srv/Pi5_GUI');
    const skill = resources.skills.find(item => item.name === 'web-test-skill');
    assert.equal(skill.manageable, true);
    assert.equal(path.basename(skill.filePath), 'SKILL.md');
    assert.equal(path.basename(path.dirname(skill.filePath)), 'web-test-skill');

    await service.deleteSkill('web-test-skill');
    resources = await service.getResourceSnapshot('/srv/Pi5_GUI');
    assert.equal(resources.skills.some(item => item.name === 'web-test-skill'), false);
});
