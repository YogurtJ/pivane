'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createBackgroundIndex } = require('../server/profile-memory/background-index');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
test('large history refresh and verified search leave the parent responsive and never read native bytes there', {
    skip: !bundle, timeout: 30000,
}, async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-background-index-'));
    const context = { profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: base,
        profileRoot: path.join(base, 'memory'), sessionsRoot: path.join(base, 'sessions') };
    fs.mkdirSync(context.profileRoot);
    fs.mkdirSync(path.join(context.sessionsRoot, 'project'), { recursive: true });
    const file = path.join(context.sessionsRoot, 'project', 'large.jsonl');
    const header = { type: 'session', version: 3, id: 'large', cwd: base, timestamp: new Date().toISOString() };
    const marker = { type: 'custom', id: 'binding', customType: 'pivane-agent-profile', data: {
        version: 1, sessionId: header.id, profileId: context.profileId } };
    const entries = [header, marker];
    for (let i = 0; i < 450; i++) entries.push({ type: 'message', id: 'm'+i, parentId: i ? 'm'+(i-1) : 'binding',
        timestamp: header.timestamp, message: { role: 'user', content: [{ type: 'text', text: 'backgroundneedle '.repeat(1000) }] } });
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n')+'\n');
    const index = createBackgroundIndex(context, bundle);
    t.after(async () => { await index.close(); fs.rmSync(base, { recursive: true, force: true }); });
    const io = require('../server/pi-file-io');
    const original = io.openReadSync;
    let reads = 0;
    io.openReadSync = filename => { if (filename === file) reads++; return original(filename); };
    t.after(() => { io.openReadSync = original; });
    let ticks = 0, maxDelay = 0, previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now-previous); previous = now; ticks++; }, 10);
    t.after(() => clearInterval(timer));
    index.schedule(file);
    for (let i=0;i<10;i++) index.schedule(file);
    const result = await index.search({ query: 'backgroundneedle' });
    assert.ok(result.details.count > 0);
    assert.equal(reads, 0, 'parent must not snapshot JSONL for settled indexing or search');
    assert.ok(ticks > 2, 'RPC event loop runs throughout indexing');
    assert.ok(maxDelay < 1000, `event loop stalled for ${maxDelay}ms`);
    fs.writeFileSync(file, [header, { ...marker, data: { ...marker.data, profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }]
        .map(entry => JSON.stringify(entry)).join('\n')+'\n');
    const rebound = await index.search({ query: 'backgroundneedle' });
    assert.equal(rebound.details.count || 0, 0, 'source proof removes rebound history before exposing snippets');
});

// Exercise the real coordinator with controlled worker replies; JSONL/SQLite
// locking is covered separately by the real-worker concurrency regression.
function controlledIndex(t) {
    const { EventEmitter } = require('node:events');
    const vm = require('node:vm');
    let worker, releaseTermination;
    const termination = new Promise(resolve => { releaseTermination = resolve; });
    class ControlledWorker extends EventEmitter {
        constructor() { super(); worker = this; this.sent = []; this.terminations = 0; this.holdTermination = false; }
        postMessage(message) { this.sent.push(message); }
        reply(request, result = {}, error) { this.emit('message', { id: request.id, result, error }); }
        terminate() { this.terminations++; return this.holdTermination ? termination : Promise.resolve(0); }
    }
    const filename = require.resolve('../server/profile-memory/background-index');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, __dirname: path.dirname(filename),
        require: name => name === 'node:worker_threads' ? { Worker: ControlledWorker } : require(name),
    }, { filename });
    const index = module.exports.createBackgroundIndex({}, 'synthetic-bundle');
    t.after(async () => {
        releaseTermination(0);
        worker.emit('error', new Error('Synthetic fixture cleanup'));
        await index.close();
    });
    return { index, worker, releaseTermination };
}
const drainMicrotasks = () => new Promise(resolve => setImmediate(resolve));

test('a failed refresh still drains the single latest pending notification before search', async t => {
    const { index, worker } = controlledIndex(t);
    index.schedule('current'); index.schedule('superseded'); index.schedule('latest');
    const searched = index.search({ query: 'needle' }); searched.catch(() => {});
    assert.equal(worker.sent.length, 1);
    worker.reply(worker.sent[0], undefined, 'Synthetic locked index');
    await drainMicrotasks();
    assert.deepEqual(worker.sent.map(item => [item.operation, item.args?.file]), [['refresh', 'current'], ['refresh', 'latest']]);
    worker.reply(worker.sent[1], { indexed: 1 });
    await drainMicrotasks();
    assert.equal(worker.sent[2].operation, 'search');
    worker.reply(worker.sent[2], { details: { count: 1 } });
    assert.equal((await searched).details.count, 1);
    assert.equal(worker.sent.length, 3, 'failure does not create an automatic retry queue');
});

