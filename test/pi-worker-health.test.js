const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated identity: readiness checks may inspect native configuration.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-worker-health-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const fixture = path.join(__dirname, 'fixtures/rpc-health-fixture.cjs');
const previousCli = process.env.PI_WEB_CLI;
process.env.PI_WEB_CLI = fixture;
const { PiRpcClient, startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT, STARTUP_TIMEOUT_RANGE, STARTUP_TIMEOUT_MESSAGE } = require('../server/pi-rpc-client');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { normalizeEnvironment } = require('../server/pi-local-env');
test.after(() => {
    if (previousCli === undefined) delete process.env.PI_WEB_CLI; else process.env.PI_WEB_CLI = previousCli;
    fs.rmSync(root, { recursive: true, force: true });
});

let sessions = 0;
function session() {
    const id = `health-${++sessions}`;
    const file = path.join(root, `${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`);
    return { cwd: root, sessionPath: file, sessionId: id };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = log => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
function withEnv(t, values) {
    const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

test('startup window defaults to two minutes and configured values stay inside the browser wait', () => {
    assert.equal(startupTimeoutMs(undefined), DEFAULT_STARTUP_TIMEOUT);
    assert.equal(DEFAULT_STARTUP_TIMEOUT, 120000);
    assert.equal(startupTimeoutMs(''), DEFAULT_STARTUP_TIMEOUT);
    assert.equal(startupTimeoutMs('not-a-number'), DEFAULT_STARTUP_TIMEOUT);
    assert.equal(startupTimeoutMs('90000'), 90000);
    assert.equal(startupTimeoutMs('1000'), STARTUP_TIMEOUT_RANGE.min, 'the former fixed window is the lower bound');
    assert.equal(startupTimeoutMs('999999'), STARTUP_TIMEOUT_RANGE.max);
    assert.ok(STARTUP_TIMEOUT_RANGE.max < 180000, 'the browser opens a thread with a 180 s wait');
    const env = normalizeEnvironment({ PIVANE_WEB_STARTUP_TIMEOUT_MS: '150000' });
    assert.equal(startupTimeoutMs(env.PI_WEB_STARTUP_TIMEOUT_MS), 150000, 'PIVANE_ spelling reaches the runtime name');
    assert.throws(() => normalizeEnvironment({ PIVANE_WEB_STARTUP_TIMEOUT_MS: '1', PI_WEB_STARTUP_TIMEOUT_MS: '2' }), /Conflicting/);
});

test('a slow cold start inside the window succeeds, beyond it fails with a startup error, and a crash fails at once', async t => {
    withEnv(t, { FIXTURE_START_DELAY_MS: '2200' });
    const slow = new PiRpcClient({ cwd: root, noSession: true, startupTimeoutMs: 6000 });
    t.after(() => slow.dispose());
    await slow.start();
    assert.ok(slow.startupMs >= 2000, 'readiness waited for the delayed process instead of failing after one probe');
    assert.equal(slow.startupProbes.size, 0);

    const late = new PiRpcClient({ cwd: root, noSession: true, startupTimeoutMs: 1200 });
    t.after(() => late.dispose());
    await assert.rejects(late.start(), error => error.code === 'RPC_STARTUP_FAILED' && error.message === STARTUP_TIMEOUT_MESSAGE && error.startupTimeoutMs === 1200);

    process.env.FIXTURE_START_DELAY_MS = '60000';
    process.env.FIXTURE_EXIT_AFTER_MS = '300';
    t.after(() => { delete process.env.FIXTURE_EXIT_AFTER_MS; });
    const crashing = new PiRpcClient({ cwd: root, noSession: true, startupTimeoutMs: 30000 });
    t.after(() => crashing.dispose());
    const started = Date.now();
    await assert.rejects(crashing.start(), error => error.code === 'RPC_STARTUP_FAILED' && /exited/.test(error.message));
    assert.ok(Date.now() - started < 5000, 'an exited process is not awaited for the whole window');
});

test('liveness probes are bounded, hide late replies, and count a reply already waiting behind a blocked parent', async t => {
    const client = new PiRpcClient({ cwd: root, noSession: true, startupTimeoutMs: 10000 });
    t.after(() => client.dispose());
    await client.start();
    const events = [];
    client.on('event', event => events.push(event));
    assert.equal(await client.probe(1000), true);

    // The parent event loop is blocked while the reply arrives: the timer may run
    // first, but the waiting reply still proves the child command loop is alive.
    const blocked = client.probe(50);
    const until = Date.now() + 400; while (Date.now() < until) { /* block this process */ }
    assert.equal(await blocked, true);

    await client.request('fixture_delay', { ms: 500 });
    assert.equal(await client.probe(100), false, 'a silent window is unresponsive');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(events, [], 'late private probe replies are not forwarded as events');
    assert.equal(client.healthProbes.size, 0);
});

test('an idle worker that stops answering is replaced once; the old process exits first and callers share the replacement', async t => {
    const log = path.join(root, 'replace.log');
    withEnv(t, { FIXTURE_LOG: log });
    const supervisor = new PiAgentSupervisor({ healthTimeoutMs: 300, startupTimeoutMs: 10000 });
    t.after(() => supervisor.dispose());
    const target = session();
    const first = await supervisor.getWorker(target);
    const firstPid = first.client.child.pid;
    assert.equal(await supervisor.getWorker(target), first, 'a responsive idle worker is reused');
    assert.deepEqual(pids(log), [firstPid]);

    const reconnects = [];
    first.subscribe(event => reconnects.push(event.type));
    first.client.send({ type: 'fixture_freeze' });
    const [a, b] = await Promise.all([supervisor.getWorker(target), supervisor.getWorker(target)]);
    assert.equal(a, b, 'concurrent callers receive the same replacement');
    assert.notEqual(a, first);
    assert.equal(first.disposed, true);
    assert.equal(alive(firstPid), false, 'the unresponsive process exited');
    assert.ok(reconnects.includes('gateway_reconnect'), 'connected browsers are told to reconnect');
    assert.equal(supervisor.workers.size, 1);
    assert.equal(supervisor.workers.get(target.sessionPath), a);
    assert.equal(pids(log).length, 2, 'exactly one replacement process was started');
    assert.equal((await a.request('get_state')).sessionId, target.sessionId);
});

test('a busy or background worker is never replaced because a reply is missing', async t => {
    const log = path.join(root, 'busy.log');
    withEnv(t, { FIXTURE_LOG: log });
    const supervisor = new PiAgentSupervisor({ healthTimeoutMs: 200, startupTimeoutMs: 10000 });
    t.after(() => supervisor.dispose());
    const target = session();
    const worker = await supervisor.getWorker(target);
    const pid = worker.client.child.pid;
    worker.client.send({ type: 'fixture_busy_freeze' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(worker.isIdle(), false, 'the native agent_start event made the worker active');
    assert.equal(await supervisor.getWorker(target), worker);
    assert.equal(alive(pid), true);

    const background = session();
    const detached = await supervisor.getWorker(background);
    detached.controls.subagents.background = { active: true };
    detached.client.send({ type: 'fixture_freeze' });
    assert.equal(await supervisor.getWorker(background), detached, 'detached subagent work keeps its worker');
    assert.equal(alive(detached.client.child.pid), true);
    assert.equal(pids(log).length, 2, 'no replacement process was started');
});
