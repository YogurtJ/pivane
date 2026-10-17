'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { listExtendedMemories, safeFile } = require('../server/profile-memory/management');
const { documentIndex } = require('../server/profile-memory/document-index');
const { prepareProfileDatabase } = require('../server/profile-memory/schema-prep');
const { Worker } = require('node:worker_threads');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const columns = db => db.prepare('PRAGMA table_info(memories)').all().map(column => column.name);
const hits = db => db.prepare('SELECT content, hit_count AS hits, last_hit_at AS lastHit FROM memories ORDER BY id').all();
const tempRoot = (t, name) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), name)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
};
// Creates a database with the current schema, then removes the two 0.9.10 columns.
async function legacyDatabase(root) {
    const upstream = await import(pathToFileURL(bundle).href);
    const created = new upstream.DatabaseManager(root);
    created.getDb();
    created.close();
    const db = new (createRequire(bundle)('better-sqlite3'))(path.join(root, 'sessions.db'));
    try {
        db.exec('ALTER TABLE memories DROP COLUMN last_hit_at; ALTER TABLE memories DROP COLUMN hit_count;');
        db.prepare('INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (?, ?, ?, ?, ?, ?)')
            .run(null, 'memory', null, 'Existing fact', '2026-01-01', '2026-01-01');
    } finally { db.close(); }
    return path.join(root, 'sessions.db');
}

// pi-hermes-memory 0.9.10 adds memories.hit_count/last_hit_at. The only schema
// difference from 0.9.9 is those two columns, so dropping them reproduces an
// existing profile database written by the previous bundled release.
test('previous profile memory database upgrades additively without changing Pivane revisions', { skip: !bundle }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-memory-upgrade-')));
    const managers = [];
    t.after(() => { for (const manager of managers) try { manager.close(); } catch { /* already closed */ }
        fs.rmSync(root, { recursive: true, force: true }); });
    const upstream = await import(pathToFileURL(bundle).href);
    const Database = createRequire(bundle)('better-sqlite3');
    const created = new upstream.DatabaseManager(root);
    created.getDb();
    created.close();
    const dbPath = path.join(root, 'sessions.db');
    const legacy = new Database(dbPath);
    legacy.exec('ALTER TABLE memories DROP COLUMN last_hit_at; ALTER TABLE memories DROP COLUMN hit_count;');
    // Statement shapes used by the previous release and by Pivane's document index.
    const insert = legacy.prepare('INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(null, 'memory', null, 'Document mirrored fact about 秩', '2026-01-01', '2026-01-02');
    insert.run('/synthetic/project', 'memory', 'insight', 'SQLite-only project insight', '2026-01-03', '2026-01-03');
    assert.equal(columns(legacy).includes('hit_count'), false);
    legacy.close();
    const before = listExtendedMemories(root, bundle);
    assert.equal(before.items.length, 2);

    const upgraded = new upstream.DatabaseManager(root);
    managers.push(upgraded);
    const db = upgraded.getDb();
    assert.ok(columns(db).includes('hit_count') && columns(db).includes('last_hit_at'));
    assert.deepEqual(hits(db).map(row => [row.hits, row.lastHit]), [[0, null], [0, null]]);
    assert.deepEqual(listExtendedMemories(root, bundle), before, 'listing and its revision ignore upstream recall counters');

    const register = options => {
        let tool;
        upstream.registerMemorySearchTool({ registerTool: value => { tool = value; } }, upgraded, options);
        return tool;
    };
    const found = await register({ usageTrackingEnabled: false }).execute('search', { query: '秩' });
    assert.equal(found.details.count, 1);
    assert.deepEqual(hits(db).map(row => row.hits), [0, 0], 'the Pivane adapter option keeps search read-only');
    // Pin the reviewed upstream default so a future change is noticed in review.
    await register(undefined).execute('search', { query: '秩' });
    assert.deepEqual(hits(db).map(row => row.hits), [1, 0], 'upstream default records a recall hit');
    assert.deepEqual(listExtendedMemories(root, bundle), before, 'recall counters never change the knowledge revision');
    upgraded.close();

    // Previous-release write shapes keep working after the additive migration.
    fs.writeFileSync(path.join(root, 'MEMORY.md'), 'Document mirrored fact about 秩');
    const after = 'Document mirrored fact about 秩\n§\nNew document fact after upgrade';
    const index = await documentIndex(root, 'memory', bundle, { text: 'Document mirrored fact about 秩', revision: null }, after);
    try {
        index.mark();
        fs.writeFileSync(path.join(root, 'MEMORY.md'), after);
        assert.equal(safeFile(path.join(root, 'MEMORY.md')).revision, index.plan.after);
        index.sync();
    } finally { index.close(); }
    const reopened = new Database(dbPath, { readonly: true });
    try {
        const rows = hits(reopened);
        assert.deepEqual(rows.map(row => row.content), ['Document mirrored fact about 秩', 'SQLite-only project insight', 'New document fact after upgrade']);
        assert.deepEqual(rows.map(row => row.hits), [1, 0, 0]);
    } finally { reopened.close(); }
});

