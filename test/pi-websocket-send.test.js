'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { createWebSocketSender } = require('../server/pi-websocket-send');

class Socket extends EventEmitter {
    constructor(t) {
        super(); this.readyState = WebSocket.OPEN; this.bufferedAmount = 0;
        this.frames = []; this.pending = []; this.closes = []; this.terminated = 0;
        t.after(() => { if (this.readyState !== WebSocket.CLOSED) this.finishClose(); });
    }
    send(wire, callback) {
        this.frames.push(wire);
        const bytes = Buffer.byteLength(wire);
        this.bufferedAmount += bytes;
        this.pending.push({ bytes, callback });
    }
    flushOne(error) {
        const item = this.pending.shift();
        this.bufferedAmount -= item.bytes;
        item.callback?.(error);
    }
    close(code, reason) { this.closes.push({ code, reason }); this.readyState = WebSocket.CLOSING; }
    finishClose() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
    terminate() { this.terminated++; this.finishClose(); }
}

test('ordinary events have a byte bound and a stalled peer cannot affect another peer', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 512 });
    const slow = new Socket(t), fast = new Socket(t);
    let accepted = 0;
    for (let sequence = 0; sequence < 30; sequence++) {
        const event = { type: 'message_update', webSequence: sequence, delta: 'x'.repeat(80) };
        if (send(slow, event)) accepted++;
        assert.equal(send(fast, event), true); fast.flushOne();
    }
    assert.ok(accepted > 0 && accepted < 30);
    assert.ok(slow.bufferedAmount <= 512, 'queued frames stay within the regular byte allowance');
    assert.deepEqual(slow.frames.map(JSON.parse).map(event => event.webSequence), Array.from({ length: accepted }, (_, index) => index));
    assert.equal(slow.closes.length, 1); assert.equal(slow.closes[0].code, 1013);
    assert.deepEqual(fast.frames.map(JSON.parse).map(event => event.webSequence), Array.from({ length: 30 }, (_, index) => index));
    assert.deepEqual(fast.closes, []);
    let serialized = 0;
    assert.equal(send(slow, { toJSON() { serialized++; return {}; } }), false);
    assert.equal(serialized, 0, 'closed output does not continue serializing events');
});

test('accounting uses UTF-8 bytes and rejects existing excess before serialization', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 100 });
    const socket = new Socket(t); socket.bufferedAmount = 50;
    assert.equal(send(socket, { type: 'x', text: '界'.repeat(10) }), false);
    assert.equal(socket.frames.length, 0); assert.equal(socket.closes[0].code, 1013);
    const alreadyFull = new Socket(t); alreadyFull.bufferedAmount = 101;
    let calls = 0;
    assert.equal(send(alreadyFull, { type: 'x', toJSON() { calls++; return {}; } }), false);
    assert.equal(calls, 0);
});

test('one large snapshot is preserved, trailing output stays bounded and its credit expires on delivery', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 512 });
    const socket = new Socket(t);
    const snapshot = { type: 'response', command: 'open_session', data: 'history'.repeat(600) };
    assert.equal(send(socket, snapshot), true);
    assert.deepEqual(JSON.parse(socket.frames[0]), snapshot);
    assert.equal(send(socket, { type: 'message_update', delta: 'a'.repeat(200) }), true);
    socket.flushOne();
    assert.equal(send(socket, { type: 'message_update', delta: 'b'.repeat(400) }), false,
        'the completed snapshot cannot enlarge the budget of later deltas');
    assert.equal(socket.closes[0].code, 1013);

    const bounded = new Socket(t); assert.equal(send(bounded, snapshot), true);
    let count = 0;
    for (; count < 10; count++) {
        if (!send(bounded, { type: 'message_update', delta: 'c'.repeat(120) })) break;
    }
    assert.ok(count > 0 && count < 10);
    assert.ok(bounded.bufferedAmount <= Buffer.byteLength(JSON.stringify(snapshot)) + 512);
    assert.equal(bounded.closes.length, 1);
});

test('an oversized frame cannot accumulate behind another oversized pending frame', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 512 });
    const socket = new Socket(t), event = { type: 'message_end', data: 'x'.repeat(2048) };
    assert.equal(send(socket, event), true);
    assert.equal(send(socket, event), false);
    assert.equal(socket.frames.length, 1); assert.equal(socket.closes[0].code, 1013);
});

