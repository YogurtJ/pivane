'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { ProfileKnowledgeService, mountProfileKnowledgeRoutes } = require('../server/profile-memory/knowledge-service');
const { safeFile } = require('../server/profile-memory/management');
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash = value => createHash('sha256').update(value).digest('hex');

function setup(t, limits = {}) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-knowledge-session-')));
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const profile = { id, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000, ...limits },
        skills: { learnedEnabled: true } };
    const hooks = { beforeProfile: null };
    const service = new ProfileKnowledgeService({ profiles: { reserve: work => work(), getProfile: async key => {
        const hook = hooks.beforeProfile;
        hooks.beforeProfile = null;
        hook?.();
        return key === id ? profile : null;
    } }, getAgentDir: async () => agent, bundlePath: bundle });
    const root = path.join(agent, 'pivane-profiles', 'data', id);
    let serial = 0;
    const input = async (operation, fields = {}) => ({ requestId: `session-${++serial}`,
        expectedRevision: (await service.snapshot(id)).revision, operation, kind: 'memory', ...fields });
    return { service, agent, root, hooks, profile, input };
}

// Pi names native files `<timestamp>_<sessionId>.jsonl` under a per-cwd directory.
function session(agent, name, { profileId = id, extra = [] } = {}) {
    const cwd = fs.mkdtempSync(path.join(agent, `${name}-cwd-`));
    const dir = path.join(agent, 'sessions', `--${name}--`);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = `${name}-session`;
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    const lines = [{ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01' },
        { type: 'custom', customType: 'pivane-agent-profile', id: 'binding', data: { version: 1, sessionId, profileId } },
        { type: 'message', id: 'user-1', parentId: 'binding', message: { role: 'user', content: 'synthetic' } }, ...extra];
    const write = rows => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    write(lines);
    return { cwd, sessionId, file, lines, write, projectKey: hash(cwd) };
}

test('web project memory edits are verified through the session and can be undone', { skip: !bundle }, async t => {
    const { service, agent, root, input } = setup(t);
    const own = session(agent, 'own');
    const snapshot = await service.snapshot(id);
    assert.deepEqual([snapshot.capabilities.projectWrites, snapshot.capabilities.projectWritesBySession], [false, true]);
    const created = await service.mutate(id, await input('create', { scope: 'project', sessionId: own.sessionId,
        category: 'procedure', content: 'Use the project Makefile.' }));
    assert.equal(created.status, 'saved');
    assert.deepEqual({ scope: created.item.scope, projectKey: created.item.projectKey, target: created.item.target },
        { scope: 'project', projectKey: own.projectKey, target: 'project' });
    assert.deepEqual({ origin: created.receipt.origin, source: created.receipt.source, scope: created.receipt.scope },
        { origin: 'manual', source: { sessionId: own.sessionId }, scope: 'project' });
    assert.equal(Object.hasOwn(created.item, 'source'), false);
    const projectFile = path.join(root, 'projects', own.projectKey, 'MEMORY.md');
    assert.equal(safeFile(projectFile).text, 'Use the project Makefile.');
    const Database = createRequire(bundle)('better-sqlite3');
    const db = new Database(path.join(root, 'sessions.db'), { readonly: true });
    assert.equal(db.prepare('SELECT project FROM memories WHERE content = ?').get('Use the project Makefile.').project, own.cwd);
    db.close();
    // Session-verified web writes use client request IDs, which keep the validity window.
    const ledger = JSON.parse(fs.readFileSync(path.join(root, '.pivane-knowledge.json'), 'utf8'));
    assert.equal(ledger.requests[created.receipt.requestId].s, false);
    assert.equal((await service.snapshot(id, { sessionId: own.sessionId })).receipts[0].id, created.receipt.id);
    const updated = await service.mutate(id, await input('update', { scope: 'project', sessionId: own.sessionId,
        itemId: created.item.id, itemRevision: created.item.revision, category: 'procedure', content: 'Use make check.' }));
    assert.equal(safeFile(projectFile).text, 'Use make check.');
    const removed = await service.mutate(id, await input('delete', { scope: 'project', sessionId: own.sessionId,
        itemId: updated.item.id, itemRevision: updated.item.revision }));
    assert.equal(removed.item.state, 'deleted');
    assert.equal(safeFile(projectFile).text, '');
    const undone = await service.mutate(id, await input('undo', { scope: 'project', sessionId: own.sessionId, receiptId: removed.receipt.id }));
    assert.deepEqual([undone.item.state, undone.receipt.origin, undone.receipt.source], ['active', 'manual', { sessionId: own.sessionId }]);
    assert.equal(safeFile(projectFile).text, 'Use make check.');
    // Without the session the same item stays read-only for the web.
    const current = (await service.getItem(id, created.item.id)).item;
    await assert.rejects(service.mutate(id, await input('delete', { itemId: current.id, itemRevision: current.revision })), /verified cwd/);
    await assert.rejects(service.mutate(id, await input('undo', { receiptId: undone.receipt.id })), /verified cwd/);
});

test('session project edits refuse client project keys, foreign sessions and other scopes', { skip: !bundle }, async t => {
    const { service, agent, input } = setup(t);
    const own = session(agent, 'mine');
    const foreign = session(agent, 'foreign', { profileId: other });
    const base = { scope: 'project', sessionId: own.sessionId, category: 'fact', content: 'Project only.' };
    await assert.rejects(service.mutate(id, await input('create', { ...base, projectKey: hash('/elsewhere') })), /verified cwd/);
    await assert.rejects(service.mutate(id, await input('create', { ...base, projectKey: own.projectKey })), /verified cwd/);
    await assert.rejects(service.mutate(id, await input('create', { ...base, sessionId: foreign.sessionId })),
        error => error.status === 409 && /not bound/.test(error.message));
    await assert.rejects(service.mutate(id, await input('create', { ...base, sessionId: 'missing-session' })), error => error.status === 404);
    await assert.rejects(service.mutate(id, await input('create', { ...base, sessionId: '../escape' })), error => error.status === 400);
    await assert.rejects(service.mutate(id, await input('create', { ...base, scope: 'profile' })), /Invalid session project mutation/);
    await assert.rejects(service.mutate(id, await input('create', { ...base, kind: 'skill', name: 'no-skill', description: '' })),
        /Invalid session project mutation/);
    await assert.rejects(service.mutate(id, await input('restore', { ...base, itemId: hash('a'), itemRevision: hash('b') })),
        /Invalid session project mutation/);
    await assert.rejects(service.mutate(id, await input('create', { ...base, source: { sessionId: own.sessionId, entryId: 'user-1' } })),
        /Invalid knowledge mutation|Unverified source/);
    // A session cannot be used to edit profile-wide memory.
    const profileItem = (await service.mutate(id, await input('create', { category: 'fact', content: 'Profile fact.' }))).item;
    await assert.rejects(service.mutate(id, await input('delete', { scope: 'project', sessionId: own.sessionId,
        itemId: profileItem.id, itemRevision: profileItem.revision })), /limited to its project memory/);
    // A header whose cwd is not canonical is not a project identity.
    const moved = session(agent, 'moved');
    moved.write(moved.lines.map(row => row.type === 'session' ? { ...row, cwd: `${moved.cwd}/../${path.basename(moved.cwd)}` } : row));
    await assert.rejects(service.mutate(id, await input('create', { ...base, sessionId: moved.sessionId })), /not bound/);
    // Two files claiming one session ID are ambiguous.
    const twin = session(agent, 'twin');
    fs.copyFileSync(twin.file, path.join(path.dirname(twin.file), `2026-02-01T00-00-00-000Z_${twin.sessionId}.jsonl`));
    await assert.rejects(service.mutate(id, await input('create', { ...base, sessionId: twin.sessionId })), /ambiguous/);
});

test('a session rebound to another profile during the write is refused before publication', { skip: !bundle }, async t => {
    const { service, agent, root, hooks, input } = setup(t);
    const own = session(agent, 'rebound');
    const request = await input('create', { scope: 'project', sessionId: own.sessionId, category: 'fact', content: 'Must not land.' });
    hooks.beforeProfile = () => own.write(own.lines.map(row => row.customType === 'pivane-agent-profile'
        ? { ...row, data: { ...row.data, profileId: other } } : row));
    await assert.rejects(service.mutate(id, request), error => error.status === 409 && /Session changed or is not bound/.test(error.message));
    assert.equal(fs.existsSync(path.join(root, 'projects', own.projectKey, 'MEMORY.md')), false);
    assert.equal((await service.snapshot(id)).status, 'ready');
    own.write(own.lines);
    const retried = await service.mutate(id, { ...request, expectedRevision: (await service.snapshot(id)).revision });
    assert.equal(retried.status, 'saved');
    // A cwd change in the header between the checks is refused as well.
    const moved = await input('create', { scope: 'project', sessionId: own.sessionId, category: 'fact', content: 'Neither this.' });
    const elsewhere = fs.mkdtempSync(path.join(agent, 'elsewhere-'));
    hooks.beforeProfile = () => own.write(own.lines.map(row => row.type === 'session' ? { ...row, cwd: elsewhere } : row));
    await assert.rejects(service.mutate(id, moved), /Session changed or is not bound/);
    assert.equal(safeFile(path.join(root, 'projects', own.projectKey, 'MEMORY.md')).text, 'Must not land.');
});

async function expectedBlock(root, cwd, limits) {
    const upstream = await import(pathToFileURL(bundle).href);
    const config = { memoryMode: 'legacy-inject', memoryCharLimit: limits.memoryCharLimit, userCharLimit: limits.userCharLimit,
        memoryOverflowStrategy: 'reject', autoConsolidate: false, failureInjectionEnabled: false };
    const store = new upstream.MemoryStore({ ...config, memoryDir: root });
    await store.loadFromDisk();
    const projectStore = new upstream.MemoryStore({ ...config, memoryDir: path.join(root, 'projects', hash(cwd || '')) });
    if (cwd) await projectStore.loadFromDisk();
    return [store.formatForSystemPrompt(), cwd ? projectStore.formatProjectBlock(cwd) : ''].filter(Boolean).join('\n\n');
}

test('injection preview renders the upstream block for the profile and a verified session cwd', { skip: !bundle }, async t => {
    const { service, agent, root, profile, input } = setup(t);
    const empty = await service.injection(id);
    assert.deepEqual(empty, { version: 1, status: 'ready', block: '', chars: 0, entries: 0,
        profile: { chars: 0, entries: 0 }, project: null, lastRead: null });
    assert.equal(fs.existsSync(root), false, 'the preview never creates profile data');
    const reads = [
        { type: 'custom', customType: 'pivane-profile-memory-read', id: 'read-1', parentId: 'user-1',
            data: { version: 1, profileId: id, generation: 3, loadedAt: '2026-01-01T00:00:01.000Z', scope: 'profile-and-physical-cwd', provided: false } },
        { type: 'custom', customType: 'pivane-profile-memory-read', id: 'read-2', parentId: 'read-1',
            data: { version: 1, profileId: id, generation: 7, loadedAt: '2026-01-01T00:00:02.000Z', scope: 'profile-and-physical-cwd',
                provided: true, chars: 321, entries: 4 } },
        { type: 'custom', customType: 'pivane-profile-memory-read', id: 'read-foreign', parentId: 'read-2',
            data: { version: 1, profileId: other, generation: 9, loadedAt: '2026-01-01T00:00:03.000Z', provided: true } },
    ];
    const own = session(agent, 'preview', { extra: reads });
    const noProject = await service.injection(id, { sessionId: own.sessionId });
    assert.deepEqual([noProject.project, noProject.lastRead], [{ chars: 0, entries: 0 },
        { at: '2026-01-01T00:00:02.000Z', generation: 7, provided: true, chars: 321, entries: 4 }]);
    assert.equal(fs.existsSync(path.join(root, 'projects', own.projectKey)), false, 'the preview never creates a project directory');
    await service.mutate(id, await input('create', { category: 'fact', content: 'Profile fact one.' }));
    await service.mutate(id, await input('create', { category: 'preference', content: 'Profile fact two.' }));
    await service.mutate(id, await input('create', { category: 'preference', target: 'user', content: 'The user reads Chinese.' }));
    const profileOnly = await service.injection(id);
    const profileBlock = await expectedBlock(root, null, profile.memory);
    assert.deepEqual({ status: profileOnly.status, block: profileOnly.block, chars: profileOnly.chars, entries: profileOnly.entries,
        profile: profileOnly.profile, project: profileOnly.project, lastRead: profileOnly.lastRead }, {
        status: 'ready', block: profileBlock, chars: profileBlock.length, entries: 3,
        profile: { chars: profileBlock.length, entries: 3 }, project: null, lastRead: null });
    assert.match(profileOnly.block, /Profile fact two\./);
    await service.mutate(id, await input('create', { scope: 'project', sessionId: own.sessionId, category: 'fact', content: 'Project fact.' }));
    const withProject = await service.injection(id, { sessionId: own.sessionId });
    const fullBlock = await expectedBlock(root, own.cwd, profile.memory);
    assert.equal(withProject.block, fullBlock);
    assert.match(withProject.block, new RegExp(`PROJECT MEMORY: ${own.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.deepEqual({ chars: withProject.chars, entries: withProject.entries, profile: withProject.profile },
        { chars: fullBlock.length, entries: 4, profile: { chars: profileBlock.length, entries: 3 } });
    assert.equal(withProject.project.entries, 1);
    assert.equal(withProject.project.chars, fullBlock.length - profileBlock.length - 2);
    // Another session's project memory is not part of this session's block.
    const second = session(agent, 'second');
    const unrelated = await service.injection(id, { sessionId: second.sessionId });
    assert.deepEqual([unrelated.block, unrelated.project], [profileBlock, { chars: 0, entries: 0 }]);
    const foreign = session(agent, 'foreign-preview', { profileId: other });
    await assert.rejects(service.injection(id, { sessionId: foreign.sessionId }), error => error.status === 409);
    await assert.rejects(service.injection(id, { sessionId: foreign.sessionId, cwd: own.cwd }), error => error.status === 400);
    const router = { handlers: {}, get(url, fn) { this.handlers[url] = fn; }, post(url, fn) { this.handlers[url] = fn; } };
    mountProfileKnowledgeRoutes(router, { service });
    const response = { set() { return this; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await router.handlers['/profiles/:id/knowledge/injection']({ params: { id }, query: { sessionId: own.sessionId } }, response);
    assert.equal(response.value.block, fullBlock);
    await router.handlers['/profiles/:id/knowledge/injection']({ params: { id }, query: { cwd: own.cwd } }, response);
    assert.equal(response.code, 400);
    profile.memory.enabled = false;
    assert.equal((await service.injection(id)).status, 'disabled');
});

test('injection preview truncates the block at 64 KiB on a character boundary', { skip: !bundle }, async t => {
    const { service, root } = setup(t, { memoryCharLimit: 65536 });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const text = Array.from({ length: 3 }, (_, index) => `${index}${'记'.repeat(12000)}`).join('\n\u00a7\n');
    fs.writeFileSync(path.join(root, 'MEMORY.md'), text, { mode: 0o600 });
    const preview = await service.injection(id);
    const full = await expectedBlock(root, null, { memoryCharLimit: 65536, userCharLimit: 8000 });
    assert.ok(Buffer.byteLength(full) > 64 * 1024);
    assert.equal(preview.truncated, true);
    assert.equal(preview.chars, full.length);
    assert.equal(preview.entries, 3);
    assert.ok(Buffer.byteLength(preview.block) <= 64 * 1024 && Buffer.byteLength(preview.block) > 64 * 1024 - 4);
    assert.equal(full.startsWith(preview.block), true);
    assert.equal(preview.block.includes('\ufffd'), false);
});
