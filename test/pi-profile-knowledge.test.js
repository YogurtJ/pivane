'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileKnowledgeService, mountProfileKnowledgeRoutes } = require('../server/profile-memory/knowledge-service');
const { createKnowledgeToolAdapter } = require('../server/profile-memory/knowledge-tool-adapter');
const { mountProfileDocumentRoutes } = require('../server/pi-profile-documents');
const { safeFile } = require('../server/profile-memory/management');
const privateFiles = require('../server/pi-private-files');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup(t) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-knowledge-')));
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const profile = { id, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000 },
        skills: { learnedEnabled: true } };
    const service = new ProfileKnowledgeService({ profiles: { getProfile: async key => key === id ? profile : null, reserve: work => work() },
        getAgentDir: async () => agent, bundlePath: bundle });
    const root = path.join(agent, 'pivane-profiles', 'data', id);
    let serial = 0;
    const mutate = async (operation, kind, fields = {}) => service.mutate(id, { requestId: `synthetic-${++serial}`,
        expectedRevision: (await service.snapshot(id)).revision, operation, kind, ...fields });
    return { service, agent, root, mutate };
}

test('revision, idempotency, tombstone and explicit restoration', { skip: !bundle }, async t => {
    const { service, root, mutate } = setup(t);
    const first = await service.snapshot(id);
    const base = { requestId: 'stable-request', expectedRevision: first.revision,
        operation: 'create', kind: 'memory', category: 'correction', content: 'Use the corrected limit.' };
    const saved = await service.mutate(id, base);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.receipt.indexStatus, 'ready');
    assert.equal((await service.mutate(id, base)).receipt.id, saved.receipt.id);
    await assert.rejects(service.mutate(id, { ...base, content: 'Different payload' }), /Request ID already used/);
    await assert.rejects(service.mutate(id, { ...base, requestId: 'stale-request' }), /revision changed/);
    const item = (await service.getItem(id, saved.item.id)).item;
    assert.equal(item.category, 'correction');
    assert.equal(item.content, base.content);
    const removed = await mutate('delete', 'memory', { itemId: item.id, itemRevision: item.revision });
    assert.equal((await service.getItem(id, item.id)).item.state, 'deleted');
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, '');
    await assert.rejects(mutate('create', 'memory', { category: 'fact', content: base.content }), /cannot be relearned/);
    const deleted = (await service.getItem(id, item.id)).item;
    const restored = await mutate('restore', 'memory', { itemId: item.id, itemRevision: deleted.revision });
    assert.equal(restored.item.id, item.id);
    assert.equal((await service.getItem(id, item.id)).item.state, 'active');
    const undone = await mutate('undo', 'memory', { receiptId: restored.receipt.id });
    assert.equal(undone.item.state, 'deleted');
    await assert.rejects(mutate('undo', 'memory', { receiptId: saved.receipt.id }), /Undo target changed/);
});

test('profile skills enable, disable, history and installed boundary', async t => {
    const { service, agent, root, mutate } = setup(t);
    const first = await mutate('create', 'skill', { name: 'inspect-proof', description: 'Check proof steps', content: 'Inspect each assumption.' });
    assert.equal(first.receipt.activation, 'reload-required');
    assert.match((await service.getItem(id, first.item.id)).item.content, /Inspect each assumption/);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'inspect-proof', 'SKILL.md')), true);
    const disabled = await mutate('disable', 'skill', { itemId: first.item.id, itemRevision: first.item.revision });
    assert.equal(disabled.item.state, 'disabled');
    assert.equal(fs.existsSync(path.join(root, 'skills', 'inspect-proof', 'SKILL.md')), false);
    const undoDisabled = await mutate('undo', 'skill', { receiptId: disabled.receipt.id });
    assert.equal(undoDisabled.item.state, 'active');
    assert.match((await service.getItem(id, first.item.id)).item.content, /Inspect each assumption/);
    const disabledAgain = await mutate('disable', 'skill', { itemId: first.item.id, itemRevision: undoDisabled.item.revision });
    const enabled = await mutate('enable', 'skill', { itemId: first.item.id, itemRevision: disabledAgain.item.revision });
    assert.equal(enabled.item.state, 'active');
    const deleted = await mutate('delete', 'skill', { itemId: first.item.id, itemRevision: enabled.item.revision });
    assert.equal(deleted.item.state, 'deleted');
    await mutate('restore', 'skill', { itemId: first.item.id, itemRevision: deleted.item.revision });
    fs.mkdirSync(path.join(agent, 'skills', 'installed'), { recursive: true });
    await assert.rejects(mutate('create', 'skill', { name: 'installed', description: '', content: 'No.' }), /Installed skill/);
    assert.equal(fs.existsSync(path.join(agent, 'skills', 'installed', 'SKILL.md')), false);
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(agent, 'skills'), path.join(root, 'skills', 'linked'));
        await assert.rejects(mutate('create', 'skill', { name: 'linked', description: '', content: 'No.' }), /Unsafe (skill|profile directory)/);
    }
});

