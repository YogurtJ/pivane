const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-project-')));
const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-test-')));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = testRoot;

const { PiSessionStore, getSdk } = require('../server/pi-session-store');

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

test('unset and empty project roots allow filesystem roots while explicit roots remain authoritative', () => {
    const previous = process.env.PI_PROJECT_ROOTS;
    try {
        for (const value of [undefined, '']) {
            if (value === undefined) delete process.env.PI_PROJECT_ROOTS;
            else process.env.PI_PROJECT_ROOTS = value;
            const store = new PiSessionStore();
            if (process.platform === 'win32') {
                assert.ok(store.roots.includes(fs.realpathSync.native(path.parse(testRoot).root)));
                assert.ok(store.roots.every(root => path.dirname(root) === root));
            } else {
                assert.deepEqual(store.roots, ['/']);
            }
            assert.equal(store.resolveProject(testRoot), testRoot);
            assert.equal(store.resolveProject(agentDir), agentDir);
            assert.equal(store.defaultProject(), fs.realpathSync.native(os.homedir()));
        }
        process.env.PI_PROJECT_ROOTS = testRoot;
        const restricted = new PiSessionStore();
        assert.deepEqual(restricted.roots, [testRoot]);
        assert.throws(() => restricted.resolveProject(agentDir), /outside allowed roots/);
        process.env.PI_PROJECT_ROOTS = path.join(testRoot, 'missing');
        assert.deepEqual(new PiSessionStore().roots, []);
    } finally {
        if (previous === undefined) delete process.env.PI_PROJECT_ROOTS;
        else process.env.PI_PROJECT_ROOTS = previous;
    }
});

test('concurrent list readers share one native read, isolate results, and retry after failure', async t => {
    const store = new PiSessionStore();
    const session = await store.createSession(testRoot, 'Shared list');
    const { SessionManager } = await getSdk();
    const original = SessionManager.list;
    let release, entered, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    SessionManager.list = async (...args) => { calls++; entered(); await gate; return original.apply(SessionManager, args); };
    t.after(() => { SessionManager.list = original; release(); });
    const alias = path.join(testRoot, 'concurrent-project-alias');
    fs.symlinkSync(testRoot, alias, 'junction');
    t.after(() => fs.unlinkSync(alias));
    const reads = Array.from({ length: 8 }, (_, index) => store.listSessions(index % 2 ? alias : testRoot));
    await started; release();
    const rows = await Promise.all(reads);
    assert.equal(calls, 1);
    assert.equal(rows[0][0].id, session.id);
    rows[0][0].name = 'Only this caller';
    assert.equal(rows[1][0].name, 'Shared list');
    await store.listSessions(testRoot);
    assert.equal(calls, 1, 'unchanged native identities reuse the disposable projection');
    fs.appendFileSync(session.path, '\n');
    SessionManager.list = async () => { calls++; throw new Error('Synthetic read failure'); };
    const failed = await Promise.allSettled([store.listSessions(testRoot), store.listSessions(testRoot)]);
    assert.ok(failed.every(result => result.status === 'rejected'));
    assert.equal(calls, 2);
    SessionManager.list = original;
    assert.equal((await store.listSessions(testRoot))[0].name, 'Shared list');
    await store.deleteSession(testRoot, session.id);
});

test('a newly created session cannot join a list snapshot started before creation', async t => {
    const store = new PiSessionStore();
    const first = await store.createSession(testRoot, 'Before list');
    const { SessionManager } = await getSdk();
    const original = SessionManager.list;
    let release, entered, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    SessionManager.list = async (...args) => {
        const firstRead = ++calls === 1;
        const rows = await original.apply(SessionManager, args);
        if (firstRead) { entered(); await gate; }
        return rows;
    };
    t.after(() => { SessionManager.list = original; release(); });
    const older = store.listSessions(testRoot);
    await started;
    const second = await store.createSession(testRoot, 'After list');
    const fresh = await store.listSessions(testRoot);
    assert.equal(calls, 2);
    assert.ok(fresh.some(row => row.id === second.id));
    release();
    assert.equal((await older).some(row => row.id === second.id), false);
    SessionManager.list = original;
    await store.deleteSession(testRoot, first.id); await store.deleteSession(testRoot, second.id);
});

test('profile revision changes do not reuse a concurrent list projection', async t => {
    const store = new PiSessionStore();
    const session = await store.createSession(testRoot, 'Profile revision');
    let revision = 'before';
    store.profiles = { state: async () => ({ revision, state: { revision } }), describe: async (_manager, state) => ({ name: state.revision }) };
    const { SessionManager } = await getSdk();
    const original = SessionManager.list;
    let release, entered, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    SessionManager.list = async (...args) => {
        if (++calls === 1) { entered(); await gate; }
        return original.apply(SessionManager, args);
    };
    t.after(() => { SessionManager.list = original; release(); });
    const older = store.listSessions(testRoot);
    await started; revision = 'after';
    const fresh = await store.listSessions(testRoot);
    assert.equal(fresh[0].agentProfile.name, 'after');
    assert.equal(calls, 2);
    release();
    assert.equal((await older)[0].agentProfile.name, 'before');
    SessionManager.list = original; store.profiles = null;
    await store.deleteSession(testRoot, session.id);
});

test('rejects projects outside configured roots', () => {
    const store = new PiSessionStore();
    assert.throws(() => store.resolveProject(os.tmpdir()), /outside allowed roots/);
});
