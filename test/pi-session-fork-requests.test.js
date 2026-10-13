const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-fork-requests-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { ForkRequests } = require('../server/pi-session-fork-requests');
const { atomicJson } = require('../server/pi-maintenance-files');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
async function fixture() {
    const store = new PiSessionStore(), session = await store.createSession(root, 'Source');
    const source = await store.getSession(root, session.id);
    return { store, source, requests: new ForkRequests(store), input: { requestId: randomUUID(), expectedLeafId: null } };
}
test('fork receipts reserve concurrent work and persist completion without conversation payloads', async () => {
    const f = await fixture(); let finish, calls = 0;
    const result = { session: { ...await f.store.createSession(root, 'Target'), created: 'presentation-only timestamp' }, draft: null };
    const first = f.requests.run(f.source, f.input, async start => { calls++; start(); await new Promise(r => { finish = r; }); return result; });
    while (!finish) await new Promise(r => setImmediate(r));
    assert.equal((await f.requests.status(f.source, f.input.requestId)).status, 'pending');
    const second = f.requests.run(f.source, f.input, () => assert.fail('duplicate executed'));
    await assert.rejects(f.requests.run(f.source, { ...f.input, position: 'at' }, () => assert.fail()), { code: 'FORK_REQUEST_CONFLICT' });
    const other = new ForkRequests(f.store);
    await assert.rejects(other.run(f.source, f.input, () => assert.fail('another owner must not execute pending intent')), { code: 'FORK_REQUEST_UNCERTAIN' });
    finish(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
    assert.equal((await other.status(f.source, f.input.requestId)).result.session.id, result.session.id);
    const file = await other.file(other.key(f.source, f.input.requestId));
    require('./private-file-helper.cjs').assertPrivateFile(file);
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(receipt).sort(), ['draftEntryId', 'fingerprint', 'requestId', 'source', 'status', 'target', 'version']);
    assert.equal((await other.status(f.source, randomUUID())).status, 'not_found');
    await assert.rejects(other.run({ ...f.source, cwd: '/' + 'x'.repeat(65536) }, { ...f.input, requestId: randomUUID() }, () => assert.fail('oversize receipt must reject before execution')), { code: 'FORK_REQUEST_LIMIT' });
});
test('interruption, known failure, stale identity and corrupt receipts never replay', async () => {
    const f = await fixture(); let calls = 0;
    assert.throws(() => f.requests.run(f.source, { ...f.input, position: null }, () => assert.fail()), { code: 'FORK_REQUEST_INVALID', status: 400 });
    await assert.rejects(f.requests.run(f.source, f.input, start => { calls++; start(); throw new Error('publication interrupted'); }), /interrupted/);
    assert.equal((await new ForkRequests(f.store).status(f.source, f.input.requestId)).status, 'uncertain');
    await assert.rejects(f.requests.run(f.source, f.input, () => { calls++; }), { code: 'FORK_REQUEST_UNCERTAIN' }); assert.equal(calls, 1);
    const denied = { ...f.input, requestId: randomUUID() };
    await assert.rejects(f.requests.run(f.source, denied, () => { throw new Error('source busy before mutation'); }), /busy/);
    assert.equal((await f.requests.status(f.source, denied.requestId)).status, 'failed');
    await assert.rejects(f.requests.run(f.source, denied, () => assert.fail()), { code: 'FORK_REQUEST_UNCERTAIN' });
    const file = await f.requests.file(f.requests.key(f.source, f.input.requestId));
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); receipt.status = 'pending'; atomicJson(file, receipt);
    assert.equal((await new ForkRequests(f.store).status(f.source, f.input.requestId)).status, 'uncertain', 'pending on disk without live ownership is not idle/retryable');
    await assert.rejects(f.requests.run({ ...f.source, created: 'another native session' }, f.input, () => assert.fail()), { code: 'FORK_REQUEST_CHANGED' });
    fs.writeFileSync(file, '{broken');
    await assert.rejects(f.requests.run(f.source, f.input, () => assert.fail()), SyntaxError);
});
test('navigation anchors retain exact legacy custom/user positions and cancellation context', async () => {
    const { SessionManager } = await getSdk();
    const { bindSessionNavigation, navigateSession } = require('../server/pi-session-navigation');
    for (const kind of ['user', 'custom']) {
        const manager = SessionManager.inMemory(root); bindSessionNavigation(manager);
        const old = kind === 'user' ? manager.appendMessage({ role: 'user', content: 'original', timestamp: 1 })
            : manager.appendCustomMessageEntry('fixture', 'original', true);
        const before = manager.buildSessionContext().messages;
        const ctx = { sessionManager: manager, mode: 'rpc', isIdle: () => true, hasPendingMessages: () => false,
            navigateTree: async (id) => { assert.equal(id, old); assert.notEqual(manager.getLeafId(), old); return { cancelled: true }; } };
        assert.equal((await navigateSession(ctx, old, { summarize: false })).cancelled, true);
        assert.deepEqual(manager.buildSessionContext().messages, before, 'cancelled edit preserves root question/custom message');
        const records = manager.getEntries().length;
        await assert.rejects(navigateSession({ ...ctx, hasPendingMessages: () => true }, old), /尚未就绪/);
        assert.equal(manager.getEntries().length, records);
    }
});
