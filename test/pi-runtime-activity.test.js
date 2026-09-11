const assert = require('node:assert/strict');
const test = require('node:test');
const { PiRuntimeActivity } = require('../server/pi-runtime-activity');

test('activity follows settled, parallel tools and retry, not low-level agent_end', () => {
    const activity = new PiRuntimeActivity();
    const emit = (type, data = {}) => activity.handle({ type, ...data });
    assert.deepEqual(activity.snapshot(), { phase: 'idle', busy: false });
    emit('agent_start');
    emit('tool_execution_start', { toolCallId: 'a', args: { secret: 'not exposed' } });
    emit('tool_execution_start', { toolCallId: 'b' });
    emit('tool_execution_end', { toolCallId: 'a', isError: true });
    assert.equal(activity.snapshot().phase, 'tool');
    emit('tool_execution_end', { toolCallId: 'b' });
    emit('message_end', { message: { role: 'assistant', stopReason: 'error' } });
    emit('agent_end');
    assert.equal(activity.snapshot().busy, true);
    emit('auto_retry_start');
    assert.equal(activity.snapshot().phase, 'retrying');
    emit('auto_retry_end', { success: true });
    emit('agent_settled');
    assert.deepEqual(activity.snapshot(), { phase: 'idle', busy: false });
});

test('manual compaction stays busy without an agent run; final errors and aborts remain visible', () => {
    const activity = new PiRuntimeActivity();
    activity.handle({ type: 'compaction_start' });
    assert.deepEqual(activity.snapshot(), { phase: 'compacting', busy: true });
    activity.handle({ type: 'summarization_retry_scheduled' });
    assert.equal(activity.snapshot().phase, 'retrying');
    activity.handle({ type: 'summarization_retry_finished' });
    activity.handle({ type: 'compaction_end', errorMessage: 'private error' });
    assert.deepEqual(activity.snapshot(), { phase: 'error', busy: false });
    activity.handle({ type: 'agent_start' });
    activity.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } });
    activity.handle({ type: 'agent_settled' });
    assert.deepEqual(activity.snapshot(), { phase: 'stopped', busy: false });
    activity.handle({ type: 'agent_start' });
    activity.handle({ type: 'auto_retry_end', success: false });
    activity.handle({ type: 'agent_settled' });
    assert.deepEqual(activity.snapshot(), { phase: 'error', busy: false });
});

test('completion requires a final visible assistant reply and only emits once per settled run', () => {
    const activity = new PiRuntimeActivity();
    activity.handle({ type: 'agent_start' });
    activity.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } });
    assert.equal(activity.handle({ type: 'agent_settled' }), true);
    assert.equal(activity.handle({ type: 'agent_settled' }), false);
    activity.handle({ type: 'agent_start' });
    activity.handle({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content: 'Partial' } });
    assert.equal(activity.handle({ type: 'agent_settled' }), false);
    activity.handle({ type: 'agent_start' });
    activity.handle({ type: 'message_end', message: { role: 'toolResult', content: 'Not a reply' } });
    assert.equal(activity.handle({ type: 'agent_settled' }), false);
    activity.waitingCount = 1;
    assert.deepEqual(activity.snapshot(), { phase: 'waiting', busy: true });
});