test('route injection and profile isolation reject untrusted source and project key', async t => {
    const { service } = setup(t);
    const router = { handlers: {}, get(url, fn) { this.handlers[url] = fn; }, post(url, fn) { this.handlers[url] = fn; } };
    assert.equal(mountProfileKnowledgeRoutes(router, { service }), service);
    const response = { set() { return this; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await router.handlers['/profiles/:id/knowledge']({ params: { id }, query: {} }, response);
    assert.equal(response.value.profileId, id);
    assert.ok(response.value.capabilities.operations.includes('create'));
    assert.equal(response.value.capabilities.projectWrites, false);
    const initialRevision = response.value.revision;
    await router.handlers['/profiles/:id/knowledge']({ params: { id }, query: { offset: '0' } }, response);
    assert.equal(response.value.status, 'ready');
    await router.handlers['/profiles/:id/knowledge']({ params: { id }, query: { offset: '01' } }, response);
    assert.equal(response.code, 400);
    await router.handlers['/profiles/:id/knowledge']({ params: { id }, query: { offset: '-1' } }, response);
    assert.equal(response.code, 400);
    await router.handlers['/profiles/:id/knowledge/mutations']({ params: { id }, body: {
        requestId: 'spoof', expectedRevision: response.value.revision, operation: 'create', kind: 'memory',
        content: 'Spoof', category: 'fact', source: { sessionId: 'unverified' } } }, response);
    assert.equal(response.code, 400);
    await assert.rejects(service.mutate(id, { requestId: 'project', expectedRevision: initialRevision,
        operation: 'create', kind: 'memory', content: 'No', category: 'fact', scope: 'project', projectKey: 'fake' }), /verified cwd/);
    assert.equal((await service.snapshot('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).status, 'missing');
});

test('skill update undo restores previous bytes; creation undo retains restorable body', async t => {
    const { service, mutate } = setup(t);
    const created = await mutate('create', 'skill', { name: 'versioned-skill', description: 'Old', content: 'Original steps.' });
    const oldBody = (await service.getItem(id, created.item.id)).item.content;
    const updated = await mutate('update', 'skill', { itemId: created.item.id, itemRevision: created.item.revision,
        name: 'versioned-skill', description: 'New', content: 'Revised steps.' });
    assert.match((await service.getItem(id, created.item.id)).item.content, /Revised steps/);
    const undone = await mutate('undo', 'skill', { receiptId: updated.receipt.id });
    assert.equal((await service.getItem(id, created.item.id)).item.content, oldBody);
    assert.equal(undone.item.revision, created.item.revision);
    const removed = await mutate('delete', 'skill', { itemId: created.item.id, itemRevision: undone.item.revision });
    const restored = await mutate('restore', 'skill', { itemId: created.item.id, itemRevision: removed.item.revision });
    assert.equal((await service.getItem(id, created.item.id)).item.content, oldBody);
    await mutate('undo', 'skill', { receiptId: restored.receipt.id });
    assert.equal((await service.getItem(id, created.item.id)).item.state, 'deleted');
    const another = await mutate('create', 'skill', { name: 'undo-create', description: 'Test', content: 'Keep body.' });
    const undoneCreate = await mutate('undo', 'skill', { receiptId: another.receipt.id });
    assert.equal(undoneCreate.item.state, 'deleted');
    await mutate('restore', 'skill', { itemId: another.item.id, itemRevision: undoneCreate.item.revision });
    assert.match((await service.getItem(id, another.item.id)).item.content, /Keep body/);
});

test('published skill with metadata failure is pending and same request repairs without repeating publication', async t => {
    const { service, root } = setup(t);
    const input = { requestId: 'publication-once', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'skill', name: 'recover-skill', description: 'Recovery', content: 'Retain publication.' };
    const original = privateFiles.writePrivateFileSync;
    privateFiles.writePrivateFileSync = (file, content, sync) => {
        if (file.includes('.pivane-knowledge.json.')) throw new Error('Synthetic metadata failure');
        return original(file, content, sync);
    };
    try { await assert.rejects(service.mutate(id, input), /Synthetic metadata failure/); }
    finally { privateFiles.writePrivateFileSync = original; }
    const file = path.join(root, 'skills', 'recover-skill', 'SKILL.md');
    const bytes = fs.readFileSync(file, 'utf8');
    assert.equal((await service.snapshot(id)).status, 'pending');
    await assert.rejects(service.mutate(id, { ...input, requestId: 'different-request' }), /needs repair/);
    const result = await service.mutate(id, input);
    assert.equal(result.status, 'saved');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal((await service.mutate(id, input)).receipt.id, result.receipt.id);
    assert.equal(fs.existsSync(path.join(root, '.pivane-knowledge.pending')), false);
});

test('unpublished skill retry reuses the same request after a verified pre-publication failure', async t => {
    const { service, root } = setup(t);
    const input = { requestId: 'retry-before-publish', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'skill', name: 'unpublished', description: 'Retry', content: 'Publish once.' };
    const original = privateFiles.writePrivateFileSync;
    privateFiles.writePrivateFileSync = (file, content, sync) => {
        if (file.includes(`${path.sep}skills${path.sep}unpublished${path.sep}`)) throw new Error('Synthetic pre-publication failure');
        return original(file, content, sync);
    };
    try { await assert.rejects(service.mutate(id, input), /Synthetic pre-publication failure/); }
    finally { privateFiles.writePrivateFileSync = original; }
    assert.equal((await service.snapshot(id)).status, 'pending');
    assert.equal(fs.existsSync(path.join(root, 'skills', 'unpublished', 'SKILL.md')), false);
    const repaired = await service.mutate(id, input);
    assert.equal(repaired.status, 'saved');
    assert.equal((await service.snapshot(id)).status, 'ready');
    assert.equal((await service.mutate(id, input)).receipt.id, repaired.receipt.id);
});

test('competing writers with one revision publish at most one item', async t => {
    const { service, root } = setup(t);
    const expectedRevision = (await service.snapshot(id)).revision;
    const common = { expectedRevision, operation: 'create', kind: 'skill', description: 'Race', content: 'Only once.' };
    const outcomes = await Promise.allSettled([
        service.mutate(id, { ...common, requestId: 'racing-one', name: 'racing-one' }),
        service.mutate(id, { ...common, requestId: 'racing-two', name: 'racing-two' }),
    ]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await service.snapshot(id, { kind: 'skill' })).items.length, 1);
    assert.equal(fs.readdirSync(path.join(root, 'skills')).filter(name => name.startsWith('racing-')).length, 1);
});

test('failure and SQLite-only memories are visible but never mutate the wrong target', { skip: !bundle }, async t => {
    const { service, root, mutate } = setup(t);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'failures.md'), '[failure] Synthetic failure');
    const first = await mutate('create', 'memory', { content: 'Markdown identity', category: 'fact' });
    const Database = createRequire(bundle)('better-sqlite3');
    const db = new Database(path.join(root, 'sessions.db'));
    db.prepare('INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (NULL, ?, NULL, ?, ?, ?)')
        .run('memory', 'SQLite only', '2026-01-01', '2026-01-01');
    db.close();
    const rows = (await service.snapshot(id, { kind: 'memory' })).items;
    const failure = rows.find(item => item.target === 'failure');
    const only = rows.find(item => item.content === 'SQLite only');
    assert.equal(failure.readOnly, true);
    assert.equal(failure.category, 'failure');
    assert.equal(only.readOnly, true);
    assert.notEqual(first.item.id, only.id);
    for (const row of [failure, only]) await assert.rejects(mutate('delete', 'memory', {
        itemId: row.id, itemRevision: row.revision }), /read-only/);
    assert.equal((await service.getItem(id, first.item.id)).item.content, 'Markdown identity');
});

test('native provenance and physical project scope are verified and survive reload', { skip: !bundle }, async t => {
    const { service, agent, root } = setup(t);
    const cwd = fs.mkdtempSync(path.join(agent, 'cwd-'));
    const sessions = path.join(agent, 'sessions', 'synthetic');
    fs.mkdirSync(sessions, { recursive: true });
    const sessionId = 'synthetic-session', entryId = 'native-message';
    const sessionPath = path.join(sessions, 'synthetic.jsonl');
    const lines = [{ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01' },
        { type: 'custom', id: 'binding', customType: 'pivane-agent-profile', data: { version: 1, sessionId, profileId: id } },
        { type: 'message', id: entryId, message: { role: 'user', content: 'synthetic' } }];
    fs.writeFileSync(sessionPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const native = { sessionId, entryId, sessionPath, cwd }, projectKey = createHash('sha256').update(cwd).digest('hex');
    const input = { requestId: 'native-project', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', scope: 'project', category: 'procedure', content: 'Project-specific fact' };
    await assert.rejects(service.mutate(id, { ...input, projectKey, source: { sessionId, entryId } }), /Unverified source/);
    await assert.rejects(service.mutateFromNative(id, input, { ...native, entryId: 'invented' }), /not bound/);
    const saved = await service.mutateFromNative(id, input, native);
    assert.equal(saved.receipt.source.sessionId, sessionId);
    assert.equal(saved.item.projectKey, projectKey);
    assert.equal((await service.snapshot(id, { sessionId })).receipts[0].source.entryId, entryId);
    assert.equal(safeFile(path.join(root, 'projects', projectKey, 'MEMORY.md')).text, 'Project-specific fact');
    const Database = createRequire(bundle)('better-sqlite3');
    const projectDb = new Database(path.join(root, 'sessions.db'), { readonly: true });
    assert.equal(projectDb.prepare('SELECT project FROM memories WHERE content = ?').get('Project-specific fact').project, cwd);
    projectDb.close();
    const next = { requestId: 'native-skill', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'skill', scope: 'project', name: 'project-proof', description: 'Verify project', content: 'Run checks.' };
    const skill = await service.mutateFromNative(id, next, native);
    assert.equal(skill.item.scope, 'project');
    assert.match((await service.getItem(id, skill.item.id)).item.content, /Run checks/);
    assert.equal((await service.snapshot(id)).items.find(item => item.id === skill.item.id).projectKey, projectKey);
    const disabled = await service.mutateFromNative(id, { requestId: 'native-disable',
        expectedRevision: (await service.snapshot(id)).revision, operation: 'disable', kind: 'skill', scope: 'project',
        itemId: skill.item.id, itemRevision: skill.item.revision }, native);
    assert.equal(disabled.item.state, 'disabled');
    await assert.rejects(service.mutate(id, { requestId: 'web-restore', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'enable', kind: 'skill', itemId: disabled.item.id, itemRevision: disabled.item.revision }), /verified cwd/);
    const draft = await service.mutateFromNative(id, { requestId: 'proposed-skill', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'skill', scope: 'project', name: 'verified-draft', description: 'Proposed only',
        content: 'Review before activation', state: 'draft' }, native);
    assert.equal(draft.item.state, 'draft');
    assert.equal(draft.receipt.activation, 'unknown');
    assert.equal(fs.existsSync(path.join(root, 'projects', projectKey, 'skills', 'verified-draft', 'SKILL.md')), false);
    await service.mutateFromNative(id, { requestId: 'enable-draft', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'enable', kind: 'skill', scope: 'project', itemId: draft.item.id, itemRevision: draft.item.revision }, native);
    assert.match((await service.getItem(id, draft.item.id)).item.content, /Review before activation/);
    const altered = lines.map(line => line.customType === 'pivane-agent-profile'
        ? { ...line, data: { ...line.data, profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } : line);
    fs.writeFileSync(sessionPath, altered.map(line => JSON.stringify(line)).join('\n') + '\n');
    await assert.rejects(service.mutateFromNative(id, { requestId: 'rebound-source',
        expectedRevision: (await service.snapshot(id)).revision, operation: 'create', kind: 'memory',
        category: 'fact', content: 'Must not write' }, native), /not bound/);
});

test('tool adapter routes global, project and skill mutations through one native journal', { skip: !bundle }, async t => {
    const { service, agent, root } = setup(t);
    const cwd = fs.mkdtempSync(path.join(agent, 'tool-cwd-'));
    const sessions = path.join(agent, 'sessions', 'tool-session');
    fs.mkdirSync(sessions, { recursive: true });
    const native = { sessionId: 'tool-session', entryId: 'user-1', cwd,
        sessionPath: path.join(sessions, 'tool-session.jsonl') };
    fs.writeFileSync(native.sessionPath, [
        { type: 'session', id: native.sessionId, cwd, timestamp: '2026-01-01' },
        { type: 'custom', id: 'binding', customType: 'pivane-agent-profile', data: { version: 1, sessionId: native.sessionId, profileId: id } },
        { type: 'message', id: native.entryId, message: { role: 'user', content: 'synthetic' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const tool = createKnowledgeToolAdapter(service, id);
    const global = await tool('memory_add', { target: 'memory', content: 'Global note' }, native);
    assert.equal(global.details.success, true);
    const local = await tool('memory_add', { target: 'project', content: 'Local note' }, native);
    assert.equal(local.details.receipt.scope, 'project');
    assert.equal((await tool('memory_replace', { target: 'project', old_text: 'Local note', content: 'Local revision' }, native)).details.success, true);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, 'Global note');
    assert.equal(safeFile(path.join(root, 'projects', createHash('sha256').update(cwd).digest('hex'), 'MEMORY.md')).text, 'Local revision');
    const skill = await tool('skill_manage', { action: 'create', scope: 'global', name: 'tool-skill', description: 'Tools',
        when_to_use: 'Persistent check', procedure_steps: ['Open'], verification_steps: ['Inspect'] }, native);
    assert.equal(skill.details.success, true);
    const patch = await tool('skill_manage', { action: 'patch', skill_id: 'global:tool-skill',
        section: 'Procedure', procedure_steps: ['Open', 'Verify'] }, native);
    assert.equal(patch.details.success, true);
    assert.match(safeFile(path.join(root, 'skills', 'tool-skill', 'SKILL.md')).text, /2\. Verify/);
    await tool('skill_manage', { action: 'delete', skill_id: 'global:tool-skill' }, native);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'tool-skill', 'SKILL.md')), false);
    await assert.rejects(tool('memory_add', { target: 'failure', content: 'Do not misroute' }, native), /read-only/);
    assert.equal((await service.snapshot(id, { sessionId: native.sessionId })).receipts.length, 6);
});

test('the request journal keeps accepting writes after the active receipt window fills', async t => {
    const { service, root } = setup(t);
    const first = { requestId: 'original-id', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'skill', name: 'journal-skill', description: 'Journal', content: 'One step.' };
    const saved = await service.mutate(id, first);
    let revision = saved.revision;
    for (let i = 0; i < 205; i++) {
        const result = await service.mutate(id, { requestId: `journal-fill-${i}`, expectedRevision: revision,
            operation: 'create', kind: 'skill', name: `journal-skill-${i}`, description: 'Journal', content: 'One step.' });
        revision = result.revision;
    }
    const data = JSON.parse(fs.readFileSync(path.join(root, '.pivane-knowledge.json'), 'utf8'));
    assert.equal(data.version, 2);
    assert.equal(data.receipts.length, 200);
    assert.equal(data.archive.length, 6);
    const snapshot = await service.snapshot(id);
    assert.deepEqual(snapshot.capabilities.operations, ['create', 'update', 'delete', 'restore', 'enable', 'disable', 'undo']);
    assert.deepEqual({ receipts: snapshot.capabilities.journal.receipts, archived: snapshot.capabilities.journal.archivedReceipts,
        requests: snapshot.capabilities.journal.requests }, { receipts: 200, archived: 6, requests: 206 });
    // The oldest request replays from its archive digest: same receipt, no undo.
    const replayed = await service.mutate(id, first);
    assert.equal(replayed.receipt.id, saved.receipt.id);
    assert.equal(replayed.receipt.undoable, false);
    // New requests keep publishing long after the window filled.
    const candidate = await service.mutate(id, { ...first, requestId: 'new-after-window',
        expectedRevision: (await service.snapshot(id)).revision, name: 'should-publish' });
    assert.equal(candidate.status, 'saved');
    assert.equal(fs.existsSync(path.join(root, 'skills', 'should-publish', 'SKILL.md')), true);
});

test('post-publication SQLite failure retains a repairable memory pending receipt', { skip: !bundle }, async t => {
    const { service, root } = setup(t);
    const Database = createRequire(bundle)('better-sqlite3');
    // Initialize the SQLite schema through the normal document publication.
    await service.mutate(id, { requestId: 'initial-fact', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Initial fact' });
    const db = new Database(path.join(root, 'sessions.db'));
    db.exec("CREATE TRIGGER reject_synthetic_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'synthetic index failure'); END;");
    db.close();
    const input = { requestId: 'failed-index-once', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Second fact' };
    await assert.rejects(service.mutate(id, input), /synthetic index failure/);
    assert.equal((await service.snapshot(id)).status, 'pending');
    assert.match(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8'), /Second fact/);
    const fixed = new Database(path.join(root, 'sessions.db'));
    fixed.exec('DROP TRIGGER reject_synthetic_insert');
    fixed.close();
    const repaired = await service.mutate(id, input);
    assert.equal(repaired.receipt.indexStatus, 'ready');
    assert.equal((await service.snapshot(id)).status, 'ready');
    assert.equal((await service.snapshot(id, { query: 'Second fact' })).items.filter(row => row.content === 'Second fact').length, 2);
});

test('full-document editor cannot revive a tombstone or overwrite a managed fact', { skip: !bundle }, async t => {
    const { service, root, agent, mutate } = setup(t);
    const router = { handlers: {}, get(url, fn) { this.handlers[`GET ${url}`] = fn; }, put(url, fn) { this.handlers[`PUT ${url}`] = fn; } };
    const profile = { id, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000 },
        skills: { learnedEnabled: true } };
    mountProfileDocumentRoutes(router, { profiles: { getProfile: async () => profile, reserve: work => work() },
        getAgentDir: async () => agent, bundlePath: bundle });
    const response = () => ({ set() { return this; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } });
    const get = async () => {
        const res = response();
        await router.handlers['GET /profiles/:id/documents']({ params: { id }, query: { target: 'memory' } }, res);
        assert.equal(res.value.status, 'ready');
        return res.value;
    };
    const put = async (content, document) => {
        const res = response();
        await router.handlers['PUT /profiles/:id/documents']({ params: { id }, body: { target: 'memory',
            content, expectedRevision: document.revision, expectedProfileRevision: document.profileRevision } }, res);
        return res;
    };
    const created = await mutate('create', 'memory', { category: 'fact', content: 'Managed fact' });
    const blockedEdit = await put('Untracked replacement', await get());
    assert.equal(blockedEdit.code, 409);
    assert.match(blockedEdit.value.error, /Managed memory/);
    const removed = await mutate('delete', 'memory', { itemId: created.item.id, itemRevision: created.item.revision });
    assert.equal(removed.item.state, 'deleted');
    const blockedRevival = await put('Managed fact', await get());
    assert.equal(blockedRevival.code, 409);
    assert.match(blockedRevival.value.error, /explicit restore/);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, '');
    const allowed = await put('Independent legacy fact', await get());
    assert.equal(allowed.code, 200);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, 'Independent legacy fact');
});

test('expired client request IDs are refused instead of re-executed', async t => {
    const { service, root } = setup(t);
    const input = { requestId: 'expiring-request', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'skill', name: 'expiring-skill', description: 'Expiry', content: 'Keep once.' };
    await service.mutate(id, input);
    const ledgerPath = path.join(root, '.pivane-knowledge.json');
    const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    data.requests['expiring-request'].at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(ledgerPath, JSON.stringify(data));
    const retry = { ...input, expectedRevision: (await service.snapshot(id)).revision };
    await assert.rejects(service.mutate(id, retry), /expired/);
    // The expired ID is remembered as spent, so even a changed payload cannot run.
    await assert.rejects(service.mutate(id, { ...retry, requestId: 'expiring-request', name: 'second-skill' }), /expired/);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'expiring-skill', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(root, 'skills', 'second-skill')), false);
    const fresh = await service.mutate(id, { requestId: 'fresh-after-expiry',
        expectedRevision: (await service.snapshot(id)).revision, operation: 'create', kind: 'skill',
        name: 'after-expiry', description: 'Fresh', content: 'Fresh step.' });
    assert.equal(fresh.status, 'saved');
});

test('archived receipts stop being undoable while tombstones keep blocking revival', { skip: !bundle }, async t => {
    const { service, root } = setup(t);
    const createdInput = { requestId: 'archive-create', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Original managed fact.' };
    const created = await service.mutate(id, createdInput);
    const updated = await service.mutate(id, { requestId: 'archive-update', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'update', kind: 'memory', itemId: created.item.id, itemRevision: created.item.revision,
        category: 'fact', content: 'Replaced managed fact.' });
    const ledgerPath = path.join(root, '.pivane-knowledge.json');
    const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    while (data.receipts.length < 200) data.receipts.push({ requestId: `synthetic-${data.receipts.length}`,
        id: `synthetic-${data.receipts.length}`, operation: 'create', kind: 'skill', status: 'saved',
        at: new Date().toISOString(), undoable: false });
    fs.writeFileSync(ledgerPath, JSON.stringify(data));
    // Two further writes push both real receipts out of the active window.
    await service.mutate(id, { requestId: 'archive-flush-1', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Flush fact one.' });
    await service.mutate(id, { requestId: 'archive-flush-2', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Flush fact two.' });
    const journal = (await service.snapshot(id)).capabilities.journal;
    assert.deepEqual({ receipts: journal.receipts, archived: journal.archivedReceipts }, { receipts: 200, archived: 2 });
    await assert.rejects(service.mutate(id, { requestId: 'archive-undo', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'undo', kind: 'memory', receiptId: updated.receipt.id }), /not undoable/);
    const replayed = await service.mutate(id, createdInput);
    assert.equal(replayed.receipt.id, created.receipt.id);
    assert.equal(replayed.receipt.undoable, false);
    await assert.rejects(service.mutate(id, { requestId: 'revive-after-archive',
        expectedRevision: (await service.snapshot(id)).revision, operation: 'create', kind: 'memory',
        category: 'fact', content: 'Original managed fact.' }), /cannot be relearned/);
});

test('version 1 knowledge metadata upgrades on write and keeps idempotency and tombstones', { skip: !bundle }, async t => {
    const { service, root } = setup(t);
    const input = { requestId: 'legacy-request', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Legacy managed fact.' };
    const saved = await service.mutate(id, input);
    const ledgerPath = path.join(root, '.pivane-knowledge.json');
    const v2 = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(v2.version, 2);
    const revisionBefore = (await service.snapshot(id)).revision;
    const migratedTombstone = createHash('sha256').update('Never relearn this.').digest('hex');
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, records: v2.records, receipts: v2.receipts,
        tombstones: { [migratedTombstone]: { itemId: saved.item.id, at: saved.receipt.at } } }));
    // Reading version 1 keeps the same revision; the upgrade happens on write.
    assert.equal((await service.snapshot(id)).revision, revisionBefore);
    const replayed = await service.mutate(id, input);
    assert.equal(replayed.receipt.id, saved.receipt.id);
    const second = await service.mutate(id, { requestId: 'post-migration', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'update', kind: 'memory', itemId: saved.item.id, itemRevision: saved.item.revision,
        category: 'fact', content: 'Upgraded managed fact.' });
    assert.equal(second.status, 'saved');
    const upgraded = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(upgraded.version, 2);
    assert.equal(upgraded.sequence, 2);
    assert.equal(upgraded.requests['legacy-request'].r, saved.receipt.id);
    await assert.rejects(service.mutate(id, { requestId: 'revive-migrated',
        expectedRevision: (await service.snapshot(id)).revision, operation: 'create', kind: 'memory',
        category: 'fact', content: 'Never relearn this.' }), /cannot be relearned/);
    await assert.rejects(service.mutate(id, { requestId: 'revive-replaced',
        expectedRevision: (await service.snapshot(id)).revision, operation: 'create', kind: 'memory',
        category: 'fact', content: 'Legacy managed fact.' }), /cannot be relearned/);
});