test('late callbacks for already drained writes do not clear a newer snapshot allowance', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 512 });
    const socket = new Socket(t), snapshot = { type: 'response', data: 'x'.repeat(2048) };
    assert.equal(send(socket, snapshot), true);
    const first = socket.pending.shift(); socket.bufferedAmount = 0;
    assert.equal(send(socket, snapshot), true);
    first.callback();
    assert.equal(send(socket, { type: 'agent_update', text: 'tail' }), true);
    assert.equal(socket.closes.length, 0);
});

test('Shell retains its smaller backlog budget and authentication is checked before data encoding', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 1024, maxShellBufferedBytes: 128 });
    const shell = new Socket(t); shell.bufferedAmount = 129;
    assert.equal(send(shell, { type: 'gateway_shell', delta: 'x' }), false);
    assert.equal(shell.closes[0].code, 1013); assert.match(shell.closes[0].reason, /Shell/);
    const ordinary = new Socket(t); ordinary.bufferedAmount = 129;
    assert.equal(send(ordinary, { type: 'message_update', delta: 'x' }), true);
    const revoked = new Socket(t); revoked.workspaceIdentity = 'synthetic';
    revoked.workspaceAccess = { validIdentity(identity) { assert.equal(identity, 'synthetic'); return false; } };
    let encoded = 0;
    assert.equal(send(revoked, { toJSON() { encoded++; return {}; } }), false);
    assert.equal(encoded, 0); assert.equal(revoked.closes[0].code, 4401);
});

test('terminal application close codes survive overflow while revocation retains priority', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 100 });
    for (const [code, reason] of [[4004, 'Session deleted'], [4005, 'Session moved'], [1012, 'Session classification changed'], [1000, 'Side chat ended']]) {
        const socket = new Socket(t); socket.bufferedAmount = 101;
        assert.equal(send(socket, { type: 'terminal-event' }, { code, reason }), false);
        assert.deepEqual(socket.closes, [{ code, reason }]);
    }
    const revoked = new Socket(t); revoked.bufferedAmount = 101;
    revoked.workspaceAccess = { validIdentity: () => false };
    send(revoked, { type: 'terminal-event' }, { code: 4004, reason: 'Session deleted' });
    assert.equal(revoked.closes[0].code, 4401);
    const current = new Socket(t);
    assert.equal(send(current, { type: 'terminal-event' }, { code: 4004, reason: 'Session deleted' }), true);
    assert.equal(current.closes.length, 0, 'successful notification leaves normal close to the application');
});

test('backpressure close is bounded, idempotent and its timer clears on a normal close', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const send = createWebSocketSender({ maxBufferedBytes: 100, closeGraceMs: 10 });
    const stalled = new Socket(t); stalled.bufferedAmount = 101;
    send(stalled, { type: 'event' }); send(stalled, { type: 'event' });
    assert.equal(stalled.closes.length, 1);
    t.mock.timers.tick(9); assert.equal(stalled.terminated, 0);
    t.mock.timers.tick(1); assert.equal(stalled.terminated, 1);
    t.mock.timers.tick(100); assert.equal(stalled.terminated, 1);
    const acknowledged = new Socket(t); acknowledged.bufferedAmount = 101;
    send(acknowledged, { type: 'event' }); acknowledged.finishClose();
    t.mock.timers.tick(100); assert.equal(acknowledged.terminated, 0);
});

test('delivery errors close only that transport; serialization errors retain caller error handling', t => {
    const send = createWebSocketSender({ maxBufferedBytes: 100 });
    const broken = new Socket(t); broken.send = () => { throw new Error('synthetic write failure'); };
    assert.equal(send(broken, { type: 'event' }), false);
    assert.equal(broken.closes[0].code, 1011);
    const asynchronous = new Socket(t);
    assert.equal(send(asynchronous, { type: 'response', data: 'x'.repeat(200) }), true);
    asynchronous.flushOne(new Error('synthetic callback failure'));
    assert.equal(asynchronous.closes[0].code, 1011);
    const valid = new Socket(t), cyclic = { type: 'event' }; cyclic.self = cyclic;
    assert.throws(() => send(valid, cyclic), /circular/i);
    assert.equal(valid.readyState, WebSocket.OPEN); assert.equal(valid.frames.length, 0);
    assert.equal(send(valid, { type: 'event', ok: true }), true);
});
