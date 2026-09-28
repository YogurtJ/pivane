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
