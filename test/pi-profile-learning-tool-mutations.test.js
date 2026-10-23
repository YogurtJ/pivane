'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { ProfileKnowledgeService } = require('../server/profile-memory/knowledge-service');
const { LIMITS } = require('../server/profile-memory/knowledge-compare');
const { createKnowledgeMemoryTools: rawKnowledgeTools } = require('../server/profile-memory/tool-mutations');
const { withComparison } = require('./helpers/profile-knowledge-call');
const createKnowledgeMemoryTools = (...args) => withComparison(rawKnowledgeTools(...args));
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

test('upstream project skill IDs resolve by slug inside the verified cwd scope only', async () => {
    const calls = [];
    const cwdKey = require('node:crypto').createHash('sha256').update('/tmp/synthetic').digest('hex');
    const rows = [{ id: 'e'.repeat(64), revision: 'd'.repeat(64), kind: 'skill', scope: 'project', projectKey: cwdKey,
        name: 'release-app', state: 'active' },
    { id: 'f'.repeat(64), revision: 'd'.repeat(64), kind: 'skill', scope: 'project', projectKey: '0'.repeat(64),
        name: 'release-app', state: 'active' }];
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { skill: true }, items: rows, hasMore: false }),
        mutateFromNative: async (_id, input) => { calls.push(input); return { receipt: { id: 'r', status: 'saved' } }; } };
    const ctx = { cwd: '/tmp/synthetic', sessionManager: { getSessionFile: () => '/tmp/synthetic.jsonl',
        getSessionId: () => 'session-1', getBranch: () => [{ id: 'entry-1' }] } };
    const execute = createKnowledgeMemoryTools(service, profileId);
    const removed = await execute('skill_manage', { action: 'delete', skill_id: 'project:my-repo:release-app' }, undefined, () => true, ctx);
    assert.equal(removed.details.success, true);
    assert.deepEqual([calls[0].itemId, calls[0].scope, calls[0].projectKey], [rows[0].id, 'project', cwdKey]);
    for (const skill_id of ['global:my-repo:release-app', 'project:a:b:release-app', 'project:bad name:release-app']) {
        const rejected = await execute('skill_manage', { action: 'delete', skill_id }, undefined, () => true, ctx);
        assert.equal(rejected.details.success, false, skill_id);
        assert.match(rejected.details.error, /Invalid skill identity/);
    }
    assert.equal(calls.length, 1);
});

