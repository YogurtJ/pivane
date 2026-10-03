'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { mountProfileDocumentRoutes } = require('../server/pi-profile-documents');
const { documentIndex, pendingDocumentIndex } = require('../server/profile-memory/document-index');
const { safeFile } = require('../server/profile-memory/management');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
test('whole-document edits reconcile only their exact native Markdown facts', { skip: !bundle, timeout: 30000 }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-recall-')));
    test.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = path.join(root, 'agent'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    const upstream = await import(bundle);
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    t.after(() => profiles.dispose());
    const createProfile = async name => profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name, description: '', soul: '', enabled: true, memory: { enabled: true, autoLearn: false } } });
    const first = (await createProfile('One')).profile, second = (await createProfile('Two')).profile;
    const firstRoot = path.join(agent, 'pivane-profiles', 'data', first.id);
    const secondRoot = path.join(agent, 'pivane-profiles', 'data', second.id);
    const projectRoot = path.join(firstRoot, 'projects', 'a'.repeat(64));
    for (const dir of [firstRoot, secondRoot, projectRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const config = dir => ({ memoryDir: dir, memoryMode: 'legacy-inject', memoryCharLimit: 16000, userCharLimit: 8000,
        memoryOverflowStrategy: 'reject', autoConsolidate: false });
    const ownStore = new upstream.MemoryStore(config(firstRoot)), otherStore = new upstream.MemoryStore(config(secondRoot)),
        projectStore = new upstream.MemoryStore(config(projectRoot));
    const ownDb = new upstream.DatabaseManager(firstRoot), otherDb = new upstream.DatabaseManager(secondRoot);
    t.after(() => { ownDb.close(); otherDb.close(); });
    const tools = db => { const registered = new Map(), pi = { registerTool: tool => registered.set(tool.name, tool), on() {} };
        upstream.registerMemorySearchTool(pi, db); return registered; };
    const ownTools = tools(ownDb), otherTools = tools(otherDb);
    upstream.registerMemoryTool({ registerTool: tool => ownTools.set(tool.name, tool), on() {} }, ownStore, projectStore, ownDb, () => '/synthetic');
    upstream.registerMemoryTool({ registerTool: tool => otherTools.set(tool.name, tool), on() {} }, otherStore, null, otherDb);
    await Promise.all([ownStore.loadFromDisk(), otherStore.loadFromDisk(), projectStore.loadFromDisk()]);
    const add = (list, target, content) => list.get('memory_add').execute('fixture', { target, content }, undefined, undefined, {});
    assert.equal((await add(ownTools, 'user', 'OldFactAlpha')).details.success, true);
    assert.equal((await add(ownTools, 'memory', 'OtherGlobal')).details.success, true);
    assert.equal((await add(ownTools, 'project', 'ProjectOnly')).details.success, true);
    assert.equal((await add(otherTools, 'user', 'OtherProfile')).details.success, true);
    ownDb.getDb().prepare('INSERT INTO memories (target, project, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)')
        .run('user', null, 'IndependentSqliteOnly', '2026-01-01', '2026-01-01');
    const routes = new Map(), router = { get: (name, fn) => routes.set('GET', fn), put: (name, fn) => routes.set('PUT', fn) };
    mountProfileDocumentRoutes(router, { profiles, getAgentDir: async () => agent, bundlePath: bundle });
    const call = async (method, id, input) => { const res = { code: 200, set() { return this; }, status(value) { this.code = value; return this; },
        json(data) { this.data = data; return this; } }; await routes.get(method)({ params: { id }, query: { target: 'user' }, body: input }, res); return res; };
    const save = async (content, before) => {
        before ??= (await call('GET', first.id)).data;
        return call('PUT', first.id, { target: 'user', content,
            expectedRevision: before.revision, expectedProfileRevision: before.profileRevision });
    };
    const lookup = async (registered, query, target) => (await registered.get('memory_search').execute('fixture', { query, target })).details.count;
    const stale = (await call('GET', first.id)).data;
    const replaced = await save('NewFactBeta');
    assert.equal(replaced.code, 200, JSON.stringify(replaced.data));
    assert.equal(replaced.data.indexSynced, true);
    assert.equal(await lookup(ownTools, 'OldFactAlpha', 'user'), 0);
    assert.equal(await lookup(ownTools, 'NewFactBeta', 'user'), 1);
    assert.equal(await lookup(ownTools, 'IndependentSqliteOnly', 'user'), 1);
    assert.equal(await lookup(ownTools, 'OtherGlobal', 'memory'), 1);
    assert.equal(await lookup(ownTools, 'ProjectOnly', 'project'), 1);
    assert.equal(await lookup(otherTools, 'OtherProfile', 'user'), 1);
    assert.equal((await save('Cannot overwrite', stale)).code, 409);
    assert.equal(await lookup(ownTools, 'NewFactBeta', 'user'), 1);
    const cleared = await save('');
    assert.equal(cleared.code, 200, JSON.stringify(cleared.data));
    assert.equal(await lookup(ownTools, 'NewFactBeta', 'user'), 0);
    assert.equal(await lookup(ownTools, 'IndependentSqliteOnly', 'user'), 1);
    assert.equal((await save('Unique')).code, 200);
    ownDb.getDb().prepare('INSERT INTO memories (target, project, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)')
        .run('user', null, 'Unique', '2026-01-01', '2026-01-01');
    const ambiguous = await save('Changed');
    assert.equal(ambiguous.code, 409);
    assert.equal((await call('GET', first.id)).data.content, 'Unique');
    const ids = ownDb.getDb().prepare("SELECT id FROM memories WHERE target = 'user' AND project IS NULL AND content = 'Unique' ORDER BY id").all();
    ownDb.getDb().prepare('DELETE FROM memories WHERE id = ?').run(ids[1].id);
    ownDb.getDb().prepare("UPDATE memories SET category = 'preference' WHERE id = ?").run(ids[0].id);
    assert.equal((await save('Changed')).code, 409, 'metadata conflicts reject before publication');
    assert.equal((await call('GET', first.id)).data.content, 'Unique');
    assert.equal(pendingDocumentIndex(firstRoot, 'user'), null);
});

