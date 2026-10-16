const test = require('node:test');
const assert = require('node:assert/strict');
const { PiLiveState } = require('../server/pi-live-state');

test('bounded live recovery retains the native parent association even when output is truncated', () => {
    const live = new PiLiveState();
    live.handle({ type: 'tool_execution_start', toolCallId: 'parent', toolName: 'codemode', args: {} });
    live.handle({ type: 'tool_execution_end', parentToolCallId: 'parent', toolCallId: 'nested', toolName: 'read',
        args: { path: 'fixture.txt' }, result: { content: [{ type: 'text', text: 'x'.repeat(100000) }] } });
    const snapshot = live.snapshot();
    assert.equal(snapshot.tools.find(row => row.toolCallId === 'nested').parentToolCallId, 'parent');
    assert.equal(snapshot.truncated, true);
    assert.ok(JSON.stringify(snapshot.tools.find(row => row.toolCallId === 'nested')).length < 65536);
});

test('authoritative parent result releases only that live nested tree, including deeper descendants', () => {
    const live = new PiLiveState();
    for (const [id, parent] of [['a', undefined], ['a1', 'a'], ['a2', 'a1'], ['b', undefined], ['b1', 'b']]) {
        live.handle({ type: 'tool_execution_start', toolCallId: id, parentToolCallId: parent, toolName: 'fixture', args: {} });
    }
    live.handle({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'a', nestedCalls: { calls: [], complete: false } } });
    assert.deepEqual(live.snapshot().tools.map(row => row.toolCallId), ['b', 'b1']);
    live.handle({ type: 'agent_settled' });
    assert.deepEqual(live.snapshot().tools, []);
});

test('reconnect preview retains bounded final argument errors without converting them into executable arguments', () => {
    const live = new PiLiveState();
    live.handle({ type: 'message_start', message: { role: 'assistant', timestamp: 1 } });
    const call = { id: 'invalid', name: 'write', arguments: {}, argumentsError: 'Invalid arguments: ' + 'x'.repeat(20000) };
    live.handle({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call } });
    const snapshot = live.snapshot();
    assert.deepEqual(snapshot.message.content[0].arguments, {});
    assert.equal(snapshot.message.content[0].argumentsError, call.argumentsError.slice(0, 8192));
    assert.equal(snapshot.truncated, true);
    snapshot.message.content[0].argumentsError = 'changed preview';
    assert.equal(live.snapshot().message.content[0].argumentsError.length, 8192);
    assert.equal(call.argumentsError.length, 20019);
});