test('the last failed refresh is visible until an explicitly scheduled refresh succeeds', async t => {
    const { index, worker } = controlledIndex(t);
    index.schedule('current');
    const failed = assert.rejects(index.search({ query: 'needle' }), error =>
        error.code === 'PROFILE_INDEX_REFRESH_FAILED' && /Synthetic unreadable index/.test(error.message));
    worker.reply(worker.sent[0], undefined, 'Synthetic unreadable index');
    await drainMicrotasks();
    // The original coordinator incorrectly posts a normal search after swallowing
    // the failure. Settle it too so this regression fails without leaving work.
    if (worker.sent[1]?.operation === 'search') worker.reply(worker.sent[1], { details: { count: 0 } });
    await failed;
    await assert.rejects(index.search({ query: 'needle' }), error => error.code === 'PROFILE_INDEX_REFRESH_FAILED');
    assert.equal(worker.sent.length, 1, 'search does not automatically retry a failed refresh');
    index.schedule('current');
    const recovered = index.search({ query: 'needle' }); recovered.catch(() => {});
    worker.reply(worker.sent[1], { indexed: 1 });
    await drainMicrotasks();
    assert.equal(worker.sent[2].operation, 'search');
    worker.reply(worker.sent[2], { details: { count: 1 } });
    assert.equal((await recovered).details.count, 1);
});

test('a notification arriving as the previous drain settles is not lost', async t => {
    const { index, worker } = controlledIndex(t);
    index.schedule('first');
    const searched = index.search({ query: 'needle' }); searched.catch(() => {});
    worker.reply(worker.sent[0], { indexed: 1 });
    queueMicrotask(() => index.schedule('next'));
    await drainMicrotasks();
    assert.deepEqual(worker.sent.map(item => [item.operation, item.args?.file]), [['refresh', 'first'], ['refresh', 'next']]);
    worker.reply(worker.sent[1], { indexed: 1 });
    await drainMicrotasks();
    worker.reply(worker.sent[2], { details: { count: 1 } });
    assert.equal((await searched).details.count, 1);
});

test('close drops pending refreshes and waits for the in-flight request and actual worker termination', async t => {
    const { index, worker, releaseTermination } = controlledIndex(t);
    worker.holdTermination = true;
    index.schedule('first'); index.schedule('pending');
    const search = assert.rejects(index.search({ query: 'needle' }), /Profile index is closed/);
    search.catch(() => {});
    const firstClose = index.close(); firstClose.catch(() => {});
    assert.equal(index.close(), firstClose, 'repeated close shares the completion promise');
    let closed = false; firstClose.then(() => { closed = true; }, () => {});
    assert.equal(worker.terminations, 0);
    worker.reply(worker.sent[0], undefined, 'Synthetic refresh failure during close');
    await drainMicrotasks();
    assert.deepEqual(worker.sent.map(item => item.operation), ['refresh', 'close']);
    assert.equal(worker.terminations, 0);
    worker.reply(worker.sent[1]);
    await drainMicrotasks();
    assert.equal(worker.terminations, 1); assert.equal(closed, false);
    releaseTermination(0); await firstClose; await search;
    index.schedule('ignored');
    await assert.rejects(index.search({ query: 'needle' }), /Profile index is closed/);
    assert.equal(worker.sent.length, 2);
});

test('closing after a failed refresh preserves the final coalesced recall batch and shares termination', async t => {
    const { index, worker, releaseTermination } = controlledIndex(t);
    worker.holdTermination = true;
    assert.equal(index.recordHits([1]), true);
    index.schedule('current');
    assert.equal(index.recordHits([1, 2]), true);
    const closing = index.close(); closing.catch(() => {});
    assert.equal(index.close(), closing);
    assert.equal(index.recordHits([3]), false, 'closing rejects late advisory counts');
    worker.reply(worker.sent[0], { recorded: 1 });
    worker.reply(worker.sent[1], undefined, 'Synthetic refresh failure during close');
    await drainMicrotasks();
    assert.deepEqual(worker.sent.map(item => item.operation), ['hits', 'refresh', 'hits', 'close']);
    assert.deepEqual(JSON.parse(JSON.stringify(worker.sent[2].args.counts)), [[1, 1], [2, 1]]);
    let closed = false; closing.then(() => { closed = true; }, () => {});
    worker.reply(worker.sent[2], { recorded: 2 });
    await drainMicrotasks();
    assert.equal(worker.terminations, 0, 'counter completion alone does not close the worker');
    worker.reply(worker.sent[3]);
    await drainMicrotasks();
    assert.equal(worker.terminations, 1); assert.equal(closed, false);
    releaseTermination(0); await closing;
    assert.equal(worker.sent.length, 4, 'failure and close do not create retries');
});