test('post-publication index failure reports partial save and permits deterministic repair', { skip: !bundle }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-repair-')));
    test.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = path.join(root, 'agent'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    const upstream = await import(bundle);
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    t.after(() => profiles.dispose());
    const saved = await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name: 'Fixture', description: '', soul: '', enabled: true, memory: { enabled: true, autoLearn: false } } });
    const rootDir = path.join(agent, 'pivane-profiles', 'data', saved.profile.id);
    const routes = new Map(), router = { get: (_name, fn) => routes.set('GET', fn), put: (_name, fn) => routes.set('PUT', fn) };
    mountProfileDocumentRoutes(router, { profiles, getAgentDir: async () => agent, bundlePath: bundle });
    const call = async (method, body) => { const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
        json(value) { this.data = value; return this; } }; await routes.get(method)({ params: { id: saved.profile.id }, query: { target: 'user' }, body }, res); return res; };
    const before = (await call('GET')).data;
    const original = upstream.DatabaseManager.prototype.withCorruptionRecovery;
    let calls = 0;
    upstream.DatabaseManager.prototype.withCorruptionRecovery = function (...args) {
        if (++calls === 2) throw Error('synthetic index unavailable');
        return original.apply(this, args);
    };
    let partial;
    try { partial = await call('PUT', { target: 'user', content: 'RecoverableFact', expectedRevision: before.revision,
        expectedProfileRevision: before.profileRevision }); }
    finally { upstream.DatabaseManager.prototype.withCorruptionRecovery = original; }
    assert.equal(partial.code, 503, JSON.stringify(partial.data));
    assert.deepEqual([partial.data.documentSaved, partial.data.indexSynced], [true, false]);
    assert.equal((await call('GET')).data.indexSynced, false);
    assert.ok(pendingDocumentIndex(rootDir, 'user'));
    const changed = (await call('GET')).data;
    assert.equal((await call('PUT', { target: 'user', content: 'Different', expectedRevision: changed.revision,
        expectedProfileRevision: changed.profileRevision })).code, 409);
    const repairRevision = (await call('GET')).data;
    const repaired = await call('PUT', { target: 'user', content: repairRevision.content, expectedRevision: repairRevision.revision,
        expectedProfileRevision: repairRevision.profileRevision });
    assert.equal(repaired.code, 200, JSON.stringify(repaired.data));
    assert.equal(repaired.data.indexSynced, true);
    assert.equal(pendingDocumentIndex(rootDir, 'user'), null);
    const db = new upstream.DatabaseManager(rootDir);
    assert.equal(upstream.searchMemories(db, 'RecoverableFact', { target: 'user' }).length, 1);
    db.close();
    const current = (await call('GET')).data;
    const privateFiles = require('../server/pi-private-files');
    const originalMode = privateFiles.privateFileMode;
    privateFiles.privateFileMode = file => {
        if (file === path.join(rootDir, 'USER.md')) throw Error('synthetic post-replace failure');
        return originalMode(file);
    };
    let uncertain;
    try { uncertain = await call('PUT', { target: 'user', content: 'SecondFact', expectedRevision: current.revision,
        expectedProfileRevision: current.profileRevision }); }
    finally { privateFiles.privateFileMode = originalMode; }
    assert.equal(uncertain.code, 503);
    assert.deepEqual([uncertain.data.documentSaved, uncertain.data.indexSynced], [true, false]);
    assert.equal((await call('GET')).data.content, 'SecondFact');
    assert.ok(pendingDocumentIndex(rootDir, 'user'));
    const now = (await call('GET')).data;
    assert.equal((await call('PUT', { target: 'user', content: now.content, expectedRevision: now.revision,
        expectedProfileRevision: now.profileRevision })).code, 200);
});

