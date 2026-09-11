const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-upgrade-rpc-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { createPiAgentGateway } = require('../server/pi-agent-routes');

function eventPromise(worker, predicate) {
    let unsubscribe;
    const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('RPC event timeout')); }, 15000);
        unsubscribe = worker.subscribe(event => {
            if (!predicate(event)) return;
            clearTimeout(timer);
            unsubscribe();
            resolve(event);
        });
    });
    promise.catch(() => {});
    return promise;
}

test('Pi upgrade: public SDK, reported version, native tools, queues, abort, compaction cancellation and resume', { timeout: 60000 }, async t => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    assert.equal(sdk.VERSION, require('../package.json').dependencies['@earendil-works/pi-coding-agent']);
    for (const name of ['SessionManager', 'ModelRuntime', 'DefaultPackageManager', 'SettingsManager', 'loadSkills']) assert.ok(sdk[name]);
    const legacyPath = path.join(root, 'legacy.jsonl');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'pi-0843-session.jsonl'), legacyPath);
    const legacyBytes = fs.readFileSync(legacyPath);
    const legacy = sdk.SessionManager.open(legacyPath);
    assert.equal(legacy.getSessionName(), 'Pi 0.84.3 compatibility fixture');
    assert.equal(legacy.getHeader().version, 3);
    assert.ok(legacy.getEntries().some(entry => entry.message?.content === 'Preserve this original requirement.'));
    const legacyContext = legacy.buildSessionContext().messages;
    assert.equal(legacyContext[0].role, 'compactionSummary');
    assert.ok(legacyContext.some(message => message.content === 'Continue with this retained requirement.'));
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes, 'reading legacy v3 must not rewrite its history');
    const gateway = createPiAgentGateway();
    const express = require('express');
    const app = express();
    gateway.mount(app);
    const api = app.listen(0, '127.0.0.1');
    await once(api, 'listening');
    t.after(async () => { await gateway.dispose(); await new Promise(resolve => api.close(resolve)); });
    const status = await (await fetch(`http://127.0.0.1:${api.address().port}/api/pi/status`)).json();
    assert.equal(status.version, sdk.VERSION);
    assert.equal(gateway.supervisor.workers.size, 0);

    let mode = 'tool';
    let toolRequests = 0;
    const held = new Set();
    const provider = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (mode === 'hold') { held.add(res); res.on('close', () => held.delete(res)); return; }
        const hasToolResult = body.messages.some(message => message.role === 'tool');
        const tool = mode === 'tool' && !hasToolResult;
        if (tool) toolRequests++;
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'upgrade-read', type: 'function', function: {
            name: 'read', arguments: JSON.stringify({ path: path.join(root, 'fixture.txt') })
        } }] } : { role: 'assistant', content: 'UPGRADE_OK\u2028line\u2029end' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 12, total_tokens: 212 } }
        ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'Native read tool fixture');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: {
        fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-not-a-secret', models: [
            { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
        ] }
    } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
        defaultProvider: 'fixture', defaultModel: 'fixture', defaultThinkingLevel: 'off',
        compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 }
    }));
    const extensionDir = path.join(process.env.PI_CODING_AGENT_DIR, 'extensions');
    fs.mkdirSync(extensionDir);
    fs.writeFileSync(path.join(extensionDir, 'upgrade-ui.ts'), `export default function(pi) {
        pi.registerCommand('upgrade-confirm', { handler: async (_args, ctx) => {
            const confirmed = await ctx.ui.confirm('Upgrade fixture', 'Confirm test', { timeout: 10000 });
            ctx.ui.notify(confirmed ? 'UI_CONFIRMED' : 'UI_CANCELLED');
        } });
    }`);
    const supervisor = new PiAgentSupervisor();
    t.after(async () => {
        for (const res of held) res.destroy();
        await supervisor.dispose();
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const initial = sdk.SessionManager.create(root, path.join(root, 'sessions'));
    fs.writeFileSync(initial.getSessionFile(), '', { flag: 'wx' });
    const manager = sdk.SessionManager.open(initial.getSessionFile(), undefined, root);
    const options = { cwd: root, sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId() };
    const worker = await supervisor.getWorker(options);
    assert.equal(await supervisor.getWorker(options), worker, 'one worker per file');
    const events = [];
    worker.subscribe(event => events.push(event));
    assert.ok((await worker.request('get_available_models')).models.some(model => model.id === 'fixture'));
    assert.deepEqual((await worker.request('get_available_thinking_levels')).levels, ['off']);
    assert.ok((await worker.request('get_commands')).commands.some(command => command.name === 'upgrade-confirm'));
    const settled = eventPromise(worker, event => event.type === 'agent_settled');
    await worker.request('prompt', { message: 'Read fixture file and preserve this requirement. '.repeat(100) });
    await settled;
    assert.equal(toolRequests, 1);
    assert.ok(events.some(event => event.type === 'tool_execution_end' && !event.isError));
    const messages = (await worker.request('get_messages')).messages;
    assert.ok(messages.some(message => message.role === 'toolResult' && message.content[0].text.includes('Native read tool fixture')));
    assert.ok(messages.some(message => message.role === 'assistant' && message.content.some(block => block.text?.includes('\u2028'))));

    const uiRequest = eventPromise(worker, event => event.type === 'extension_ui_request' && event.method === 'confirm');
    const command = worker.request('prompt', { message: '/upgrade-confirm' });
    const pendingUi = await uiRequest;
    assert.equal(worker.getPendingUi()[0].id, pendingUi.id);
    assert.equal(worker.canEvict(Date.now() + 100000, 1), false);
    const notified = eventPromise(worker, event => event.type === 'extension_ui_request' && event.message === 'UI_CONFIRMED');
    worker.send({ type: 'extension_ui_response', id: pendingUi.id, confirmed: true });
    await Promise.all([command, notified]);
    assert.equal(worker.getPendingUi().length, 0);
    mode = 'normal';
    const secondSettled = eventPromise(worker, event => event.type === 'agent_settled');
    await worker.request('prompt', { message: 'Retain this second fixture requirement. '.repeat(100) });
    await secondSettled;

    mode = 'hold';
    const started = eventPromise(worker, event => event.type === 'agent_start');
    const aborted = eventPromise(worker, event => event.type === 'agent_settled');
    await worker.request('prompt', { message: 'Hold for abort.' });
    await started;
    await worker.request('steer', { message: 'Queued steering' });
    await worker.request('follow_up', { message: 'Queued follow-up' });
    assert.deepEqual(await worker.request('clear_queue'), { steering: ['Queued steering'], followUp: ['Queued follow-up'] });
    await worker.request('abort');
    await aborted;
    assert.equal((await worker.request('get_state')).isStreaming, false);
    assert.equal(worker.activity.snapshot().busy, false);

    const compactionStarted = eventPromise(worker, event => event.type === 'compaction_start');
    const compact = worker.request('compact');
    const cancelled = assert.rejects(compact, /abort|cancel/i);
    cancelled.catch(() => {});
    await compactionStarted;
    const compactionEnded = eventPromise(worker, event => event.type === 'compaction_end');
    await worker.request('abort');
    await cancelled;
    assert.equal((await compactionEnded).aborted, true);
    const state = await worker.request('get_state');
    assert.equal(state.isCompacting, false);
    assert.equal(state.webCompaction.status, 'cancelled');
    assert.equal(worker.activity.snapshot().busy, false);

    await worker.request('set_session_name', { name: 'Upgrade resume fixture' });
    const before = (await worker.request('get_entries')).entries;
    await supervisor.stopSession(options.sessionPath);
    const resumed = await supervisor.getWorker(options);
    assert.equal((await resumed.request('get_state')).sessionName, 'Upgrade resume fixture');
    assert.deepEqual((await resumed.request('get_entries')).entries, before);
    assert.ok((await resumed.request('get_tree')).tree.length);
    mode = 'normal';
    const resumedSettled = eventPromise(resumed, event => event.type === 'agent_settled');
    await resumed.request('prompt', { message: 'Continue after reload.' });
    await resumedSettled;
    assert.ok((await resumed.request('get_entries')).entries.length > before.length);
});
