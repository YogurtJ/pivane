const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-retirement-')), file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, '{}\n');
    const gate = Promise.withResolvers(), supervisor = new PiAgentSupervisor({ queueStore: { acquireReferenceLease() { throw new Error('must not acquire'); } } });
    let calls = 0;
    const worker = { sessionPath: file, isIdle: () => true, retainsBackgroundWork: () => false, canEvict: () => true,
        dispose: () => { calls++; return gate.promise; } };
    supervisor.workers.set(file, worker);
    t.after(async () => { gate.resolve(); await supervisor.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    return { supervisor, worker, file, gate, get calls() { return calls; } };
}
test('retirement stays owned and non-idle until actual completion; repeat stops share the same promise', async t => {
    const f = fixture(t), first = f.supervisor.stopSession(f.file), second = f.supervisor.stopSession(f.file);
    assert.equal(first, second); assert.equal(f.supervisor.isIdle(), false); assert.equal(f.supervisor.isSessionIdle(f.file), false);
    await Promise.resolve(); assert.equal(f.calls, 1); assert.equal(f.supervisor.workers.get(f.file), f.worker);
    let settled = false;
    const opening = f.supervisor.getWorker({ sessionPath: f.file });
    opening.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(opening, /no longer exists/);
    await Promise.resolve(); assert.equal(settled, false); assert.equal(f.supervisor.starting.size, 0);
    await assert.rejects(f.supervisor.acquireQueueReferenceLease(), /会话正在执行/);
    fs.unlinkSync(f.file); f.gate.resolve(); await first; await rejected;
    assert.equal(f.supervisor.retiring.size, 0); assert.equal(f.supervisor.workers.size, 0); assert.equal(f.supervisor.isIdle(), true);
});
test('idle sweeping tracks process retirement rather than creating an empty-map idle gap', async t => {
    const f = fixture(t), sweep = f.supervisor._sweep();
    assert.equal(f.supervisor.retiring.size, 1); assert.equal(f.supervisor.isIdle(), false);
    f.gate.resolve(); await sweep; assert.equal(f.supervisor.isIdle(), true);
});
test('failed disposal retains ownership and blocks replacement, cleanup and early queue removal', async t => {
    const f = fixture(t), stopping = f.supervisor.stopSession(f.file);
    f.gate.reject(new Error('synthetic stop failure')); await assert.rejects(stopping, /synthetic stop failure/);
    assert.equal(f.supervisor.retiring.size, 1); assert.equal(f.supervisor.isIdle(), false);
    await assert.rejects(f.supervisor.getWorker({ sessionPath: f.file }), /synthetic stop failure/);
    f.supervisor.removing.set(f.file, Promise.resolve()); fs.unlinkSync(f.file);
    await assert.rejects(f.supervisor.forgetDeletedSession(f.file), /运行实例已停止/);
    assert.equal(f.calls, 1);
});
