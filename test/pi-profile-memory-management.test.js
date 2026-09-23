'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mountProfileMemoryRoutes } = require('../server/profile-memory/management');

test('management browsing is scoped, read-only, paginated and respects disabled profiles', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-memory-management-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const data = path.join(base, 'pivane-profiles', 'data');
    const alphaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const betaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const alpha = path.join(data, alphaId);
    const beta = path.join(data, betaId);
    fs.mkdirSync(path.join(alpha, 'skills', 'proof'), { recursive: true });
    fs.mkdirSync(beta, { recursive: true });
    fs.writeFileSync(path.join(alpha, 'MEMORY.md'), '极限方法\n§\n秩的性质');
    const project = path.join(alpha, 'projects', 'a'.repeat(64));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'MEMORY.md'), '栈的操作');
    fs.writeFileSync(path.join(beta, 'MEMORY.md'), 'other-private-memory');
    fs.writeFileSync(path.join(alpha, 'skills', 'proof', 'SKILL.md'), '---\nname: proof\ndescription: Synthetic procedure\n---\n');
    const profiles = { getProfile: async id => ({
        [alphaId]: { id: alphaId, enabled: true, memory: { enabled: true }, skills: { learnedEnabled: true } },
        [betaId]: { id: betaId, enabled: false, memory: { enabled: true }, skills: { learnedEnabled: true } },
    })[id] || null };
    const router = { get(route, handler) { assert.equal(route, '/profiles/:id/memory'); this.handle = handler; } };
    mountProfileMemoryRoutes(router, { profiles, getAgentDir: async () => base, bundlePath: process.env.PIVANE_TEST_HERMES_BUNDLE });
    const request = async (id, query) => {
        const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; },
            status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; } };
        await router.handle({ params: { id }, query }, res);
        return res;
    };
    const memory = await request(alphaId, { kind: 'memories', query: '秩' });
    assert.equal(memory.headers['Cache-Control'], 'no-store');
    assert.equal(memory.payload.status, process.env.PIVANE_TEST_HERMES_BUNDLE ? 'ready' : 'unsupported');
    if (!process.env.PIVANE_TEST_HERMES_BUNDLE) return;
    assert.deepEqual(memory.payload.items.map(item => item.content), ['秩的性质']);
    assert.equal((await request(alphaId, { kind: 'memories', query: '栈' })).payload.items[0].target, 'project');
    assert.equal(memory.payload.items[0].source, undefined);
    assert.ok(memory.payload.revision);
    assert.equal((await request(alphaId, { kind: 'memories', offset: 1 })).payload.items.length, 2);
    assert.equal((await request(alphaId, { kind: 'skills' })).payload.items[0].description, 'Synthetic procedure');
    assert.equal((await request(betaId, { kind: 'memories' })).payload.status, 'disabled');
    assert.equal((await request('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { kind: 'memories' })).payload.status, 'missing');
    assert.equal((await request(alphaId, { kind: 'bad' })).code, 400);
    assert.equal((await request('../beta', { kind: 'memories' })).code, 400);
    assert.equal(fs.existsSync(path.join(alpha, 'sessions.db')), false);
    if (process.env.PIVANE_TEST_HERMES_BUNDLE) {
        const { createRequire } = require('node:module');
        const Database = createRequire(process.env.PIVANE_TEST_HERMES_BUNDLE)('better-sqlite3');
        const db = new Database(path.join(alpha, 'sessions.db'));
        db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, project TEXT, target TEXT, content TEXT, created TEXT, last_referenced TEXT)');
        db.prepare('INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)')
            .run(null, 'memory', 'extended-row', '2026-01-01', '2026-01-02');
        db.close();
        const extended = await request(alphaId, { kind: 'memories', query: 'extended-row' });
        assert.equal(extended.payload.status, 'ready');
    assert.equal(extended.payload.items[0].content, 'extended-row');
        const firstRevision = (await request(alphaId, { kind: 'memories' })).payload.revision;
        const writer = new Database(path.join(alpha, 'sessions.db'));
        writer.pragma('journal_mode = WAL');
        writer.prepare('INSERT INTO memories (project, target, content, created, last_referenced) VALUES (?, ?, ?, ?, ?)')
            .run(null, 'memory', 'extended-row', '2026-01-01', '2026-01-02');
        const second = await request(alphaId, { kind: 'memories', query: 'extended-row' });
        assert.equal(second.payload.items.length, 2, 'distinct rows must not collapse by content');
        assert.notEqual((await request(alphaId, { kind: 'memories' })).payload.revision, firstRevision);
        writer.close();
    }
});
