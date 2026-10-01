const test = require('node:test');
const assert = require('node:assert/strict');
const { SideConnection, PiSideChatService, SIDE_IDLE_MS } = require('../server/pi-side-chat');

function fixture() {
    const events = [], messages = [{ role: 'assistant', content: 'visible side only', timestamp: 1 }];
    const side = Object.create(SideConnection.prototype);
    Object.assign(side, { service: { idleMs: 100, connections: new Set() }, parent: {}, initialized: true, closed: false,
        ready: Promise.resolve(), usageFlush: Promise.resolve(), toolMode: 'none', reference: {}, send: event => events.push(event), socket: { close() {} },
        worker: { busy: false, getPendingUi: () => [], request: async type => type === 'get_messages' ? { messages } : {},
            exclusive: async fn => { if (side.worker.busy) throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }); return fn(null, { model: { id: 'fixture' } }); },
            dispose: async () => { side.disposed = true; } } });
    side.service.connections.add(side); side.parent.connection = side;
    return { side, events, messages };
}

test('side expiry is 12 hours, reserves native idle, snapshots visible history and releases runtime slots', async () => {
    assert.equal(SIDE_IDLE_MS, 43200000);
    const { side, events, messages } = fixture();
    side.worker.busy = true;
    await side.expire();
    assert.equal(events.length, 0); assert.equal(side.closed, false); assert.ok(side.expiryTimer);
    side.cancelExpiry(); side.worker.busy = false; side.idleDeadline = Date.now() - 1;
    await side.expire();
    assert.equal(side.closed, true); assert.equal(side.disposed, true); assert.equal(side.service.connections.size, 0);
    assert.equal(side.parent.connection, null); assert.equal(events[0].type, 'gateway_side_expired');
    assert.deepEqual(events[0].messages, messages);
    await assert.rejects(side.handle({ type: 'prompt', message: 'no replay' }), /结束/);
});

test('idle timer cancellation and rearming require a full new idle interval', async () => {
    const { side, events } = fixture();
    side.service.idleMs = 80;
    side.armExpiry();
    await new Promise(resolve => setTimeout(resolve, 25));
    side.cancelExpiry();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(events.length, 0);
    side.armExpiry();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(events[0]?.type, 'gateway_side_expired');
    assert.equal(side.disposed, true);
});

test('new-segment close rejects active work and returns only final visible history before disposal', async () => {
    const { side, messages } = fixture();
    side.worker.busy = true;
    await assert.rejects(side.handle({ type: 'close_side_segment' }), { code: 'SESSION_BUSY' });
    assert.equal(side.closed, false); assert.equal(side.expiring, false);
    side.worker.busy = false;
    const snapshot = await side.handle({ type: 'close_side_segment' });
    assert.deepEqual(snapshot.messages, messages); assert.equal(side.disposed, true);
});

test('pre-send model choices use native supported levels and available authenticated catalog without launching', async () => {
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai/compat');
    const base = { provider: 'fixture', id: 'base', reasoning: false }, chosen = { provider: 'fixture', id: 'reasoner', reasoning: true };
    const source = { request: async type => type === 'get_available_models' ? { models: [base, chosen] } : { model: base, thinkingLevel: 'off' } };
    const service = new PiSideChatService({});
    const options = await service.modelOptions(source);
    assert.deepEqual(options.models[1].levels, getSupportedThinkingLevels(chosen));
    const selected = await service.selectModel(source, { model: base, thinkingLevel: 'off' }, { model: { provider: 'fixture', id: 'reasoner' }, thinkingLevel: 'high' });
    assert.equal(selected.model, chosen); assert.equal(selected.thinkingLevel, 'high');
    assert.equal(service.connections.size, 0); assert.equal(service.tickets.size, 0);
    await assert.rejects(service.selectModel(source, { model: base }, { model: { provider: 'fixture', id: 'missing' } }), /不可用/);
    await assert.rejects(service.selectModel(source, { model: base }, { thinkingLevel: 'high' }), /不支持/);
});
