const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { WebSocket } = require('ws');
const { historyArchive, validateArchiveRequest } = require('../server/pi-history-archive');
const { validateHistoryRequest } = require('../server/pi-history-model');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-history-archive-'));
delete process.env.PORT;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'archive-fixture';
const question = text => ({ role: 'user', content: text, timestamp: 0 });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 123, stopReason: 'stop', provider: 'fixture', model: 'fixture', api: 'openai-completions', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const tool = (id, args = { path: 'target.js' }, name = 'read') => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'TOOL_RESULT_SENTINEL' }], details: { secret: 'PRIVATE_DETAILS' }, isError, timestamp: 124 });
const memory = async () => (await import('@earendil-works/pi-coding-agent')).SessionManager.inMemory(root);
const read = (sm, input = {}) => {
    const before = JSON.stringify(sm.getEntries()), leaf = sm.getLeafId(), context = JSON.stringify(sm.buildSessionContext());
    const response = historyArchive(sm, input);
    assert.equal(JSON.stringify(sm.getEntries()), before); assert.equal(sm.getLeafId(), leaf); assert.equal(JSON.stringify(sm.buildSessionContext()), context);
    assert.doesNotMatch(JSON.stringify(response), /THINKING_SENTINEL|TOOL_RESULT_SENTINEL|PRIVATE_DETAILS|HIDDEN_SENTINEL/);
    return response;
};
const full = (sm, index = read(sm)) => read(sm, { view: 'turns', start: 0, end: index.total, revision: index.revision });
const code = expected => error => error.code === expected;
function assertCut(sm) {
    const branch = sm.getBranch(), ci = branch.findLastIndex(e => e.type === 'compaction'), compaction = branch[ci];
    const ki = branch.findIndex((e, i) => i < ci && e.id === compaction.firstKeptEntryId), cut = ki < 0 ? ci : ki;
    const context = new Set(sm.buildContextEntries().map(e => e.id));
    for (const entry of branch.slice(0, cut)) assert.ok(!context.has(entry.id), `archived ${entry.id} is outside model context`);
    for (const entry of branch.slice(cut, ci)) if (entry.type === 'message' && entry.message.role !== 'system') assert.ok(context.has(entry.id), `kept ${entry.id} is in context`);
    assert.equal(read(sm).revision, createHash('sha256').update(JSON.stringify(['archive-v1', sm.getSessionId(), compaction.id, branch[cut].id, cut])).digest('hex'));
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('archive cut equals native context for one, repeated and retain-none compactions; no compaction is empty', async () => {
    const sm = await memory(); sm.appendMessage(question('old')); sm.appendMessage(assistant('old answer'));
    assert.equal(read(sm).total, 0);
    const kept = sm.appendMessage(question('kept')); sm.appendMessage(assistant('kept answer'));
    const first = sm.appendCompaction('first summary', kept, 4000); assertCut(sm);
    const index = read(sm); assert.equal(index.total, 1); assert.equal(index.compactionId, first); assert.equal(index.turns[0].title, 'old');
    const later = sm.appendMessage(question('later')); sm.appendMessage(assistant('later answer'));
    sm.appendCompaction('second summary', later, 5000); assertCut(sm);
    const repeated = read(sm), details = full(sm, repeated);
    assert.deepEqual(details.turns.map(t => t.kind), ['user', 'user', 'summary']);
    assert.equal(details.turns[2].entryId, first); assert.equal(details.turns[2].text, 'first summary'); assert.equal(details.turns[2].tokensBefore, 4000);
    sm.appendCompaction('retain none', undefined, 6000); assert.equal(sm.getEntry(sm.getLeafId()).firstKeptEntryId, sm.getLeafId()); assertCut(sm);
    assert.equal(read(sm).continues, false); assert.equal(full(sm).turns.at(-1).summaryType, 'compaction');
});
test('native turn segmentation, summaries, final text, failures, hidden data and process statistics', async () => {
    const sm = await memory(); sm.appendMessage(assistant('orphan'));
    const user = sm.appendMessage(question('  first\n question  '));
    const progress = sm.appendMessage({ ...assistant('progress'), content: [{ type: 'thinking', thinking: 'THINKING_SENTINEL' }, { type: 'text', text: 'progress' }, tool('one', { command: 'echo\nhi', path: 'lower-priority' }, 'bash')] });
    const resultId = sm.appendMessage(result('one', true));
    const final = sm.appendMessage(assistant('first final'));
    sm.appendMessage({ ...assistant(''), content: [{ type: 'thinking', thinking: 'THINKING_SENTINEL' }] });
    sm.appendMessage({ role: 'bashExecution', command: 'false\nnext', output: 'TOOL_RESULT_SENTINEL', exitCode: 1, timestamp: 125 });
    sm.appendMessage({ role: 'bashExecution', command: 'cancel', output: 'TOOL_RESULT_SENTINEL', exitCode: 0, cancelled: true, timestamp: 126 });
    const summary = sm.branchWithSummary(sm.getLeafId(), 'branch summary');
    const afterSummary = sm.appendMessage(assistant('reply after summary'));
    sm.appendCustomMessageEntry('hidden', 'HIDDEN_SENTINEL', false);
    const custom = sm.appendCustomMessageEntry('wake'.repeat(30), 'Agent task\nsecond line', true);
    sm.appendMessage(assistant('agent result'));
    const legacy = sm.appendMessage({ role: 'custom', customType: 'legacy', display: true, content: 'Legacy task', timestamp: 127 });
    sm.appendMessage({ ...assistant(''), stopReason: 'error', errorMessage: 'failed' });
    sm.appendMessage(question('stopped')); const aborted = sm.appendMessage({ ...assistant(''), stopReason: 'aborted' });
    sm.appendCompaction('latest', undefined, 6000);
    const index = read(sm), details = full(sm, index);
    assert.deepEqual(details.turns.map(t => t.kind), ['user', 'summary', 'agent', 'agent', 'user']);
    assert.equal(index.turns[0].title, 'first question'); assert.equal(index.turns[0].timestamp, 0);
    assert.equal(details.turns[0].entryId, user); assert.equal(details.turns[0].reply.entryId, afterSummary); assert.notEqual(details.turns[0].reply.entryId, final);
    assert.deepEqual(details.turns[0].process, { steps: 5, tools: 1, errors: 3, startedAt: 0, endedAt: 123 });
    assert.equal(details.turns[1].entryId, summary); assert.equal(details.turns[1].summaryType, 'branch_summary'); assert.equal(index.turns[1].title, ''); assert.equal(details.turns[1].reply, null);
    assert.equal(details.turns[2].entryId, custom); assert.equal([...details.turns[2].customType].length, 64); assert.equal(index.turns[2].title, 'Agent task');
    assert.equal(details.turns[3].entryId, legacy); assert.equal(details.turns[3].customType, 'legacy'); assert.equal(details.turns[3].reply.text, ''); assert.equal(index.turns[3].reply.failed, true);
    assert.equal(details.turns[4].reply.entryId, aborted); assert.equal(details.turns[4].reply.text, '');
    const process = read(sm, { view: 'process', index: 0, revision: index.revision });
    assert.equal(process.total, 5); assert.equal(process.steps.filter(s => s.kind === 'text').length, 2);
    const call = process.steps.find(s => s.kind === 'tool'); assert.equal(call.entryId, progress); assert.equal(call.resultEntryId, resultId); assert.equal(call.isError, true); assert.equal(call.label, 'echo hi');
    assert.equal(process.steps.filter(s => s.kind === 'bash' && s.isError).length, 2);
});
test('split compaction marks the last non-summary turn continued and suppresses its reply', async () => {
    const sm = await memory(); sm.appendMessage(question('split')); sm.appendMessage(assistant('prefix text'));
    sm.branchWithSummary(sm.getLeafId(), 'marker'); const kept = sm.appendMessage(assistant('visible final')); sm.appendCompaction('current', kept, 3000);
    assertCut(sm); const index = read(sm); assert.equal(index.continues, true); assert.equal(index.turns[0].continues, true); assert.equal(index.turns[0].reply, null);
    const details = full(sm, index); assert.equal(details.turns[0].reply, null); assert.equal(details.turns[0].process.steps, 1); assert.equal(details.turns[1].continues, undefined);
});
test('index pages 100 turns, append-stable revisions, compaction and branch changes invalidate revisions', async () => {
    const sm = await memory(); const first = sm.appendMessage(question('first'));
    for (let i = 1; i < 205; i++) { sm.appendMessage(question(`question ${i}`)); sm.appendMessage(assistant(`reply ${i}`)); }
    const compaction = sm.appendCompaction('summary', undefined, 7000), one = read(sm);
    assert.equal(one.total, 205); assert.equal(one.turns.length, 100); assert.equal(one.hasMore, true); assert.ok(Buffer.byteLength(JSON.stringify(one)) <= 160 * 1024);
    const two = read(sm, { offset: 100, revision: one.revision }); assert.equal(two.turns[0].index, 100); assert.equal(two.turns.length, 100);
    assert.equal(read(sm, { offset: 200, revision: one.revision }).hasMore, false);
    sm.appendMessage(question('running new message')); sm.appendMessage(assistant('running new reply')); assert.equal(read(sm).revision, one.revision);
    sm.appendCompaction('new summary', undefined, 8000); assert.notEqual(read(sm).revision, one.revision);
    assert.throws(() => historyArchive(sm, { revision: one.revision }), code('HISTORY_STALE'));
    sm.branch(compaction); assert.equal(read(sm).revision, one.revision);
    sm.branch(first); assert.notEqual(read(sm).revision, one.revision); assert.equal(read(sm).total, 0);
});
test('turns pack backwards within bytes, enforce text caps, preserve emoji and fit escaped control characters', async () => {
    const sm = await memory();
    for (let i = 0; i < 12; i++) { sm.appendMessage({ ...question('😀'.repeat(12001)), content: [{ type: 'text', text: '😀'.repeat(12001) }, { type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/png' }] }); sm.appendMessage({ ...assistant('😀'.repeat(20001)), model: '😀'.repeat(121), errorMessage: '😀'.repeat(1001) }); }
    sm.appendCompaction('summary', undefined, 8000); const index = read(sm), details = full(sm, index);
    assert.equal(index.turns[0].images, 1); assert.equal([...index.turns[0].title].length, 160); assert.equal([...index.turns[0].reply.excerpt].length, 600);
    assert.ok(details.start > 0); assert.equal(details.end, 12); assert.equal(details.turns.at(-1).index, 11); assert.ok(details.turns.length >= 1); assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 192 * 1024);
    for (const t of details.turns) { assert.equal([...t.text].length, 12000); assert.equal([...t.reply.text].length, 20000); assert.equal(t.textTruncated, true); assert.equal(t.reply.truncated, true); assert.equal([...t.reply.model].length, 120); assert.equal([...t.reply.errorMessage].length, 1000); assert.equal(t.images, 1); assert.doesNotMatch(t.text + t.reply.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u); }
    const escaped = await memory(); escaped.appendMessage(question('\u0000'.repeat(12000))); escaped.appendMessage({ ...assistant('\u0000'.repeat(20000)), errorMessage: '\u0000'.repeat(1000) }); escaped.appendCompaction('summary', undefined, 1000);
    const bounded = full(escaped); assert.equal(bounded.turns.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 192 * 1024); assert.equal(bounded.turns[0].reply.truncated, true); assert.ok(bounded.turns[0].reply.text.length < 20000);
});
test('process labels use priority and fallback, match results by call id, and page 100 bounded steps', async () => {
    const sm = await memory(); sm.appendMessage(question('many tools'));
    const args = [{ path: 'wrong', command: 'right\ncommand' }, { file_path: 'wrong', path: 'right-path' }, { pattern: 'wrong', file_path: 'right-file' }, { query: 'wrong', pattern: 'right-pattern' }, { url: 'wrong', query: 'right-query' }, { description: 'wrong', url: 'right-url' }, { other: 'wrong', description: 'right-description' }, { first: 'fallback\nvalue', other: 'wrong' }];
    for (let i = 0; i < 205; i++) sm.appendMessage({ ...assistant(''), content: [tool(`call-${i}`, i < args.length ? args[i] : i === args.length ? { path: 'must-not-override-empty-command', command: '' } : { command: '😀'.repeat(201) }, 'x'.repeat(81))] });
    const errorResult = sm.appendMessage(result('call-2', true)); sm.appendMessage(result('call-0')); sm.appendMessage(assistant('final')); sm.appendCompaction('summary', undefined, 3000);
    const index = read(sm), one = read(sm, { view: 'process', index: 0, revision: index.revision });
    assert.equal(one.total, 205); assert.equal(one.steps.length, 100); assert.equal(one.hasMore, true);
    assert.deepEqual(one.steps.slice(0, 8).map(s => s.label), ['right command', 'right-path', 'right-file', 'right-pattern', 'right-query', 'right-url', 'right-description', 'fallback value']);
    assert.equal(one.steps[2].resultEntryId, errorResult); assert.equal(one.steps[2].isError, true); assert.equal(one.steps[0].isError, false); assert.equal(one.steps[1].resultEntryId, undefined);
    assert.equal(one.steps[0].name.length, 80); assert.equal(one.steps[8].label, ''); assert.equal([...one.steps[9].label].length, 200);
    const two = read(sm, { view: 'process', index: 0, offset: 100, revision: index.revision }); assert.equal(two.steps.length, 100);
    assert.equal(read(sm, { view: 'process', index: 0, offset: 200, revision: index.revision }).hasMore, false);
    assert.ok(Buffer.byteLength(JSON.stringify(one)) <= 160 * 1024);
});
test('index and process stop before their byte budget even when the 100-item limit is not reached', async () => {
    const sm = await memory();
    for (let i = 0; i < 100; i++) { sm.appendMessage(question('😀'.repeat(160))); sm.appendMessage(assistant('😀'.repeat(600))); }
    sm.appendCompaction('summary', undefined, 1000);
    const first = read(sm); assert.ok(first.turns.length >= 1 && first.turns.length < 100); assert.equal(first.hasMore, true); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 160 * 1024);
    const next = read(sm, { offset: first.turns.length, revision: first.revision }); assert.equal(next.turns[0].index, first.turns.length); assert.equal(next.hasMore, false);
    const tools = await memory(); tools.appendMessage(question('escaped tools'));
    tools.appendMessage({ ...assistant(''), content: Array.from({ length: 100 }, (_, i) => tool(`id-${i}`, { command: '\u0000'.repeat(200) }, '\u0000'.repeat(80))) });
    tools.appendCompaction('summary', undefined, 1000);
    const index = read(tools), process = read(tools, { view: 'process', index: 0, revision: index.revision });
    assert.ok(process.steps.length >= 1 && process.steps.length < 100); assert.equal(process.hasMore, true); assert.ok(Buffer.byteLength(JSON.stringify(process)) <= 160 * 1024);
    assert.equal(read(tools, { view: 'process', index: 0, offset: process.steps.length, revision: index.revision }).hasMore, false);
});
test('validation rejects bad fields, stale revisions and out-of-range positions with history codes', async () => {
    const revision = 'a'.repeat(64);
    for (const input of [null, [], { view: 'bad' }, { offset: -1 }, { offset: 0.1 }, { offset: 50001 }, { offset: 1 }, { revision: 'z'.repeat(64) }, { revision: 1 }, { view: 'turns', start: 0, end: 1 }, { view: 'turns', start: -1, end: 1, revision }, { view: 'turns', start: 1, end: 1, revision }, { view: 'turns', start: 0, end: 25, revision }, { view: 'turns', start: 0.1, end: 1, revision }, { view: 'process', index: 0 }, { view: 'process', index: -1, revision }, { view: 'process', index: 0, offset: -1, revision }]) assert.throws(() => validateArchiveRequest(input), code('HISTORY_INVALID'));
    assert.deepEqual(validateHistoryRequest('archive', { unknown: true }), { view: 'index', offset: 0, revision: undefined });
    const sm = await memory(); sm.appendMessage(question('q')); sm.appendMessage(assistant('answer')); sm.appendCompaction('summary', undefined, 1000);
    const index = read(sm);
    for (const input of [{ offset: 2, revision: index.revision }, { view: 'turns', start: 0, end: 2, revision: index.revision }, { view: 'process', index: 1, revision: index.revision }, { view: 'process', index: 0, offset: 1, revision: index.revision }]) assert.throws(() => historyArchive(sm, input), code('HISTORY_INVALID'));
    for (const view of [{}, { view: 'turns', start: 0, end: 1 }, { view: 'process', index: 0 }]) assert.throws(() => historyArchive(sm, { ...view, revision }), code('HISTORY_STALE'));
});
test('huge text and content arrays stay capped; entry and processing time limits reject explicitly', async () => {
    const sm = await memory(); sm.appendMessage(question('x'.repeat(4 * 1024 * 1024)));
    const content = Array.from({ length: 20000 }, (_, i) => i === 0 ? { type: 'text', text: 'y'.repeat(4 * 1024 * 1024) } : { type: 'thinking', thinking: 'THINKING_SENTINEL' });
    sm.appendMessage({ ...assistant(''), content }); sm.appendCompaction('summary', undefined, 1000);
    // Access beyond the first 10000 blocks is forbidden in all archive projections.
    Object.defineProperty(content, 10000, { get() { throw Error('archive scanned beyond 10000 blocks'); } });
    const index = historyArchive(sm, {}), details = historyArchive(sm, { view: 'turns', start: 0, end: 1, revision: index.revision });
    assert.equal(details.turns[0].text.length, 12000); assert.equal(details.turns[0].reply.text.length, 20000); assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 192 * 1024);
    assert.equal(historyArchive(sm, { view: 'process', index: 0, revision: index.revision }).total, 0);
    assert.throws(() => historyArchive({ getEntries: () => ({ length: 50001 }) }, {}), code('HISTORY_LIMIT'));
    const originalNow = Date.now; let clock = 0;
    try { Date.now = () => (clock += 1600); assert.throws(() => historyArchive(sm, {}), code('HISTORY_LIMIT')); }
    finally { Date.now = originalNow; }
});
test('single-line labels stop scanning long whitespace runs instead of stalling the worker', async () => {
    const sm = await memory(); sm.appendMessage(question('q'));
    sm.appendMessage({ ...assistant(''), content: [tool('blank', { command: ' '.repeat(16 * 1024 * 1024) + 'x' }, 'bash')], stopReason: 'toolUse' });
    sm.appendMessage(question('next')); sm.appendCompaction('summary', sm.getLeafId(), 1000);
    const index = read(sm), began = Date.now();
    const steps = read(sm, { view: 'process', index: 0, revision: index.revision });
    assert.ok(Date.now() - began < 1000, 'blank argument scan is bounded');
    assert.equal(steps.steps[0].label, '');
});
test('long blank assistant replies check the deadline during scanning', async () => {
    for (const arrayContent of [false, true]) {
        const sm = await memory(); sm.appendMessage(question('q'));
        const text = ' '.repeat(2 * 1024 * 1024) + 'late text';
        sm.appendMessage({ ...assistant(''), content: arrayContent ? [{ type: 'text', text }] : text });
        sm.appendCompaction('summary', undefined, 1000);
        const originalNow = Date.now; let clock = 0;
        try {
            Date.now = () => (clock += 10);
            assert.throws(() => historyArchive(sm, {}), code('HISTORY_LIMIT'));
        } finally { Date.now = originalNow; }
    }
});
test('archive queue drops old-thread and replaced-index loads before fetching', async () => {
    const vm = require('node:vm');
    const element = () => ({ setAttribute() {}, addEventListener() {}, replaceChildren() {}, childElementCount: 0 });
    const sandbox = { window: {}, document: { createElement: element }, IntersectionObserver: class { disconnect() {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-transcript-archive.js'), 'utf8'), sandbox);
    for (const switchThread of [false, true]) {
        const identity = { key: 'a', generation: 1 };
        const archive = sandbox.window.PiTranscriptArchive.create({ container: element(), scroller: element(), context: () => identity });
        let release, calls = 0;
        archive.fetch = () => { calls++; return new Promise(resolve => { release = resolve; }); };
        const first = archive.load(0, 12), queued = archive.load(12, 24);
        await Promise.resolve(); assert.equal(calls, 1);
        if (switchThread) { identity.key = 'b'; identity.generation++; }
        archive.reset(); // Same-thread reset represents a new compaction/index too.
        release(true);
        assert.equal(await first, true); assert.equal(await queued, false);
        assert.equal(calls, 1, 'a cancelled local queue must not fetch using the new identity or revision');
    }
});
test('archived extension messages can be previewed and bookmarked through native history', async () => {
    const { previewHistory, setHistoryBookmark, searchHistory } = require('../server/pi-history-model');
    const { sessionTree } = require('../server/pi-session-tree');
    const sm = await memory(); sm.appendMessage(question('q')); sm.appendMessage(assistant('a'));
    const id = sm.appendCustomMessageEntry('scheduled-task', 'SCHEDULED_BODY', true);
    const hidden = sm.appendCustomMessageEntry('internal', 'HIDDEN_SENTINEL', false);
    sm.appendMessage(assistant('done')); sm.appendCompaction('summary', undefined, 1000);
    const index = read(sm);
    assert.deepEqual(index.turns.map(turn => turn.kind), ['user', 'agent']);
    assert.equal(index.turns[1].entryId, id);
    const preview = previewHistory(sm, { entryId: id });
    assert.equal(preview.kind, 'assistant'); assert.match(preview.text, /SCHEDULED_BODY/);
    assert.throws(() => previewHistory(sm, { entryId: hidden }), code('HISTORY_NOT_FOUND'));
    const found = searchHistory(sm, { q: 'SCHEDULED_BODY', scope: 'all', filter: 'all' });
    assert.deepEqual(found.results.map(row => row.entryId), [id]);
    assert.equal(searchHistory(sm, { q: 'HIDDEN_SENTINEL', scope: 'all', filter: 'all' }).total, 0);
    const labels = [];
    const saved = setHistoryBookmark(sm, { entryId: id, label: 'daily', expectedBookmarkRevision: 'none' }, (target, label) => { labels.push([target, label]); sm.appendLabelChange(target, label); });
    assert.equal(saved.entryId, id); assert.deepEqual(labels, [[id, 'daily']]);
    // The conversation tree keeps its existing outline without extension messages.
    assert.ok(!sessionTree(sm, {}).rows.some(row => row.entryId === id));
});
test('gateway archive: actual worker reads all views without changing model context or native session bytes', { timeout: 90000 }, async t => {
    let requests = 0;
    const provider = http.createServer(async (req, res) => { for await (const _ of req) {} requests++; res.writeHead(500); res.end(); });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes'), gateway = createPiAgentGateway({ deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); gateway.attachWebSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let socket;
    t.after(async () => { socket?.terminate(); await gateway.dispose(); server.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]); });
    const session = await gateway.store.createSession(root, 'Archive fixture'), { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const seed = SessionManager.open(session.path), target = seed.appendMessage(question('archived question'));
    const callId = seed.appendMessage({ ...assistant('archived progress'), content: [{ type: 'text', text: 'archived progress' }, tool('archived-call')] });
    const resultId = seed.appendMessage(result('archived-call', true)); seed.appendMessage(assistant('archived final'));
    const kept = seed.appendMessage(question('kept question')); seed.appendMessage(assistant('kept answer')); seed.appendCompaction('current summary', kept, 6000);
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/pi/ws`); await once(socket, 'open');
    const pending = new Map(), events = []; let next = 0;
    socket.on('message', raw => { const e = JSON.parse(raw), p = e.type === 'response' && pending.get(e.id); if (p) { pending.delete(e.id); clearTimeout(p.timer); e.success ? p.resolve(e.data) : p.reject(Object.assign(Error(e.error), { code: e.code })); } else events.push(e); });
    const call = (type, input = {}) => new Promise((resolve, reject) => { const id = String(++next), timer = setTimeout(() => { pending.delete(id); reject(Error(`timeout ${type}`)); }, 40000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ type, id, ...input })); });
    await call('open_session', { cwd: root, sessionId: session.id, token: 'archive-fixture' });
    const original = fs.readFileSync(session.path), context = JSON.stringify(SessionManager.open(session.path).buildSessionContext()), messages = await call('get_messages');
    const status = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/status`, { headers: { Authorization: 'Bearer archive-fixture' } }); assert.equal(status.status, 200); assert.equal((await status.json()).historyArchive, true);
    const index = await call('get_history_archive'); assert.equal(index.total, 1); assert.equal(index.turns[0].entryId, target);
    const turns = await call('get_history_archive', { view: 'turns', start: 0, end: 1, revision: index.revision }); assert.equal(turns.turns[0].reply.text, 'archived final');
    const processView = await call('get_history_archive', { view: 'process', index: 0, revision: index.revision }); assert.equal(processView.total, 2); assert.equal(processView.steps.find(s => s.kind === 'tool').entryId, callId); assert.equal(processView.steps.find(s => s.kind === 'tool').resultEntryId, resultId);
    assert.deepEqual(await call('get_messages'), messages); assert.equal(JSON.stringify(SessionManager.open(session.path).buildSessionContext()), context); assert.deepEqual(fs.readFileSync(session.path), original); assert.equal(requests, 0);
    assert.doesNotMatch(JSON.stringify(index) + JSON.stringify(turns) + JSON.stringify(processView), /THINKING_SENTINEL|TOOL_RESULT_SENTINEL|PRIVATE_DETAILS/);
    assert.ok(!events.some(e => e.type === 'extension_ui_request' && /pivaneHistory|archived final/.test(e.message || '')));
    const worker = gateway.supervisor.getActiveWorker(session.path), originalRequest = worker.client.request.bind(worker.client);
    worker.client.request = async (type, ...rest) => type === 'get_commands' ? { commands: [{ source: 'extension', path: path.join(__dirname, '../server/pi-web-session-extension.ts'), name: require('../server/pivane-compat').INTERNAL_COMMAND, description: 'history-v1; tree-v1' }] } : originalRequest(type, ...rest);
    await assert.rejects(worker.historyRequest('archive', {}), /尚未加载历史接口/); worker.client.request = originalRequest;
});