test('agent failure memories map to profile MEMORY.md with mapped categories and an optional reason', async () => {
    const calls = [];
    const rows = [{ id: 'b'.repeat(64), revision: 'c'.repeat(64), kind: 'memory', scope: 'profile', target: 'memory',
        state: 'active', category: 'preference', content: 'Writable note' },
    { id: 'd'.repeat(64), revision: 'e'.repeat(64), kind: 'memory', scope: 'profile', target: 'failure',
        state: 'active', category: 'failure', content: 'Legacy failure', readOnly: true }];
    const service = { snapshot: async () => ({ status: 'ready', revision, capabilities: { memory: true }, items: rows, hasMore: false }),
        mutateFromNative: async (_id, input) => { calls.push(input); return { receipt: { id: 'r', status: 'saved' } }; } };
    const context = { cwd: '/tmp/synthetic', sessionManager: { getSessionFile: () => '/tmp/native.jsonl',
        getSessionId: () => 'native', getBranch: () => [{ id: 'user-1' }] } };
    const run = (name, args) => createKnowledgeMemoryTools(service, profileId)(name, args, undefined, () => true, context);
    const added = await run('memory_add', { target: 'failure', content: ' Build failed ', failure_reason: ' missing env ' });
    assert.equal(added.details.success, true);
    assert.deepEqual({ target: calls[0].target, scope: calls[0].scope, category: calls[0].category, content: calls[0].content },
        { target: 'memory', scope: 'profile', category: 'failure', content: 'Build failed（原因：missing env）' });
    const expected = { failure: 'failure', 'tool-quirk': 'failure', correction: 'correction', preference: 'preference',
        convention: 'procedure', insight: 'fact' };
    for (const [category, mapped] of Object.entries(expected)) {
        for (const target of ['failure', 'memory']) {
            await run('memory_add', { target, content: `${category} ${target}`, category });
            assert.equal(calls.at(-1).category, mapped, `${target}/${category}`);
            assert.equal(calls.at(-1).target, 'memory');
        }
    }
    await run('memory_add', { target: 'memory', content: 'plain', failure_reason: 'ignored outside failure' });
    assert.deepEqual([calls.at(-1).category, calls.at(-1).content], ['fact', 'plain']);
    for (const failure_reason of ['x'.repeat(201), 'two\nlines', 42]) {
        const rejected = await run('memory_add', { target: 'failure', content: 'Bad reason', failure_reason });
        assert.equal(rejected.details.success, false);
        assert.match(rejected.details.error, /Invalid failure_reason/);
    }
    const unknown = await run('memory_add', { target: 'memory', content: 'Unknown', category: 'mystery' });
    assert.match(unknown.details.error, /Invalid memory category/);
    const count = calls.length;
    await run('memory_replace', { target: 'memory', old_text: 'Writable note', content: 'Kept category' });
    assert.equal(calls.at(-1).category, 'preference');
    await run('memory_replace', { target: 'memory', old_text: 'Writable note', content: 'Explicit', category: 'convention' });
    assert.equal(calls.at(-1).category, 'procedure');
    await run('memory_replace', { target: 'failure', old_text: 'Writable note', content: 'Now a failure' });
    assert.deepEqual([calls.at(-1).operation, calls.at(-1).itemId, calls.at(-1).category], ['update', rows[0].id, 'failure']);
    await run('memory_replace', { target: 'failure', old_text: 'Writable note', content: 'Insight', category: 'insight' });
    assert.equal(calls.at(-1).category, 'fact');
    await run('memory_remove', { target: 'failure', old_text: 'Writable note' });
    assert.deepEqual([calls.at(-1).operation, calls.at(-1).itemId], ['delete', rows[0].id]);
    for (const name of ['memory_replace', 'memory_remove']) {
        const legacy = await run(name, { target: 'failure', old_text: 'Legacy failure', content: 'x' });
        assert.equal(legacy.details.success, false);
        assert.equal(legacy.details.status, 409);
        assert.equal(legacy.details.error, 'Legacy failure entries are read-only');
    }
    const missing = await run('memory_remove', { target: 'failure', old_text: 'Nothing here' });
    assert.match(missing.details.error, /missing or ambiguous/);
    assert.equal(calls.length, count + 5);
});

const memoryContext = { cwd: '/tmp/synthetic-memory-project', sessionManager: {
    getSessionFile: () => '/tmp/synthetic-memory-session.jsonl', getSessionId: () => 'memory-session',
    getBranch: () => [{ id: 'memory-entry' }],
} };
const digest = value => createHash('sha256').update(value).digest('hex');
function memoryItem(content, fields = {}) {
    return { id: digest(`item:${content}`), revision: digest(content), kind: 'memory', scope: 'profile',
        target: 'memory', state: 'active', category: 'fact', content, ...fields };
}
function memoryService(items) {
    const reads = [], writes = [];
    const service = {
        snapshot: async key => {
            assert.equal(key, profileId);
            return { status: 'ready', revision, capabilities: { memory: true }, hasMore: false,
                items: items.map(item => ({ ...item, content: item.content.slice(0, 512) })) };
        },
        getItem: async (key, itemId) => {
            assert.equal(key, profileId);
            reads.push(itemId);
            return { status: 'ready', item: { ...items.find(item => item.id === itemId) } };
        },
        mutateFromNative: async (key, input) => {
            assert.equal(key, profileId);
            writes.push(input);
            return { receipt: { id: 'memory-receipt', status: 'saved' } };
        },
    };
    const run = (name, args, signal, ensure = () => true) => rawKnowledgeTools(service, profileId)(name, args, signal, ensure, memoryContext);
    return { service, reads, writes, run };
}

test('memory tools match complete text at 511, 512 and 513 characters', async t => {
    for (const length of [511, 512, 513]) for (const name of ['memory_replace', 'memory_remove']) {
        await t.test(`${name}/${length}`, async () => {
            const row = memoryItem('x'.repeat(length));
            const f = memoryService([row]);
            const result = await f.run(name, { target: 'memory', old_text: row.content, content: 'Replacement' });
            assert.equal(result.details.success, true, JSON.stringify(result.details));
            assert.deepEqual(f.reads, length >= 512 ? [row.id] : []);
            assert.equal(f.writes.length, 1);
            assert.deepEqual([f.writes[0].itemId, f.writes[0].itemRevision, f.writes[0].expectedRevision],
                [row.id, row.revision, revision]);
        });
    }
});

