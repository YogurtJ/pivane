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
    const context = { cwd: '/tmp/synthetic-project', sessionManager: { getSessionFile: () => '/tmp/synthetic-session.jsonl',
        getSessionId: () => 'synthetic-session', getBranch: () => [{ id: 'native-user-entry' }] } };
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { memory: true, skill: true }, items: [row], hasMore: false }),
        mutateFromNative: async (_id, input, source) => { calls.push(input); assert.equal(source.entryId, 'native-user-entry');
            return { receipt: { id: 'receipt-1', status: 'saved', indexStatus: 'ready', activation: 'next-turn' } }; } };
    const execute = createKnowledgeMemoryTools(service, profileId);
    const run = (name, args, ensure) => execute(name, args, undefined, ensure, context);
    const changed = await run('memory_replace', { target: 'memory', old_text: '旧规则', content: '新规则' });
    assert.equal(changed.details.success, true);
    assert.equal(changed.details.receipt.id, 'receipt-1');
    assert.deepEqual({ operation: calls[0].operation, itemId: calls[0].itemId, itemRevision: calls[0].itemRevision,
        category: calls[0].category, expectedRevision: calls[0].expectedRevision },
    { operation: 'update', itemId: row.id, itemRevision: row.revision, category: 'correction', expectedRevision: revision });
    await run('memory_remove', { target: 'memory', old_text: '旧规则' });
    assert.equal(calls[1].operation, 'delete');
    assert.equal(Object.hasOwn(calls[1], 'content'), false);
    await run('memory_add', { target: 'user', content: '新偏好' });
    assert.equal(calls[2].operation, 'create');
    assert.equal(calls[2].target, 'user');
    assert.equal(calls[2].category, 'fact');
    await run('memory_add', { target: 'project', content: 'local' });
    assert.equal(calls[3].scope, 'project');
    assert.equal(calls[3].projectKey.length, 64);
    const unbound = await run('memory_add', { target: 'memory', content: 'stale' }, () => false);
    assert.equal(unbound.details.success, false);
    assert.match(unbound.details.error, /binding changed/);
    assert.equal(calls.length, 4);
});

