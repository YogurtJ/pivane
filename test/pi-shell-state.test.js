const test = require('node:test');
const assert = require('node:assert/strict');
const { PiShellExecution, OUTPUT_CHARACTERS } = require('../server/pi-shell-execution');
function fixture() {
    let finish, fail;
    const worker = { operation: null, pendingUi: new Map(), resourceResults: new Map(), activity: { snapshot: () => ({ busy: false }) }, ensureReady: async () => {}, request: async () => ({}), _broadcast: () => {},
        client: { request: (type, payload, timeout, onId) => {
            if (type === 'abort_bash') return Promise.resolve({});
            assert.equal(type, 'bash'); assert.equal(timeout, null); onId('native-id');
            return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
        } }
    };
    worker.shell = new PiShellExecution(worker);
    return { worker, shell: worker.shell, finish: result => finish(result), fail: error => fail(error) };
}
test('Shell stop acknowledgement retains reservation, ignores foreign chunks, and bounds streamed Unicode', async () => {
    const f = fixture();
    const accepted = await f.shell.start({ command: 'fixture' });
    f.shell.handle({ type: 'bash_execution_update', id: 'foreign', delta: 'must not leak' });
    assert.equal(f.shell.snapshot().job.output, '');
    f.shell.handle({ type: 'bash_execution_update', id: 'native-id', delta: '😀'.repeat(OUTPUT_CHARACTERS) });
    const output = f.shell.snapshot().job.output;
    assert.ok(output.length <= OUTPUT_CHARACTERS); assert.equal(output.isWellFormed(), true); assert.equal(f.shell.job.displayTruncated, true);
    await f.shell.abort(accepted.job.id);
    assert.equal(f.shell.busy, true); assert.equal(f.shell.job.status, 'stopping');
    await assert.rejects(f.shell.start({ command: 'second' }), /空闲/);
    await assert.rejects(f.shell.abort(accepted.job.id), /正在停止/);
    f.finish({ output: 'partial', cancelled: true, truncated: false }); await f.shell.completion;
    assert.equal(f.shell.busy, false); assert.equal(f.shell.job.status, 'cancelled'); assert.equal(f.shell.job.recorded, true);
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
