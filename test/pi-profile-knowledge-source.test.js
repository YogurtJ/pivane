'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scope = require('../server/profile-memory/scope');
const { ProfileKnowledgeService } = require('../server/profile-memory/knowledge-service');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignProfileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(t) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-source-proof-')));
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const sessionsRoot = path.join(agent, 'sessions');
    const directory = path.join(sessionsRoot, 'project');
    fs.mkdirSync(directory, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(agent, 'cwd-'));
    const sessionId = 'source-session';
    return { agent, sessionsRoot, directory, cwd, sessionId, file: path.join(directory, `${sessionId}.jsonl`),
        context: { sessionsRoot, profileId, sessionId, cwd } };
}

// One branch: binding -> user-1 -> assistant-1; `branch` appends a second branch from the binding.
function rows(f, { body = 'synthetic turn', header = {}, marker, branch = false } = {}) {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const list = [{ type: 'session', id: f.sessionId, cwd: f.cwd, timestamp, ...header }];
    if (marker !== false) list.push({ type: 'custom', id: 'binding-1', parentId: null, customType: 'pivane-agent-profile',
        timestamp, data: { version: 1, sessionId: f.sessionId, profileId, ...(marker || {}) } });
    list.push({ type: 'message', id: 'user-1', parentId: 'binding-1', timestamp,
        message: { role: 'user', content: [{ type: 'text', text: body }] } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } });
    if (branch) list.push(secondBranch(f));
    return list;
}
const secondBranch = f => ({ type: 'message', id: 'user-2', parentId: 'binding-1', timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'other branch' }] } });
const write = (file, list) => fs.writeFileSync(file, list.map(row => JSON.stringify(row)).join('\n') + '\n');

function service(f, { beforeReserve } = {}) {
    const profile = { id: profileId, enabled: true, memory: { enabled: true, memoryCharLimit: 16000, userCharLimit: 8000 },
        skills: { learnedEnabled: true } };
    return new ProfileKnowledgeService({ profiles: {
        getProfile: async key => key === profileId ? profile : null,
        reserve: work => { beforeReserve?.(); return work(); },
    }, getAgentDir: async () => f.agent, bundlePath: bundle });
}

test('source proof keeps only leaf-branch entries and works beyond the 8 MiB history cap', t => {
    const f = fixture(t);
    write(f.file, rows(f, { body: 'x'.repeat(8 * 1024 * 1024) }));
    assert.equal(scope.snapshot(f.file, { sessionsRoot: f.sessionsRoot, profileId }), null, 'history index keeps the 8 MiB bound');
    for (const entryId of ['user-1', 'assistant-1', 'binding-1'])
        assert.ok(scope.sourceProof(f.file, f.context, entryId), `${entryId} is on the current leaf path`);
    assert.equal(scope.sourceProof(f.file, f.context, 'invented'), null, 'unknown entries prove nothing');
    fs.appendFileSync(f.file, JSON.stringify(secondBranch(f)) + '\n');
    for (const entryId of ['user-1', 'assistant-1'])
        assert.equal(scope.sourceProof(f.file, f.context, entryId), null, `${entryId} moved to an abandoned branch`);
    assert.ok(scope.sourceProof(f.file, f.context, 'user-2'));
    assert.ok(scope.sourceProof(f.file, f.context, 'binding-1'), 'the shared ancestor stays on the leaf path');
});

test('source proof rejects wrong headers, bindings, symlinks and replaced files', t => {
    const f = fixture(t);
    write(f.file, rows(f, { header: { id: 'other-session' } }));
    assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'header id must match the claimed session');
    write(f.file, rows(f, { header: { cwd: f.agent } }));
    assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'header cwd must match the claimed cwd');
    write(f.file, rows(f, { marker: false }));
    assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'without a binding marker nothing is proven');
    write(f.file, [...rows(f), { type: 'custom', id: 'binding-2', parentId: null, customType: 'pivane-agent-profile',
        timestamp: '2026-01-01T00:00:02.000Z', data: { version: 1, sessionId: f.sessionId, profileId } }]);
    assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'duplicate current-ID markers are ambiguous');
    write(f.file, rows(f, { marker: { version: 2 } }));
    assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'unknown binding versions are rejected');
    write(f.file, rows(f, { marker: { profileId: foreignProfileId } }));
    assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'foreign profile bindings are rejected');
    write(f.file, rows(f));
    const link = path.join(f.directory, 'link.jsonl');
    fs.symlinkSync(f.file, link);
    assert.equal(scope.sourceProof(link, f.context, 'user-1'), null, 'symbolic links are never opened');
    const io = require('../server/pi-file-io');
    const original = io.openReadSync;
    let replaced = false;
    io.openReadSync = file => {
        const fd = original(file);
        if (!replaced && file === f.file) {
            replaced = true;
            fs.renameSync(f.file, `${f.file}.old`);
            fs.copyFileSync(`${f.file}.old`, f.file);
        }
        return fd;
    };
    try { assert.equal(scope.sourceProof(f.file, f.context, 'user-1'), null, 'a file replaced during the read is rejected'); }
    finally { io.openReadSync = original; }
    assert.ok(scope.sourceProof(f.file, f.context, 'user-1'), 'the replacement itself proves again on the next read');
});