test('USER initialized without memory or a mirror is indexed after enable, including unchanged documents', { skip: !bundle }, async t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-enable-')));
    test.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const agent = path.join(base, 'agent'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    const upstream = await import(bundle);
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    t.after(() => profiles.dispose());
    const create = async (name, enabled) => (await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name, description: '', soul: '', enabled: true, memory: { enabled, autoLearn: false } } })).profile;
    const dormant = await create('Dormant', false);
    const root = path.join(agent, 'pivane-profiles', 'data', dormant.id);
    const handlers = new Map(), router = { get: (_name, fn) => handlers.set('GET', fn), put: (_name, fn) => handlers.set('PUT', fn) };
    mountProfileDocumentRoutes(router, { profiles, getAgentDir: async () => agent, bundlePath: bundle });
    const request = async (method, id, body) => {
        const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
            json(value) { this.data = value; return this; } };
        await handlers.get(method)({ params: { id }, query: { target: 'user' }, body }, res);
        return res;
    };
    const read = async id => (await request('GET', id)).data;
    const save = async (id, content) => {
        const before = await read(id);
        return request('PUT', id, { target: 'user', content, expectedRevision: before.revision,
            expectedProfileRevision: before.profileRevision });
    };
    assert.equal((await save(dormant.id, 'BeforeEnable')).code, 202);
    assert.equal(fs.existsSync(path.join(root, 'sessions.db')), false, 'inactive USER initialization does not open SQLite');
    await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { ...dormant, memory: { ...dormant.memory, enabled: true } } });
    assert.equal((await read(dormant.id)).indexSynced, false, 'enabling memory does not invent mirror rows');
    const db = new upstream.DatabaseManager(root);
    t.after(() => db.close());
    db.getDb().prepare('INSERT INTO memories (target, project, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)')
        .run('user', null, 'IndependentSqliteOnly', '2026-01-01', '2026-01-01');
    assert.equal((await read(dormant.id)).indexSynced, false, 'an unrelated SQLite row does not prove the document is indexed');
    assert.equal((await save(dormant.id, 'AfterEnable')).code, 200);
    assert.equal((await read(dormant.id)).indexSynced, true);
    assert.equal(upstream.searchMemories(db, 'BeforeEnable', { target: 'user' }).length, 0);
    assert.equal(upstream.searchMemories(db, 'AfterEnable', { target: 'user' }).length, 1);
    assert.equal(upstream.searchMemories(db, 'IndependentSqliteOnly', { target: 'user' }).length, 1);

    const legacy = await create('Legacy', true);
    const legacyRoot = path.join(agent, 'pivane-profiles', 'data', legacy.id);
    fs.mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(legacyRoot, 'USER.md'), 'LegacyWithoutAdapter', { mode: 0o600 });
    assert.equal((await read(legacy.id)).indexSynced, false, 'pre-existing native Markdown without a DB is not indexed');
    assert.equal((await save(legacy.id, 'LegacyWithoutAdapter')).code, 200, 'unchanged-current PUT repairs a missing mirror');
    assert.equal((await read(legacy.id)).indexSynced, true);
    const legacyDb = new upstream.DatabaseManager(legacyRoot);
    assert.equal(upstream.searchMemories(legacyDb, 'LegacyWithoutAdapter', { target: 'user' }).length, 1);
    legacyDb.close();

    const empty = await create('Empty DB', true);
    const emptyRoot = path.join(agent, 'pivane-profiles', 'data', empty.id);
    fs.mkdirSync(emptyRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(emptyRoot, 'USER.md'), 'BeforeEmptyIndex', { mode: 0o600 });
    const emptyDb = new upstream.DatabaseManager(emptyRoot);
    emptyDb.getDb();
    assert.equal((await read(empty.id)).indexSynced, false, 'an empty SQLite database is not a mirror');
    assert.equal((await save(empty.id, 'AfterEmptyIndex')).code, 200);
    assert.equal(upstream.searchMemories(emptyDb, 'BeforeEmptyIndex', { target: 'user' }).length, 0);
    assert.equal(upstream.searchMemories(emptyDb, 'AfterEmptyIndex', { target: 'user' }).length, 1);
    emptyDb.close();
});

