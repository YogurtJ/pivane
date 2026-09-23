'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scope = require('../server/profile-memory/scope');
const indexer = require('../server/profile-memory/index');
const { createMutationLock } = require('../server/profile-memory/mutation-lock');
const { spawn } = require('node:child_process');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const jitiPath = process.env.PIVANE_TEST_PI_JITI;
const gate = !bundle || !jitiPath ? 'Verified bundle and Pi jiti required' : false;

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-runtime-final-'));
    const agent = path.join(base, 'agent');
    const sessionsRoot = path.join(agent, 'sessions');
    const cwd = path.join(base, 'workspace');
    fs.mkdirSync(path.join(sessionsRoot, 'project'), { recursive: true });
    fs.mkdirSync(cwd);
    const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const root = path.join(agent, 'pivane-profiles', 'data', profileId);
    const create = (id, text) => {
        const file = path.join(sessionsRoot, 'project', `${id}.jsonl`);
        const header = { type: 'session', id, cwd, timestamp: new Date().toISOString() };
        const entries = [header, { type: 'custom', id: `${id}-binding`, customType: 'pivane-agent-profile',
            data: { version: 1, sessionId: id, profileId } },
        { type: 'message', id: `${id}-msg`, timestamp: new Date().toISOString(),
            message: { role: 'user', content: [{ type: 'text', text }] } }];
        fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
        return { file, header, entries };
    };
    const context = session => ({ version: 1, profileId, sessionId: session.header.id, sessionPath: session.file,
        cwd, sessionsRoot, profileRoot: root, memory: { enabled: true, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } });
    return { base, root, create, context, cwd, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('profile mutation revision is serialized across processes and stale CAS is rejected', async t => {
    const f = fixture(); t.after(f.cleanup);
    fs.mkdirSync(f.root, { recursive: true });
    const child = spawn(process.execPath, ['-e', `const {createMutationLock}=require(${JSON.stringify(path.join(__dirname, '../server/profile-memory/mutation-lock'))});
        createMutationLock(process.argv[1]).run(undefined, async () => {
            process.stdout.write('locked\\n');
            await new Promise(resolve => setTimeout(resolve, 150));
        }).catch(error => { console.error(error); process.exitCode=1; });`, f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
    const childExit = new Promise(resolve => child.once('exit', resolve));
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`child exited before lock: ${code}`)));
    });
    let wrote = false;
    const result = await createMutationLock(f.root).run(undefined, () => { wrote = true; }, 0);
    assert.deepEqual(result, { conflict: true });
    assert.equal(wrote, false);
    const exit = await childExit;
    assert.equal(exit, 0);
});

test('active session beyond history page and 8 MiB retains tools while recall reports partial', { skip: gate }, async t => {
    const f = fixture(); t.after(f.cleanup);
    const dir = path.dirname(f.create('00000', 'older').file);
    for (let i = 1; i <= 5001; i++) fs.writeFileSync(path.join(dir, String(i).padStart(5, '0') + '.jsonl'), '{}\n');
    const active = f.create('zzzzz', 'x'.repeat(8 * 1024 * 1024));
    const context = scope.parseContext(JSON.stringify(f.context(active)));
    assert.ok(scope.verifyNativeSession(context));
    assert.equal(scope.snapshot(active.file, context), null, 'index byte cap stays in force');
    const { registerProfileMemory } = require(jitiPath).createJiti(path.join(__dirname, '../server/profile-memory/extension.ts'))(
        path.join(__dirname, '../server/profile-memory/extension.ts'));
    const oldContext = process.env.PIVANE_AGENT_PROFILE_CONTEXT, oldBundle = process.env.PIVANE_HERMES_BUNDLE;
    t.after(() => {
        if (oldContext === undefined) delete process.env.PIVANE_AGENT_PROFILE_CONTEXT;
        else process.env.PIVANE_AGENT_PROFILE_CONTEXT = oldContext;
        if (oldBundle === undefined) delete process.env.PIVANE_HERMES_BUNDLE;
        else process.env.PIVANE_HERMES_BUNDLE = oldBundle;
    });
    process.env.PIVANE_AGENT_PROFILE_CONTEXT = JSON.stringify(context);
    process.env.PIVANE_HERMES_BUNDLE = bundle;
    const events = new Map(), tools = new Map();
    const pi = { on(name, fn) { events.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); } };
    await registerProfileMemory(pi);
    const manager = { getHeader: () => active.header, getEntries: () => active.entries,
        getSessionId: () => active.header.id, getSessionFile: () => active.file };
    const ctx = { mode: 'rpc', cwd: f.cwd, sessionManager: manager };
    await events.get('session_start')({}, ctx);
    assert.ok(tools.has('memory_add'));
    assert.ok(tools.has('skill_manage'));
    assert.equal((await tools.get('memory_add').execute('call', { target: 'memory', content: 'large-active-fact' }, undefined, undefined, ctx)).details.success, true);
    const pendingFile = path.join(f.root, '.pivane-memory-index-memory.pending');
    fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, target: 'memory', before: null,
        after: 'a'.repeat(64), old: [], next: [] }), { mode: 0o600 });
    try {
        await assert.rejects(tools.get('memory_search').execute('call', { query: 'large-active-fact', target: 'memory' },
            undefined, undefined, ctx), /index needs repair/);
        await assert.rejects(tools.get('memory_search').execute('call', { query: 'large-active-fact' },
            undefined, undefined, ctx), /index needs repair/);
        await assert.rejects(tools.get('memory_add').execute('call', { target: 'memory', content: 'blocked' },
            undefined, undefined, ctx), /index needs repair/);
    } finally { fs.unlinkSync(pendingFile); }
    assert.ok((await tools.get('memory_search').execute('call', { query: 'large-active-fact', target: 'memory' },
        undefined, undefined, ctx)).details.count);
    const result = await tools.get('session_search').execute('call', { query: 'older' }, undefined, undefined, ctx);
    assert.equal(result.details.coverage.initialSweepComplete, false);
    for (let i = 0; i < 28; i++) await events.get('agent_settled')({}, ctx);
    const afterSweep = await tools.get('session_search').execute('call', { query: 'older' }, undefined, undefined, ctx);
    assert.equal(afterSweep.details.coverage.initialSweepComplete, true);
    assert.equal(afterSweep.details.coverage.limited, true);
    assert.ok(events.get('resources_discover')({}, ctx).skillPaths.length);
    events.get('session_shutdown')({}, ctx);
});

