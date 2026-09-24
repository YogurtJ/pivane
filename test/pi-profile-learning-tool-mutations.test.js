'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKnowledgeMemoryTools } = require('../server/profile-memory/tool-mutations');
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revision = 'a'.repeat(64);

test('global agent memory writes use the same knowledge CAS, receipts and tombstone guard', async () => {
    const calls = [];
    const row = { id: 'b'.repeat(64), revision: 'c'.repeat(64), kind: 'memory', scope: 'profile', target: 'memory',
        state: 'active', category: 'correction', content: '旧规则' };
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { memory: true }, items: [row], hasMore: false }),
        mutate: async (_id, input) => { calls.push(input); return { receipt: { id: 'receipt-1', status: 'saved', indexStatus: 'ready', activation: 'next-turn' } }; } };
    const execute = createKnowledgeMemoryTools(service, profileId);
    const changed = await execute('memory_replace', { target: 'memory', old_text: '旧规则', content: '新规则' });
    assert.equal(changed.details.success, true);
    assert.equal(changed.details.receipt.id, 'receipt-1');
    assert.deepEqual({ operation: calls[0].operation, itemId: calls[0].itemId, itemRevision: calls[0].itemRevision,
        category: calls[0].category, expectedRevision: calls[0].expectedRevision },
    { operation: 'update', itemId: row.id, itemRevision: row.revision, category: 'correction', expectedRevision: revision });
    await execute('memory_remove', { target: 'memory', old_text: '旧规则' });
    assert.equal(calls[1].operation, 'delete');
    assert.equal(Object.hasOwn(calls[1], 'content'), false);
    await execute('memory_add', { target: 'user', content: '新偏好' });
    assert.equal(calls[2].operation, 'create');
    assert.equal(calls[2].target, 'user');
    assert.equal(calls[2].category, 'fact');
    assert.equal(await execute('memory_add', { target: 'project', content: 'local' }), null);
    await assert.rejects(execute('memory_add', { target: 'memory', content: 'stale' }, undefined, () => false), /binding changed/);
    assert.equal(calls.length, 3);
});

test('knowledge rejection cannot be converted into a successful agent tool response', async () => {
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { memory: true }, items: [], hasMore: false }),
        mutate: async () => { throw Object.assign(new Error('Deleted memory cannot be relearned'), { status: 409 }); } };
    await assert.rejects(createKnowledgeMemoryTools(service, profileId)('memory_add', { target: 'memory', content: 'deleted' }),
        /cannot be relearned/);
});
