const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { scanReferences, verifyAll } = require('../server/pi-document-storage-references');
const { settingsScope } = require('../server/pi-document-storage-gateway');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-scope-')));
    const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(path.join(agent, 'sessions', 'project'), { recursive: true }); fs.mkdirSync(cwd);
    const file = path.join(agent, 'sessions', 'project', 'session.jsonl');
    const header = { type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
    const write = entries => fs.writeFileSync(file, [header, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n');
    const store = { resolveProject(value) { assert.equal(value, cwd); return cwd; } };
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, agent, cwd, file, header, write, store };
}

test('configured native session roots outside the canonical tree disable cleanup', t => {
    const f = fixture(t), previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    const { NativeDocumentScope } = require('../server/pi-document-native-scope');
    try {
        process.env.PI_CODING_AGENT_SESSION_DIR = path.join(f.root, 'external');
        assert.equal(new NativeDocumentScope(f.agent).complete, false);
        process.env.PI_CODING_AGENT_SESSION_DIR = path.join(f.agent, 'sessions', 'nested');
        assert.equal(new NativeDocumentScope(f.agent).complete, true);
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
        else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
});

test('structured external session metadata disables completeness without opening external paths', async t => {
    const f = fixture(t), external = path.join(f.root, 'outside', 'session.jsonl');
    f.write([{ type: 'message', id: 'one', parentId: null, message: { role: 'toolResult', details: { sessionFile: external } } }]);
    const result = await scanReferences(f.agent, new Set());
    assert.equal(result.scope.complete, false); assert.deepEqual(result.scope.projects, [f.cwd]);
    assert.equal(fs.existsSync(path.dirname(external)), false);
    assert.equal(settingsScope(f.agent, result.scope, f.store).complete, false);
});

test('default managed paths are complete and arbitrary report prose is not a path authority', async t => {
    const f = fixture(t);
    f.write([{ type: 'message', id: 'one', parentId: null, message: { role: 'toolResult', details: { sessionFile: f.file },
        content: [{ type: 'text', text: 'Example sessionFile: /outside/private/session.jsonl and defaultSessionDir examples' }] } }]);
    const result = await scanReferences(f.agent, new Set());
    assert.equal(result.scope.complete, true);
    const settings = settingsScope(f.agent, result.scope, f.store);
    assert.equal(settings.complete, true); verifyAll(settings.proofs);
});

test('escaped scope keys and oversized or untyped paths are conservatively incomplete', async t => {
    const f = fixture(t);
    const record = JSON.stringify({ type: 'message', id: 'one', parentId: null, data: { sessionFile: '/outside/session.jsonl' } });
    fs.writeFileSync(f.file, JSON.stringify(f.header) + '\n' + record.replace('sessionFile', 'session\\u0046ile') + '\n');
    assert.equal((await scanReferences(f.agent, new Set())).scope.complete, false);
    for (const value of ['x'.repeat(5000), ['relative'], 12]) {
        f.write([{ type: 'custom', id: 'one', parentId: null, data: { sessionDir: value } }]);
        assert.equal((await scanReferences(f.agent, new Set())).scope.complete, false);
    }
});

test('global and project custom-root settings are verified and bound to their exact files', async t => {
    const f = fixture(t); f.write([]);
    const native = (await scanReferences(f.agent, new Set())).scope;
    const settingsFile = path.join(f.agent, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ subagents: { defaultSessionDir: path.join(f.agent, 'sessions', 'custom') } }));
    const accepted = settingsScope(f.agent, native, f.store); assert.equal(accepted.complete, true);
    fs.writeFileSync(settingsFile, JSON.stringify({ subagents: { defaultSessionDir: path.join(f.root, 'external') } }));
    assert.throws(() => verifyAll(accepted.proofs));
    assert.equal(settingsScope(f.agent, native, f.store).complete, false);
    fs.writeFileSync(settingsFile, '{}'); fs.mkdirSync(path.join(f.cwd, '.pi'));
    fs.writeFileSync(path.join(f.cwd, '.pi', 'settings.json'), JSON.stringify({ subagents: { defaultSessionDir: '/outside' } }));
    assert.equal(settingsScope(f.agent, native, f.store).complete, false);
    assert.equal(settingsScope(f.agent, native, { resolveProject() { throw Error('outside allowed roots'); } }).complete, false);
});

test('missing project settings cannot appear during the final deletion proof window', async t => {
    const f = fixture(t); f.write([]);
    const native = (await scanReferences(f.agent, new Set())).scope;
    const accepted = settingsScope(f.agent, native, f.store); assert.equal(accepted.complete, true);
    fs.mkdirSync(path.join(f.cwd, '.pi'));
    fs.writeFileSync(path.join(f.cwd, '.pi', 'settings.json'), JSON.stringify({ subagents: { defaultSessionDir: '/outside' } }));
    assert.throws(() => verifyAll(accepted.proofs));
});
