const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-pi087-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store');
const { PiSessionTransfer, validateImport } = require('../server/pi-session-transfer');
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
const user = content => ({ role: 'user', content, timestamp: 1 });
const assistant = content => ({ role: 'assistant', content: [{ type: 'text', text: content }], timestamp: 2,
    provider: 'fixture', model: 'fixture', api: 'openai-completions', stopReason: 'stop', usage });
const jsonl = manager => [manager.getHeader(), ...manager.getEntries()].map(e => JSON.stringify(e)).join('\n') + '\n';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Pi 0.87 import preserves context edits, raw history, usage and retain-none compaction', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sm = SessionManager.inMemory(root);
    const question = sm.appendMessage(user('original question'));
    const answer = sm.appendMessage(assistant('original answer'));
    sm.appendContextEdit(question, { content: 'replacement question' });
    sm.appendContextEdit(answer, null);
    sm.appendUsage('future-kind', 'fixture', 'fixture', usage);
    const branch = sm.getLeafId();
    sm.appendCompaction('summary only', null, 100);
    const compacted = sm.getLeafId();
    sm.branch(branch);
    sm.appendContextEdit(answer, { content: 'replacement answer' });
    const store = new PiSessionStore();
    const transfer = new PiSessionTransfer({ store, supervisor: { getWorker() { throw Error('no worker'); } } });
    const imported = await transfer.import(root, jsonl(sm), 'context-import-0000001');
    const result = SessionManager.open(imported.session.path);
    assert.deepEqual(result.getEntries(), JSON.parse(JSON.stringify(sm.getEntries())));
    assert.deepEqual(result.buildSessionContext(), sm.buildSessionContext());
    assert.equal(result.getEntry(answer).message.content[0].text, 'original answer');
    result.branch(compacted);
    assert.deepEqual(result.buildSessionContext().messages.map(m => m.role), ['compactionSummary']);
    assert.equal(result.buildSessionContext().messages[0].summary, 'summary only');
    require('./private-file-helper.cjs').assertPrivateFile(imported.session.path);
});

test('Pi 0.87 import rejects invalid edit targets, cross-branch references and malformed replacement blocks', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sm = SessionManager.inMemory(root);
    const q = sm.appendMessage(user('question'));
    const a = sm.appendMessage(assistant('answer'));
    const edit = sm.appendContextEdit(a, { content: 'replacement' });
    assert.doesNotThrow(() => validateImport(jsonl(sm)));
    const bad = change => { const entries = JSON.parse('[' + jsonl(sm).trim().split('\n').join(',') + ']'); change(entries); assert.throws(() => validateImport(entries.map(e => JSON.stringify(e)).join('\n'))); };
    bad(e => e.at(-1).targetId = 'missing');
    bad(e => e.at(-1).targetId = edit);
    bad(e => e.at(-1).parentId = q);
    bad(e => e[2].message = { role: 'system', content: 'prompt', timestamp: 1 });
    bad(e => e[2].message = { role: 'custom', customType: 'fixture', content: 'legacy custom', timestamp: 1 });
    bad(e => e.at(-1).replacement = {});
    bad(e => e.at(-1).replacement = { content: [{ type: 'text', text: 123 }] });
    bad(e => e.at(-1).replacement = { content: [{ type: 'image', data: 'AA==', mimeType: 'text/html' }] });
    bad(e => { e.at(-1).targetId = q; e.at(-1).replacement = { content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }] }; });
});

test('Pi 0.87 forks before the first assistant preserve native IDs, edits, timestamps and compaction', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const store = new PiSessionStore();
    const session = await store.createSession(root, 'early');
    const sm = SessionManager.open(session.path);
    const q = sm.appendMessage(user('original'));
    sm.appendContextEdit(q, { content: 'edited' });
    const custom = sm.appendCustomMessageEntry('fixture', 'background', false);
    sm.appendContextEdit(custom, null);
    sm.appendUsage('cache_warm', 'fixture', 'fixture', usage);
    const before = fs.readFileSync(session.path);
    const fork = await store.forkSession(session, { entries: sm.getEntries(), leafId: sm.getLeafId() });
    const copy = SessionManager.open(fork.session.path);
    assert.notEqual(copy.getSessionId(), sm.getSessionId());
    assert.deepEqual(copy.getEntry(q), sm.getEntry(q));
    assert.deepEqual(copy.buildSessionContext(), sm.buildSessionContext());
    assert.equal(copy.getEntries().filter(e => e.type === 'context_edit').length, 2);
    assert.equal(copy.getEntries().filter(e => e.type === 'usage').length, 1);
    assert.deepEqual(fs.readFileSync(session.path), before);
    sm.appendCompaction('no retained messages', null, 20);
    const compactFork = await store.forkSession(session, { entries: sm.getEntries(), leafId: sm.getLeafId() });
    assert.deepEqual(SessionManager.open(compactFork.session.path).buildSessionContext(), sm.buildSessionContext());
    require('./private-file-helper.cjs').assertPrivateFile(fork.session.path);
});

