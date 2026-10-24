'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileLearningService } = require('../server/profile-memory/learning-service');

const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revision = 'a'.repeat(64);
const skills = (count, state) => Array.from({ length: count }, () => ({ kind: 'skill', state }));
const skillCounts = ({ active = 0, draft = 0, disabled = 0, deleted = 0 } = {}) =>
    ({ total: active + draft + disabled, active, draft, disabled, deleted });

function fixture(t, { rows = [], counts, status = 'ready', skill = true, changedPage, unavailablePage } = {}) {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-snapshot-'));
    const calls = [];
    const first = { status, revision, items: [], hasMore: false, capabilities: { memory: true, skill },
        ...(counts === undefined ? {} : { counts: { skill: counts } }) };
    const knowledge = {
        snapshot: async (id, options) => {
            assert.equal(id, profileId);
            calls.push(options || {});
            if (!options) return first;
            assert.equal(options.kind, 'skill');
            return { status: options.offset === unavailablePage ? 'pending' : 'ready',
                revision: options.offset === changedPage ? 'b'.repeat(64) : revision,
                items: rows.slice(options.offset, options.offset + 50), hasMore: rows.length > options.offset + 50 };
        },
        mutateFromNative: async () => assert.fail('A status snapshot must never write knowledge')
    };
    const service = new ProfileLearningService({
        profiles: { getProfile: async () => ({ id: profileId, enabled: true, memory: { enabled: true } }) },
        store: {}, knowledge, getAgentDir: async () => agentDir,
        preferences: { getMemoryModels: () => Object.fromEntries(['memory-correction', 'memory-review', 'memory-extraction']
            .map(purpose => [purpose, { provider: '', modelId: '' }])) },
        createModelRuntime: async () => assert.fail('A status snapshot must never request a model')
    });
    t.after(async () => { await service.dispose(); fs.rmSync(agentDir, { recursive: true, force: true }); });
    return { service, calls, first, snapshot: () => service.snapshot(profileId) };
}

test('learning snapshot reuses complete skill counts from its one knowledge revision', async t => {
    const cases = [
        { name: 'empty', rows: [], counts: skillCounts(), expected: { pending: 0 } },
        { name: 'mixed states', rows: [...skills(60, 'active'), ...skills(7, 'draft'), ...skills(3, 'disabled'), ...skills(4, 'deleted')],
            counts: skillCounts({ active: 60, draft: 7, disabled: 3, deleted: 4 }), expected: { pending: 7 } },
        { name: 'exactly 200', rows: skills(200, 'draft'), counts: skillCounts({ draft: 200 }), expected: { pending: 200 } },
        { name: '201', rows: skills(201, 'draft'), counts: skillCounts({ draft: 201 }), expected: { pending: 200, capped: true } },
        { name: '1000 including deleted', rows: [...skills(998, 'deleted'), ...skills(1, 'active'), ...skills(1, 'draft')],
            counts: skillCounts({ active: 1, draft: 1, deleted: 998 }), expected: { pending: 1 } }
    ];
    for (const item of cases) await t.test(item.name, async t => {
        const f = fixture(t, item);
        const before = structuredClone(f.first);
        const result = await f.snapshot();
        assert.deepEqual(result.drafts, item.expected);
        assert.deepEqual(f.calls, [{}], 'complete counts must avoid all skill page queries');
        assert.deepEqual(f.first, before);
        assert.equal(result.revision, 0, 'display counts do not create or revise the learning journal');
    });
});

test('learning snapshot takes fresh display counts on every call without rereading skill pages', async t => {
    const f = fixture(t, { rows: skills(7, 'draft'), counts: skillCounts({ draft: 7 }) });
    const first = await f.snapshot();
    f.first.revision = 'b'.repeat(64);
    f.first.counts.skill = skillCounts({ draft: 8 });
    const second = await f.snapshot();
    assert.deepEqual([first.drafts, second.drafts], [{ pending: 7 }, { pending: 8 }]);
    assert.deepEqual(f.calls, [{}, {}], 'each call owns its new knowledge snapshot');
});

test('learning snapshot retains bounded pagination for missing or untrusted skill counts', async t => {
    const valid = skillCounts({ active: 2, draft: 2 });
    const cases = [{ name: 'missing', counts: undefined }, { name: 'null', counts: null },
        { name: 'array', counts: [] }, { name: 'draft exceeds total', counts: { ...valid, total: 1 } }];
    for (const field of ['total', 'active', 'draft', 'disabled', 'deleted']) {
        for (const [name, value] of [['missing', undefined], ['negative', -1], ['fraction', 0.5], ['NaN', NaN],
            ['infinite', Infinity], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '0'], ['null', null]]) {
            cases.push({ name: `${field}: ${name}`, counts: { ...valid, [field]: value } });
        }
    }
    for (const item of cases) await t.test(item.name, async t => {
        const f = fixture(t, { rows: [...skills(2, 'active'), ...skills(2, 'draft')], ...item });
        assert.deepEqual((await f.snapshot()).drafts, { pending: 2 });
        assert.deepEqual(f.calls, [{}, { kind: 'skill', offset: 0 }]);
    });
});

test('learning snapshot preserves the 1001-skill scan bound including deleted rows', async t => {
    for (const draftFirst of [false, true]) await t.test(draftFirst ? 'draft in first page' : 'draft beyond scan bound', async t => {
        const rows = draftFirst ? [...skills(1, 'draft'), ...skills(999, 'deleted'), ...skills(1, 'active')]
            : [...skills(999, 'deleted'), ...skills(1, 'active'), ...skills(1, 'draft')];
        const f = fixture(t, { rows, counts: skillCounts({ active: 1, draft: 1, deleted: 999 }) });
        assert.deepEqual((await f.snapshot()).drafts, { pending: draftFirst ? 1 : 0, capped: true });
        assert.equal(f.calls.length, 21);
        assert.deepEqual(f.calls.slice(1), Array.from({ length: 20 }, (_, page) => ({ kind: 'skill', offset: page * 50 })));
    });
});

test('learning snapshot fallback keeps revision and readiness checks and the 200-draft cap', async t => {
    for (const [name, options, expected, pageCount] of [
        ['revision changed on first page', { rows: skills(80, 'draft'), changedPage: 0 }, { pending: 0 }, 1],
        ['revision changed on second page', { rows: skills(80, 'draft'), changedPage: 50 }, { pending: 50 }, 2],
        ['second page unavailable', { rows: skills(80, 'draft'), unavailablePage: 50 }, { pending: 50 }, 2],
        ['exactly 200 without counts', { rows: skills(200, 'draft') }, { pending: 200 }, 4],
        ['201 without counts', { rows: skills(201, 'draft') }, { pending: 200, capped: true }, 5]
    ]) await t.test(name, async t => {
        const f = fixture(t, options);
        assert.deepEqual((await f.snapshot()).drafts, expected);
        assert.equal(f.calls.length, pageCount + 1);
    });
});

test('learning snapshot never uses counts when knowledge is unavailable or skills are disabled', async t => {
    for (const options of [{ skill: false }, { status: 'pending' }, { status: 'error' }]) await t.test(JSON.stringify(options), async t => {
        const f = fixture(t, { rows: skills(7, 'draft'), counts: skillCounts({ draft: 7 }), ...options });
        assert.deepEqual((await f.snapshot()).drafts, { pending: 0 });
        assert.deepEqual(f.calls, [{}]);
    });
});
