'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scope = require('../server/profile-memory/scope');

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-profile-memory-'));
    const agent = path.join(base, 'agent');
    const sessionsRoot = path.join(agent, 'sessions');
    fs.mkdirSync(path.join(sessionsRoot, 'project'), { recursive: true });
    const cwd = path.join(base, 'a', 'shared');
    fs.mkdirSync(cwd, { recursive: true });
    const context = { version: 1, profileId: 'alpha', sessionId: 'session-a', cwd,
        profileRoot: path.join(agent, 'pivane-profiles', 'data', 'alpha'), sessionsRoot,
        memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true } };
    function session(id, profile, folder = 'project', workdir = cwd) {
        const dir = path.join(sessionsRoot, folder);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.jsonl`);
        const lines = [{ type: 'session', id, timestamp: new Date().toISOString(), cwd: workdir }];
        if (profile !== undefined) lines.push({ type: 'custom', id: `${id}-marker`, customType: 'pivane-agent-profile',
            data: { version: 1, sessionId: id, profileId: profile } });
        lines.push({ type: 'message', id: `${id}-message`, timestamp: new Date().toISOString(), message: {
            role: 'user', content: [{ type: 'text', text: `极限 秩 栈 ${id}` }] } });
        fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
        return { file, lines };
    }
    return { base, context, cwd, sessionsRoot, session, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('native session marker and canonical profile root are mandatory', t => {
    const f = fixture(); t.after(f.cleanup);
    const own = f.session('session-a', 'alpha');
    const foreign = f.session('session-b', 'beta');
    const absent = f.session('session-c');
    const copied = f.session('session-d', 'alpha');
    const changed = copied.lines.map(line => line.type === 'custom' ? { ...line, data: { ...line.data, sessionId: 'session-a' } } : line);
    fs.writeFileSync(copied.file, changed.map(line => JSON.stringify(line)).join('\n') + '\n');
    const ctx = scope.parseContext(JSON.stringify(f.context));
    assert.ok(ctx);
    assert.equal(scope.verifyNativeSession(ctx), true);
    assert.equal(scope.eligibleFile(own.file, ctx), true);
    for (const file of [foreign.file, absent.file, copied.file]) assert.equal(scope.eligibleFile(file, ctx), false);
    assert.deepEqual(scope.listEligibleFiles(ctx).map(file => path.basename(file)), ['session-a.jsonl']);
    const manager = { getHeader: () => own.lines[0], getEntries: () => own.lines,
        getSessionId: () => 'session-a', getSessionFile: () => own.file };
    assert.equal(scope.eligibleManager(manager, ctx, f.cwd), true);
    assert.equal(scope.eligibleManager({ ...manager, getEntries: () => [...own.lines, own.lines[1]] }, ctx, f.cwd), false);
    assert.equal(scope.parseContext(JSON.stringify({ ...f.context, profileRoot: f.base })), null);
    assert.equal(scope.parseContext(JSON.stringify({ ...f.context, profileId: '../beta' })), null);
    const alternateSessions = path.join(f.base, 'native-sessions');
    fs.mkdirSync(alternateSessions);
    assert.equal(scope.parseContext(JSON.stringify({ ...f.context, sessionsRoot: alternateSessions })).agentDir,
        path.join(f.base, 'agent'));
    assert.equal(scope.parseContext(undefined), null);
});

test('same-name cwd directories remain distinct; symlinked session file is rejected', t => {
    const f = fixture(); t.after(f.cleanup);
    const otherCwd = path.join(f.base, 'b', 'shared');
    fs.mkdirSync(otherCwd, { recursive: true });
    const own = f.session('session-a', 'alpha');
    const other = f.session('session-e', 'alpha', 'project', otherCwd);
    const ctx = scope.parseContext(JSON.stringify(f.context));
    assert.equal(scope.eligibleFile(other.file, ctx), true);
    assert.equal(scope.eligibleManager({ getHeader: () => ({ id: 'session-a', cwd: otherCwd }),
        getEntries: () => own.lines, getSessionFile: () => own.file }, ctx, f.cwd), false);
    const link = path.join(f.sessionsRoot, 'project', 'link.jsonl');
    fs.symlinkSync(own.file, link);
    assert.equal(scope.eligibleFile(link, ctx), false);
});
