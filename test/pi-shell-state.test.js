const test = require('node:test');
const assert = require('node:assert/strict');
const { PiShellExecution, OUTPUT_CHARACTERS } = require('../server/pi-shell-execution');
function fixture() {
    let finish, fail;
    const worker = { operation: null, promptAdmissionUncertain: false, runStartupCalls: new Set(), bashDispatches: 0,
        pendingUi: new Map(), resourceResults: new Map(), activity: { snapshot: () => ({ busy: false }) }, ensureReady: async () => {}, request: async () => ({}), _broadcast: () => {},
        client: { request: (type, payload, timeout, onId) => {
            if (type === 'abort_bash') return Promise.resolve({});
            assert.equal(type, 'bash'); assert.equal(timeout, null); onId('native-id'); worker.bashDispatches++;
            return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
        } }
    };
    worker.shell = new PiShellExecution(worker);
    return { worker, shell: worker.shell, finish: result => finish(result), fail: error => fail(error) };
}
test('Shell rejects pending native runs before reserving an execution', async t => {
    for (const pending of ['promptAdmissionUncertain', 'runStartupCalls']) await t.test(pending, async () => {
        const f = fixture();
        if (pending === 'runStartupCalls') f.worker.runStartupCalls.add('native-call');
        else f.worker.promptAdmissionUncertain = true;
        let readinessChecks = 0;
        f.worker.ensureReady = async () => { readinessChecks++; };
        await assert.rejects(f.shell.start({ command: 'fixture' }), /空闲/);
        assert.equal(f.worker.bashDispatches, 0); assert.equal(readinessChecks, 0);
        assert.equal(f.shell.job, null); assert.equal(f.shell.busy, false);
    });
});
test('Shell rechecks pending native runs after readiness and native state awaits', async t => {
    for (const boundary of ['ensureReady', 'request']) for (const pending of ['promptAdmissionUncertain', 'runStartupCalls']) {
        await t.test(`${pending} during ${boundary}`, async () => {
            const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
            f.worker[boundary] = async () => { entered.resolve(); await release.promise; return {}; };
            const started = f.shell.start({ command: 'fixture' });
            await entered.promise;
            assert.equal(f.shell.job.status, 'starting'); assert.equal(f.shell.busy, true);
            if (pending === 'runStartupCalls') f.worker.runStartupCalls.add('native-call');
            else f.worker.promptAdmissionUncertain = true;
            release.resolve();
            await assert.rejects(started, /空闲/);
            assert.equal(f.worker.bashDispatches, 0);
            assert.equal(f.shell.job.status, 'rejected'); assert.equal(f.shell.busy, false);
        });
    }
});
test('Idle Shell reserves once before readiness and executes without blocking itself', async () => {
    const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.worker.ensureReady = async () => { entered.resolve(); await release.promise; };
    const started = f.shell.start({ command: 'fixture' });
    await entered.promise;
    await assert.rejects(f.shell.start({ command: 'concurrent fixture' }), /空闲/);
    assert.equal(f.worker.bashDispatches, 0);
    release.resolve();
    assert.equal((await started).job.status, 'running'); assert.equal(f.worker.bashDispatches, 1);
    f.finish({ output: 'fixture completed', exitCode: 0 }); await f.shell.completion;
    assert.equal(f.shell.busy, false); assert.equal(f.shell.job.status, 'completed');
    assert.equal(f.shell.job.output, 'fixture completed'); assert.equal(f.shell.job.recorded, true);
});
test('Shell stop acknowledgement retains reservation, ignores foreign chunks, and bounds streamed Unicode', async () => {
    const f = fixture();
    const accepted = await f.shell.start({ command: 'fixture' });
    f.shell.handle({ type: 'bash_execution_update', id: 'foreign', delta: 'must not leak' });
    assert.equal(f.shell.snapshot().job.output, '');
    f.shell.handle({ type: 'bash_execution_update', id: 'native-id', delta: '😀'.repeat(OUTPUT_CHARACTERS) });
    const output = f.shell.snapshot().job.output;
    assert.ok(output.length <= OUTPUT_CHARACTERS); assert.equal(output.isWellFormed(), true); assert.equal(f.shell.job.displayTruncated, true);
    f.worker.promptAdmissionUncertain = true; f.worker.runStartupCalls.add('native-call');
    await f.shell.abort(accepted.job.id);
    assert.equal(f.shell.busy, true); assert.equal(f.shell.job.status, 'stopping');
    await assert.rejects(f.shell.start({ command: 'second' }), /空闲/);
    await assert.rejects(f.shell.abort(accepted.job.id), /正在停止/);
    f.finish({ output: 'partial', cancelled: true, truncated: false }); await f.shell.completion;
    assert.equal(f.shell.busy, false); assert.equal(f.shell.job.status, 'cancelled'); assert.equal(f.shell.job.recorded, true);
});
test('Shell disposal still cancels the native execution while prompt admission is blocked', async () => {
    const f = fixture(); await f.shell.start({ command: 'fixture' });
    f.worker.promptAdmissionUncertain = true; f.worker.runStartupCalls.add('native-call');
    f.worker.client.child = {};
    let abortDispatches = 0;
    f.worker.client.request = async type => {
        assert.equal(type, 'abort_bash'); abortDispatches++;
        f.finish({ output: 'cancelled on exit', cancelled: true });
        return {};
    };
    await f.shell.dispose(); await f.shell.completion;
    assert.equal(abortDispatches, 1); assert.equal(f.worker.bashDispatches, 1);
    assert.equal(f.shell.busy, false); assert.equal(f.shell.job.status, 'cancelled');
});
test('Uncertain execution never unlocks or replays; explicit native rejection ends the operation', async () => {
    const f = fixture(); await f.shell.start({ command: 'fixture' });
    f.fail(Object.assign(new Error('fixture connection lost'), { code: 'RPC_TIMEOUT' })); await f.shell.completion;
    assert.equal(f.shell.busy, true); assert.equal(f.shell.job.status, 'uncertain');
    await assert.rejects(f.shell.start({ command: 'again' }), /空闲/);
    const rejected = fixture(); await rejected.shell.start({ command: 'fixture' });
    rejected.fail(Object.assign(new Error('fixture rejected'), { code: 'RPC_REJECTED' })); await rejected.shell.completion;
    assert.equal(rejected.shell.busy, false); assert.equal(rejected.shell.job.status, 'failed'); assert.equal(rejected.shell.job.recorded, false);
});