test('a 512-character preview cannot authorize replacing or removing the unseen tail', async () => {
    for (const name of ['memory_replace', 'memory_remove']) {
        const row = memoryItem(`${'p'.repeat(512)}Keep this unseen tail.`);
        const f = memoryService([row]);
        const result = await f.run(name, { target: 'memory', old_text: row.content.slice(0, 512), content: 'Replacement' });
        assert.equal(result.details.success, false);
        assert.equal(result.details.status, 409);
        assert.match(result.details.error, /missing or ambiguous/);
        assert.deepEqual(f.reads, [row.id]);
        assert.deepEqual(f.writes, []);
    }
});

test('shared previews resolve only a unique full memory and keep exact duplicates ambiguous', async () => {
    const prefix = 's'.repeat(512), left = memoryItem(`${prefix}Left tail`), right = memoryItem(`${prefix}Right tail`);
    const unrelated = Array.from({ length: 30 }, (_, i) => memoryItem(`Unrelated ${i}`));
    const f = memoryService([left, right, ...unrelated]);
    const selected = await f.run('memory_remove', { target: 'memory', old_text: right.content });
    assert.equal(selected.details.success, true, JSON.stringify(selected.details));
    assert.deepEqual(f.reads, [left.id, right.id]);
    assert.equal(f.writes[0].itemId, right.id);
    const ambiguous = memoryService([left, { ...left, id: 'f'.repeat(64) }]);
    const result = await ambiguous.run('memory_replace', { target: 'memory', old_text: left.content, content: 'Replacement' });
    assert.equal(result.details.success, false);
    assert.match(result.details.error, /missing or ambiguous/);
    assert.equal(ambiguous.reads.length, 2);
    assert.deepEqual(ambiguous.writes, []);
});

test('complete memory matching accepts 12 preview candidates and refuses 13 without reading or writing', async () => {
    for (const size of [LIMITS.candidates, LIMITS.candidates + 1]) {
        const rows = Array.from({ length: size }, (_, i) => memoryItem(`${'b'.repeat(512)}Tail ${i}`));
        const f = memoryService(rows);
        const result = await f.run('memory_remove', { target: 'memory', old_text: rows[0].content });
        assert.equal(result.details.success, size === LIMITS.candidates, JSON.stringify(result.details));
        assert.equal(f.reads.length, size === LIMITS.candidates ? size : 0);
        assert.equal(f.writes.length, size === LIMITS.candidates ? 1 : 0);
        if (size > LIMITS.candidates) {
            assert.equal(result.details.status, 409);
            assert.match(result.details.error, /Too many memory candidates.*nothing was saved/);
        }
    }
});

test('memory detail checks reject changed identity, scope, revision and incomplete or read-only bodies', async t => {
    const row = memoryItem(`${'d'.repeat(512)}Complete body`);
    const variants = { id: 'f'.repeat(64), revision: 'f'.repeat(64), kind: 'skill', scope: 'project',
        projectKey: 'f'.repeat(64), target: 'user', state: 'deleted', readOnly: true, truncated: true,
        content: `Changed ${row.content}` };
    for (const [field, value] of Object.entries(variants)) await t.test(field, async () => {
        const f = memoryService([row]);
        let detailReads = 0;
        f.service.getItem = async () => { detailReads++; return { status: 'ready', item: { ...row, [field]: value } }; };
        const result = await f.run('memory_remove', { target: 'memory', old_text: row.content });
        assert.equal(result.details.success, false, field);
        assert.equal(result.details.status, 409);
        assert.equal(detailReads, 1, 'the complete candidate must be checked');
        assert.deepEqual(f.writes, []);
    });
    for (const detail of [{ status: 'missing' }, { status: 'pending' }, { status: 'ready' }]) {
        const f = memoryService([row]);
        f.service.getItem = async () => detail;
        const result = await f.run('memory_remove', { target: 'memory', old_text: row.content });
        assert.equal(result.details.success, false);
        assert.deepEqual(f.writes, []);
    }
    const unavailable = memoryService([row]);
    delete unavailable.service.getItem;
    const result = await unavailable.run('memory_remove', { target: 'memory', old_text: row.content });
    assert.equal(result.details.success, false);
    assert.equal(result.details.status, 409);
    assert.deepEqual(unavailable.writes, []);
});

