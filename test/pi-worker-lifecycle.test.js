const test = require('node:test');
const assert = require('node:assert/strict');
const { workerLifecycle } = require('../server/pi-worker-lifecycle');
const { PiRuntimeActivity } = require('../server/pi-runtime-activity');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');

function worker() {
    return { activity: new PiRuntimeActivity(), navigation: {}, shell: {}, modelCatalog: {},
        titleResults: new Map(), resourceResults: new Map(), pendingUi: new Map(),
        controls: { recoveries: [], drafts: [], queue: { steering: [], followUp: [] } } };
}

test('queued input and uncertain model changes prevent idle maintenance even after the agent settles', () => {
    const value = worker();
    value.activity.handle({ type: 'agent_start' });
    value.controls.queue.followUp.push('private queued text');
    value.activity.handle({ type: 'agent_settled' });
    assert.deepEqual(workerLifecycle(value).activity, { busy: false, phase: 'idle' });
    assert.deepEqual(workerLifecycle(value).blockers, ['queue']);
    assert.equal(JSON.stringify(workerLifecycle(value)).includes('private queued text'), false);
    value.controls.queue.followUp.length = 0;
    value.modelChangeUncertain = true;
    assert.deepEqual(workerLifecycle(value).blockers, ['model-uncertain']);
});

test('a reserved request remains busy before native agent_start; background titles only block maintenance', () => {
    const value = worker();
    value.promptPending = 1;
    assert.deepEqual(workerLifecycle(value).activity, { busy: true, phase: 'running' });
    value.promptPending = 0;
    value.titleGeneration = true;
    assert.deepEqual(workerLifecycle(value).activity, { busy: false, phase: 'idle' });
    assert.deepEqual(workerLifecycle(value).blockers, ['title-generation']);
    value.titleGeneration = false;
    value.resourceResults.set('private-request-id', null);
    assert.deepEqual(workerLifecycle(value).activity, { busy: true, phase: 'running' });
    value.resourceResults.clear();
    assert.deepEqual(workerLifecycle(value).blockers, []);
});

test('supervisor idle includes starting and temporary workers without exposing their internals to routes', async t => {
    const supervisor = new PiAgentSupervisor();
    t.after(() => supervisor.dispose());
    assert.equal(supervisor.isIdle(), true);
    supervisor.starting.set('synthetic', Promise.resolve());
    assert.equal(supervisor.isIdle(), false);
    supervisor.starting.clear();
    const temporary = { dispose() {} };
    supervisor.ephemeralWorkers.add(temporary);
    assert.equal(supervisor.isIdle(), false);
    supervisor.ephemeralWorkers.clear();
    const value = worker();
    supervisor.workers.set('synthetic', { isIdle: () => workerLifecycle(value).blockers.length === 0, dispose() {} });
    assert.equal(supervisor.isIdle(), true);
    value.controls.recoveries.push({ text: 'unsaved' });
    assert.equal(supervisor.isIdle(), false);
    value.controls.recoveries.length = 0;
    value.disposed = true;
    assert.equal(supervisor.isIdle(), false);
});
