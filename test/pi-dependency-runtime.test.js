'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { PI_PACKAGES, verifyPiPackages } = require('../server/pi-update-installer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-dependency-runtime-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PACKAGE_DIR = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
process.env.PI_SKIP_VERSION_CHECK = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('installed official Pi group imports its public entries with the exact reviewed lock and security resolutions', async () => {
    const manifest = require('../package.json'), lock = require('../package-lock.json');
    verifyPiPackages(path.resolve(__dirname, '..'), manifest, lock, '1.2.0');
    for (const name of PI_PACKAGES) assert.ok(await import(name));
    assert.deepEqual(require('../scripts/install-bundled-capabilities.cjs').enforceShrinkwrapFixes(), []);
});

test('Pi 1.2 SDK retains offline models, settings and historical session tree/context edits', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    assert.equal(sdk.VERSION, '1.2.0');
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(root, 'agent', 'auth.json'),
        modelsPath: null, modelsStorePath: path.join(root, 'models-store.json'), allowModelNetwork: false });
    assert.ok(Array.isArray(await runtime.getAvailable()));
    assert.equal(typeof ai.getSupportedThinkingLevels, 'function');
    const settings = sdk.SettingsManager.create(root, process.env.PI_CODING_AGENT_DIR);
    assert.ok(settings.getGlobalSettings());
    const legacy = path.join(root, 'legacy.jsonl');
    fs.copyFileSync(path.join(__dirname, 'fixtures/pi-0843-session.jsonl'), legacy);
    const session = sdk.SessionManager.open(legacy);
    assert.ok(session.getEntries().length);
    const original = session.appendMessage({ role: 'user', content: 'Original dependency fixture', timestamp: 1 });
    session.appendContextEdit(original, { content: 'Edited dependency fixture' });
    assert.ok(session.getEntries().some(entry => entry.type === 'context_edit'));
    assert.ok(session.buildSessionContext().messages.some(message => message.content === 'Edited dependency fixture'));
});

test('unchanged memory 0.9.9 bundle imports against Pi 1.2 without rebuilding upstream implementation', async () => {
    const bundle = require('../server/pi-bundled-capabilities').memoryBundle();
    assert.equal(createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'), require('../server/profile-memory/management').BUNDLE_SHA256);
    const memory = await import(pathToFileURL(bundle).href);
    for (const name of ['DatabaseManager', 'MemoryStore', 'SkillStore', 'parseSessionManagerSnapshot', 'registerMemoryTool', 'registerSessionSearchTool'])
        assert.equal(typeof memory[name], 'function');
});