test('memory candidates stay inside the requested target and verified physical project', async () => {
    const content = `${'i'.repeat(512)}Scoped tail`, projectKey = digest(memoryContext.cwd);
    const rows = [memoryItem(content), memoryItem(content, { id: '1'.repeat(64), target: 'user' }),
        memoryItem(content, { id: '2'.repeat(64), scope: 'project', target: 'project', projectKey }),
        memoryItem(content, { id: '3'.repeat(64), scope: 'project', target: 'project', projectKey: 'f'.repeat(64) }),
        memoryItem(content, { id: '4'.repeat(64), readOnly: true }),
        memoryItem(content, { id: '5'.repeat(64), truncated: true }),
        memoryItem(content, { id: '6'.repeat(64), state: 'deleted' }),
        memoryItem(content, { id: '7'.repeat(64), kind: 'skill' })];
    for (const [index, target] of ['memory', 'user', 'project'].entries()) {
        const f = memoryService(rows);
        const result = await f.run('memory_remove', { target, old_text: content });
        assert.equal(result.details.success, true, JSON.stringify(result.details));
        assert.deepEqual(f.reads, [rows[index].id]);
        assert.equal(f.writes[0].itemId, rows[index].id);
        assert.equal(f.writes[0].scope, rows[index].scope);
        if (target === 'project') assert.equal(f.writes[0].projectKey, projectKey);
    }
});

test('cancellation and binding changes during a memory detail read stop subsequent reads and writes', async () => {
    for (const change of ['abort', 'binding']) {
        const row = memoryItem(`${'c'.repeat(512)}First tail`);
        const f = memoryService([row, memoryItem(`${'c'.repeat(512)}Second tail`)]);
        const controller = new AbortController();
        let started, resume, bound = true;
        const reading = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { resume = resolve; });
        f.service.getItem = async () => { f.reads.push(row.id); started(); await gate; return { status: 'ready', item: row }; };
        const result = f.run('memory_remove', { target: 'memory', old_text: row.content }, controller.signal, () => bound);
        const first = await Promise.race([reading.then(() => 'reading'), result.then(() => 'settled')]);
        assert.equal(first, 'reading', 'the tool must read full text before it can settle');
        if (change === 'abort') controller.abort(); else bound = false;
        resume();
        if (change === 'abort') await assert.rejects(result, { name: 'AbortError' });
        else {
            const value = await result;
            assert.equal(value.details.success, false);
            assert.match(value.details.error, /binding changed/);
        }
        assert.deepEqual(f.reads, [row.id]);
        assert.deepEqual(f.writes, []);
    }
});

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
function storedMemories(t) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-tool-memory-')));
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const foreignId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const profiles = { getProfile: async id => [profileId, foreignId].includes(id)
        ? { id, enabled: true, memory: { enabled: true, memoryCharLimit: 65536, userCharLimit: 32768 }, skills: { learnedEnabled: true } } : null,
    reserve: work => work() };
    const service = new ProfileKnowledgeService({ profiles, getAgentDir: async () => agent, bundlePath: bundle });
    const root = path.join(agent, 'pivane-profiles', 'data', profileId);
    const foreignRoot = path.join(agent, 'pivane-profiles', 'data', foreignId);
    const cwd = fs.mkdtempSync(path.join(agent, 'project-'));
    const native = { cwd, sessionId: 'memory-session', entryId: 'memory-entry', sessionPath: path.join(agent, 'sessions', 'memory.jsonl') };
    fs.mkdirSync(path.dirname(native.sessionPath), { recursive: true });
    fs.writeFileSync(native.sessionPath, [
        { type: 'session', id: native.sessionId, cwd, timestamp: '2026-01-01' },
        { type: 'custom', id: 'binding', parentId: null, customType: 'pivane-agent-profile',
            data: { version: 1, sessionId: native.sessionId, profileId } },
        { type: 'message', id: native.entryId, parentId: 'binding', message: { role: 'user', content: 'Synthetic memory test' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const context = { cwd, sessionManager: { getSessionFile: () => native.sessionPath,
        getSessionId: () => native.sessionId, getBranch: () => [{ id: native.entryId }] } };
    const tool = rawKnowledgeTools(service, profileId);
    const run = (name, args) => tool(name, args, undefined, () => true, context);
    let serial = 0;
    const create = async (content, target = 'memory') => service.mutateFromNative(profileId,
        { requestId: `stored-${++serial}`, expectedRevision: (await service.snapshot(profileId)).revision,
            operation: 'create', kind: 'memory', scope: target === 'project' ? 'project' : 'profile', target,
            category: 'fact', content }, native);
    const Database = createRequire(bundle)('better-sqlite3');
    const databaseRows = () => {
        const db = new Database(path.join(root, 'sessions.db'), { readonly: true });
        try { return db.prepare('SELECT id, project, target, content FROM memories ORDER BY id').all(); }
        finally { db.close(); }
    };
    const ledgerBytes = () => fs.readFileSync(path.join(root, '.pivane-knowledge.json'));
    return { service, root, foreignRoot, foreignId, native, run, create, Database, databaseRows, ledgerBytes };
}

test('real memory files and SQLite preserve preview tails and accept complete 511/512/513 edits', { skip: !bundle }, async t => {
    const f = storedMemories(t);
    for (const length of [511, 512, 513]) {
        const content = `${length}:`.padEnd(length, 'x');
        const saved = await f.create(content);
        const listed = (await f.service.snapshot(profileId, { kind: 'memory', state: 'present' })).items;
        assert.equal(listed.find(row => row.id === saved.item.id).content, content.slice(0, 512));
        if (length === 513) for (const name of ['memory_replace', 'memory_remove']) {
            const fileBefore = fs.readFileSync(path.join(f.root, 'MEMORY.md'));
            const dbBefore = f.databaseRows(), ledgerBefore = f.ledgerBytes();
            const rejected = await f.run(name, { target: 'memory', old_text: content.slice(0, 512), content: 'Must not publish' });
            assert.equal(rejected.details.success, false, JSON.stringify(rejected.details));
            assert.deepEqual(fs.readFileSync(path.join(f.root, 'MEMORY.md')), fileBefore);
            assert.deepEqual(f.databaseRows(), dbBefore);
            assert.deepEqual(f.ledgerBytes(), ledgerBefore);
        }
        const replacement = `${length} replacement ${'r'.repeat(520)}`;
        const updated = await f.run('memory_replace', { target: 'memory', old_text: content, content: replacement });
        assert.equal(updated.details.success, true, JSON.stringify(updated.details));
        assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), replacement);
        assert.deepEqual(f.databaseRows().map(row => row.content), [replacement]);
        const removed = await f.run('memory_remove', { target: 'memory', old_text: replacement });
        assert.equal(removed.details.success, true, JSON.stringify(removed.details));
        assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), '');
        assert.deepEqual(f.databaseRows(), []);
        assert.equal((await f.service.getItem(profileId, saved.item.id)).item.state, 'deleted');
    }
});

