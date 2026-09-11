const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compaction-rpc-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');

function waitFor(worker, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('Expected RPC event did not arrive')); }, 15000);
        const unsubscribe = worker.subscribe(event => {
            if (predicate(event)) { clearTimeout(timer); unsubscribe(); resolve(event); }
        });
    });
}

test('native RPC compaction: manual, automatic threshold/overflow, retries, history and worker guards', { timeout: 60000 }, async t => {
    const requests = [];
    let mode = 'normal';
    let summaryFailures = 0;
    let heldSummary;
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests.push(body);
        const summary = body.messages.some(message => JSON.stringify(message.content).includes('<conversation>'));
        if (summary && mode === 'hold') {
            heldSummary = res;
            return;
        }
        if (summary && summaryFailures > 0) {
            summaryFailures--;
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Controlled summary service unavailable' } }));
        }
        if (summary && mode === 'error') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Controlled invalid summary request' } }));
        }
        if (!summary && mode === 'overflow') {
            mode = 'normal';
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'maximum context length exceeded' } }));
        }
        const text = summary ? '## Goal\nKeep the fixture goal and recent work.' : 'Fixture reply.';
        const input = !summary && mode === 'threshold' ? 3600 : 200;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of [
            { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: 10, total_tokens: input + 10 } }
        ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: {
        fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-not-a-secret', api: 'openai-completions', models: [
            { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
        ] }
    } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
        defaultProvider: 'fixture', defaultModel: 'fixture', defaultThinkingLevel: 'off',
        compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 }
    }));
    const supervisor = new PiAgentSupervisor();
    t.after(async () => {
        heldSummary?.destroy();
        await supervisor.dispose();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const initial = SessionManager.create(root, path.join(root, 'sessions'));
    fs.writeFileSync(initial.getSessionFile(), '', { flag: 'wx' });
    const manager = SessionManager.open(initial.getSessionFile(), undefined, root);
    const worker = await supervisor.getWorker({ cwd: root, sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId() });
    const events = [];
    worker.subscribe(event => events.push(event));
    const prompt = async () => {
        const settled = waitFor(worker, event => event.type === 'agent_settled');
        const submission = worker.request('prompt', { message: 'Retain this fixture requirement. '.repeat(100) });
        await assert.rejects(worker.request('compact'), /正在运行或压缩/);
        await submission;
        await settled;
    };
    await prompt();
    await prompt();
    const before = (await worker.request('get_entries')).entries;
    summaryFailures = 1;
    const result = await worker.request('compact', { customInstructions: 'Keep the fixture requirement' }, 15000);
    assert.ok(result.summary.includes('fixture goal'));
    assert.ok(result.estimatedTokensAfter > 0);
    assert.ok(events.some(event => event.type === 'summarization_retry_scheduled'));
    assert.equal((await worker.request('get_state')).webCompaction.status, 'success');
    const stats = await worker.request('get_session_stats');
    assert.equal(stats.contextUsage.tokens, null);
    assert.equal(stats.contextUsage.percent, null);
    const messages = (await worker.request('get_messages')).messages;
    assert.equal(messages[0].role, 'compactionSummary');
    assert.ok(messages.length > 1);
    const after = (await worker.request('get_entries')).entries;
    assert.deepEqual(after.slice(0, before.length), before, 'compaction must retain original entries');
    assert.equal(after.at(-1).type, 'compaction');
    await assert.rejects(worker.request('compact'), /Already compacted/);
    assert.equal((await worker.request('get_state')).webCompaction.status, 'unchanged');
    assert.equal(worker.activity.snapshot().phase, 'idle');
    await prompt();
    assert.ok((await worker.request('get_session_stats')).contextUsage.tokens > 0);

    const historyBeforeFailure = (await worker.request('get_entries')).entries.length;
    mode = 'error';
    await assert.rejects(worker.request('compact'), /Controlled invalid/);
    assert.equal((await worker.request('get_entries')).entries.length, historyBeforeFailure);
    assert.equal((await worker.request('get_state')).webCompaction.status, 'error');

    mode = 'hold';
    const running = waitFor(worker, event => event.type === 'compaction_start');
    const pending = worker.request('compact', {}, 100);
    const timedOut = assert.rejects(pending, /timed out/);
    await assert.rejects(worker.request('compact'), /正在运行或压缩/);
    await running;
    assert.equal((await worker.request('get_state')).isCompacting, true);
    await assert.rejects(worker.request('prompt', { message: 'must not interrupt' }), /正在压缩/);
    await assert.rejects(worker.request('set_model', { provider: 'fixture', modelId: 'fixture' }), /正在压缩/);
    await timedOut;
    assert.equal(worker.canEvict(Date.now() + 100000, 1), false);
    await assert.rejects(worker.request('compact'), /正在运行或压缩/);
    const failed = waitFor(worker, event => event.type === 'compaction_end');
    mode = 'error';
    heldSummary.writeHead(400, { 'Content-Type': 'application/json' });
    heldSummary.end(JSON.stringify({ error: { message: 'Controlled cancellation by provider' } }));
    await failed;
    mode = 'normal';
    await worker.request('compact');

    await worker.request('set_auto_compaction', { enabled: true });
    assert.equal((await worker.request('get_state')).autoCompactionEnabled, true);
    mode = 'threshold';
    await prompt();
    assert.ok(events.some(event => event.type === 'compaction_end' && event.reason === 'threshold' && event.result));
    mode = 'overflow';
    await prompt();
    assert.ok(events.some(event => event.type === 'compaction_end' && event.reason === 'overflow' && event.willRetry && event.result));
    assert.ok((await worker.request('get_session_stats')).contextUsage.tokens > 0);
    assert.equal(worker.activity.snapshot().busy, false);
    worker.client.emit('event', { type: 'agent_start' });
    await assert.rejects(worker.request('compact'), /正在运行或压缩/);
    worker.client.emit('event', { type: 'agent_settled' });
    worker.client.emit('event', { type: 'compaction_start', reason: 'manual' });
    worker.client.emit('event', { type: 'compaction_end', reason: 'manual', aborted: true });
    const cancelledState = await worker.request('get_state');
    assert.equal(cancelledState.webCompaction.status, 'cancelled');
    assert.equal(Object.hasOwn(cancelledState.webCompaction, 'summary'), false);
    const persisted = SessionManager.open(manager.getSessionFile());
    assert.ok(persisted.getEntries().filter(entry => entry.type === 'compaction').length >= 4);
    assert.ok(requests.some(body => JSON.stringify(body.messages).includes('Keep the fixture requirement')));
    assert.ok(requests.filter(body => body.messages.some(message => JSON.stringify(message.content).includes('<conversation>')))
        .every(body => !body.tools && !Object.hasOwn(body, 'tool_choice')));
});
