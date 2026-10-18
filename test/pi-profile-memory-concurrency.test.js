'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { createIndex } = require('../server/profile-memory/index');
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;

test('profile index reserves its SQLite writer before reading source rows and completes later archive pages', {
    skip: !bundle, timeout: 30000,
}, async t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-index-writer-')));
    const cwdA = path.join(base, 'one', 'shared'), cwdB = path.join(base, 'two', 'shared');
    const sessionsRoot = path.join(base, 'sessions'), profileRoot = path.join(base, 'profile');
    for (const directory of [cwdA, cwdB, sessionsRoot, profileRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const create = (id, cwd, owner, text) => {
        const directory = path.join(sessionsRoot, `--${id}--`); fs.mkdirSync(directory);
        const file = path.join(directory, id + '.jsonl');
        const entries = [{ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00Z' }];
        if (owner) entries.push({ type: 'custom', id: id + '-binding', customType: 'pivane-agent-profile',
            data: { version: 1, sessionId: id, profileId: owner } });
        entries.push({ type: 'message', id: id + '-message', timestamp: '2026-01-01T00:00:00Z',
            message: { role: 'user', content: [{ type: 'text', text }] } });
        fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
        return file;
    };
    const a = create('a', cwdA, profileId, 'current a'), b = create('b', cwdB, profileId, 'current b');
    for (let i = 0; i < 27; i++) create('archive-' + String(i).padStart(2, '0'), cwdA, profileId, 'archive-key-' + String(i).padStart(2, '0'));
    create('foreign', cwdA, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'foreign-secret');
    create('none', cwdA, null, 'unbound-secret');
    const context = { profileId, profileRoot, sessionsRoot, cwd: cwdB, sessionPath: b, sessionId: 'b' };
    const upstream = await import(pathToFileURL(bundle).href);
    const manager = new upstream.DatabaseManager(profileRoot), db = manager.getDb();
    const index = createIndex(manager, upstream, { ...context, cwd: cwdA, sessionPath: a, sessionId: 'a' });
    const signal = new Int32Array(new SharedArrayBuffer(4));
    let worker;
    const release = () => { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };
    t.after(async () => { release(); await worker?.terminate(); index.close(); fs.rmSync(base, { recursive: true, force: true }); });
    db.exec('CREATE TABLE writer_probe (value INTEGER); INSERT INTO writer_probe VALUES (0)');
    index.index(a);
    assert.equal(index.advance().indexed, 20);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pivane_sources WHERE session_id = 'archive-26'").get().count, 0);
    // Keep this genuine second connection non-blocking while the worker holds its
    // reservation. The production connection retains its existing busy timeout.
    db.pragma('busy_timeout = 0');
    worker = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        const { pathToFileURL } = require('node:url');
        (async () => {
            const upstream = await import(pathToFileURL(workerData.bundle).href);
            const manager = new upstream.DatabaseManager(workerData.context.profileRoot);
            const db = manager.getDb(), prepare = db.prepare.bind(db);
            let paused = false;
            db.prepare = (sql, ...args) => {
                const statement = prepare(sql, ...args);
                if (sql === 'SELECT session_id, fingerprint FROM pivane_sources WHERE path = ?') {
                    const get = statement.get.bind(statement);
                    statement.get = (...values) => {
                        const row = get(...values);
                        if (!paused && values[0] === workerData.context.sessionPath) {
                            paused = true;
                            parentPort.postMessage({ phase: 'read-source-row' });
                            if (Atomics.wait(new Int32Array(workerData.signal), 0, 0, 10000) === 'timed-out')
                                throw new Error('Synthetic writer gate was not released');
                        }
                        return row;
                    };
                }
                return statement;
            };
            const index = require(workerData.indexModule).createIndex(manager, upstream, workerData.context);
            try {
                index.index(workerData.context.sessionPath);
                const advanced = index.advance();
                parentPort.postMessage({ phase: 'done', advanced });
            } finally { index.close(); }
        })().catch(error => parentPort.postMessage({ phase: 'error', message: error.message, code: error.code }));
    `, { eval: true, workerData: { bundle, context, signal: signal.buffer, indexModule: require.resolve('../server/profile-memory/index') } });
    const exited = once(worker, 'exit'); exited.catch(() => {});
    const [ready] = await once(worker, 'message');
    assert.equal(ready.phase, 'read-source-row', JSON.stringify(ready));
    const finished = once(worker, 'message'); finished.catch(() => {});
    try {
        assert.throws(() => db.prepare('UPDATE writer_probe SET value = value + 1').run(),
            error => /^SQLITE_BUSY/.test(error.code), 'another writer cannot commit between the source SELECT and index write');
    } finally { release(); }
    const [done] = await finished;
    assert.equal(done.phase, 'done', JSON.stringify(done));
    assert.equal(done.advanced.initialSweepComplete, true);
    assert.equal((await exited)[0], 0, 'the second connection has finished its close/checkpoint work');
    db.prepare('UPDATE writer_probe SET value = value + 1').run();
    assert.equal(db.prepare('SELECT value FROM writer_probe').get().value, 1, 'the writer reservation is released after commit');
    let search;
    upstream.registerSessionSearchTool({ registerTool: tool => { search = tool; } }, manager, { variant: 'legacy' });
    assert.equal((await search.execute('fixture', { query: 'archive-key-26' })).details.count, 1);
    for (const query of ['foreign-secret', 'unbound-secret']) assert.equal((await search.execute('fixture', { query })).details.count, 0);
});