test('real memory matching accepts the complete 65536-character detail boundary', { skip: !bundle }, async t => {
    const f = storedMemories(t);
    const content = `${'b'.repeat(65535)}终`;
    const saved = await f.create(content);
    const detail = await f.service.getItem(profileId, saved.item.id);
    assert.equal(detail.item.content, content);
    assert.equal(Boolean(detail.item.truncated), false);
    const rejected = await f.run('memory_remove', { target: 'memory', old_text: content.slice(0, -1) });
    assert.equal(rejected.details.success, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), content);
    assert.deepEqual(f.databaseRows().map(row => row.content), [content]);
    const removed = await f.run('memory_remove', { target: 'memory', old_text: content });
    assert.equal(removed.details.success, true, JSON.stringify(removed.details));
    assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), '');
    assert.deepEqual(f.databaseRows(), []);
});

test('real shared-prefix memories retain the other complete entry and isolate profiles and projects', { skip: !bundle }, async t => {
    const f = storedMemories(t);
    const prefix = 'q'.repeat(512), left = `${prefix}Left`, right = `${prefix}Right`;
    await f.create(left); await f.create(right); await f.create(right, 'project');
    fs.mkdirSync(f.foreignRoot, { recursive: true });
    fs.writeFileSync(path.join(f.foreignRoot, 'MEMORY.md'), right);
    const foreignProject = path.join(f.root, 'projects', 'f'.repeat(64), 'MEMORY.md');
    fs.mkdirSync(path.dirname(foreignProject), { recursive: true });
    fs.writeFileSync(foreignProject, right);
    const removed = await f.run('memory_remove', { target: 'memory', old_text: right });
    assert.equal(removed.details.success, true, JSON.stringify(removed.details));
    assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), left);
    assert.deepEqual(f.databaseRows().map(row => [row.project, row.content]), [[null, left], [f.native.cwd, right]]);
    const projectFile = path.join(f.root, 'projects', digest(f.native.cwd), 'MEMORY.md');
    assert.equal(fs.readFileSync(projectFile, 'utf8'), right);
    const projectRemoved = await f.run('memory_remove', { target: 'project', old_text: right });
    assert.equal(projectRemoved.details.success, true, JSON.stringify(projectRemoved.details));
    assert.equal(fs.readFileSync(projectFile, 'utf8'), '');
    assert.deepEqual(f.databaseRows().map(row => [row.project, row.content]), [[null, left]]);
    assert.equal(fs.readFileSync(foreignProject, 'utf8'), right);
    assert.equal(fs.readFileSync(path.join(f.foreignRoot, 'MEMORY.md'), 'utf8'), right);
    assert.equal((await f.service.snapshot(f.foreignId)).items[0].content, prefix);
});

