const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('session removal blocks reconnect and duplicate deletion until shutdown and file operation settle', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-removal-'));
    const file = path.join(root, 'session.jsonl'); fs.writeFileSync(file, 'fixture');
    const supervisor = new PiAgentSupervisor();
    t.after(async () => { await supervisor.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const stopped = deferred(), entered = deferred(), releaseFile = deferred();
    let disposed = false;
    const worker = {
        exclusive: (operation, options) => { assert.equal(options.idle, false); return operation(); },
        dispose: async () => { await stopped.promise; disposed = true; },
        isIdle: () => true, retainsBackgroundWork: () => false
    };
    supervisor.workers.set(file, worker);
    const removal = supervisor.withSessionRemoval(file, async current => {
        assert.equal(current, worker);
        await supervisor.stopSession(file);
        assert.ok(disposed); entered.resolve();
        await releaseFile.promise; fs.unlinkSync(file);
        return { trashed: false };
    });
    assert.equal(supervisor.isIdle(), false);
    assert.equal(supervisor.isSessionIdle(file), false);
    await assert.rejects(supervisor.getWorker({ sessionPath: file }), /being deleted/);
    await assert.rejects(supervisor.withSessionRemoval(file, () => assert.fail('duplicate')), /being deleted/);
    stopped.resolve(); await entered.promise;
    await assert.rejects(supervisor.getWorker({ sessionPath: file }), /being deleted/);
    releaseFile.resolve(); assert.deepEqual(await removal, { trashed: false });
    await assert.rejects(supervisor.getWorker({ sessionPath: file }), /no longer exists/);
    assert.equal(supervisor.isIdle(), true);
});

test('closed-session deletion does not start a worker; failures release reservation without deleting the file', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-removal-'));
    const file = path.join(root, 'session.jsonl'); fs.writeFileSync(file, 'fixture');
    const supervisor = new PiAgentSupervisor();
    t.after(async () => { await supervisor.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    await assert.rejects(supervisor.withSessionRemoval(file, async worker => {
        assert.equal(worker, null); throw new Error('preservation failed');
    }), /preservation failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'fixture');
    assert.equal(supervisor.removing.size, 0);
    assert.equal(supervisor.isIdle(), true);
    assert.equal(await supervisor.withSessionRemoval(file, worker => worker === null), true);
});

test('session deletion waits for pending startup and global shutdown waits for deletion', async () => {
    const supervisor = new PiAgentSupervisor(), startup = deferred(), operation = deferred();
    supervisor.starting.set('fixture', startup.promise);
    let started = false;
    const removal = supervisor.withSessionRemoval('fixture', async () => { started = true; await operation.promise; });
    await Promise.resolve(); assert.equal(started, false);
    startup.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, true);
    let finished = false;
    const shutdown = supervisor.dispose().then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false);
    operation.resolve(); await removal; await shutdown;
    assert.equal(finished, true);
});