test('interrupted pending plan restores missing retained facts without changing unrelated rows', { skip: !bundle }, async t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-retained-')));
    test.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const agent = path.join(base, 'agent'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    const upstream = await import(bundle);
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    t.after(() => profiles.dispose());
    const profile = (await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name: 'Interrupted', description: '', soul: '', enabled: true, memory: { enabled: true, autoLearn: false } } })).profile;
    const root = path.join(agent, 'pivane-profiles', 'data', profile.id);
    const handlers = new Map(), router = { get: (_name, fn) => handlers.set('GET', fn), put: (_name, fn) => handlers.set('PUT', fn) };
    mountProfileDocumentRoutes(router, { profiles, getAgentDir: async () => agent, bundlePath: bundle });
    const request = async (method, body) => {
        const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
            json(data) { this.data = data; return this; } };
        await handlers.get(method)({ params: { id: profile.id }, query: { target: 'user' }, body }, res);
        return res;
    };
    const save = async content => { const before = (await request('GET')).data;
        return request('PUT', { target: 'user', content, expectedRevision: before.revision,
            expectedProfileRevision: before.profileRevision }); };
    assert.equal((await save('Retained\n§\nRemoved')).code, 200);
    const db = new upstream.DatabaseManager(root);
    t.after(() => db.close());
    db.getDb().prepare('INSERT INTO memories (target, project, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)')
        .run('user', null, 'SeparateSqliteFact', '2026-01-01', '2026-01-01');
    const original = upstream.DatabaseManager.prototype.withCorruptionRecovery;
    let calls = 0;
    upstream.DatabaseManager.prototype.withCorruptionRecovery = function (...args) {
        if (++calls === 2) throw Error('synthetic post-publication interruption');
        return original.apply(this, args);
    };
    let partial;
    try { partial = await save('Retained\n§\nAdded'); }
    finally { upstream.DatabaseManager.prototype.withCorruptionRecovery = original; }
    assert.equal(partial.code, 503, JSON.stringify(partial.data));
    assert.ok(pendingDocumentIndex(root, 'user'));
    db.getDb().prepare("DELETE FROM memories WHERE target = 'user' AND project IS NULL AND content IN ('Retained', 'Removed')").run();
    assert.equal((await request('GET')).data.indexSynced, false);
    assert.equal((await save('Retained\n§\nAdded')).code, 200, 'the same current content repairs the pending plan');
    assert.equal((await request('GET')).data.indexSynced, true);
    assert.equal(upstream.searchMemories(db, 'Retained', { target: 'user' }).length, 1);
    assert.equal(upstream.searchMemories(db, 'Added', { target: 'user' }).length, 1);
    assert.equal(upstream.searchMemories(db, 'Removed', { target: 'user' }).length, 0);
    assert.equal(upstream.searchMemories(db, 'SeparateSqliteFact', { target: 'user' }).length, 1);
    assert.equal(pendingDocumentIndex(root, 'user'), null);
});