test('Pivane pre-migration adds exactly the upstream columns once and never follows unsafe paths', { skip: !bundle }, async t => {
    const Database = createRequire(bundle)('better-sqlite3');
    const shape = file => { const db = new Database(file, { readonly: true });
        try { return db.prepare('PRAGMA table_info(memories)').all(); } finally { db.close(); } };
    const fresh = tempRoot(t, 'pivane-memory-fresh-');
    const upstream = await import(pathToFileURL(bundle).href);
    const manager = new upstream.DatabaseManager(fresh);
    manager.getDb();
    manager.close();
    const legacyRoot = tempRoot(t, 'pivane-memory-legacy-');
    const legacyFile = await legacyDatabase(legacyRoot);
    assert.deepEqual(prepareProfileDatabase(legacyRoot, bundle), ['hit_count', 'last_hit_at']);
    assert.deepEqual(shape(legacyFile), shape(path.join(fresh, 'sessions.db')), 'same column definitions as an upstream-created database');
    assert.deepEqual(prepareProfileDatabase(legacyRoot, bundle), [], 'idempotent');
    const missing = tempRoot(t, 'pivane-memory-missing-');
    assert.deepEqual(prepareProfileDatabase(missing, bundle), []);
    assert.equal(fs.existsSync(path.join(missing, 'sessions.db')), false, 'never creates a database');
    const targetRoot = tempRoot(t, 'pivane-memory-target-');
    const target = await legacyDatabase(targetRoot);
    const linked = tempRoot(t, 'pivane-memory-link-');
    fs.symlinkSync(target, path.join(linked, 'sessions.db'));
    assert.deepEqual(prepareProfileDatabase(linked, bundle), []);
    assert.equal(shape(target).some(column => column.name === 'hit_count'), false, 'a symlinked database is not migrated');
    const corruptRoot = tempRoot(t, 'pivane-memory-corrupt-');
    fs.writeFileSync(path.join(corruptRoot, 'sessions.db'), Buffer.alloc(4096, 7));
    assert.deepEqual(prepareProfileDatabase(corruptRoot, bundle), [], 'corruption is left to upstream recovery');
    const busyRoot = tempRoot(t, 'pivane-memory-busy-');
    const busyFile = await legacyDatabase(busyRoot);
    const writer = new Database(busyFile);
    writer.exec('BEGIN IMMEDIATE');
    try {
        assert.throws(() => prepareProfileDatabase(busyRoot, bundle, { busyTimeoutMs: 50 }), error => error.code === 'SQLITE_BUSY',
            'a busy writer fails closed instead of falling through to an unsynchronized upstream migration');
    } finally { writer.exec('ROLLBACK'); writer.close(); }
    assert.equal(shape(busyFile).some(column => column.name === 'hit_count'), false);
    assert.deepEqual(prepareProfileDatabase(busyRoot, bundle), ['hit_count', 'last_hit_at']);
});

test('concurrent first opens of an upgraded profile database do not race on added columns', { skip: !bundle }, async t => {
    const Database = createRequire(bundle)('better-sqlite3');
    const run = async (prepare, { busyTimeoutMs, holdWriter = false } = {}) => {
        const root = tempRoot(t, 'pivane-memory-race-');
        const file = await legacyDatabase(root);
        const barrier = new SharedArrayBuffer(4);
        // The writer stays locked until both workers have reported, however long they take to start.
        const writer = holdWriter ? new Database(file) : null;
        writer?.exec('BEGIN IMMEDIATE');
        let results;
        try {
            results = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
                const worker = new Worker(path.join(__dirname, 'helpers', 'profile-memory-open-race.mjs'),
                    { workerData: { bundle, root, barrier, prepare, busyTimeoutMs } });
                worker.once('message', resolve);
                worker.once('error', reject);
            })));
        } finally { if (writer) { writer.exec('ROLLBACK'); writer.close(); } }
        const db = new Database(file, { readonly: true });
        try {
            assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
            assert.equal(db.prepare('SELECT COUNT(*) AS total FROM memories').get().total, 1);
            return { results, migrated: columns(db).includes('hit_count') && columns(db).includes('last_hit_at') };
        } finally { db.close(); }
    };
    // Reviewed upstream behaviour: revisit schema-prep.js once upstream serializes this migration.
    const unprepared = await run(false);
    assert.ok(unprepared.migrated && unprepared.results.every(result => result.reached), 'both opens reached the upstream column snapshot');
    assert.deepEqual(unprepared.results.map(result => result.ok).sort(), [false, true]);
    assert.match(unprepared.results.find(result => !result.ok).error, /duplicate column name/);
    const prepared = await run(true);
    assert.ok(prepared.migrated && prepared.results.every(result => result.ok && result.reached), 'the Pivane pre-migration serializes the first opens');
    // A writer holding the lock past the busy timeout makes both preparations fail
    // closed; neither reaches the unsynchronized upstream migration.
    const busy = await run(true, { busyTimeoutMs: 100, holdWriter: true });
    assert.ok(busy.results.every(result => !result.ok && result.stage === 'prepare' && result.code === 'SQLITE_BUSY' && !result.reached),
        JSON.stringify(busy.results));
    assert.equal(busy.migrated, false);
});
