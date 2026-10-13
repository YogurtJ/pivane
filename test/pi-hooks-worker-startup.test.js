'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-hook-worker-')));
const agentDir = path.join(root, 'agent');
fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { PiSessionStore } = require('../server/pi-session-store');
const waitFor = async check => {
    const deadline = Date.now() + 15000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Managed startup fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('public SDK startup adapter preserves call identity, return values, exceptions and nested ownership', async () => {
    const { installRunStartupAdapter } = await import('../server/pi-run-startup-adapter.mjs');
    const records = [], originalCalls = [], pending = [];
    const session = {
        prompt: function (...args) { assert.equal(this, session); originalCalls.push(['prompt', ...args]); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
        sendCustomMessage: function (...args) { assert.equal(this, session); originalCalls.push(['custom', ...args]); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    };
    installRunStartupAdapter(session, { token: 'synthetic-runtime', sessionId: 'synthetic-session', emit: record => records.push(record) });
    const options = { preflightResult() {} }, extra = { unchanged: true };
    const prompt = session.prompt('synthetic user', options, extra);
    const message = { customType: 'fixture', content: 'wake' }, wakeOptions = { triggerTurn: true };
    const custom = session.sendCustomMessage(message, wakeOptions);
    assert.equal(records.length, 2, 'both reservations are synchronous');
    assert.deepEqual(originalCalls, [['prompt', 'synthetic user', options, extra], ['custom', message, wakeOptions]]);
    assert.equal(originalCalls[0][2], options); assert.equal(originalCalls[1][1], message);
    pending[1].resolve('custom-return'); assert.equal(await custom, 'custom-return');
    assert.equal(records[2].id, records[1].id);
    assert.equal(records.filter(record => record.id === records[0].id).length, 1, 'inner completion retains the outer prompt');
    const failure = new Error('Synthetic native preparation failure');
    pending[0].reject(failure); await assert.rejects(prompt, error => error === failure);
    assert.equal(records[3].id, records[0].id);
    for (const options of [{ triggerTurn: false }, { triggerTurn: true, deliverAs: 'nextTurn' }]) {
        const before = records.length, note = session.sendCustomMessage(message, options);
        pending.at(-1).resolve('note-return'); assert.equal(await note, 'note-return');
        assert.equal(records.length, before, 'note/nextTurn calls do not reserve a run');
    }
    assert.deepEqual(records.map(record => record.sequence), [1, 2, 3, 4]);
    assert.deepEqual(records.map(record => record.phase), ['started', 'started', 'finished', 'finished']);
    assert.ok(records.every(record => record.sessionId === 'synthetic-session' && record.token === 'synthetic-runtime'));
    assert.equal(originalCalls.length, 4, 'each native method is invoked exactly once');
});

test('managed custom wake remains busy throughout a slow before_agent_start hook and cancellation', { timeout: 45000 }, async t => {
    const holdFile = path.join(root, 'hold-hook');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
        defaultThinkingLevel: 'off', enableInstallTelemetry: false, compaction: { enabled: false } }));
    fs.writeFileSync(path.join(agentDir, 'extensions', 'hook-wake.ts'), `import fs from 'node:fs'; export default function(pi) {
        pi.on('before_agent_start', async (event, ctx) => {
            if (event.messageType !== 'custom') return;
            ctx.ui.notify('HOOK WORKER STARTUP');
            while (fs.existsSync(${JSON.stringify(holdFile)})) await new Promise(resolve => setTimeout(resolve, 10));
            if (fs.existsSync(${JSON.stringify(holdFile + '.hook-error')})) throw new Error('Synthetic hook failure');
            if (fs.existsSync(${JSON.stringify(holdFile + '.prepare-failure')})) event.systemPromptOptions.sections.preamble = 'Invalid section';
        });
        pi.on('agent_settled', () => {
            const file = ${JSON.stringify(holdFile + '.defer')};
            if (!fs.existsSync(file)) return;
            fs.unlinkSync(file);
            pi.sendMessage({ customType: 'fixture-deferred-wake', content: 'Synthetic deferred wake', display: false }, { triggerTurn: true });
        });
        pi.registerCommand('hookwake', { handler: async () => pi.sendMessage({ customType: 'fixture-hook-wake', content: 'Synthetic custom wake', display: false }, { triggerTurn: true }) });
        pi.registerCommand('hooknote', { handler: async () => pi.sendMessage({ customType: 'fixture-note', content: 'Synthetic nextTurn context', display: false }, { triggerTurn: true, deliverAs: 'nextTurn' }) });
    }`);
    let calls = 0;
    const provider = http.createServer(async (req, res) => {
        for await (const _ of req) {} calls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
            delta: { role: 'assistant', content: 'Fixture done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }) + '\n\ndata: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
        api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
    } } }));
    const supervisor = new PiAgentSupervisor();
    t.after(async () => {
        fs.rmSync(holdFile, { force: true });
        await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const session = await new PiSessionStore().createSession(root, 'Hook startup fixture');
    const worker = await supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    const events = [], settlementBusy = [];
    worker.subscribe(event => {
        events.push(event);
        if (event.type === 'agent_settled') settlementBusy.push(!worker.isIdle());
    });
    const starts = () => events.filter(event => event.type === 'extension_ui_request' && event.message === 'HOOK WORKER STARTUP').length;
    const wake = async () => {
        const before = starts();
        await worker.request('prompt', { message: '/hookwake' });
        await waitFor(() => starts() > before);
    };
    const busyBeforeRead = async () => {
        assert.equal(worker.isIdle(), false, 'startup is busy before a state query');
        assert.equal(supervisor.isIdle(), false);
        assert.equal(supervisor.isSessionIdle(session.path), false);
        assert.equal(worker.canEvict(Date.now() + 100000, 0), false);
        await assert.rejects(supervisor.acquireQueueReferenceLease(), /会话正在执行/);
    };
    fs.writeFileSync(holdFile, '');
    await wake();
    await busyBeforeRead();
    assert.equal((await worker.request('get_state')).isStreaming, true);
    let stopped = false;
    const abort = worker.request('abort').then(() => { stopped = true; });
    assert.equal((await worker.request('get_state')).isStreaming, true);
    assert.equal(worker.isIdle(), false);
    assert.equal(stopped, false);
    fs.unlinkSync(holdFile); await abort;
    await waitFor(() => events.some(event => event.type === 'agent_settled'));
    assert.equal(calls, 0, 'cancelled startup never reaches the synthetic provider');
    await waitFor(() => worker.isIdle());
    assert.equal(worker.isIdle(), true);
    fs.writeFileSync(holdFile, '');
    await wake(); await busyBeforeRead();
    const beforeQueuedCalls = calls;
    await worker.request('follow_up', { message: 'Synthetic queued follow-up' });
    assert.equal(worker.isIdle(), false);
    fs.unlinkSync(holdFile);
    await waitFor(() => worker.isIdle());
    assert.ok(calls >= beforeQueuedCalls + 2, 'queued follow-up is consumed before the SDK call releases');
    assert.ok(settlementBusy.every(Boolean), 'native settlement alone never releases the public SDK call');
    fs.writeFileSync(holdFile + '.hook-error', '');
    const beforeHookFailure = calls;
    await wake(); await waitFor(() => worker.isIdle());
    assert.equal(calls, beforeHookFailure + 1, 'native hook exceptions retain their catch-and-continue behavior');
    assert.ok(events.some(event => event.type === 'extension_error' && /Synthetic hook failure/.test(event.error)));
    fs.unlinkSync(holdFile + '.hook-error');
    fs.writeFileSync(holdFile + '.prepare-failure', '');
    const beforePreparationFailure = calls;
    await wake(); await waitFor(() => worker.isIdle());
    assert.equal(calls, beforePreparationFailure, 'a failed native preparation releases without a provider request or agent_settled');
    assert.ok(events.some(event => event.type === 'extension_error' && /Invalid system prompt section/.test(event.error)));
    fs.unlinkSync(holdFile + '.prepare-failure');
    // nextTurn does not start a custom run or retain an SDK call after its command.
    await worker.request('prompt', { message: '/hooknote' });
    await waitFor(() => worker.isIdle());
    const beforeDeferredStarts = starts(), beforeDeferredCalls = calls, beforeDeferredSettlement = settlementBusy.length;
    fs.writeFileSync(holdFile, ''); fs.writeFileSync(holdFile + '.defer', '');
    await worker.request('prompt', { message: 'Synthetic user run which schedules a settled wake.' });
    await waitFor(() => starts() > beforeDeferredStarts);
    await busyBeforeRead();
    assert.equal(settlementBusy[beforeDeferredSettlement], true, 'user prompt holds ownership across deferred custom wake handoff');
    fs.unlinkSync(holdFile); await waitFor(() => worker.isIdle());
    assert.equal(calls, beforeDeferredCalls + 2);
    assert.equal(worker.runStartupCalls.size, 0);
    // Every private frame is intercepted, including unknown, foreign and late records.
    // Use an independent projection so synthetic sequence numbers do not alter
    // the real child's monotonic transport sequence.
    const projection = Object.assign(Object.create(Object.getPrototypeOf(worker)), {
        navigationToken: worker.navigationToken, sessionId: session.id, runStartupCalls: new Set(), runStartupSequence: 0,
        _broadcast: () => { throw new Error('Private startup frame leaked'); },
    });
    const frame = { type: 'pivane_run_startup', token: worker.navigationToken, sessionId: session.id,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sequence: 1, phase: 'started' };
    projection._handleEvent({ ...frame, token: 'foreign-runtime' });
    projection._handleEvent({ ...frame, sessionId: 'foreign-session' });
    projection._handleEvent({ type: 'pivane_run_startup' });
    projection._handleEvent(frame);
    assert.equal(projection.runStartupCalls.size, 1);
    projection._handleEvent({ ...frame, phase: 'finished', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sequence: 2 });
    assert.equal(projection.runStartupCalls.size, 1, 'unknown completion cannot release a known call');
    projection._handleEvent({ ...frame, phase: 'finished', sequence: 3 });
    assert.equal(projection.runStartupCalls.size, 0);
    projection._handleEvent(frame);
    assert.equal(projection.runStartupCalls.size, 0, 'late startup frame cannot resurrect a completed call');
    // Idle snapshots and read timeouts cannot release active calls; real exit can.
    fs.writeFileSync(holdFile, ''); await wake(); await busyBeforeRead();
    const read = worker.client.request.bind(worker.client);
    worker.client.request = async type => {
        if (type === 'get_state') return { sessionId: session.id, sessionFile: session.path, isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
        throw Object.assign(new Error('Synthetic read timeout'), { code: 'RPC_TIMEOUT' });
    };
    await worker.request('get_state'); assert.equal(worker.isIdle(), false);
    await assert.rejects(worker.request('get_session_stats'), /Synthetic read timeout/);
    assert.equal(worker.isIdle(), false); worker.client.request = read;
    const childExit = once(worker.client.child, 'exit');
    worker.client.child.kill('SIGKILL'); await childExit;
    assert.equal(worker.runStartupCalls.size, 0, 'reservations release only after actual process exit');
    assert.equal(worker.isIdle(), false, 'exited worker still has its lifecycle blocker until retirement');
    worker._handleEvent({ ...frame, sequence: worker.runStartupSequence + 1 });
    assert.equal(worker.runStartupCalls.size, 0, 'late frame after exit is ignored');
    await supervisor.stopSession(session.path);
    assert.equal(supervisor.workers.size, 0);
});