test('unpublished pending plan clears only for a verified old document', { skip: !bundle }, async t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-before-publish-')));
    test.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const agent = path.join(base, 'agent'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    const upstream = await import(bundle);
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    t.after(() => profiles.dispose());
    const profile = (await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name: 'Interrupted', description: '', soul: '', enabled: true, memory: { enabled: true, autoLearn: false } } })).profile;
    const root = path.join(agent, 'pivane-profiles', 'data', profile.id), file = path.join(root, 'USER.md');
    const handlers = new Map(), router = { get: (_name, fn) => handlers.set('GET', fn), put: (_name, fn) => handlers.set('PUT', fn) };
    mountProfileDocumentRoutes(router, { profiles, getAgentDir: async () => agent, bundlePath: bundle });
    const request = async (method, body) => {
        const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; },
            json(data) { this.data = data; return this; } };
        await handlers.get(method)({ params: { id: profile.id }, query: { target: 'user' }, body }, res);
        return res;
    };
    const save = async content => { const before = (await request('GET')).data;
        return request('PUT', { target: 'user', content, expectedRevision: before.revision,
            expectedProfileRevision: before.profileRevision }); };
    assert.equal((await save('Original')).code, 200);
    const interrupted = await documentIndex(root, 'user', bundle, safeFile(file), 'NeverPublished');
    interrupted.mark(); interrupted.close();
    assert.ok(pendingDocumentIndex(root, 'user'));
    assert.equal((await request('GET')).data.indexSynced, false);
    const edited = await save('FreshEdit');
    assert.equal(edited.code, 200, JSON.stringify(edited.data));
    assert.equal(pendingDocumentIndex(root, 'user'), null);
    const db = new upstream.DatabaseManager(root);
    assert.equal(upstream.searchMemories(db, 'Original', { target: 'user' }).length, 0);
    assert.equal(upstream.searchMemories(db, 'NeverPublished', { target: 'user' }).length, 0);
    assert.equal(upstream.searchMemories(db, 'FreshEdit', { target: 'user' }).length, 1);
    db.close();

    const uncertain = await documentIndex(root, 'user', bundle, safeFile(file), 'Proposed');
    uncertain.mark(); uncertain.close();
    fs.writeFileSync(file, 'ThirdPartyContent');
    assert.equal((await save('RefuseUnknown')).code, 409);
    assert.ok(pendingDocumentIndex(root, 'user'), 'unknown source revision retains the gate');
    assert.equal((await request('GET')).data.content, 'ThirdPartyContent');
});
