const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-project-')));
const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-test-')));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = testRoot;

const { PiSessionStore } = require('../server/pi-session-store');

test.after(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
});

test('creates, lists, renames, and deletes native Pi sessions', async () => {
    const store = new PiSessionStore();
    const created = await store.createSession(testRoot, 'Web test session');

    assert.equal(created.cwd, testRoot);
    assert.equal(created.name, 'Web test session');
    assert.ok(fs.existsSync(created.path));

    let sessions = await store.listSessions(testRoot);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, created.id);
    assert.equal(sessions[0].name, 'Web test session');

    const renamed = await store.renameSession(testRoot, created.id, 'Renamed session');
    assert.equal(renamed.name, 'Renamed session');
    sessions = await store.listSessions(testRoot);
    assert.equal(sessions[0].name, 'Renamed session');

    const removed = await store.deleteSession(testRoot, created.id);
    assert.equal(removed.id, created.id);
    sessions = await store.listSessions(testRoot);
    assert.equal(sessions.length, 0);
});

test('creation and reopening keep the same session identity through an Agent directory alias', async () => {
    const { PiSessionStore } = require('../server/pi-session-store');
    const alias = path.join(testRoot, 'agent-alias'); fs.symlinkSync(agentDir, alias, 'junction');
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = alias;
        const store = new PiSessionStore(); const session = await store.createSession(testRoot, 'Alias identity');
        assert.equal(session.path, fs.realpathSync.native(session.path));
        assert.equal((await store.getSession(testRoot, session.id)).path, session.path);
        await store.deleteSession(testRoot, session.id);
    } finally { process.env.PI_CODING_AGENT_DIR = previous; }
});

test('case-insensitive project aliases resolve to the same canonical session path', async () => {
    const { PiSessionStore } = require('../server/pi-session-store');
    const store = new PiSessionStore();
    const directory = path.join(testRoot, 'MixedCaseProject'); fs.mkdirSync(directory);
    const alias = path.join(testRoot, 'mixedcaseproject');
    if (!fs.existsSync(alias)) {
        assert.throws(() => store.resolveProject(alias), /does not exist/);
        return;
    }
    const canonical = fs.realpathSync.native(directory);
    assert.equal(store.resolveProject(alias), canonical);
    const session = await store.createSession(directory, 'Canonical identity');
    assert.equal((await store.getSession(alias, session.id)).path, session.path);
    await store.deleteSession(alias, session.id);
});

test('filesystem root permits descendants, nested roots permit their allowed parent, and defaults are valid', async () => {
    const store = new PiSessionStore();
    store.roots = [path.parse(testRoot).root];
    assert.equal(store.resolveProject(testRoot), testRoot);
    assert.ok(path.isAbsolute(store.defaultProject()));
    assert.equal((await store.listDirectories(path.parse(testRoot).root)).parent, null);
    const child = path.join(testRoot, 'nested'); fs.mkdirSync(child);
    store.roots = [child, testRoot];
    assert.equal((await store.listDirectories(child)).parent, testRoot);
    assert.equal((await store.listDirectories(testRoot)).parent, null);
    assert.equal(store.defaultProject(), child);
    store.roots = []; assert.equal(store.defaultProject(), null);
});

test('rejects projects outside configured roots', () => {
    const store = new PiSessionStore();
    assert.throws(() => store.resolveProject(os.tmpdir()), /outside allowed roots/);
});
