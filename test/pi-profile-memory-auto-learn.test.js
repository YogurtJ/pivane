'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewer, reviewModelConfig } = require('../server/profile-memory/auto-learn');

const event = { outcome: 'completed', context: { contextMessages: [
    { role: 'user', content: 'Please consistently use the synthetic verification checklist for this project and confirm each step.' },
    { role: 'assistant', content: [{ type: 'text', text: 'I will apply the synthetic verification checklist and confirm each step.' }] },
] } };

test('DIRECT review is awaited, cheap and scoped to one guarded memory write', async t => {
    const prior = process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL;
    t.after(() => { if (prior === undefined) delete process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL;
        else process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL = prior; });
    process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL = JSON.stringify({ provider: 'synthetic', modelId: 'cheap' });
    const records = [], calls = [], writes = [];
    let entries = [];
    const store = { getMemoryEntries: () => entries, getUserEntries: () => [], loadFromDisk: async () => {} };
    const projectStore = { getMemoryEntries: () => [], loadFromDisk: async () => {} };
    const ctx = { mode: 'rpc', modelRegistry: {
        getModel(provider, id) { assert.deepEqual([provider, id], ['synthetic', 'cheap']); return { cost: { input: 0.1, output: 1 } }; },
        async getAvailable() { return [{ provider: 'synthetic', id: 'cheap' }]; },
        async completeSimple(model, request, options) {
            calls.push({ request, options });
            await new Promise(resolve => setTimeout(resolve, 5));
            return { stopReason: 'stop', usage: { input: 14, output: 12, cost: { total: 0.00003 } }, content: [{ type: 'text', text: '{"target":"memory","content":"Use the synthetic verification checklist."}' }] };
        },
    } };
    const pi = { appendEntry: (type, data) => records.push({ type, data }) };
    const tools = new Map([['memory_add', { async execute(id, args, signal) {
        assert.equal(id, 'profile-review'); assert.equal(signal.aborted, false);
        writes.push(args); entries = [...entries, args.content];
        return { details: { success: true } };
    } }]]);
    const mutation = { inspect: async work => work(0), run: async (_signal, work) => work() };
    const reviewer = createReviewer(pi, { context: { profileId: 'synthetic', memory: { enabled: true, autoLearn: true } },
        store, projectStore, tools, allowed: () => true, mutation });
    await reviewer.review(event, ctx); await reviewer.review(event, ctx);
    assert.equal(calls.length, 0);
    await reviewer.review(event, ctx);
    assert.deepEqual(writes, [{ target: 'memory', content: 'Use the synthetic verification checklist.' }]);
    assert.equal(calls[0].options.maxTokens, 220);
    assert.equal(calls[0].options.toolChoice, 'none');
    assert.equal(calls[0].request.messages.length, 1);
    assert.deepEqual(records.map(item => item.data.status), ['completed']);
    assert.deepEqual(records[0].data.usage, { input: 14, output: 12, reportedCostUsd: 0.00003 });
    assert.deepEqual([records[0].data.provider, records[0].data.modelId], ['synthetic', 'cheap']);
    await reviewer.review(event, ctx); await reviewer.review(event, ctx); await reviewer.review(event, ctx);
    assert.equal(calls.length, 1, 'minimum interval prevents repeated paid calls');
});

test('unsupported and failed proposals do not claim a completed review', async t => {
    const prior = process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL;
    t.after(() => { if (prior === undefined) delete process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL;
        else process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL = prior; });
    delete process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL;
    assert.equal(reviewModelConfig('{"provider":"synthetic"}'), null);
    const records = [];
    const reviewer = createReviewer({ appendEntry: (_type, data) => records.push(data) }, {
        context: { profileId: 'synthetic', memory: { enabled: true, autoLearn: true } },
        store: {}, projectStore: {}, tools: new Map(), allowed: () => true,
        mutation: { inspect: async work => work(0), run: async (_signal, work) => work() },
    });
    for (let i = 0; i < 3; i++) await reviewer.review(event, {});
    assert.deepEqual(records.map(r => r.status), ['unsupported']);
    assert.equal(records[0].reason, 'model-not-configured');
    await reviewer.review({ ...event, outcome: 'aborted' }, {});
    assert.equal(records.length, 1);
});
