'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { ProfileKnowledgeService } = require('../server/profile-memory/knowledge-service');
const { memoryRecall, withRecall, entryText, listMemories, listExtendedMemories } = require('../server/profile-memory/management');
const { createBackgroundIndex } = require('../server/profile-memory/background-index');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup(t) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-recall-')));
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const profile = { id, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } };
    const service = new ProfileKnowledgeService({ profiles: { getProfile: async key => key === id ? profile : null, reserve: work => work() },
        getAgentDir: async () => agent, bundlePath: bundle });
    const root = path.join(agent, 'pivane-profiles', 'data', id);
    let serial = 0;
    const mutate = async (operation, fields = {}) => service.mutate(id, { requestId: `recall-${++serial}`,
        expectedRevision: (await service.snapshot(id)).revision, operation, kind: 'memory', ...fields });
    const sql = (statement, ...params) => {
        const db = new (createRequire(bundle)('better-sqlite3'))(path.join(root, 'sessions.db'));
        try { return db.prepare(statement).run(...params); } finally { db.close(); }
    };
    return { service, root, mutate, sql };
}

test('entryText strips only the upstream trailing metadata comment', () => {
    assert.equal(entryText('Plain fact.'), 'Plain fact.');
    assert.equal(entryText('Dated fact. <!-- created=2026-01-01, last=2026-02-01 -->'), 'Dated fact.');
    assert.equal(entryText('Scoped fact. <!-- created=2026-01-01, last=2026-02-01, project64=cHJvag -->'), 'Scoped fact.');
    assert.equal(entryText('Keeps <!-- inline --> text'), 'Keeps <!-- inline --> text');
});

test('memory_search recall counters are listed advisory data and never change the write revision', { skip: !bundle }, async t => {
    const { service, root, mutate, sql } = setup(t);
    const kept = (await mutate('create', { category: 'fact', content: 'Recall kept fact.' })).item;
    const edited = (await mutate('create', { category: 'fact', content: 'Recall edited fact.' })).item;
    const user = (await mutate('create', { category: 'fact', content: 'Recall user fact.', target: 'user' })).item;
    const before = await service.snapshot(id);
    assert.equal(before.items.some(item => item.recall), false, 'no counters before any search');

    sql("UPDATE memories SET hit_count = 3, last_hit_at = '2026-10-15' WHERE content = ?", 'Recall kept fact.');
    sql("UPDATE memories SET hit_count = 1, last_hit_at = '2026-10-16' WHERE content = ?", 'Recall edited fact.');
    sql("UPDATE memories SET hit_count = 2, last_hit_at = '2026-10-17' WHERE content = ?", 'Recall user fact.');
    const counted = await service.snapshot(id);
    assert.equal(counted.revision, before.revision, 'recording a recall does not invalidate a pending edit');
    const recall = itemId => counted.items.find(item => item.id === itemId)?.recall;
    assert.deepEqual(recall(kept.id), { hits: 3, lastHitAt: '2026-10-15' });
    assert.deepEqual(recall(edited.id), { hits: 1, lastHitAt: '2026-10-16' });
    assert.deepEqual(recall(user.id), { hits: 2, lastHitAt: '2026-10-17' });
    assert.deepEqual((await service.getItem(id, kept.id)).item.recall, { hits: 3, lastHitAt: '2026-10-15' });

    // Editing one entry replaces only its index row; the sibling keeps its count.
    const updated = await mutate('update', { itemId: edited.id, itemRevision: edited.revision, category: 'fact', content: 'Recall rewritten fact.' });
    const after = await service.snapshot(id);
    assert.equal(after.items.find(item => item.id === updated.item.id)?.recall, undefined);
    assert.deepEqual(after.items.find(item => item.id === kept.id)?.recall, { hits: 3, lastHitAt: '2026-10-15' });
    // A deleted entry shows no stale counter.
    await mutate('delete', { itemId: kept.id, itemRevision: kept.revision });
    const deleted = (await service.snapshot(id, { state: 'all' })).items.find(item => item.id === kept.id);
    assert.equal(deleted.state, 'deleted');
    assert.equal(deleted.recall, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8').includes('<!--'), false);
});

test('a database without the counter columns lists no recalls instead of failing', { skip: !bundle }, async t => {
    const { service, root, mutate, sql } = setup(t);
    const item = (await mutate('create', { category: 'fact', content: 'Legacy recall fact.' })).item;
    sql('ALTER TABLE memories DROP COLUMN last_hit_at');
    sql('ALTER TABLE memories DROP COLUMN hit_count');
    assert.equal(memoryRecall(root, bundle).size, 0);
    const snapshot = await service.snapshot(id);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.items.find(row => row.id === item.id).recall, undefined);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'missing')), false);
    assert.equal(memoryRecall(path.join(path.dirname(root), 'missing'), bundle).size, 0, 'no database means no recalls');
});

