'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { ProfileKnowledgeService, mountProfileKnowledgeRoutes } = require('../server/profile-memory/knowledge-service');
const { safeFile } = require('../server/profile-memory/management');
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = value => createHash('sha256').update(value).digest('hex');

function setup(t, limits = {}) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-consolidate-')));
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const profile = { id, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000, ...limits },
        skills: { learnedEnabled: true } };
    const service = new ProfileKnowledgeService({ profiles: { getProfile: async key => key === id ? profile : null, reserve: work => work() },
        getAgentDir: async () => agent, bundlePath: bundle });
    const root = path.join(agent, 'pivane-profiles', 'data', id);
    let serial = 0;
    const mutate = async (operation, fields = {}) => service.mutate(id, { requestId: `consolidate-${++serial}`,
        expectedRevision: (await service.snapshot(id)).revision, operation, kind: 'memory', ...fields });
    const create = async (content, target) => (await mutate('create', { category: 'fact', content, ...(target ? { target } : {}) })).item;
    const consolidateInput = async (sources, fields = {}) => ({ requestId: `batch-${++serial}`,
        expectedRevision: (await service.snapshot(id)).revision, operation: 'consolidate', kind: 'memory', target: 'memory',
        items: sources.map(item => ({ itemId: item.id, itemRevision: item.revision })),
        content: 'Merged procedure', category: 'procedure', ...fields });
    const ledger = () => JSON.parse(fs.readFileSync(path.join(root, '.pivane-knowledge.json'), 'utf8'));
    return { service, agent, root, mutate, create, consolidateInput, ledger };
}

