'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { WebSocket } = require('ws');
const express = require('express');

// This file runs in its own standard-runner child. Keep only the two reviewed
// bundle locations; do not let a native fixture inherit a live gateway identity.
const bundleKeys = new Set(['PIVANE_TEST_HERMES_BUNDLE', 'PIVANE_TEST_PI_JITI']);
for (const key of Object.keys(process.env)) {
    if (/^(PI_|PIVANE_)/.test(key) && !bundleKeys.has(key)) delete process.env[key];
}
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-ws-backpressure-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const directory of [agent, cwd]) fs.mkdirSync(directory, { mode: 0o700 });
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_TELEMETRY: '0',
    PI_WEB_TOKEN: 'synthetic-pressure-token', PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') });
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic',
    models: [{ id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }]
} } }));
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
    compaction: { enabled: false }, defaultProjectTrust: 'never', enableInstallTelemetry: false }));
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { MAX_BUFFERED_BYTES } = require('../server/pi-websocket-send');
const digest = text => createHash('sha256').update(text).digest('hex');
function packet(socket, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Synthetic WebSocket response timed out')), 20000);
        const onMessage = raw => {
            const value = JSON.parse(raw);
            if (predicate(value)) finish(null, value);
        };
        const onClose = () => finish(new Error('Synthetic WebSocket closed before response'));
        function finish(error, value) {
            clearTimeout(timer); socket.off('message', onMessage); socket.off('error', finish); socket.off('close', onClose);
            if (error) reject(error); else resolve(value);
        }
        socket.on('message', onMessage); socket.once('error', finish); socket.once('close', onClose);
    });
}
function request(socket, id, type, input = {}) {
    const result = packet(socket, value => value.type === 'response' && value.id === id);
    socket.send(JSON.stringify({ id, type, ...input }));
    return result;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('a pressured persistent peer disconnects without replaying an accepted operation or stopping its shared worker', { timeout: 30000 }, async t => {
    const gateway = createPiAgentGateway();
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.PI_WORKSPACE_BASE_URL = base;
    const wss = gateway.attachWebSocket(server), clients = [];
    let worker, originalWrite, originalRequest, held, released = false;
    t.after(async () => {
        if (held && !released && originalWrite) { released = true; originalWrite.call(worker.client.child.stdin, held.wire, ...held.args); }
        if (worker && originalWrite && worker.client.child) worker.client.child.stdin.write = originalWrite;
        if (worker && originalRequest) worker.request = originalRequest;
        for (const client of clients) client.terminate();
        for (const socket of wss.clients) socket.terminate();
        await gateway.dispose();
        await new Promise(resolve => wss.close(resolve));
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const history = 'synthetic large history '.repeat(400000);
    assert.ok(Buffer.byteLength(history) > MAX_BUFFERED_BYTES, 'fixture exceeds the ordinary queue limit');
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const session = await gateway.store.createSession(cwd, 'Pressure fixture', { agentProfileId: null,
        initializeSession(manager) {
            manager.appendMessage({ role: 'user', content: 'Synthetic question', timestamp: 1 });
            manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: history }], timestamp: 2,
                stopReason: 'stop', api: 'openai-completions', provider: 'fixture', model: 'fixture', usage });
        } });
    async function connect(id) {
        const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/pi/ws'); clients.push(socket);
        await once(socket, 'open');
        const opened = await request(socket, id, 'open_session', { token: 'synthetic-pressure-token', cwd, sessionId: session.id });
        assert.equal(opened.success, true, opened.error);
        const answer = opened.data.messages.messages.find(message => message.role === 'assistant');
        assert.equal(digest(answer.content.find(block => block.type === 'text').text), digest(history), 'large snapshot arrives intact');
        return { socket, opened };
    }
    const first = await connect('first'), second = await connect('second');
    worker = gateway.supervisor.getActiveWorker(session.path);
    assert.ok(worker); assert.equal(gateway.supervisor.workers.size, 1);
    await request(first.socket, 'ready', 'get_state');

    const accepted = deferred(), completed = deferred(); let renameRequests = 0;
    originalWrite = worker.client.child.stdin.write;
    worker.client.child.stdin.write = function (wire, ...args) {
        const record = JSON.parse(String(wire));
        if (record.type === 'set_session_name') {
            renameRequests++; held = { id: record.id, wire, args }; accepted.resolve(); return true;
        }
        return originalWrite.call(this, wire, ...args);
    };
    originalRequest = worker.request;
    worker.request = function (type, ...args) {
        const operation = originalRequest.call(this, type, ...args);
        if (type === 'set_session_name') operation.then(completed.resolve, completed.reject);
        return operation;
    };
    first.socket.send(JSON.stringify({ id: 'rename', type: 'set_session_name', name: 'Recovered pressure title' }));
    await accepted.promise;
    assert.equal(worker.client.pending.has(held.id), true);

    const slow = [...wss.clients].find(socket => socket._socket.remotePort === first.socket._socket.localPort);
    assert.ok(slow);
    const serverClosed = once(slow, 'close'), clientClosed = once(first.socket, 'close');
    const fastEvent = packet(second.socket, value => value.pressureFixture === true);
    // A deterministic stalled-transport seam on an actual gateway WebSocket.
    // The close, peer isolation, native RPC and reconnect paths remain real.
    Object.defineProperty(slow, 'bufferedAmount', { configurable: true, get: () => MAX_BUFFERED_BYTES + 1 });
    worker._broadcast({ type: 'gateway_controls', controls: worker.controls.snapshot(), pressureFixture: true });
    const [close] = await Promise.all([clientClosed, serverClosed, fastEvent]);
    assert.equal(close[0], 1013);
    assert.equal(second.socket.readyState, WebSocket.OPEN);
    assert.equal(gateway.supervisor.getActiveWorker(session.path), worker);
    assert.equal(worker.disposed, false);
    assert.equal(worker.client.pending.has(held.id), true, 'losing a subscriber does not cancel accepted RPC work');

    released = true; originalWrite.call(worker.client.child.stdin, held.wire, ...held.args);
    await completed.promise;
    assert.equal(renameRequests, 1, 'accepted mutation was never automatically replayed');
    const third = await connect('reconnected');
    assert.equal(third.opened.data.session.name, 'Recovered pressure title');
    assert.equal(gateway.supervisor.getActiveWorker(session.path), worker);
    assert.equal(gateway.supervisor.workers.size, 1);
    assert.equal(renameRequests, 1);
    assert.equal((await request(second.socket, 'still-here', 'get_state')).success, true);
});