test('completed sweep distinguishes ineligible files from capped historical sources', { skip: gate }, async t => {
    const f = fixture(); t.after(f.cleanup);
    const own = f.create('own', 'verified body');
    const context = scope.parseContext(JSON.stringify(f.context(own)));
    const invalid = path.join(path.dirname(own.file), 'unbound.jsonl');
    fs.writeFileSync(invalid, '{}\n');
    const upstream = await import(bundle);
    const db = new upstream.DatabaseManager(f.root);
    const index = indexer.createIndex(db, upstream, context);
    const clean = index.advance();
    assert.equal(clean.initialSweepComplete, true);
    assert.equal(clean.limited, false);
    const huge = path.join(path.dirname(own.file), 'oversize.jsonl');
    fs.writeFileSync(huge, 'x'.repeat(8 * 1024 * 1024 + 1));
    const partial = index.advance();
    assert.equal(partial.initialSweepComplete, true);
    assert.equal(partial.limited, true);
    fs.unlinkSync(huge);
    assert.equal(index.advance().limited, false, 'a completed clean sweep clears historical partial coverage');
    fs.appendFileSync(own.file, JSON.stringify({ type: 'message', id: 'large-later', timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'x'.repeat(8 * 1024 * 1024) } }) + '\n');
    assert.equal(index.reconcile(), true);
    assert.equal(index.coverage().limited, true, 'growth beyond the cap invalidates complete coverage immediately');
    assert.equal(db.getDb().prepare('SELECT COUNT(*) AS total FROM pivane_sources').get().total, 0);
    index.close();
});

test('two SQLite connections replace one source with atomic provenance and stale snapshot rejection', { skip: gate }, async t => {
    const f = fixture(); t.after(f.cleanup);
    const session = f.create('one', 'original indexed body');
    const context = scope.parseContext(JSON.stringify(f.context(session)));
    const upstream = await import(bundle);
    const firstDb = new upstream.DatabaseManager(f.root), secondDb = new upstream.DatabaseManager(f.root);
    const first = indexer.createIndex(firstDb, upstream, context);
    const second = indexer.createIndex(secondDb, upstream, context);
    assert.equal(first.index(session.file), true);
    const stale = scope.snapshot(session.file, context);
    fs.writeFileSync(session.file, session.entries.map(e => JSON.stringify(e.type === 'message'
        ? { ...e, message: { role: 'user', content: [{ type: 'text', text: 'replacement indexed body' }] } } : e)).join('\n') + '\n');
    const seen = [];
    const observing = { ...upstream, indexSession(db, parsed) {
        const other = secondDb.getDb();
        seen.push({ source: other.prepare('SELECT fingerprint FROM pivane_sources WHERE session_id = ?').get('one')?.fingerprint,
            messages: other.prepare('SELECT content FROM messages WHERE session_id = ?').all('one').map(r => r.content) });
        return upstream.indexSession(db, parsed);
    } };
    const observingIndex = indexer.createIndex(firstDb, observing, context);
    assert.equal(observingIndex.index(session.file), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, stale.fingerprint);
    assert.ok(seen[0].messages.some(text => text.includes('original indexed body')));
    assert.equal(second.index(session.file, stale), false, 'another connection cannot publish obsolete bytes');
    const row = secondDb.getDb().prepare('SELECT fingerprint FROM pivane_sources WHERE session_id = ?').get('one');
    assert.equal(row.fingerprint, scope.snapshot(session.file, context).fingerprint);
    const messages = secondDb.getDb().prepare('SELECT content FROM messages WHERE session_id = ?').all('one');
    assert.ok(messages.some(r => r.content.includes('replacement indexed body')));
    assert.ok(messages.every(r => !r.content.includes('original indexed body')));
    fs.writeFileSync(session.file, session.entries.map(e => JSON.stringify(e.type === 'message'
        ? { ...e, message: { role: 'user', content: [{ type: 'text', text: 'second connection body' }] } } : e)).join('\n') + '\n');
    assert.equal(second.index(session.file), true);
    assert.equal(first.index(session.file, stale), false);
    const finalSource = firstDb.getDb().prepare('SELECT fingerprint FROM pivane_sources WHERE session_id = ?').get('one');
    assert.equal(finalSource.fingerprint, scope.snapshot(session.file, context).fingerprint);
    const finalMessages = firstDb.getDb().prepare('SELECT content FROM messages WHERE session_id = ?').all('one');
    assert.ok(finalMessages.some(r => r.content.includes('second connection body')));
    assert.ok(finalMessages.every(r => !r.content.includes('replacement indexed body')));
    first.close(); second.close();
});