function nativeSession(agent) {
    const cwd = fs.mkdtempSync(path.join(agent, 'cwd-'));
    const sessions = path.join(agent, 'sessions', 'consolidate');
    fs.mkdirSync(sessions, { recursive: true });
    const native = { sessionId: 'consolidate-session', entryId: 'user-1', cwd, sessionPath: path.join(sessions, 'consolidate.jsonl') };
    fs.writeFileSync(native.sessionPath, [
        { type: 'session', id: native.sessionId, cwd, timestamp: '2026-01-01' },
        { type: 'custom', id: 'binding', customType: 'pivane-agent-profile', data: { version: 1, sessionId: native.sessionId, profileId: id } },
        { type: 'message', id: native.entryId, message: { role: 'user', content: 'synthetic' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    return native;
}

test('consolidate replaces 2-20 profile entries with one entry, tombstones the sources and marks their receipts superseded', { skip: !bundle }, async t => {
    const { service, agent, root, create, consolidateInput, ledger } = setup(t);
    const first = await create('Run lint before commit.');
    const second = await create('Run tests before commit.');
    const kept = await create('Unrelated fact.');
    const user = await create('The user prefers Chinese.', 'user');
    const input = await consolidateInput([first, second], { content: 'Run lint and tests before commit.' });
    const saved = await service.mutate(id, input);
    assert.equal(saved.status, 'saved');
    const merged = saved.item;
    assert.deepEqual({ operation: saved.receipt.operation, origin: saved.receipt.origin, itemId: saved.receipt.itemId,
        consolidated: saved.receipt.consolidated, preview: saved.receipt.preview, category: saved.receipt.category,
        undoable: saved.receipt.undoable, indexStatus: saved.receipt.indexStatus }, {
        operation: 'consolidate', origin: 'manual', itemId: merged.id, consolidated: [first.id, second.id],
        preview: 'Run lint and tests before commit.', category: 'procedure', undoable: true, indexStatus: 'ready' });
    assert.equal(Object.hasOwn(saved.receipt, 'inputHash'), false);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, 'Unrelated fact.\n\u00a7\nRun lint and tests before commit.');
    assert.equal(safeFile(path.join(root, 'USER.md')).text, 'The user prefers Chinese.');
    const snapshot = await service.snapshot(id);
    const state = itemId => snapshot.items.find(item => item.id === itemId)?.state;
    assert.deepEqual([state(first.id), state(second.id), state(kept.id), state(user.id), state(merged.id)],
        ['deleted', 'deleted', 'active', 'active', 'active']);
    const receipts = snapshot.receipts;
    assert.equal(receipts[0].id, saved.receipt.id);
    for (const itemId of [first.id, second.id])
        assert.equal(receipts.find(row => row.itemId === itemId && row.operation === 'create').superseded, true);
    assert.equal(receipts.find(row => row.itemId === kept.id).superseded, undefined);
    // One publication updated the derived search index as well.
    const Database = createRequire(bundle)('better-sqlite3');
    const db = new Database(path.join(root, 'sessions.db'), { readonly: true });
    const rows = db.prepare("SELECT content FROM memories WHERE target = 'memory' ORDER BY content").all().map(row => row.content);
    db.close();
    assert.deepEqual(rows, ['Run lint and tests before commit.', 'Unrelated fact.']);
    // Every source body is now anti-revival protected, including against background learning.
    const native = nativeSession(agent);
    await assert.rejects(service.mutateFromNative(id, { requestId: 'learning-revive', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Run lint before commit.' }, native,
    { origin: 'learning', reason: 'review' }), /cannot be relearned/);
    assert.equal(ledger().tombstones.includes(hash('Run tests before commit.')), true);
    // Same request replays the same receipt; a changed payload under the same ID is refused.
    assert.equal((await service.mutate(id, input)).receipt.id, saved.receipt.id);
    await assert.rejects(service.mutate(id, { ...input, content: 'Different merge' }), /Request ID already used/);
});

test('consolidate input is validated and only the manual HTTP path accepts it', { skip: !bundle }, async t => {
    const { service, agent, create, consolidateInput } = setup(t);
    const first = await create('Alpha note.');
    const second = await create('Beta note.');
    const valid = await consolidateInput([first, second]);
    const invalid = [
        { ...valid, items: valid.items.slice(0, 1) },
        { ...valid, items: [valid.items[0], valid.items[0]] },
        { ...valid, items: Array.from({ length: 21 }, (_, index) => ({ itemId: hash(`x${index}`), itemRevision: hash('r') })) },
        { ...valid, items: [...valid.items.slice(0, 1), { ...valid.items[1], extra: true }] },
        { ...valid, target: 'project' },
        { ...valid, kind: 'skill' },
        { ...valid, category: 'unknown' },
        { ...valid, content: 'a\n\u00a7\nb' },
        { ...valid, itemId: first.id },
        { ...valid, scope: 'project' },
    ];
    for (const input of invalid) await assert.rejects(service.mutate(id, input), error => error.status === 400);
    const router = { handlers: {}, get(url, fn) { this.handlers[url] = fn; }, post(url, fn) { this.handlers[url] = fn; } };
    mountProfileKnowledgeRoutes(router, { service });
    const response = { set() { return this; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await router.handlers['/profiles/:id/knowledge']({ params: { id }, query: {} }, response);
    assert.ok(response.value.capabilities.operations.includes('consolidate'));
    await router.handlers['/profiles/:id/knowledge/mutations']({ params: { id }, body: { ...valid, items: valid.items.slice(0, 1) } }, response);
    assert.equal(response.code, 400);
    const native = nativeSession(agent);
    await assert.rejects(service.mutateFromNative(id, valid, native), /only available to manual edits/);
    await assert.rejects(service.mutateFromNative(id, valid, native, { origin: 'learning', reason: 'review' }), /only available to manual edits/);
    // A merged body that equals one of its sources would be tombstoned while active.
    await assert.rejects(service.mutate(id, { ...valid, content: 'Alpha note.' }), /must differ/);
    assert.equal((await service.mutate(id, valid)).status, 'saved');
});

test('a stale, foreign or read-only item rejects the whole batch without writing', { skip: !bundle }, async t => {
    const { service, root, create, consolidateInput, ledger, mutate } = setup(t);
    const first = await create('First fact.');
    const second = await create('Second fact.');
    const user = await create('User fact.', 'user');
    const updated = await mutate('update', { itemId: second.id, itemRevision: second.revision, category: 'fact', content: 'Second fact, revised.' });
    const before = { memory: safeFile(path.join(root, 'MEMORY.md')).text, sequence: ledger().sequence };
    fs.writeFileSync(path.join(root, 'failures.md'), '[failure] Legacy failure');
    const legacy = (await service.snapshot(id)).items.find(item => item.target === 'failure');
    const attempts = [
        await consolidateInput([first, second]),
        await consolidateInput([first, user]),
        await consolidateInput([first, legacy]),
        { ...await consolidateInput([first, updated.item]), items: [{ itemId: first.id, itemRevision: first.revision },
            { itemId: hash('missing'), itemRevision: updated.item.revision }] },
    ];
    for (const input of attempts) await assert.rejects(service.mutate(id, input), error => error.status === 409
        && /Consolidation items changed or are not writable/.test(error.message));
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, before.memory);
    assert.equal(ledger().sequence, before.sequence);
    const stale = await consolidateInput([first, updated.item]);
    await mutate('update', { itemId: first.id, itemRevision: first.revision, category: 'fact', content: 'First fact, revised.' });
    await assert.rejects(service.mutate(id, stale), /revision changed/);
    await assert.rejects(service.mutate(id, { ...stale, expectedRevision: (await service.snapshot(id)).revision }),
        /Consolidation items changed/);
});

test('consolidation is checked against the saved cap after the merge', { skip: !bundle }, async t => {
    const { service, root, create, consolidateInput } = setup(t, { memoryCharLimit: 256 });
    const first = await create('a'.repeat(100));
    const second = await create('b'.repeat(100));
    const error = await service.mutate(id, await consolidateInput([first, second], { content: 'm'.repeat(257) })).catch(value => value);
    assert.deepEqual({ status: error.status, code: error.code, details: error.details },
        { status: 409, code: 'memory-full', details: { target: 'memory', chars: 203, limit: 256, needed: 257 } });
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text.length, 203);
    // A merge that shrinks the document fits even though the cap is nearly reached.
    const saved = await service.mutate(id, await consolidateInput([first, second], { content: 'm'.repeat(150) }));
    assert.equal(saved.status, 'saved');
    assert.equal((await service.snapshot(id)).usage.memory.chars, 150);
});

test('undo restores every source entry at once, retires the merged entry and keeps it from being relearned', { skip: !bundle }, async t => {
    const { service, agent, root, create, consolidateInput, mutate, ledger } = setup(t);
    const first = await create('Use pnpm in this repository.');
    const second = await create('Never use npm install here.');
    const third = await create('Keep a changelog.');
    const saved = await service.mutate(id, await consolidateInput([first, second], { content: 'Use pnpm; never npm install.' }));
    const undone = await mutate('undo', { receiptId: saved.receipt.id });
    assert.equal(undone.status, 'saved');
    assert.deepEqual([undone.receipt.operation, undone.receipt.itemId, undone.receipt.undoable, undone.item.state],
        ['undo', saved.item.id, false, 'deleted']);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text,
        'Keep a changelog.\n\u00a7\nUse pnpm in this repository.\n\u00a7\nNever use npm install here.');
    const snapshot = await service.snapshot(id);
    const find = itemId => snapshot.items.find(item => item.id === itemId);
    assert.deepEqual([find(first.id).state, find(second.id).state, find(third.id).state, find(saved.item.id).state],
        ['active', 'active', 'active', 'deleted']);
    assert.equal(find(first.id).revision, first.revision);
    assert.equal(snapshot.receipts.find(row => row.id === saved.receipt.id).superseded, true);
    const data = ledger();
    assert.equal(data.tombstones.includes(hash('Use pnpm in this repository.')), false);
    assert.equal(data.tombstones.includes(hash('Use pnpm; never npm install.')), true);
    // Background learning cannot write the merged body back.
    const native = nativeSession(agent);
    await assert.rejects(service.mutateFromNative(id, { requestId: 'learning-merged', expectedRevision: (await service.snapshot(id)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Use pnpm; never npm install.' }, native,
    { origin: 'learning', reason: 'extraction' }), /cannot be relearned/);
    await assert.rejects(mutate('undo', { receiptId: saved.receipt.id }), /Undo target changed/);
    await assert.rejects(mutate('undo', { receiptId: undone.receipt.id }), /not undoable/);
    // The restored sources are ordinary entries again.
    const edited = await mutate('update', { itemId: first.id, itemRevision: first.revision, category: 'fact', content: 'Use pnpm 9.' });
    assert.equal(edited.status, 'saved');
});

test('undo of a consolidation checks the merged and every source revision', { skip: !bundle }, async t => {
    const { service, root, create, consolidateInput, mutate } = setup(t);
    const first = await create('Source one.');
    const second = await create('Source two.');
    const saved = await service.mutate(id, await consolidateInput([first, second], { content: 'Sources merged.' }));
    const restored = await mutate('restore', { itemId: first.id, itemRevision: (await service.getItem(id, first.id)).item.revision });
    assert.equal(restored.item.state, 'active');
    const text = safeFile(path.join(root, 'MEMORY.md')).text;
    await assert.rejects(mutate('undo', { receiptId: saved.receipt.id }), /Undo target changed/);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, text);
    await mutate('undo', { receiptId: restored.receipt.id });
    const merged = (await service.getItem(id, saved.item.id)).item;
    await mutate('update', { itemId: merged.id, itemRevision: merged.revision, category: 'procedure', content: 'Sources merged, edited.' });
    await assert.rejects(mutate('undo', { receiptId: saved.receipt.id }), /Undo target changed/);
});

test('a consolidation that fails after publication is pending and the same request repairs it', { skip: !bundle }, async t => {
    const { service, root, create, consolidateInput, ledger } = setup(t);
    const first = await create('Index source one.');
    const second = await create('Index source two.');
    const Database = createRequire(bundle)('better-sqlite3');
    const db = new Database(path.join(root, 'sessions.db'));
    db.exec("CREATE TRIGGER reject_synthetic_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'synthetic index failure'); END;");
    db.close();
    const input = await consolidateInput([first, second], { content: 'Index sources merged.' });
    const sequence = ledger().sequence;
    await assert.rejects(service.mutate(id, input), /synthetic index failure/);
    assert.equal((await service.snapshot(id)).status, 'pending');
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, 'Index sources merged.');
    // The ledger was not advanced, but the pending marker holds the batch receipt.
    assert.equal(ledger().sequence, sequence);
    const pending = JSON.parse(fs.readFileSync(path.join(root, '.pivane-knowledge.pending'), 'utf8'));
    assert.deepEqual(pending.receipt.consolidated, [first.id, second.id]);
    await assert.rejects(service.mutate(id, { ...input, requestId: 'other-request' }), /needs repair/);
    const fixed = new Database(path.join(root, 'sessions.db'));
    fixed.exec('DROP TRIGGER reject_synthetic_insert');
    fixed.close();
    const repaired = await service.mutate(id, input);
    assert.deepEqual([repaired.status, repaired.receipt.operation, repaired.receipt.id], ['saved', 'consolidate', pending.receipt.id]);
    const snapshot = await service.snapshot(id);
    assert.equal(snapshot.status, 'ready');
    assert.deepEqual([first.id, second.id].map(itemId => snapshot.items.find(item => item.id === itemId).state), ['deleted', 'deleted']);
    assert.equal(ledger().sequence, sequence + 1);
    const check = new Database(path.join(root, 'sessions.db'), { readonly: true });
    assert.deepEqual(check.prepare("SELECT content FROM memories WHERE target = 'memory'").all().map(row => row.content), ['Index sources merged.']);
    check.close();
    assert.equal((await service.mutate(id, input)).receipt.id, pending.receipt.id);
    const undone = await service.mutate(id, { requestId: 'undo-repaired', expectedRevision: snapshot.revision,
        operation: 'undo', kind: 'memory', receiptId: pending.receipt.id });
    assert.equal(undone.status, 'saved');
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, 'Index source one.\n\u00a7\nIndex source two.');
});

test('a consolidation whose before-copies are given up for the history budget is reported as not undoable', { skip: !bundle }, async t => {
    const { service, root, create, consolidateInput, ledger, mutate } = setup(t);
    const first = await create('Budget source one.');
    const second = await create('Budget source two.');
    const saved = await service.mutate(id, await consolidateInput([first, second], { content: 'Budget sources merged.' }));
    // A newer receipt owning a ~7.3 MiB before-copy pushes the journal past the history budget.
    const data = ledger();
    const fillerId = hash('filler-skill');
    data.records[fillerId] = { id: fillerId, kind: 'skill', scope: 'profile', name: 'filler-skill', content: 'Filler.',
        revision: hash('deleted\0Filler.'), state: 'deleted', updatedAt: new Date().toISOString(),
        history: [{ receiptId: 'filler-receipt', before: { content: 'x'.repeat(Math.floor(7.3 * 1024 * 1024)) } }] };
    data.receipts.push({ id: 'filler-receipt', requestId: 'filler-request', operation: 'delete', kind: 'skill', itemId: fillerId,
        status: 'saved', at: new Date().toISOString(), undoable: true });
    fs.writeFileSync(path.join(root, '.pivane-knowledge.json'), JSON.stringify(data));
    await mutate('create', { category: 'fact', content: 'Trigger the budget.' });
    const after = ledger();
    const row = after.receipts.find(receipt => receipt.id === saved.receipt.id);
    assert.equal(row.undoable, false);
    for (const itemId of [saved.item.id, first.id, second.id])
        assert.equal(after.records[itemId].history.some(entry => entry.receiptId === saved.receipt.id), false);
    assert.ok(fs.statSync(path.join(root, '.pivane-knowledge.json')).size < 7 * 1024 * 1024);
    assert.equal((await service.snapshot(id)).receipts.find(receipt => receipt.id === saved.receipt.id).undoable, false);
    await assert.rejects(mutate('undo', { receiptId: saved.receipt.id }), /not undoable/);
    assert.equal(safeFile(path.join(root, 'MEMORY.md')).text, 'Budget sources merged.\n\u00a7\nTrigger the budget.');
});
