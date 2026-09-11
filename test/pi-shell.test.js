const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shell-test-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_WORKSPACE_BASE_URL = 'http://127.0.0.1:1';
process.env.PI_WEB_TOKEN = '';
process.env.PI_OFFLINE = '1';
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { OUTPUT_CHARACTERS } = require('../server/pi-shell-execution');
const wait = async predicate => {
    for (let n = 0; n < 500; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Condition timeout');
};
async function connect(url, session, type = 'open_session') {
    const socket = new WebSocket(url); await once(socket, 'open');
    const events = [], pending = new Map(); let n = 0;
    socket.on('message', raw => {
        const event = JSON.parse(raw);
        if (event.type === 'response' && pending.has(event.id)) {
            const { resolve, reject, timer } = pending.get(event.id); pending.delete(event.id); clearTimeout(timer);
            if (event.success) resolve(event.data); else reject(new Error(event.error));
        } else events.push(event);
    });
    const call = (type, payload = {}) => new Promise((resolve, reject) => {
        const id = String(++n), timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + type)); }, 30000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, type, ...payload }));
    });
    const snapshot = await call(type, { cwd: root, sessionId: session?.id });
    return { socket, events, call, snapshot };
}

test('Web Shell: native execution, single worker, streaming, cancellation, history, exclusion, modes and disconnect', { timeout: 120000 }, async t => {
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'bash.ts'), `export default function(pi) {
        pi.on('user_bash', async event => {
            if(event.command === 'extension-result') return { result: { output: 'Extension handled', exitCode: 0, cancelled: false, truncated: false } };
            if(event.command === 'extension-fail') throw new Error('Extension execution rejected');
        });
    }`);
    const gateway = createPiAgentGateway({ deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); gateway.attachWebSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const sockets = [];
    t.after(async () => { sockets.forEach(s => s.terminate()); await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const origin = `http://127.0.0.1:${server.address().port}`, url = origin.replace('http:', 'ws:') + '/api/pi/ws';
    const status = await (await fetch(origin + '/api/pi/status')).json(); assert.equal(status.userShell, true); assert.equal(status.queueModes, true);
    const session = await gateway.store.createSession(root, 'Shell fixture');
    const a = await connect(url, session), b = await connect(url, session); sockets.push(a.socket, b.socket);
    const worker = gateway.supervisor.getActiveWorker(session.path);
    assert.equal(gateway.supervisor.workers.size, 1);
    await assert.rejects(a.call('bash', { command: 'pwd', cwd: '/' }), /command/);
    await assert.rejects(a.call('bash', { command: '', excludeFromContext: true }), /非空/);
    await assert.rejects(a.call('bash', { command: 'pwd', excludeFromContext: 'yes' }), /command/);
    const command = "printf '中文\\342\\200\\250LF\\n'; sleep 2; printf 'END\\n'";
    const starts = await Promise.allSettled([a.call('bash', { command }), b.call('bash', { command })]);
    assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1);
    const accepted = starts.find(r => r.status === 'fulfilled').value;
    assert.equal(accepted.busy, true);
    await wait(() => b.events.some(e => e.type === 'gateway_shell' && e.shell.job?.output.includes('中文')));
    assert.equal(gateway.supervisor.getActivity()[0].busy, true);
    assert.equal(worker.canEvict(Date.now() + 100000, 1), false);
    for (const type of ['prompt', 'steer', 'follow_up', 'compact', 'set_model', 'abort', 'stop_and_recover', 'reload_resources']) {
        await assert.rejects(b.call(type, { message: 'must not execute' }));
    }
    await assert.rejects(worker.exclusive(async () => {}), /空闲/);
    await assert.rejects(b.call('abort_bash', { executionId: 'stale' }), /变化/);
    a.socket.close();
    const c = await connect(url, session); sockets.push(c.socket);
    assert.equal(c.snapshot.state.webShell.job.id, accepted.job.id);
    await wait(async () => !(await c.call('get_state')).webShell.busy);
    const messages = (await c.call('get_messages')).messages;
    const first = messages.find(m => m.role === 'bashExecution');
    assert.equal(first.command, command); assert.match(first.output, /中文\u2028LF/); assert.match(first.output, /END/);
    assert.equal(first.excludeFromContext, false);
    assert.equal(messages.filter(m => m.role === 'bashExecution').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(session.path, 'utf8').trim().split('\n').at(-1)).message.role, 'bashExecution', 'blank Web session persists native bash without an assistant');
    assert.ok(!b.events.some(e => e.type === 'bash_execution_update'), 'raw chunks are not double-broadcast');
    assert.ok(b.events.every(e => e.type !== 'gateway_shell' || e.shell.job.output.length <= OUTPUT_CHARACTERS));
    const second = await c.call('bash', { command: "printf 'PRIVATE'; sleep 10", excludeFromContext: true });
    await wait(() => c.events.some(e => e.type === 'gateway_shell' && e.shell.job?.id === second.job.id && e.shell.job.output.includes('PRIVATE')));
    await c.call('abort_bash', { executionId: second.job.id });
    await wait(async () => !(await c.call('get_state')).webShell.busy);
    const cancelled = (await c.call('get_messages')).messages.at(-1);
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.excludeFromContext, true);
    const sdk = await import('@earendil-works/pi-coding-agent');
    const converted = sdk.convertToLlm((await c.call('get_messages')).messages);
    assert.ok(JSON.stringify(converted).includes('END')); assert.ok(!JSON.stringify(converted).includes('PRIVATE'));
    await c.call('bash', { command: 'extension-result' });
    await wait(async () => !(await c.call('get_state')).webShell.busy);
    assert.equal((await c.call('get_messages')).messages.at(-1).output, 'Extension handled');
    const large = await c.call('bash', { command: "node -e 'process.stdout.write(\"x\".repeat(200000))'" });
    await wait(async () => !(await c.call('get_state')).webShell.busy);
    const largeResult = (await c.call('get_messages')).messages.at(-1);
    assert.equal(largeResult.truncated, true); assert.ok(largeResult.fullOutputPath);
    fs.rmSync(largeResult.fullOutputPath, { force: true });
    assert.ok(c.events.filter(e => e.type === 'gateway_shell' && e.shell.job?.id === large.job.id).every(e => e.shell.job.output.length <= OUTPUT_CHARACTERS));
    // Queue changes use native setters, persist global defaults and reject stale browser state.
    const modes = (await c.call('get_state')).webQueueModes;
    const updated = await c.call('set_steering_mode', { mode: 'all', runtimeId: modes.runtimeId, revision: modes.revision });
    assert.equal(updated.steeringMode, 'all');
    await assert.rejects(b.call('set_follow_up_mode', { mode: 'all', runtimeId: modes.runtimeId, revision: modes.revision }), /变化/);
    await assert.rejects(c.call('set_follow_up_mode', { mode: 'invalid', runtimeId: updated.runtimeId, revision: updated.revision }), /逐条/);
    await c.call('set_follow_up_mode', { mode: 'all', runtimeId: updated.runtimeId, revision: updated.revision });
    await wait(() => JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8')).followUpMode === 'all');
    assert.ok(b.events.some(e => e.type === 'gateway_queue_modes' && e.modes.steeringMode === 'all'));
    // Reopen the same native file with no parallel writer.
    await c.call('quit_session');
    const d = await connect(url, session); sockets.push(d.socket);
    assert.equal(d.snapshot.messages.messages.filter(m => m.role === 'bashExecution').length, 4);
    assert.equal(d.snapshot.state.steeringMode, 'all');
    // Ephemeral disconnect aborts foreground subprocesses before destroying the worker.
    const ephemeral = await connect(url, null, 'open_ephemeral'); sockets.push(ephemeral.socket);
    const sentinel = path.join(root, 'must-not-exist');
    await ephemeral.call('bash', { command: `printf READY; sleep 3; touch '${sentinel}'` });
    await wait(() => ephemeral.events.some(e => e.type === 'gateway_shell' && e.shell.job?.output.includes('READY')));
    ephemeral.socket.terminate();
    await wait(() => gateway.supervisor.ephemeralWorkers.size === 0);
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(fs.existsSync(sentinel), false);
});
