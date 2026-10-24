#!/usr/bin/env node
'use strict';

// Run: node test/benchmarks/batch4-backend.cjs --output-dir /private/task/batch4/backend
// Each case runs in a new process, with an allowlisted environment and isolated data roots.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const H = require('../helpers/batch4-backend.cjs');

async function learningCase(memoryRows, activeSkills) {
    const { ProfileKnowledgeService } = require('../../server/profile-memory/knowledge-service');
    const { ProfileLearningService } = require('../../server/profile-memory/learning-service');
    const Database = require('better-sqlite3');
    const bundlePath = require('../../server/pi-bundled-capabilities').memoryBundle();
    const agent = process.env.PI_CODING_AGENT_DIR;
    const profile = { id: H.profileId, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000 },
        skills: { learnedEnabled: true } };
    const profiles = { getProfile: async id => id === profile.id ? profile : null, reserve: work => work() };
    const knowledge = new ProfileKnowledgeService({ profiles, getAgentDir: async () => agent, bundlePath });
    const root = path.join(agent, 'pivane-profiles/data', profile.id);
    fs.mkdirSync(root, { recursive: true });
    const native = await H.nativeHistory(1);
    const manager = native.manager;
    manager.appendCustomEntry('pivane-agent-profile', { version: 1, sessionId: manager.getSessionId(), profileId: profile.id });
    let first = await knowledge.snapshot(profile.id);
    const draftCount = activeSkills ? 7 : 0;
    // Create drafts through the real CAS and native-source proof path, outside timing.
    for (let i = 0; i < draftCount; i++) {
        const result = await knowledge.mutateFromNative(profile.id, { requestId: `batch4-draft-${i}`,
            expectedRevision: first.revision, operation: 'create', kind: 'skill', scope: 'profile', state: 'draft',
            name: `draft-${i}`, description: 'Synthetic draft', content: `Synthetic steps ${i}` },
        { cwd: process.env.PI_PROJECT_ROOTS, sessionPath: native.file, sessionId: manager.getSessionId(), entryId: native.ids[0].user },
        { origin: 'learning', reason: 'review' });
        assert.equal(result.receipt.status, 'saved');
        first = await knowledge.snapshot(profile.id);
    }
    // Installed/profile-owned source files and read-only legacy SQLite rows are fixture inputs.
    for (let i = 0; i < activeSkills; i++) {
        const skill = path.join(root, 'skills', `skill-${String(i).padStart(4, '0')}`);
        fs.mkdirSync(skill, { recursive: true });
        fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: skill-${String(i).padStart(4, '0')}\ndescription: Synthetic\n---\nSynthetic steps ${i}.\n`);
    }
    const db = new Database(path.join(root, 'sessions.db'));
    try {
        db.exec('CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, project TEXT, target TEXT, category TEXT, content TEXT, created TEXT, last_referenced TEXT, hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT)');
        const insert = db.prepare('INSERT INTO memories(project,target,category,content,created,last_referenced) VALUES(NULL,?,?,?,?,?)');
        db.transaction(() => { for (let i = 0; i < memoryRows; i++) insert.run('memory', 'fact', `Synthetic read-only knowledge ${i}`, '2026-01-01', '2026-01-01'); })();
    } finally { db.close(); }
    const service = new ProfileLearningService({ profiles, knowledge, getAgentDir: async () => agent,
        store: {}, preferences: { getMemoryModels: () => Object.fromEntries(['memory-correction', 'memory-review', 'memory-extraction']
            .map(purpose => [purpose, { provider: '', modelId: '' }])) },
        createModelRuntime: async () => { throw new Error('No model allowed'); } });
    clearInterval(service.timer);
    try {
        const knowledgeOnly = await H.measure(() => knowledge.snapshot(profile.id), value => {
            assert.equal(value.status, 'ready'); assert.equal(value.counts.skill.draft, draftCount);
            assert.equal(value.counts.skill.active, activeSkills); assert.equal(value.counts.memory.total, memoryRows);
            return { revision: value.revision, counts: value.counts, jsonBytes: Buffer.byteLength(JSON.stringify(value)) };
        });
        const status = await H.measure(() => service.snapshot(profile.id), value => {
            assert.equal(value.status, 'ready'); assert.deepEqual(value.drafts, { pending: draftCount });
            return { drafts: value.drafts, jsonBytes: Buffer.byteLength(JSON.stringify(value)) };
        });
        // Count separately: instrumented traversal/query probes are excluded from timing samples.
        const calls = [], original = knowledge.snapshot.bind(knowledge);
        knowledge.snapshot = async (id, options) => { calls.push(options || {}); return original(id, options); };
        const probe = H.sqliteProbe(Database);
        let probed;
        try { probed = await service.snapshot(profile.id); } finally { probe.restore(); }
        assert.deepEqual(probed.drafts, { pending: draftCount });
        return { scope: 'full ProfileLearningService.snapshot method; excludes Express/auth/HTTP serialization',
            fixture: { memoryRows, activeSkills, draftCount, sqliteBytes: fs.statSync(path.join(root, 'sessions.db')).size },
            knowledgeOnly, status, probe: { knowledgeCalls: calls, sqliteStatements: probe.counts, sqliteRowsReturned: probe.rowsReturned,
                sqliteStatementExecutions: Object.values(probe.counts).reduce((a, b) => a + b, 0) } };
    } finally { await service.dispose(); }
}

async function learningSemantics() {
    const { ProfileLearningService } = require('../../server/profile-memory/learning-service');
    const cases = [];
    async function check(name, rows, expected, { changeAt = -1, ready = true, skill = true } = {}) {
        let calls = 0;
        const service = Object.create(ProfileLearningService.prototype);
        service.knowledge = { snapshot: async (_id, options) => {
            calls++;
            return { status: 'ready', revision: calls === changeAt ? 'changed' : 'one',
                items: rows.slice(options.offset, options.offset + 50), hasMore: rows.length > options.offset + 50 };
        } };
        const result = await service.pendingDrafts(H.profileId, { status: ready ? 'ready' : 'pending', revision: 'one', capabilities: { skill } });
        assert.deepEqual(result, expected, name);
        cases.push({ name, rows: rows.length, actualDrafts: rows.filter(row => row.state === 'draft').length, result, calls });
    }
    const rows = (count, state) => Array.from({ length: count }, () => ({ kind: 'skill', state }));
    await check('zero', [], { pending: 0 });
    await check('seven after sixty active', [...rows(60, 'active'), ...rows(7, 'draft')], { pending: 7 });
    await check('exactly 200 is not capped', rows(200, 'draft'), { pending: 200 });
    await check('201 is capped', rows(201, 'draft'), { pending: 200, capped: true });
    await check('scan bound hides a late draft', [...rows(1000, 'active'), ...rows(1, 'draft')], { pending: 0, capped: true });
    await check('scan bound exactly reached remains capped when more skills exist', [...rows(1, 'draft'), ...rows(1000, 'active')], { pending: 1, capped: true });
    await check('revision change returns only earlier pages', rows(80, 'draft'), { pending: 50 }, { changeAt: 2 });
    await check('capability disabled', rows(5, 'draft'), { pending: 0 }, { skill: false });
    await check('pending knowledge', rows(5, 'draft'), { pending: 0 }, { ready: false });
    return { scope: 'pendingDrafts with isolated fake knowledge service; semantic probes only', cases };
}

async function pairsCase(count, edits) {
    const { pairs, sourceSha256 } = H.learningInternals();
    const history = await H.nativeHistory(count, { edits });
    const branch = history.manager.getBranch();
    const timed = await H.measure(() => pairs(branch), rows => {
        assert.equal(rows.length, count);
        assert.equal(rows[0].userText, edits ? 'edited question-0' : 'question-0:' + 'u'.repeat(64));
        assert.equal(rows.at(-1).user.id, history.ids.at(-1).user);
        return { rows: rows.length, lastUserText: rows.at(-1).userText,
            outputSha256: H.hash(JSON.stringify(rows.map(row => [row.user.id, row.assistant.id, row.userText, row.assistantText]))) };
    });
    const counted = H.countedBranch(branch);
    const rows = pairs(counted.branch);
    assert.equal(rows.length, count);
    assert.deepEqual(rows, pairs(branch), 'Iteration instrumentation must preserve the complete pair output');
    return { scope: 'exact private pairs(branch), exposed only in memory; excludes JSONL open, source/fork proof, cursor and job journal',
        sourceSha256, fixture: { pairs: count, edits: edits ? count : 0, branchEntries: branch.length, jsonlBytes: history.bytes },
        timed, probe: { ...counted.counts, baselineReferenceTraversals: 1 + count * 3 } };
}

async function pairSemantics() {
    const { pairs } = H.learningInternals();
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const m = SessionManager.inMemory(process.env.PI_PROJECT_ROOTS);
    const u = text => m.appendMessage({ role: 'user', content: text, timestamp: 1 });
    const a = text => m.appendMessage(H.assistant(text));
    const old = u('old source'); a('old answer');
    m.appendCustomEntry('pivane-learning-baseline', { source: 'import' });
    const one = u('question one'); const reply = a('answer one');
    m.appendContextEdit(one, { content: 'first edit' });
    m.appendContextEdit(one, { content: 'last edit' });
    m.appendContextEdit(reply, { content: [{ type: 'text', text: 'edited answer' }] });
    const deleted = u('deleted question'); a('retained assistant'); m.appendContextEdit(deleted, null);
    const omitted = u('question with omitted reply'); const omittedReply = a('omitted'); m.appendContextEdit(omittedReply, null);
    // A synthetic cron message breaks user/assistant pairing, as in production.
    m.appendCustomMessageEntry('pivane-cron-message', 'synthetic schedule', true, {}); a('cron answer');
    const forkAt = m.getLeafId();
    const abandonedUser = u('abandoned branch'); a('abandoned answer'); m.appendContextEdit(one, { content: 'abandoned edit' });
    m.branch(forkAt); const active = u('active branch'); a('active answer');
    const branch = m.getBranch(), before = H.hash(JSON.stringify(m.getEntries()));
    const rows = pairs(branch);
    assert.deepEqual(rows.map(row => row.user.id), [one, deleted, active]);
    assert.deepEqual(rows.map(row => row.userText), ['last edit', '', 'active branch']);
    assert.equal(rows[0].assistantText, 'edited answer');
    assert.ok(!rows.some(row => [old, omitted, abandonedUser].includes(row.user.id)));
    assert.equal(H.hash(JSON.stringify(m.getEntries())), before);
    return { scope: 'native SessionManager branch semantics with exact pairs function',
        verified: ['baseline exclusion', 'last edit wins', 'string and block replacements', 'null user text',
            'null assistant omission', 'cron pairing fence', 'abandoned branch edit excluded', 'read-only source'],
        rows: rows.map(row => ({ userText: row.userText, assistantText: row.assistantText })) };
}

async function queueCase(count) {
    const history = await H.nativeHistory(count, { textBytes: 512 });
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const { installQueueAdapter, queueEnvelopePrefix } = await import('../../server/pi-queue-adapter.mjs');
    const files = require('../../server/pi-maintenance-files');
    const agent = new Agent(), manager = history.manager;
    const events = [], token = randomUUID();
    const session = { agent, sessionManager: manager, prompt() {}, sendCustomMessage() {}, sendUserMessage() {},
        steer(text) { agent.steer({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }); },
        followUp(text) { agent.followUp({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }); },
        clearQueue() { agent.clearAllQueues(); } };
    installQueueAdapter(session, { token, sessionPath: history.file, sessionId: manager.getSessionId(), emit: event => events.push(event) });
    async function trackedMessage() {
        const id = randomUUID();
        await session.steer(queueEnvelopePrefix + JSON.stringify({ token, id, message: 'Synthetic queue physical proof' }));
        const message = agent.peekQueuedMessages()[0]; agent.clearSteeringQueue();
        return { id, message };
    }
    let expected;
    // Measure the wrapped native append, proof and event emission; record enrollment separately via the inner timing.
    async function operation() {
        expected = await trackedMessage();
        const { performance } = require('node:perf_hooks');
        const started = performance.now();
        const entryId = manager.appendMessage(expected.message);
        return { entryId, appendAndProofMs: performance.now() - started };
    }
    const timed = await H.measure(operation, value => {
        const event = events.find(event => event.phase === 'persisted' && event.id === expected.id);
        assert.ok(event); assert.equal(event.entryId, value.entryId);
        assert.equal(event.entryHash, H.hash(JSON.stringify(manager.getEntry(value.entryId))));
        return { entryId: value.entryId, appendAndProofMs: value.appendAndProofMs,
            persistedEventBytes: Buffer.byteLength(JSON.stringify(event)), jsonlBytes: fs.statSync(history.file).size };
    });
    const readSafe = files.readSafe, jsonParse = JSON.parse;
    const probe = { safeReads: 0, safeReadBytes: 0, jsonParseCalls: 0 };
    files.readSafe = (...args) => { const bytes = readSafe(...args); probe.safeReads++; probe.safeReadBytes += bytes.length; return bytes; };
    JSON.parse = (...args) => { probe.jsonParseCalls++; return jsonParse(...args); };
    try { const queued = await trackedMessage(); manager.appendMessage(queued.message); } finally { files.readSafe = readSafe; JSON.parse = jsonParse; }
    // A malformed final frame must retain uncertainty, then a later valid append may prove it.
    const pending = await trackedMessage(), before = events.length;
    fs.appendFileSync(history.file, '{partial');
    manager.appendMessage(pending.message);
    assert.equal(events.slice(before).some(event => event.phase === 'persisted' && event.id === pending.id), false);
    return { scope: 'real Agent queue + native SessionManager append + installQueueAdapter prove; outer timing also includes synthetic enrollment, inner appendAndProofMs excludes it; no RPC worker/store/HTTP',
        fixture: { pairs: count, initialJsonlBytes: history.bytes, textBytesPerMessage: 512 }, timed, probe,
        semantic: { exactNativeEntryHash: true, malformedTailNeverProven: true } };
}

async function previewCase(bytes) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { previewHistory, documentOf } = require('../../server/pi-history-model');
    const m = SessionManager.inMemory(process.env.PI_PROJECT_ROOTS);
    m.appendMessage({ role: 'user', content: 'Synthetic large reply', timestamp: 1 });
    const blocks = Array.from({ length: Math.ceil(bytes / 4096) }, (_, i) => ({ type: 'text', text: 'x'.repeat(Math.min(4096, bytes - i * 4096)) }));
    blocks.push({ type: 'thinking', thinking: 'PRIVATE_SYNTHETIC_THINKING', thinkingSignature: 'PRIVATE_SIGNATURE' });
    const id = m.appendMessage({ ...H.assistant(), content: blocks });
    const timed = await H.measure(() => previewHistory(m, { entryId: id }, { settled: true }), value => {
        assert.equal(value.text.length, 16000); assert.ok(value.hasMore);
        assert.equal(value.totalCharacters, bytes + Math.ceil(bytes / 4096) - 1);
        const payload = JSON.stringify(value);
        assert.ok(!payload.includes('PRIVATE_'));
        const privateResponse = { pivaneHistory: 'synthetic-history-request', success: true, data: value };
        const notify = { type: 'extension_ui_request', method: 'notify', message: JSON.stringify(privateResponse) };
        const ws = { type: 'response', id: 'synthetic-browser-request', command: 'get_history_entry', success: true, data: value };
        return { fullDocumentCharacters: value.totalCharacters, returnedCharacters: value.text.length,
            responseBytes: Buffer.byteLength(payload), privateResponseBytes: Buffer.byteLength(JSON.stringify(privateResponse)),
            rpcNotifyFrameBytes: Buffer.byteLength(JSON.stringify(notify) + '\n'), websocketResponseBytes: Buffer.byteLength(JSON.stringify(ws)) };
    });
    let textReads = 0, presentedTextBytes = 0;
    for (const block of blocks) if (block.type === 'text') {
        const text = block.text;
        Object.defineProperty(block, 'text', { configurable: true, get() { textReads++; presentedTextBytes += Buffer.byteLength(text); return text; } });
    }
    previewHistory(m, { entryId: id }, { settled: true });
    // Enforce the existing 8 MiB per-record boundary, with no relaxed budget.
    assert.throws(() => documentOf({ type: 'message', message: H.assistant('z'.repeat(8 * 1024 * 1024)) }), error => error.code === 'HISTORY_LIMIT');
    return { scope: 'previewHistory on native in-memory SessionManager; serialized frame size modeled from current wrappers, no actual IPC or browser handler timing',
        fixture: { textBytes: bytes, textBlocks: blocks.length - 1, nativeEntries: m.getEntries().length }, timed,
        probe: { textGetterReadsIncludingKindClassification: textReads, textBytesAccessedIncludingKindClassification: presentedTextBytes,
            documentOfProcessesAllTextBlocksBeforeSlicing: true }, semantic: { hiddenThinkingExcluded: true, existing8MiBBoundEnforced: true } };
}

async function taskCase(count) {
    const { TaskReturns } = require('../../server/pi-task-returns');
    const workers = new Map(), sources = new Map(), records = [];
    for (let i = 0; i < 20; i++) {
        const id = `source-${i}`;
        sources.set(id, { receipts: new Set(), read: new Set(), path: path.join(process.env.PI_PROJECT_ROOTS, id) });
        workers.set(id, { cwd: process.env.PI_PROJECT_ROOTS, sessionId: id, isIdle: () => true,
            taskReturn: () => { throw new Error('All synthetic results are already delivered'); } });
    }
    for (let i = 0; i < count; i++) records.push({ sourceMatches: true,
        session: { id: `task-${i}`, path: `synthetic-${i}`, cwd: process.env.PI_PROJECT_ROOTS, name: `Synthetic task ${i}` },
        task: { requestId: `request-${i}`, returnResults: true, source: { sessionId: `source-${i % 20}` } }, state: { status: 'settled' },
        results: Array.from({ length: 3 }, (_, run) => ({ resultId: `run-${run}`, outcome: 'completed', completedAt: '2026-01-01', preview: 'Synthetic result' })) });
    const snapshot = { complete: true, coverage: { files: count, checked: count }, records };
    let refreshes = 0, sourceReads = 0;
    const catalog = { refresh: async () => { refreshes++; return snapshot; }, source: async (_cwd, id) => { sourceReads++; return sources.get(id); } };
    const service = new TaskReturns({ catalog, supervisor: { workers, getActiveWorker: () => undefined }, isSuspended: () => false });
    clearInterval(service.timer);
    for (const record of records) for (const state of record.results) sources.get(record.task.source.sessionId).receipts.add(service.result(record, state).deliveryId);
    try {
        const timed = await H.measure(() => service.pump(), async () => {
            const value = await service.listSnapshot(process.env.PI_PROJECT_ROOTS, 'source-0', snapshot, { pendingOnly: true });
            assert.deepEqual(value.results, []); assert.equal(value.total, Math.ceil(count / 20) * 3);
            return { pendingResults: 0, relatedResultsForFirstSource: value.total };
        });
        refreshes = 0; sourceReads = 0;
        const probe = { recordFilterTraversals: 0, recordFilterVisits: 0, resultHashes: 0 };
        const nativeFilter = records.filter;
        records.filter = function (predicate) { probe.recordFilterTraversals++; return nativeFilter.call(this, (...args) => { probe.recordFilterVisits++; return predicate(...args); }); };
        const result = service.result.bind(service);
        service.result = (...args) => { probe.resultHashes++; return result(...args); };
        await service.pump();
        assert.equal(refreshes, 1); assert.equal(sourceReads, 20);
        assert.equal(probe.recordFilterVisits, count * 20); assert.equal(probe.resultHashes, count * 3);
        return { scope: 'full TaskReturns.pump with isolated fake catalog/source reads; excludes actual TaskCatalog descriptor scanning and native receipt writes',
            fixture: { records: count, workers: 20, resultsPerRecord: 3, pendingResults: 0 }, timed,
            probe: { ...probe, catalogRefreshes: refreshes, sourceReads } };
    } finally { await service.dispose(); }
}

async function child(kind, size) {
    H.denyNetwork();
    const result = kind === 'learning' ? await learningCase(size, size === 250 ? 0 : size === 1000 ? 60 : 250)
        : kind === 'learning-semantics' ? await learningSemantics()
        : kind === 'pairs' ? await pairsCase(size, true)
        : kind === 'pairs-unedited' ? await pairsCase(size, false)
        : kind === 'pairs-semantics' ? await pairSemantics()
        : kind === 'queue' ? await queueCase(size)
        : kind === 'preview' ? await previewCase(size)
        : kind === 'tasks' ? await taskCase(size) : assert.fail(`Unknown case ${kind}`);
    console.log(JSON.stringify({ kind, size, node: process.version, platform: process.platform, arch: process.arch,
        isolation: { environmentAllowlisted: true, networkDenied: true, independentHomeAgentProjectMediaQueue: true }, ...result }));
}

function main() {
    const index = process.argv.indexOf('--output-dir');
    assert.ok(index > 0 && process.argv[index + 1], '--output-dir is required');
    const output = path.resolve(process.argv[index + 1]);
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const cases = [['learning-semantics', 0], ['learning', 250], ['learning', 1000], ['learning', 4000],
        ['pairs-semantics', 0], ['pairs', 250], ['pairs', 1000], ['pairs', 4000], ['pairs-unedited', 1000],
        ['queue', 250], ['queue', 1000], ['queue', 4000],
        ['preview', 65536], ['preview', 1048576], ['preview', 4194304], ['tasks', 250], ['tasks', 1000], ['tasks', 4000]];
    const selected = process.argv.includes('--case') ? cases.filter(([kind, size]) => `${kind}-${size}` === process.argv[process.argv.indexOf('--case') + 1]) : cases;
    assert.ok(selected.length, 'No matching case');
    const results = [], failures = [];
    for (const [kind, size] of selected) {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'batch4-backend-'));
        for (const name of ['home', 'agent', 'project', 'media', 'queue']) fs.mkdirSync(path.join(fixture, name), { mode: 0o700 });
        const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
            HOME: path.join(fixture, 'home'), USERPROFILE: path.join(fixture, 'home'), XDG_CONFIG_HOME: path.join(fixture, 'home/config'),
            XDG_CACHE_HOME: path.join(fixture, 'home/cache'), PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
            PI_PROJECT_ROOTS: path.join(fixture, 'project'), BATCH4_MEDIA_ROOT: path.join(fixture, 'media'), BATCH4_QUEUE_ROOT: path.join(fixture, 'queue') };
        const run = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', kind, String(size)],
            { cwd: H.repo, env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
        fs.writeFileSync(path.join(output, `${kind}-${size}.stdout.log`), run.stdout || '');
        fs.writeFileSync(path.join(output, `${kind}-${size}.stderr.log`), run.stderr || '');
        try {
            if (run.status !== 0) throw new Error(`${run.error?.message || `exit ${run.status}`} ${run.stderr}`);
            const result = JSON.parse(run.stdout);
            fs.writeFileSync(path.join(output, `${kind}-${size}.json`), JSON.stringify(result, null, 2) + '\n');
            results.push(result);
            console.log(`${kind}-${size}: ${result.status?.warmMedianMs ?? result.timed?.warmMedianMs ?? 'semantic assertions passed'}`);
        } catch (error) { failures.push({ kind, size, error: error.message }); console.error(`${kind}-${size}: failed (see private log)`); }
        finally { fs.rmSync(fixture, { recursive: true, force: true }); }
        // Per-case records are authoritative; preserve completed evidence even on later failure.
        fs.writeFileSync(path.join(output, 'run-index.json'), JSON.stringify({ createdAt: new Date().toISOString(),
            node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
            measurementMode: 'read-only-current-source', concurrentOtherLanesPossible: true,
            samples: { first: 1, warm: 3, gcBeforeEachSample: true, queryTraversalProbesSeparate: true },
            scripts: { benchmark: H.hash(fs.readFileSync(__filename)), helper: H.hash(fs.readFileSync(path.join(__dirname, '../helpers/batch4-backend.cjs'))) },
            completed: results.map(result => `${result.kind}-${result.size}`), failures }, null, 2) + '\n');
    }
    if (failures.length) process.exitCode = 1;
}

if (process.argv[2] === '--child') child(process.argv[3], Number(process.argv[4])).catch(error => { console.error(error.stack); process.exitCode = 1; });
else main();