test('Pi 0.87 managed transcript retains original messages while side context follows edits, including after reopen', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const { previewHistory } = require('../server/pi-history-model');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    try {
        const session = await store.createSession(root, 'raw vs context');
        const sm = SessionManager.open(session.path);
        const q = sm.appendMessage(user('visible original question'));
        const a = sm.appendMessage(assistant('visible original answer'));
        sm.appendContextEdit(q, { content: 'model replacement' }); sm.appendContextEdit(a, null);
        const options = { cwd: root, sessionId: session.id, sessionPath: session.path };
        for (let i = 0; i < 2; i++) {
            const worker = await supervisor.getWorker(options);
            const raw = (await worker.request('get_messages', { since: 'not-a-browser-cursor' })).messages;
            assert.ok(raw.some(m => m.content === 'visible original question'));
            assert.ok(raw.some(m => m.content?.[0]?.text === 'visible original answer'));
            assert.ok(!raw.some(m => m.role === 'system'));
            assert.equal((await worker.request('get_session_stats')).tokens.input, usage.input);
            const context = await worker.captureContext();
            assert.ok(context.messages.some(m => m.content === 'model replacement'));
            assert.ok(!context.messages.some(m => m.content?.[0]?.text === 'visible original answer'));
            await supervisor.stopSession(session.path);
        }
        assert.equal(previewHistory(sm, { entryId: a }).atCurrentPosition, true);
    } finally { await supervisor.dispose(); }
});

test('Pi 0.87 actionable boundaries keep one worker busy through continuations and preserve prompt/tools after compaction', { timeout: 45000 }, async () => {
    const http = require('node:http'), { once } = require('node:events');
    const requests = [];
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); requests.push(input);
        const tool = requests.length === 3;
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'boundary-read', type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: path.join(root, 'boundary.txt') }) } }] }
            : { role: 'assistant', content: requests.length === 1 ? 'original attempt' : 'boundary reply' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }])
            res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const agent = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'boundary.txt'), 'BOUNDARY_TOOL_OK');
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
        models: [{ id: 'fixture', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000 }]
    } } }));
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
        defaultProjectTrust: 'never', compaction: { enabled: false }, enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'extensions/boundary.ts'), `export default function(pi) {
        let edited = false, compacted = false;
        pi.on('context', event => {
            if (event.messages.some(m => m.role === 'system')) throw Error('context must exclude system');
            return { messages: event.messages.filter(m => m.role !== 'system') };
        });
        pi.on('turn_end', event => {
            if (edited || event.outcome !== 'completed') return;
            edited = true;
            return { entries: [...event.entries,
                { type: 'context_edit', targetId: event.messageEntryId, replacement: { content: 'edited attempt' } },
                { type: 'custom_message', customType: 'fixture', content: 'Continue from turn boundary', display: false }], continue: true };
        });
        pi.on('agent_before_settle', event => {
            if (compacted || event.outcome !== 'completed') return;
            compacted = true;
            return { entries: [...event.entries,
                { type: 'compaction', summary: 'BOUNDARY_SUMMARY', firstKeptEntryId: null },
                { type: 'custom_message', customType: 'fixture', content: 'Read boundary file now', display: false }], continue: true };
        });
    }`);
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    try {
        const session = await store.createSession(root, 'boundary test');
        const worker = await supervisor.getWorker({ cwd: root, sessionId: session.id, sessionPath: session.path });
        const events = [];
        worker.subscribe(event => events.push(event));
        let unsubscribe, timer;
        const settled = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('No final settlement')), 15000);
            unsubscribe = worker.subscribe(e => { if (e.type === 'agent_settled') resolve(); });
        });
        try { await worker.request('prompt', { message: 'Exercise boundaries' }); await settled; }
        finally { clearTimeout(timer); unsubscribe(); }
        assert.equal(requests.length, 4);
        assert.match(JSON.stringify(requests[1].messages), /edited attempt/);
        assert.doesNotMatch(JSON.stringify(requests[1].messages), /original attempt/);
        assert.match(JSON.stringify(requests[2].messages), /BOUNDARY_SUMMARY/);
        for (const input of requests) {
            assert.ok(input.messages.some(m => ['system', 'developer'].includes(m.role)));
            assert.ok(input.tools.some(t => t.function?.name === 'read'));
        }
        assert.match(JSON.stringify(requests[3].messages), /BOUNDARY_TOOL_OK/);
        assert.equal(events.filter(e => e.type === 'agent_settled').length, 1);
        assert.equal(events.filter(e => e.type === 'extension_error').length, 0);
        assert.equal(worker.activity.snapshot().busy, false);
        assert.equal(supervisor.workers.size, 1);
        const entries = (await worker.request('get_entries')).entries;
        assert.ok(entries.some(e => e.message?.content?.[0]?.text === 'original attempt'));
        assert.ok(entries.some(e => e.type === 'compaction' && e.firstKeptEntryId === e.id));
        const transfer = new PiSessionTransfer({ store, supervisor });
        const exported = await transfer.export(root, session.id, 'jsonl');
        assert.doesNotThrow(() => validateImport(exported.data.toString('utf8')));
    } finally { await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
});
