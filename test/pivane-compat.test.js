const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dataFile, isInternalCommand, privateReply } = require('../server/pivane-compat');
const { loadLocalEnv, normalizeEnvironment } = require('../server/pi-local-env');
const { validateMessage } = require('../server/pi-message-payload');
const { taskProfile, taskState } = require('../server/pi-agent-threads');
const { assistantProfile } = require('../server/pi-extension-assistant');
const { titleSnapshot } = require('../server/pi-session-title-state');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compat-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('new installations use Pivane names; existing data and damaged legacy paths are not silently replaced', t => {
    const root = fixture(t), legacy = path.join(root, 'pi5-workspace.json'), current = path.join(root, 'pivane-workspace.json');
    assert.equal(dataFile(root, 'pivane-workspace.json'), current);
    fs.writeFileSync(legacy, 'legacy bytes');
    assert.equal(dataFile(root, 'pivane-workspace.json'), legacy);
    fs.writeFileSync(current, 'new bytes');
    assert.throws(() => dataFile(root, 'pivane-workspace.json'), /Both/);
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy bytes');
    if (process.platform !== 'win32') {
        const broken = path.join(root, 'pi5-access.json');
        fs.symlinkSync(path.join(root, 'missing'), broken);
        assert.equal(dataFile(root, 'pivane-access.json'), broken, 'access validation must see and reject a damaged old file');
    }
});

test('Pivane environment aliases preserve inherited precedence, clean isolation and native Pi identity', t => {
    const root = fixture(t), file = path.join(root, '.env');
    fs.writeFileSync(file, 'PIVANE_PROJECT_ROOTS=/from-file\nPIVANE_WEB_TOKEN=synthetic-file-value\nPI_CODING_AGENT_DIR=/native-identity\n');
    const env = { PI_PROJECT_ROOTS: '/inherited', PI_WEB_TOKEN: 'synthetic-inherited-value' };
    loadLocalEnv(file, env);
    assert.equal(env.PI_PROJECT_ROOTS, '/inherited');
    assert.equal(env.PI_WEB_TOKEN, 'synthetic-inherited-value');
    assert.equal(env.PI_CODING_AGENT_DIR, '/native-identity');
    const modern = {}; loadLocalEnv(file, modern);
    assert.equal(modern.PI_PROJECT_ROOTS, '/from-file');
    assert.equal(modern.PI_WEB_TOKEN, 'synthetic-file-value');
    const clean = { PIVANE_MEDIA_PROFILE: 'clean' }; loadLocalEnv(file, clean);
    assert.equal(clean.PI_MEDIA_PROFILE, 'clean'); assert.equal(clean.PI_CODING_AGENT_DIR, undefined);
    assert.throws(() => normalizeEnvironment({ PIVANE_WEB_TOKEN: 'one', PI_WEB_TOKEN: 'two' }), error => /Conflicting/.test(error.message) && !/one|two/.test(error.message));
});

test('native metadata aliases retain identity checks for titles, assistants and task threads', () => {
    for (const prefix of ['pi5', 'pivane']) {
        const entries = [
            { id: 'title', type: 'custom', customType: `${prefix}-web-title`, data: { sessionId: 'session', status: 'pending' } },
            { id: 'task', type: 'custom', customType: `${prefix}-agent-task`, data: { version: 1, sessionId: 'session' } },
            { id: 'state', type: 'custom', customType: `${prefix}-agent-task-state`, data: { sessionId: 'session', status: 'settled' } },
            { id: 'assistant', type: 'custom', customType: `${prefix}-extension-assistant`, data: { version: 1, sessionId: 'session', scope: 'project' } }
        ];
        const manager = { getEntries: () => entries, getSessionId: () => 'session', getBranch: () => [], getSessionName: () => '' };
        assert.equal(taskProfile(manager).sessionId, 'session');
        assert.equal(taskState(manager).status, 'settled');
        assert.equal(assistantProfile(manager).scope, 'project');
        assert.equal(titleSnapshot(manager).eligible, true);
        const fork = { ...manager, getSessionId: () => 'different-session' };
        assert.equal(taskProfile(fork), null); assert.equal(assistantProfile(fork), null);
        assert.equal(titleSnapshot(fork).eligible, false);
    }
});

test('both private command spellings remain blocked and legacy private replies normalize before broadcast', () => {
    for (const prefix of ['pi5', 'pivane']) {
        assert.equal(isInternalCommand(`${prefix}-web-navigate:1`), true);
        assert.throws(() => validateMessage({ message: `/${prefix}-web-navigate fixture` }), /内部/);
    }
    assert.equal(isInternalCommand('public-command'), false);
    assert.deepEqual(privateReply({ pi5Context: 'private-id', pivaneContext: null }).pivaneContext, 'private-id');
    assert.equal(privateReply({ pivaneHistory: 'current-id' }).pivaneHistory, 'current-id');
    assert.equal(privateReply(null), null);
    const policy = require('../public/pi-file-policy');
    for (const name of ['pi5-access.json', 'pivane-access.json', 'pivane-notifications.json.bak']) assert.equal(policy.restricted(name), true);
});