test('source proof fails explicitly past the byte and entry budgets instead of truncating', t => {
    const f = fixture(t);
    fs.writeFileSync(f.file, Buffer.alloc(scope.MAX_SOURCE_BYTES + 1, 0x78));
    assert.throws(() => scope.sourceProof(f.file, f.context, 'user-1'), /exceeds source proof limits/);
    const lines = [JSON.stringify({ type: 'session', id: f.sessionId, cwd: f.cwd, timestamp: '2026-01-01T00:00:00.000Z' })];
    for (let i = 0; i <= scope.MAX_SOURCE_ENTRIES; i++)
        lines.push(JSON.stringify({ type: 'message', id: `e${i}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z' }));
    fs.writeFileSync(f.file, lines.join('\n') + '\n');
    assert.throws(() => scope.sourceProof(f.file, f.context, 'e0'), /exceeds source proof limits/);
});

test('mutateFromNative writes with provenance beyond the 8 MiB session bound', { skip: !bundle }, async t => {
    const f = fixture(t);
    write(f.file, rows(f, { body: 'x'.repeat(8 * 1024 * 1024) }));
    const native = { sessionPath: f.file, sessionId: f.sessionId, entryId: 'user-1', cwd: f.cwd };
    const knowledge = service(f);
    const result = await knowledge.mutateFromNative(profileId, { requestId: 'native-large-session',
        expectedRevision: (await knowledge.snapshot(profileId)).revision, operation: 'create', kind: 'memory',
        category: 'fact', content: 'Large session fact' }, native);
    assert.equal(result.status, 'saved');
    assert.deepEqual(result.receipt.source, { sessionId: f.sessionId, entryId: 'user-1' });
    assert.equal(result.receipt.indexStatus, 'ready');
});

test('mutateFromNative rejects a source entry on an abandoned branch', { skip: !bundle }, async t => {
    const f = fixture(t);
    write(f.file, rows(f, { branch: true }));
    const native = { sessionPath: f.file, sessionId: f.sessionId, entryId: 'assistant-1', cwd: f.cwd };
    const input = { requestId: 'native-abandoned-branch', expectedRevision: (await service(f).snapshot(profileId)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Must not write' };
    await assert.rejects(service(f).mutateFromNative(profileId, input, native), /not bound/);
    assert.equal(fs.existsSync(path.join(f.agent, 'pivane-profiles', 'data', profileId, 'MEMORY.md')), false);
});

test('a branch switch between the source checks blocks publication', { skip: !bundle }, async t => {
    const f = fixture(t);
    write(f.file, rows(f));
    const beforeReserve = () => fs.appendFileSync(f.file, JSON.stringify(secondBranch(f)) + '\n');
    const native = { sessionPath: f.file, sessionId: f.sessionId, entryId: 'user-1', cwd: f.cwd };
    const input = { requestId: 'native-branch-switch', expectedRevision: (await service(f).snapshot(profileId)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Must not write' };
    await assert.rejects(service(f, { beforeReserve }).mutateFromNative(profileId, input, native), /not bound/);
    assert.equal(fs.existsSync(path.join(f.agent, 'pivane-profiles', 'data', profileId, 'MEMORY.md')), false);
    assert.equal(fs.existsSync(path.join(f.agent, 'pivane-profiles', 'data', profileId, '.pivane-knowledge.pending')), false);
});

test('same-branch growth between the source checks does not block publication', { skip: !bundle }, async t => {
    const f = fixture(t);
    write(f.file, rows(f));
    const beforeReserve = () => fs.appendFileSync(f.file, JSON.stringify({ type: 'message', id: 'user-3',
        parentId: 'assistant-1', timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } }) + '\n');
    const native = { sessionPath: f.file, sessionId: f.sessionId, entryId: 'user-1', cwd: f.cwd };
    const input = { requestId: 'native-same-branch', expectedRevision: (await service(f).snapshot(profileId)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Same branch fact' };
    const result = await service(f, { beforeReserve }).mutateFromNative(profileId, input, native);
    assert.equal(result.status, 'saved');
    assert.deepEqual(result.receipt.source, { sessionId: f.sessionId, entryId: 'user-1' });
});

test('mutateFromNative rejects symlinked, replaced and oversize provenance sources', { skip: !bundle }, async t => {
    const f = fixture(t);
    write(f.file, rows(f));
    const link = path.join(f.directory, 'link.jsonl');
    fs.symlinkSync(f.file, link);
    const input = { requestId: 'native-link', expectedRevision: (await service(f).snapshot(profileId)).revision,
        operation: 'create', kind: 'memory', category: 'fact', content: 'Must not write' };
    await assert.rejects(service(f).mutateFromNative(profileId, input,
        { sessionPath: link, sessionId: f.sessionId, entryId: 'user-1', cwd: f.cwd }), /not bound/);
    fs.unlinkSync(link);
    const io = require('../server/pi-file-io');
    const original = io.openReadSync;
    let replaced = false;
    io.openReadSync = file => {
        const fd = original(file);
        if (!replaced && file === f.file) {
            replaced = true;
            fs.renameSync(f.file, `${f.file}.old`);
            fs.copyFileSync(`${f.file}.old`, f.file);
        }
        return fd;
    };
    try {
        await assert.rejects(service(f).mutateFromNative(profileId, input,
            { sessionPath: f.file, sessionId: f.sessionId, entryId: 'user-1', cwd: f.cwd }), /not bound/);
    } finally { io.openReadSync = original; }
    fs.writeFileSync(f.file, Buffer.alloc(scope.MAX_SOURCE_BYTES + 1, 0x78));
    await assert.rejects(service(f).mutateFromNative(profileId, input,
        { sessionPath: f.file, sessionId: f.sessionId, entryId: 'user-1', cwd: f.cwd }), /exceeds source proof limits/);
    assert.equal(fs.existsSync(path.join(f.agent, 'pivane-profiles', 'data', profileId, 'MEMORY.md')), false);
});