test('recall keys follow each listing source: exact SQLite text, decoded Markdown text and failure project metadata', { skip: !bundle }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-recall-keys-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const upstream = await import(pathToFileURL(bundle).href);
    const manager = new upstream.DatabaseManager(root);
    manager.getDb();
    manager.close();
    const comment = ' <!-- created=2026-01-01, last=2026-01-02 -->';
    const project = path.join(root, 'workspace');
    const b64 = Buffer.from(project).toString('base64url');
    fs.writeFileSync(path.join(root, 'MEMORY.md'), `Literal fact${comment}\n§\nPlain fact`);
    fs.writeFileSync(path.join(root, 'failures.md'), `Shared failure <!-- created=2026-01-01, last=2026-01-02, project64=${b64} -->\n§\nGlobal failure`);
    const db = new (createRequire(bundle)('better-sqlite3'))(path.join(root, 'sessions.db'));
    const insert = db.prepare('INSERT INTO memories (project, target, category, content, created, last_referenced, hit_count, last_hit_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(null, 'memory', null, 'Literal fact', '2026-01-01', '2026-01-01', 1, '2026-10-01');
    insert.run(null, 'memory', 'insight', `Literal fact${comment}`, '2026-01-01', '2026-01-01', 5, '2026-10-05');
    insert.run(null, 'memory', null, 'Plain fact', '2026-01-01', '2026-01-01', 0, null);
    insert.run(project, 'failure', null, 'Shared failure', '2026-01-01', '2026-01-01', 2, '2026-10-02');
    insert.run(null, 'failure', null, 'Shared failure', '2026-01-01', '2026-01-01', 7, '2026-10-07');
    insert.run(null, 'failure', null, 'Global failure', '2026-01-01', '2026-01-01', 3, '2026-10-03');
    db.close();
    const recall = memoryRecall(root, bundle);
    const markdown = withRecall(listMemories(root, []).items, recall);
    const extended = withRecall(listExtendedMemories(root, bundle).items, recall);
    const hits = (items, target, content) => items.find(item => item.target === target && item.content === content)?.recall?.hits ?? 0;
    assert.equal(hits(markdown, 'memory', `Literal fact${comment}`), 1, 'a Markdown entry uses its decoded text');
    assert.equal(hits(markdown, 'memory', 'Plain fact'), 0);
    assert.equal(hits(extended, 'memory', `Literal fact${comment}`), 5, 'a SQLite-only row keeps its literal text');
    assert.equal(hits(extended, 'memory', 'Literal fact'), 1);
    assert.equal(hits(markdown, 'failure', `Shared failure <!-- created=2026-01-01, last=2026-01-02, project64=${b64} -->`), 2,
        'a project-attributed failure uses its own project, not the global row with the same text');
    assert.equal(hits(markdown, 'failure', 'Global failure'), 3);
    assert.deepEqual(JSON.parse(JSON.stringify(markdown[0])).recall, { hits: 1, lastHitAt: '2026-10-01' });
    assert.equal(Object.getOwnPropertySymbols(JSON.parse(JSON.stringify(markdown[0]))).length, 0);
    assert.equal(JSON.stringify(markdown).includes('memoryRecallKey'), false, 'the internal key is never serialized');
});

test('recall writes are bounded and fail fast while another writer holds the database', { skip: !bundle, timeout: 30000 }, async t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-recall-busy-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const context = { profileId: id, cwd: base, profileRoot: path.join(base, 'memory'), sessionsRoot: path.join(base, 'sessions') };
    fs.mkdirSync(context.profileRoot);
    fs.mkdirSync(context.sessionsRoot);
    const upstream = await import(pathToFileURL(bundle).href);
    const manager = new upstream.DatabaseManager(context.profileRoot);
    manager.getDb().prepare('INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (NULL, ?, NULL, ?, ?, ?)')
        .run('memory', 'Busy recall fact', '2026-01-01', '2026-01-01');
    manager.close();
    const Database = createRequire(bundle)('better-sqlite3');
    const dbPath = path.join(context.profileRoot, 'sessions.db');
    const hitsOf = () => { const db = new Database(dbPath, { readonly: true }); try { return db.prepare('SELECT hit_count AS hits FROM memories').get().hits; } finally { db.close(); } };

    const busy = createBackgroundIndex(context, bundle);
    t.after(() => busy.close());
    await busy.search({ query: 'warmup' }); // worker opened and migrated before the lock
    const holder = new Database(dbPath);
    holder.exec('BEGIN IMMEDIATE');
    try {
        const started = performance.now();
        const accepted = Array.from({ length: 10 }, () => busy.recordHits([1]));
        assert.ok(accepted.every(Boolean), 'counts are accepted and coalesced, never queued one request each');
        // A read queued behind the counts waits for at most one short-timeout batch.
        await busy.search({ query: 'warmup' });
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 2000, `search waited ${Math.round(elapsed)} ms behind contended counts`);
        // The coalesced follow-up batch was queued before this search, so it also ran under the lock.
        await busy.search({ query: 'warmup' });
    } finally { holder.exec('ROLLBACK'); holder.close(); }
    await busy.close();
    assert.equal(hitsOf(), 0, 'contended counts are dropped, not retried');

    const free = createBackgroundIndex(context, bundle);
    t.after(() => free.close());
    await free.search({ query: 'warmup' });
    assert.equal(free.recordHits([1]), true);
    assert.equal(free.recordHits([1, 1]), true, 'one search counts a row once');
    assert.equal(free.recordHits([0]), false, 'invalid IDs are refused before the worker');
    await free.close();
    assert.equal(hitsOf(), 2, 'in-flight and still-coalescing counts are written before the worker closes');
    assert.equal(busy.recordHits([1]), false, 'a closed index accepts no counts');
});
