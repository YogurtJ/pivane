const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-controls-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_OFFLINE = '1';
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { PiRuntimeControls } = require('../server/pi-runtime-controls');

async function connect(url, session) {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    const pending = new Map(), events = [];
    let id = 0;
    socket.on('message', raw => {
        const event = JSON.parse(raw);
        if (event.type === 'response' && pending.has(event.id)) {
            const item = pending.get(event.id); pending.delete(event.id); clearTimeout(item.timer);
            if (event.success) item.resolve(event.data); else item.reject(new Error(event.error));
        } else events.push(event);
    });
    const call = (type, payload = {}) => new Promise((resolve, reject) => {
        const key = String(++id);
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(`timeout ${type}`)); }, 20000);
        pending.set(key, { resolve, reject, timer });
        socket.send(JSON.stringify({ type, id: key, ...payload }));
    });
    const snapshot = await call('open_session', { cwd: root, sessionId: session.id });
    return { socket, call, events, snapshot };
}
async function waitFor(predicate) {
    for (let n = 0; n < 300; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('condition timeout');
}

test('native controls: bounded extension display state and explicit clearing', () => {
    const state = new PiRuntimeControls();
    state.handle({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'test', statusText: '\x1b[32mReady\x1b[0m' });
    assert.deepEqual(state.snapshot().extension.statuses, [['test', 'Ready']]);
    state.handle({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'w', widgetLines: ['x'.repeat(40000)], widgetPlacement: 'belowEditor' });
    assert.ok(state.snapshot().extension.widgets[0][1].lines.length <= 32000);
    state.handle({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'test' });
    state.handle({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'w' });
    assert.deepEqual(state.snapshot().extension.statuses, []);
    assert.deepEqual(state.snapshot().extension.widgets, []);
});

test('native gateway: actual queue recovery, stop, patch, two clients, reconnect and cancelled compaction', { timeout: 90000 }, async t => {
    const held = new Set(); let hold = false, requests = 0;
    const provider = http.createServer(async (req, res) => {
        for await (const _ of req) {} requests++;
        if (hold) { held.add(res); res.on('close', () => held.delete(res)); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of [
            { choices: [{ index: 0, delta: { role: 'assistant', content: 'Native fixture reply.' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 10, total_tokens: 410 } }
        ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
        models: [{ id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 8192, maxTokens: 1024, reasoning: false }]
    } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
        compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'status.ts'), `export default function(pi) {
        pi.on('session_start', (_,ctx) => { ctx.ui.setStatus('mode', 'Fixture mode'); ctx.ui.setWidget('progress', ['One', 'Two']); ctx.ui.setTitle('Fixture title'); });
        pi.registerCommand('clear-status', { handler: (_,ctx) => { ctx.ui.setStatus('mode', undefined); ctx.ui.setWidget('progress', undefined); ctx.ui.setTitle(''); } });
    }`);
    const gateway = createPiAgentGateway({ deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); gateway.attachWebSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const sockets = [];
    t.after(async () => { sockets.forEach(socket => socket.terminate()); for (const response of held) response.destroy();
        await gateway.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); fs.rmSync(root, { recursive: true, force: true }); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const status = await (await fetch(`${origin}/api/pi/status`)).json(); assert.equal(status.runtimeControls, true); assert.equal(status.extensionStatus, true);
    const session = await gateway.store.createSession(root, 'Native controls');
    const url = origin.replace('http:', 'ws:') + '/api/pi/ws';
    const a = await connect(url, session); sockets.push(a.socket);
    const b = await connect(url, session); sockets.push(b.socket);
    assert.equal(a.snapshot.controls.extension.title, 'Fixture title');
    assert.deepEqual(b.snapshot.controls.extension.statuses, [['mode', 'Fixture mode']]);
    assert.equal(gateway.supervisor.workers.size, 1);
    await a.call('prompt', { message: 'Retain original requirement. '.repeat(150) });
    await waitFor(() => a.events.some(event => event.type === 'agent_settled'));
    await a.call('prompt', { message: 'Second requirement. '.repeat(150) });
    await waitFor(() => a.events.filter(event => event.type === 'agent_settled').length === 2);
    hold = true;
    await a.call('prompt', { message: 'Hold operation.' });
    await waitFor(() => held.size > 0);
    await a.call('steer', { message: 'First queued instruction' });
    await b.call('follow_up', { message: 'Second queued instruction' });
    const beforeStopRequests = requests;
    const results = await Promise.allSettled([a.call('stop_and_recover'), b.call('stop_and_recover')]);
    assert.ok(results.some(result => result.status === 'fulfilled'));
    const current = (await a.call('get_state')).webControls;
    assert.equal(current.stopping, false); assert.deepEqual(current.queue, { steering: [], followUp: [] });
    assert.equal(current.recoveries.length, 1); assert.equal(current.recoveries[0].status, 'recovered');
    assert.deepEqual(current.recoveries[0].steering, ['First queued instruction']);
    assert.deepEqual(current.recoveries[0].followUp, ['Second queued instruction']);
    assert.equal(requests, beforeStopRequests, 'queued instructions must not trigger another provider call');
    const entries = (await a.call('get_entries')).entries;
    const stoppedReply = entries.filter(entry => entry.message?.role === 'assistant').at(-1).message;
    assert.equal(stoppedReply.stopReason, 'aborted', 'native cancellation is a stopped reply, not a failed stop command');
    assert.match(stoppedReply.errorMessage, /abort/i);
    assert.equal((await a.call('get_state')).isStreaming, false);
    assert.ok(!entries.some(entry => /queued instruction/.test(entry.message?.content)));
    assert.ok(b.events.some(event => event.type === 'gateway_controls' && event.controls.recoveries.some(item => item.status === 'recovered')));
    a.socket.close();
    const c = await connect(url, session); sockets.push(c.socket);
    assert.deepEqual(c.snapshot.controls.recoveries, current.recoveries);
    await c.call('ack_recovery', { recoveryId: current.recoveries[0].id });
    await assert.rejects(b.call('ack_recovery', { recoveryId: current.recoveries[0].id }), /不存在/);
    assert.deepEqual((await b.call('get_state')).webControls.recoveries, []);
    await c.call('prompt', { message: '/clear-status' });
    assert.deepEqual((await b.call('get_state')).webControls.extension, { title: '', statuses: [], widgets: [] });
    await assert.rejects(b.call('clear_queue'), /Unsupported/);
    // Native edit returns an authoritative standard patch, including preserved Unicode.
    const sdk = await import('@earendil-works/pi-coding-agent');
    fs.writeFileSync(path.join(root, 'code.txt'), 'old 中文\nkeep\n');
    const edit = sdk.createEditTool(root);
    const result = await edit.execute('edit', { path: 'code.txt', edits: [{ oldText: 'old 中文', newText: 'new 中文' }] });
    assert.match(result.details.patch, /-old 中文\n\+new 中文/);
    // Cancellation uses the same guarded command while compactPending is reserved.
    const compact = c.call('compact'); const cancelled = assert.rejects(compact, /abort|cancel/i);
    await waitFor(() => b.events.some(event => event.type === 'compaction_start'));
    await c.call('stop_and_recover'); await cancelled;
    const after = await c.call('get_state'); assert.equal(after.isCompacting, false); assert.equal(after.webCompaction.status, 'cancelled');
    assert.equal(after.webControls.stopping, false);
    // A timeout retains exclusion until native state confirms idle; it never retries a mutation.
    const worker = gateway.supervisor.getActiveWorker(session.path);
    const originalRequest = worker.client.request.bind(worker.client); let clearCalls = 0, releaseOldState;
    worker.client.request = async (type, ...args) => {
        if (type === 'get_state') return new Promise(resolve => { releaseOldState = resolve; });
        if (type === 'clear_queue') { clearCalls++; throw Object.assign(new Error('test timeout'), { code: 'RPC_TIMEOUT' }); }
        return originalRequest(type, ...args);
    };
    const oldStateRequest = worker.request('get_state');
    await waitFor(() => releaseOldState);
    await assert.rejects(worker.recoverQueue(true), /timeout/);
    await assert.rejects(worker.request('prompt', { message: 'must block' }), /停止/);
    assert.equal(worker.canEvict(Date.now() + 100000, 1), false);
    assert.equal(worker.controls.recoveries.at(-1).status, 'uncertain');
    releaseOldState({ sessionId: session.id, sessionFile: session.path, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    await oldStateRequest;
    assert.equal(worker.controlPending, true, 'an idle snapshot requested before stopping cannot unlock an uncertain operation');
    worker.client.request = originalRequest;
    await worker.request('get_state'); assert.equal(worker.controlPending, false); assert.equal(clearCalls, 1);
});
