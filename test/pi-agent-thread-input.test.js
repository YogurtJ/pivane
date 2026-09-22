const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareTaskArguments, AgentThreadsService } = require('../server/pi-agent-threads');
const filled = { action: 'create', requestId: 'stable-test', title: 'Result return test', message: 'Reply briefly.',
    provider: '', modelId: '', thinkingLevel: '', query: '', resultId: '', offset: 0 };
test('materialized optional tool fields are projected by action before schema validation', () => {
    assert.deepEqual(prepareTaskArguments(filled), { action: 'create', requestId: 'stable-test', title: filled.title, message: filled.message });
    assert.deepEqual(prepareTaskArguments({ ...filled, provider: 'fixture', modelId: 'model', thinkingLevel: 'low', resultId: 'unrelated' }),
        { action: 'create', requestId: 'stable-test', title: filled.title, message: filled.message, provider: 'fixture', modelId: 'model', thinkingLevel: 'low' });
    assert.deepEqual(prepareTaskArguments({ ...filled, action: 'status', title: '', message: '' }), { action: 'status', requestId: 'stable-test' });
    assert.deepEqual(prepareTaskArguments({ ...filled, action: 'models', requestId: '', title: '', message: '', query: 'fixture' }), { action: 'models', query: 'fixture' });
    assert.deepEqual(prepareTaskArguments({ ...filled, action: 'result', title: '', message: '' }), { action: 'result', requestId: 'stable-test', offset: 0 });
    assert.deepEqual(prepareTaskArguments({ ...filled, action: 'result', resultId: 'run-id', offset: 8000 }),
        { action: 'result', requestId: 'stable-test', resultId: 'run-id', offset: 8000 });
});
test('normalization preserves required data, nonblank model overrides, and rejects unknown identity fields', async t => {
    const original = structuredClone(filled);
    prepareTaskArguments(filled); assert.deepEqual(filled, original);
    assert.equal(prepareTaskArguments({ ...filled, provider: null, modelId: null }).provider, undefined);
    assert.equal(prepareTaskArguments({ ...filled, provider: 'fixture', modelId: '' }).provider, 'fixture');
    for (const key of ['requestId', 'title', 'message']) assert.throws(() => prepareTaskArguments({ ...filled, [key]: '' }), /requires/);
    for (const extra of [{ cwd: '/other' }, { sessionId: 'other' }, { token: 'fixture' }]) assert.throws(() => prepareTaskArguments({ ...filled, ...extra }), /Invalid/);
    assert.throws(() => prepareTaskArguments({ ...filled, action: 'constructor' }), /Invalid/);
    const service = new AgentThreadsService({ store: {}, supervisor: {}, settingsService: {} }); t.after(() => service.dispose());
    assert.throws(() => service.create({ sessionId: 'source' }, { requestId: 'id', title: 'Title', message: 'Text', offset: 0 }), /Invalid task request/);
    const { action, ...unpaired } = prepareTaskArguments({ ...filled, provider: 'fixture', modelId: '' });
    assert.throws(() => service.create({ sessionId: 'source' }, unpaired), /together/);
});