test('profile skill and project writes use trusted CAS; rejected skill writes fail closed', async () => {
    const calls = [];
    const row = { id: 'e'.repeat(64), revision: 'd'.repeat(64), kind: 'skill', scope: 'profile',
        name: 'test-skill', description: 'Synthetic procedure', state: 'active' };
    const skillFile = '---\nname: test-skill\ndescription: Synthetic procedure\n---\n# test-skill\n\n## When to use\nSynthetic tasks\n\n## Procedure\n- Verify source\n\n## Verification\n- Check result\n';
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { skill: true },
        items: [row], hasMore: false }),
        getItem: async () => ({ status: 'ready', item: { ...row, content: skillFile } }),
        mutateFromNative: async (_id, input, native) => {
            calls.push({ input, native });
            return { receipt: { id: `receipt-${calls.length}`, status: 'saved', indexStatus: 'not-applicable', activation: 'reload-required' } };
        } };
    const ctx = { cwd: '/tmp/synthetic', sessionManager: { getSessionFile: () => '/tmp/synthetic.jsonl',
        getSessionId: () => 'session-1', getBranch: () => [{ id: 'entry-1' }] } };
    const execute = createKnowledgeMemoryTools(service, profileId);
    const created = await execute('skill_manage', { action: 'create', scope: 'project', name: 'new-skill',
        description: 'Synthetic procedure', when_to_use: 'Synthetic tasks', procedure_steps: ['Verify source'],
        verification_steps: ['Check result'] }, undefined, () => true, ctx);
    assert.equal(created.details.activation, 'reload-required');
    assert.equal(calls[0].input.scope, 'project');
    assert.match(calls[0].input.content, /## Verification/);
    assert.equal(calls[0].native.entryId, 'entry-1');
    const updated = await execute('skill_manage', { action: 'update', skill_id: 'global:test-skill',
        when_to_use: 'Synthetic tasks again', procedure_steps: ['Verify source'], verification_steps: ['Check result'] },
    undefined, () => true, ctx);
    assert.equal(updated.details.success, true, JSON.stringify(updated.details));
    assert.deepEqual({ operation: calls[1].input.operation, itemId: calls[1].input.itemId,
        itemRevision: calls[1].input.itemRevision, name: calls[1].input.name, scope: calls[1].input.scope },
    { operation: 'update', itemId: row.id, itemRevision: row.revision, name: 'test-skill', scope: 'profile' });
    assert.match(calls[1].input.content, /## When to Use\nSynthetic tasks again/);
    assert.match(calls[1].input.content, /## Pitfalls\n- None/);
    const patched = await execute('skill_manage', { action: 'patch', skill_id: 'global:test-skill',
        section: 'Procedure', procedure_steps: ['Open', 'Verify'] }, undefined, () => true, ctx);
    assert.equal(patched.details.success, true, JSON.stringify(patched.details));
    assert.match(calls[2].input.content, /## Procedure\n1\. Open\n2\. Verify/);
    assert.match(calls[2].input.content, /## Verification\n- Check result/);
    await execute('skill_manage', { action: 'delete', skill_id: 'global:test-skill' }, undefined, () => true, ctx);
    assert.equal(calls[3].input.itemId, row.id);
    assert.equal(await execute('skill_manage', { action: 'list' }, undefined, () => true, ctx), null);
});

test('deterministic skill update rejections become failed tool results', async () => {
    const row = { id: 'e'.repeat(64), revision: 'd'.repeat(64), kind: 'skill', scope: 'profile',
        name: 'test-skill', description: 'Synthetic procedure', state: 'active' };
    const skillFile = '---\nname: test-skill\ndescription: Synthetic procedure\n---\n# test-skill\n\n## When to use\nSynthetic tasks\n\n## Procedure\n- Verify source\n\n## Verification\n- Check result\n';
    let detail = { status: 'ready', item: { ...row, content: skillFile } };
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { skill: true }, items: [row], hasMore: false }),
        getItem: async () => detail,
        mutateFromNative: async () => { throw new Error('mutation must not be published'); } };
    const ctx = { cwd: '/tmp/synthetic', sessionManager: { getSessionFile: () => '/tmp/synthetic.jsonl',
        getSessionId: () => 'session-1', getBranch: () => [{ id: 'entry-1' }] } };
    const execute = createKnowledgeMemoryTools(service, profileId);
    const run = args => execute('skill_manage', args, undefined, () => true, ctx);
    const incomplete = await run({ action: 'update', skill_id: 'global:test-skill' });
    assert.equal(incomplete.details.success, false);
    assert.match(incomplete.details.error, /when_to_use is required/);
    const missingSection = await run({ action: 'patch', skill_id: 'global:test-skill' });
    assert.equal(missingSection.details.success, false);
    assert.match(missingSection.details.error, /section is required/);
    const ambiguousSection = await run({ action: 'patch', skill_id: 'global:test-skill', section: 'Missing', content: 'x' });
    assert.equal(ambiguousSection.details.success, false);
    assert.match(ambiguousSection.details.error, /missing or ambiguous/);
    detail = { status: 'ready', item: { ...row, revision: 'f'.repeat(64), content: skillFile } };
    const stale = await run({ action: 'patch', skill_id: 'global:test-skill', section: 'Procedure', content: 'x' });
    assert.equal(stale.details.success, false);
    assert.match(stale.details.error, /Skill changed/);
    detail = { status: 'ready', item: { ...row, content: 'unmanaged body' } };
    const unmanaged = await run({ action: 'patch', skill_id: 'global:test-skill', section: 'Procedure', content: 'x' });
    assert.equal(unmanaged.details.success, false);
    assert.match(unmanaged.details.error, /frontmatter/);
    const invalidIdentity = await run({ action: 'update', skill_id: 'global:Test_Skill' });
    assert.equal(invalidIdentity.details.success, false);
    assert.match(invalidIdentity.details.error, /Invalid skill identity/);
});

test('knowledge rejection cannot be converted into a successful agent tool response', async () => {
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { memory: true }, items: [], hasMore: false }),
        mutateFromNative: async () => { throw Object.assign(new Error('Deleted memory cannot be relearned'), { status: 409 }); } };
    const context = { cwd: '/tmp/synthetic', sessionManager: { getSessionFile: () => '/tmp/native.jsonl',
        getSessionId: () => 'native', getBranch: () => [{ id: 'user-1' }] } };
    const rejected = await createKnowledgeMemoryTools(service, profileId)('memory_add',
        { target: 'memory', content: 'deleted' }, undefined, () => true, context);
    assert.equal(rejected.details.success, false);
    assert.match(rejected.details.error, /cannot be relearned/);
    assert.equal(rejected.details.status, 409);
    assert.match(rejected.content[0].text, /cannot be relearned/);
});

test('uncertain knowledge outcomes keep throwing instead of reporting a failed write', async () => {
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { memory: true }, items: [], hasMore: false }),
        mutateFromNative: async () => { throw Object.assign(new Error('Skill publication uncertain'), { status: 503 }); } };
    const context = { cwd: '/tmp/synthetic', sessionManager: { getSessionFile: () => '/tmp/native.jsonl',
        getSessionId: () => 'native', getBranch: () => [{ id: 'user-1' }] } };
    await assert.rejects(createKnowledgeMemoryTools(service, profileId)('memory_add',
        { target: 'memory', content: 'maybe' }, undefined, () => true, context), /uncertain/);
});
