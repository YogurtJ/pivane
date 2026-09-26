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
    supervisor.workers.set('synthetic', { isIdle: () => workerLifecycle(value).blockers.length === 0, retainsBackgroundWork: () => Boolean(value.background), dispose() {} });
    assert.equal(supervisor.isIdle(), true);
    value.background = true;
    assert.equal(supervisor.isIdle(), false, 'detached subagent work blocks maintenance without making the turn busy');
    assert.equal(workerLifecycle(value).activity.busy, false);
    value.background = false;
    value.controls.recoveries.push({ text: 'unsaved' });
    assert.equal(supervisor.isIdle(), false);
    value.controls.recoveries.length = 0;
    value.disposed = true;
    assert.equal(supervisor.isIdle(), false);
});

test('isSessionIdle checks only the realpath-matched worker of one native session', async t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-idle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const own = path.join(root, 'own.jsonl'), other = path.join(root, 'other.jsonl'), alias = path.join(root, 'alias.jsonl');
    fs.writeFileSync(own, ''); fs.writeFileSync(other, ''); fs.symlinkSync(own, alias);
    const supervisor = new PiAgentSupervisor();
    t.after(() => supervisor.dispose());
    assert.equal(supervisor.isSessionIdle(own), true, 'no worker for this session counts as idle');
    const state = { own: false, other: false, background: false };
    supervisor.workers.set(fs.realpathSync.native(own), { isIdle: () => !state.own, retainsBackgroundWork: () => state.background, dispose() {} });
    supervisor.workers.set(fs.realpathSync.native(other), { isIdle: () => !state.other, retainsBackgroundWork: () => false, dispose() {} });
    state.other = true;
    assert.equal(supervisor.isIdle(), false);
    assert.equal(supervisor.isSessionIdle(own), true, 'another busy session does not block this one');
    assert.equal(supervisor.isSessionIdle(alias), true);
    state.own = true;
    assert.equal(supervisor.isSessionIdle(own), false);
    assert.equal(supervisor.isSessionIdle(alias), false, 'a symlinked request path resolves to the same worker');
    state.own = false; state.background = true;
    assert.equal(supervisor.isSessionIdle(own), false, 'detached background work keeps the session busy');
    state.background = false;
    supervisor.starting.set(fs.realpathSync.native(own), Promise.resolve());
    assert.equal(supervisor.isSessionIdle(own), false, 'a worker still starting for this session is busy');
    supervisor.starting.clear();
    assert.equal(supervisor.isSessionIdle(own), true);
});
