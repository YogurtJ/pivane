const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { sessionDirectory, decodeSession, relocateSessionBytes, relocateProjectSessions } = require('../server/pi-session-relocation');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-relocate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = path.join(root, 'agent'), old = path.join(root, 'old'), target = path.join(root, 'pivane');
    for (const directory of [agent, old, target]) fs.mkdirSync(directory);
    return { root, agent, old, target };
}
async function nativeSessions(f) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const directory = sessionDirectory(f.agent, f.old);
    const manager = SessionManager.create(f.old, directory);
    const first = manager.appendMessage({ role: 'user', content: `Keep this historical path: ${f.old}`, timestamp: 1 });
    const assistant = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Answer' }], api: 'openai-responses',
        provider: 'synthetic', model: 'fixture', stopReason: 'stop', timestamp: 2,
        usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, total: 0 } } });
    manager.appendLabelChange(assistant, 'bookmark');
    manager.appendSessionInfo('Preserve native identity');
    manager.branch(first);
    manager.appendMessage({ role: 'user', content: 'Other branch', timestamp: 3 });
    manager.appendModelChange('synthetic', 'second-model');
    manager.appendThinkingLevelChange('high');
    manager.appendCustomEntry('opaque-extension', { historicalPath: f.old, untouched: true });
    // The filename is not the identity. Existing sessions can differ this way.
    const filename = path.join(directory, 'misleading-filename.jsonl');
    fs.renameSync(manager.getSessionFile(), filename);
    const child = SessionManager.forkFrom(filename, f.old, directory);
    return { SessionManager, directory, filename, id: manager.getSessionId(), child: child.getSessionFile(), childId: child.getSessionId() };
}

test('header relocation preserves every body byte, native identity, branch, label and historical path', async t => {
    const f = fixture(t), native = await nativeSessions(f);
    const bytes = fs.readFileSync(native.filename);
    const result = await relocateSessionBytes(bytes, { sourceCwd: f.old, targetCwd: f.target });
    const before = decodeSession(bytes), after = decodeSession(result.bytes);
    assert.deepEqual(after.tail, before.tail);
    assert.equal(after.header.cwd, f.target);
    assert.equal(after.header.id, native.id);
    assert.equal(after.header.timestamp, before.header.timestamp);
    assert.ok(after.tail.includes(Buffer.from(f.old)));
    assert.equal(after.records.filter(entry => entry.type === 'label').length, 1);
    assert.equal(result.id, native.id);
    await assert.rejects(relocateSessionBytes(bytes, { sourceCwd: f.target, targetCwd: f.old }), /cwd/);
    const malformed = Buffer.from(JSON.stringify({ ...before.header, version: 4 }) + '\n' + before.tail);
    await assert.rejects(relocateSessionBytes(malformed, { sourceCwd: f.old, targetCwd: f.target }), /v3/);
});

test('offline relocation retains exact originals and exposes the full sessions under their new native project', async t => {
    const f = fixture(t), native = await nativeSessions(f), originals = new Map();
    for (const name of fs.readdirSync(native.directory)) originals.set(name, fs.readFileSync(path.join(native.directory, name)));
    const options = { installation: f.old, agentDir: f.agent, sourceCwd: f.old, targetCwd: f.target,
        evidenceDir: path.join(f.root, 'evidence'), externalWritersStopped: true };
    const result = await relocateProjectSessions(options);
    assert.equal(result.sessions, 2);
    assert.equal(fs.existsSync(native.directory), false);
    const listed = await native.SessionManager.list(f.target, result.targetDir);
    assert.deepEqual(new Set(listed.map(session => session.id)), new Set([native.id, native.childId]));
    for (const [name, bytes] of originals) {
        assert.deepEqual(fs.readFileSync(path.join(result.originals, name)), bytes);
        const newBytes = fs.readFileSync(path.join(result.targetDir, name));
        assert.deepEqual(decodeSession(newBytes).tail, decodeSession(bytes).tail);
    }
    const child = native.SessionManager.open(path.join(result.targetDir, path.basename(native.child)));
    assert.equal(child.getHeader().parentSession, path.join(result.targetDir, 'misleading-filename.jsonl'));
    assert.equal(child.getCwd(), f.target);
    assert.equal(child.getSessionId(), native.childId);
    await assert.rejects(relocateProjectSessions(options), /destination/);
});

test('installation lock and existing destinations prevent session writes; independent writers require explicit confirmation', async t => {
    const f = fixture(t), native = await nativeSessions(f);
    const before = fs.readFileSync(native.filename);
    const options = { installation: f.old, agentDir: f.agent, sourceCwd: f.old, targetCwd: f.target, evidenceDir: path.join(f.root, 'evidence') };
    await assert.rejects(relocateProjectSessions(options), /writers/);
    const port = 40000 + createHash('sha256').update(f.old).digest().readUInt32BE(0) % 20000;
    const guard = net.createServer();
    await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(port, '127.0.0.1', resolve); });
    try { await assert.rejects(relocateProjectSessions({ ...options, externalWritersStopped: true }), { code: 'EADDRINUSE' }); }
    finally { await new Promise(resolve => guard.close(resolve)); }
    assert.equal(fs.existsSync(options.evidenceDir), false);
    assert.deepEqual(fs.readFileSync(native.filename), before);
    fs.mkdirSync(sessionDirectory(f.agent, f.target));
    await assert.rejects(relocateProjectSessions({ ...options, externalWritersStopped: true }), /destination/);
    assert.deepEqual(fs.readFileSync(native.filename), before);
});

test('very deep native histories are validated without recursive tree traversal', async t => {
    const f = fixture(t);
    const header = { type: 'session', version: 3, id: 'deep-session', cwd: f.old, timestamp: new Date().toISOString() };
    const lines = [JSON.stringify(header)];
    for (let i = 0; i < 12000; i++) lines.push(JSON.stringify({ type: 'custom', id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null,
        timestamp: header.timestamp, customType: 'fixture', data: { index: i } }));
    const bytes = Buffer.from(lines.join('\n') + '\n');
    const relocated = await relocateSessionBytes(bytes, { sourceCwd: f.old, targetCwd: f.target });
    assert.equal(relocated.entries, 12000);
    assert.equal(relocated.leaf, 'entry-11999');
    assert.deepEqual(decodeSession(relocated.bytes).tail, decodeSession(bytes).tail);
});

test('an external parent reference blocks a partial project migration', async t => {
    const f = fixture(t), native = await nativeSessions(f), other = path.join(f.root, 'other');
    fs.mkdirSync(other);
    native.SessionManager.forkFrom(native.filename, other, sessionDirectory(f.agent, other));
    await assert.rejects(relocateProjectSessions({ installation: f.old, agentDir: f.agent, sourceCwd: f.old, targetCwd: f.target,
        evidenceDir: path.join(f.root, 'evidence'), externalWritersStopped: true }), /expanded scope/);
    assert.ok(fs.existsSync(native.filename));
    assert.equal(fs.existsSync(sessionDirectory(f.agent, f.target)), false);
});