test('real detail reads and mutation CAS reject revisions changed before or after reading full text', { skip: !bundle }, async t => {
    for (const phase of ['during-detail', 'after-detail']) await t.test(phase, async () => {
        const f = storedMemories(t);
        const content = `${'v'.repeat(512)}Original`, newer = `${'v'.repeat(512)}Newer`;
        const saved = await f.create(content);
        const getItem = f.service.getItem.bind(f.service);
        let concurrent;
        f.service.getItem = async (...args) => {
            const detail = phase === 'after-detail' ? await getItem(...args) : null;
            concurrent = await f.service.mutate(profileId, { requestId: `concurrent-${phase}`,
                expectedRevision: (await f.service.snapshot(profileId)).revision, operation: 'update', kind: 'memory',
                itemId: saved.item.id, itemRevision: saved.item.revision, category: 'fact', content: newer });
            return detail || getItem(...args);
        };
        const result = await f.run('memory_remove', { target: 'memory', old_text: content });
        assert.equal(result.details.success, false, JSON.stringify(result.details));
        assert.equal(result.details.status, 409);
        assert.ok(concurrent, 'the tool must reach the full detail read');
        assert.equal(concurrent.status, 'saved');
        assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), newer);
        assert.deepEqual(f.databaseRows().map(row => row.content), [newer]);
        const snapshot = await f.service.snapshot(profileId);
        assert.equal(snapshot.receipts.length, 2, 'only create and concurrent update were published');
    });
});

test('real SQLite-only and oversized legacy memory bodies remain read-only', { skip: !bundle }, async t => {
    const f = storedMemories(t);
    await f.create('Initialize the real memory index');
    const sqliteOnly = `${'z'.repeat(512)}SQLite only tail`;
    const db = new f.Database(path.join(f.root, 'sessions.db'));
    try { db.prepare('INSERT INTO memories (project, target, content, created, last_referenced) VALUES (NULL, ?, ?, ?, ?)')
        .run('memory', sqliteOnly, '2026-01-01', '2026-01-01'); }
    finally { db.close(); }
    const oversized = `${'o'.repeat(65536)}Unseen oversized tail`;
    fs.writeFileSync(path.join(f.root, 'USER.md'), oversized);
    const listed = await f.service.snapshot(profileId, { kind: 'memory' });
    const legacy = listed.items.find(row => row.target === 'user');
    const detail = await f.service.getItem(profileId, legacy.id);
    assert.equal(detail.item.content.length, 65536);
    assert.equal(detail.item.truncated, true);
    assert.equal(detail.item.readOnly, true);
    const fileBefore = fs.readFileSync(path.join(f.root, 'USER.md'));
    const dbBefore = f.databaseRows(), ledgerBefore = f.ledgerBytes();
    for (const [target, old_text] of [['memory', sqliteOnly], ['memory', sqliteOnly.slice(0, 512)],
        ['user', oversized], ['user', oversized.slice(0, 512)], ['user', detail.item.content]]) {
        const rejected = await f.run('memory_remove', { target, old_text });
        assert.equal(rejected.details.success, false, JSON.stringify(rejected.details));
        assert.equal(rejected.details.status, 409);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'USER.md')), fileBefore);
    assert.deepEqual(f.databaseRows(), dbBefore);
    assert.deepEqual(f.ledgerBytes(), ledgerBefore);
});
