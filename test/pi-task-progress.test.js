const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { PROGRESS_ENTRY, validatePlan, currentProgress } = require('../server/pi-task-progress');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-progress-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(root, 'agent/extensions'), { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const plan = status => ({ plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Implement', status }], explanation: '' });

test('plan validation rejects impossible progress and remains bounded', () => {
    assert.throws(() => validatePlan({ plan: [{ step: ' ', status: 'pending' }] }), /non-empty/);
    assert.throws(() => validatePlan({ plan: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] }), /At most one/);
    assert.throws(() => validatePlan({ plan: Array(21).fill({ step: 'a', status: 'pending' }) }), /0–20/);
    assert.throws(() => validatePlan({ plan: [{ step: 'a'.repeat(201), status: 'pending' }] }), /200/);
    assert.throws(() => validatePlan({ plan: [], explanation: 'a'.repeat(1001) }), /1000/);
    assert.throws(() => validatePlan({ plan: [{ step: 'a', status: 'failed' }] }), /valid status/);
    assert.deepEqual(validatePlan({ plan: [] }), { plan: [], explanation: '' });
});

test('native branch, fork, compaction and clear preserve the correct plan', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sm = SessionManager.inMemory(cwd);
    const before = sm.appendMessage({ role: 'user', content: 'Start', timestamp: 1 });
    const first = sm.appendCustomEntry(PROGRESS_ENTRY, { version: 1, id: 'first', ...plan('pending') });
    sm.appendCustomEntry(PROGRESS_ENTRY, { version: 1, id: 'second', ...plan('completed') });
    sm.branch(first);
    assert.equal(currentProgress(sm).id, 'first');
    const kept = sm.appendMessage({ role: 'user', content: 'Continue', timestamp: 2 });
    sm.appendCompaction('Synthetic summary', kept, 20000);
    assert.equal(currentProgress(sm).id, 'first');
    assert.equal(sm.buildSessionContext().messages.some(m => m.details?.pivaneProgress), false);
    sm.appendCustomEntry(PROGRESS_ENTRY, { version: 1, id: 'clear', plan: [], explanation: '' });
    assert.equal(currentProgress(sm).plan.length, 0);
    sm.appendCustomEntry(PROGRESS_ENTRY, { version: 99 });
    assert.equal(currentProgress(sm), null, 'bad latest state never revives old progress');
    sm.branch(before);
    assert.equal(currentProgress(sm), null);
});

test('managed tool publishes persisted progress, restores workers and branches, survives compaction, ignores failed calls', { timeout: 120000 }, async () => {
    const calls = []; let nextTool = null, toolIndex = 0;
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); calls.push(input);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (nextTool) {
            const args = nextTool; nextTool = null;
            send({ role: 'assistant', tool_calls: [{ index: 0, id: `plan-${++toolIndex}`, type: 'function', function: { name: 'update_plan', arguments: JSON.stringify(args) } }] });
            send({}, 'tool_calls');
        } else { send({ role: 'assistant', content: 'Fixture response' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { keepRecentTokens: 50, reserveTokens: 1000 }, enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(root, 'agent/extensions/compact.ts'), `export default function(pi) {
        pi.on('session_before_compact', (event) => ({ compaction: { summary: 'Synthetic summary without a plan', firstKeptEntryId: event.branchEntries.findLast(e => e.type === 'message').id, tokensBefore: 20000 } }));
    }`);
    const { PiSessionStore } = require('../server/pi-session-store');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    const source = await store.createSession(cwd, 'Plan fixture');
    let worker;
    const open = async () => { worker = await supervisor.getWorker({ cwd, sessionPath: source.path, sessionId: source.id }); };
    const run = async (input, message) => {
        nextTool = input;
        let unsubscribe;
        const settled = new Promise(resolve => { unsubscribe = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
        try { await worker.request('prompt', { message }); await settled; } finally { unsubscribe(); }
    };
    try {
        await open();
        assert.equal((await worker.request('get_messages')).webProgress, null);
        assert.ok((await worker.getNativeResources()).tools.some(tool => tool.name === 'update_plan' && tool.active));
        const events = []; worker.subscribe(event => events.push(event));
        await run(plan('in_progress'), 'Initial plan');
        const initial = (await worker.request('get_messages')).webProgress;
        assert.equal(initial.plan[1].status, 'in_progress');
        assert.equal(events.some(event => event.type === 'extension_ui_request' && /pivaneProgress/.test(event.message)), false);
        assert.equal(events.filter(event => event.type === 'gateway_progress').length, 1);
        assert.match(JSON.stringify(calls[0]), /Use update_plan for substantial multi-step tasks/);
        const snapshot = await worker.request('get_entries');
        const saved = snapshot.entries.findLast(entry => entry.customType === PROGRESS_ENTRY);
        assert.deepEqual(saved.data, initial);
        assert.equal((await worker.request('get_messages')).webProgress.plan[1].status, 'in_progress', 'settling does not complete a step');
        await run({ plan: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] }, 'Invalid plan');
        assert.deepEqual((await worker.request('get_messages')).webProgress, initial);
        assert.ok(events.some(event => event.type === 'tool_execution_end' && event.isError));
        await run(plan('completed'), 'Finish plan');
        assert.equal((await worker.request('get_messages')).webProgress.plan[1].status, 'completed');
        const entries = await worker.request('get_entries');
        const user = entries.entries.findLast(entry => entry.type === 'message' && entry.message.role === 'user');
        await worker.exclusive(rpc => worker.navigate(rpc, { mode: 'retry', entryId: user.id, expectedLeafId: entries.leafId }));
        assert.deepEqual((await worker.request('get_messages')).webProgress, initial, 'native history retry restores earlier plan');
        await worker.request('compact');
        const compacted = await worker.request('get_messages');
        assert.deepEqual(compacted.webProgress, initial);
        assert.equal(compacted.messages.some(m => m.details?.pivaneProgress?.id === initial.id), false);
        await supervisor.stopSession(source.path); await open();
        assert.deepEqual((await worker.request('get_messages')).webProgress, initial, 'restart reconstructs from native custom entry');
        await run(null, 'Continue after compaction');
        assert.match(JSON.stringify(calls.at(-1).messages), /Latest Agent-reported task plan/);
        assert.ok(JSON.stringify(calls.at(-1).messages).includes(initial.id));
        await run({ plan: [], explanation: 'New task' }, 'Clear old plan');
        assert.deepEqual((await worker.request('get_messages')).webProgress.plan, []);
        await supervisor.stopSession(source.path); await open();
        assert.deepEqual((await worker.request('get_messages')).webProgress.plan, [], 'clear is durable');
        const forkPoint = snapshot.entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
        const { session: copy } = await store.forkSession(source, await worker.request('get_entries'), forkPoint.id, 'at');
        const fork = await supervisor.getWorker({ cwd, sessionPath: copy.path, sessionId: copy.id });
        assert.deepEqual((await fork.request('get_messages')).webProgress, initial, 'fork carries only its copied branch');
        const pub = []; worker.subscribe(event => pub.push(event));
        for (const data of [{ sessionId: 'foreign', progress: initial }, { sessionId: source.id, progress: { version: 99 } }, null])
            worker._handleEvent({ type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ pivaneProgress: data }) });
        assert.deepEqual(pub, [], 'foreign and malformed bridge events stay private');
        assert.deepEqual((await worker.request('get_messages')).webProgress.plan, []);
    } finally { await supervisor.dispose(); await new Promise(resolve => provider.close(resolve)); }
});
