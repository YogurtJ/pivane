const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
    const { registerRequestStats } = await import('../server/pi-request-stats-extension.mjs');
    const handlers = new Map(); let time = 0, reads = 0;
    registerRequestStats({ on(name, handler) { handlers.set(name, handler); } }, { now: () => { reads++; return time; } });
    const emit = (name, event = {}) => handlers.get(name)?.(event);
    const end = (output = 100, stopReason = 'stop', extra = {}) => emit('message_end', { message: {
        role: 'assistant', content: [], stopReason, usage: { output, reasoning: 40, totalTokens: output + 10 }, ...extra
    } })?.message;
    return { emit, end, handlers, advance: ms => { time += ms; }, reads: () => reads };
}

test('boundary-only request sums exclude slow tools, retain reasoning once and survive overflow compaction', async () => {
    const f = await fixture();
    f.emit('agent_start'); f.emit('message_start', { message: { role: 'user' } });
    f.emit('before_provider_request'); f.advance(1000);
    const first = f.end(100, 'toolUse');
    assert.equal(first.pivaneRequestStats.outputTokens, 100, 'reasoning is already part of output');
    f.advance(60000); f.emit('message_end', { message: { role: 'toolResult', usage: { output: 900 } } });
    f.emit('before_provider_request'); f.advance(2000); f.end(0, 'error');
    f.emit('agent_end'); f.emit('session_before_compact');
    f.emit('before_provider_request'); f.advance(120000);
    assert.equal(f.end(999), undefined, 'summary output must not enter the meter');
    f.emit('session_compact'); f.emit('agent_start');
    f.emit('before_provider_request'); f.advance(3000);
    const final = f.end(300);
    assert.deepEqual(final.pivaneRequestStats, { version: 1, outputTokens: 400, requestMs: 4000, requests: 2, excludedRequests: 1 });
    assert.equal(first.pivaneRequestStats.requests, 1, 'previous snapshots stay immutable');
    assert.equal(f.reads(), 6, 'only two clock reads per actual model message');
    for (const name of ['message_update', 'provider_stream_event', 'after_provider_response', 'tool_execution_update']) assert.equal(f.handlers.has(name), false);
});

test('settlement, steering, reload and navigation never leak previous reply totals', async () => {
    const f = await fixture();
    for (const boundary of ['agent_settled', 'session_start', 'session_switch', 'session_tree', 'session_shutdown']) {
        f.emit('agent_start'); f.emit('before_provider_request'); f.advance(10); f.end(1000);
        f.emit(boundary); f.advance(60000); f.emit('agent_start');
        f.emit('before_provider_request'); f.advance(20);
        assert.equal(f.end(2).pivaneRequestStats.outputTokens, 2);
    }
    f.emit('message_start', { message: { role: 'user' } });
    f.emit('before_provider_request'); f.advance(30);
    assert.deepEqual(f.end(3).pivaneRequestStats, { version: 1, outputTokens: 3, requestMs: 30, requests: 1, excludedRequests: 0 });
});

test('failed or cancelled compaction releases the guard and idle compaction never starts a run', async () => {
    const f = await fixture();
    f.emit('session_before_compact'); f.emit('before_provider_request'); f.advance(200);
    assert.equal(f.end(), undefined);
    f.emit('session_compact_failed'); f.emit('agent_start');
    f.emit('before_provider_request'); f.advance(100); f.end(20);
    f.emit('session_before_compact'); f.advance(9000); f.emit('session_compact_failed');
    f.emit('before_provider_request'); f.advance(200);
    assert.deepEqual(f.end(40).pivaneRequestStats, { version: 1, outputTokens: 60, requestMs: 300, requests: 2, excludedRequests: 0 });
});

test('missing usage, unavailable hooks, invalid clocks and interrupted messages are explicitly excluded', async () => {
    const f = await fixture(); f.emit('agent_start');
    f.end(); // no provider hook
    for (const extra of [{ usage: undefined }, { usage: { output: 0, totalTokens: 0 } }, { usage: { output: -1 } },
        { usage: { output: Infinity } }, { stopReason: 'aborted' }, { stopReason: 'deferred' }]) {
        f.emit('before_provider_request'); f.advance(100); f.end(10, 'stop', extra);
    }
    f.emit('before_provider_request'); f.advance(-1); f.end();
    f.emit('before_provider_request'); f.advance(100);
    assert.deepEqual(f.end(50).pivaneRequestStats, { version: 1, outputTokens: 50, requestMs: 100, requests: 1, excludedRequests: 8 });
});

test('transport retries keep the original request start; metadata size is constant over long runs', async () => {
    const f = await fixture(); f.emit('agent_start');
    f.emit('before_provider_request'); f.advance(1000); f.emit('before_provider_request'); f.advance(2000);
    assert.equal(f.end().pivaneRequestStats.requestMs, 3000);
    let message;
    for (let i = 0; i < 10000; i++) {
        f.emit('before_provider_request'); f.advance(10); message = f.end(1);
    }
    assert.equal(message.pivaneRequestStats.requests, 10001);
    assert.equal(f.reads(), 20002);
    assert.ok(JSON.stringify(message.pivaneRequestStats).length < 150);
});
