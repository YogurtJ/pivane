const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-thread-results-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_NAVIGATION_TOKEN = 'synthetic-thread-token';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { THREAD_STATE, registerThreadResults, threadOutcome, bindingBoundary } = require('../server/channels/thread-results');
const { ChannelsService, digest } = require('../server/channels/service');
let SessionManager;
test.before(async () => { ({ SessionManager } = await import('@earendil-works/pi-coding-agent')); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function turn(source = 'thread') {
    const manager = SessionManager.create(root, path.join(root, 'sessions'));
    const handlers = {}, notifications = [];
    const ctx = { mode: 'rpc', sessionManager: manager, ui: { notify: value => notifications.push(JSON.parse(value)) } };
    registerThreadResults({ on: (name, handler) => { handlers[name] = handler; }, appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
    handlers.agent_start({}, ctx);
    if (source === 'thread') manager.appendMessage({ role: 'user', content: 'Synthetic question', timestamp: Date.now() });
    else manager.appendCustomMessageEntry(source === 'channel' ? 'pivane-channel-message' : 'pivane-cron-message', 'Synthetic input', true,
        source === 'channel' ? { messageId: 'a'.repeat(64) } : { runId: 'scheduled-run' });
    return { manager, notifications, finish: event => { handlers.agent_settled(event || {}, ctx); return notifications.at(-1).pivaneThreadResult; } };
}
const reply = (manager, text = 'Own final reply', stopReason = 'stop') => manager.appendMessage({ role: 'assistant',
    content: [{ type: 'text', text }], stopReason, timestamp: Date.now() });
test('native settlement identifies web/channel/cron sources and closes files before later turns', () => {
    for (const source of ['thread', 'channel', 'cron']) {
        const f = turn(source), m = f.manager;
        m.appendCustomEntry('pivane-deliverable', { id: 'own-file', manifestRevision: 1 });
        reply(m); const state = f.finish();
        assert.equal(state.source.kind, source);
        assert.equal(f.notifications[0].token, 'synthetic-thread-token');
        m.appendMessage({ role: 'user', content: 'Later input', timestamp: Date.now() });
        m.appendCustomEntry('pivane-deliverable', { id: 'later-file', manifestRevision: 2 }); reply(m, 'Later reply');
        const result = threadOutcome(SessionManager.open(m.getSessionFile()), state.id);
        assert.equal(result.body, 'Own final reply');
        assert.deepEqual(result.deliverables, [{ id: 'own-file', manifestRevision: 1 }]);
        f.finish(); assert.equal(f.notifications.length, 1, 'duplicate settlement cannot emit another result');
        const boundary = bindingBoundary(m);
        assert.equal(boundary.excludedTurnId, state.id, 'a binding after completion excludes that finished turn');
    }
});
test('stopped/error results have explicit terminal evidence, and other branches cannot read the result', () => {
    for (const status of ['stopped', 'error']) {
        const f = turn(), m = f.manager;
        const branchPoint = m.getLeafId();
        reply(m, 'Partial output', status === 'stopped' ? 'aborted' : 'error');
        const state = f.finish({ aborted: status === 'stopped' });
        assert.equal(state.status, status);
        assert.equal(threadOutcome(m, state.id).status, status);
        m.branch(branchPoint); reply(m, 'Different branch');
        assert.equal(threadOutcome(m, state.id), null);
    }
    const f = turn(); const state = f.finish({ aborted: true });
    assert.equal(threadOutcome(f.manager, state.id).status, 'stopped');
});
async function serviceFixture(t) {
    const supervisor = new EventEmitter();
    const service = new ChannelsService({ store: {}, supervisor, directory: path.join(root, 'channels-' + Math.random()),
        componentFactory: () => ({ status: () => ({ installed: false }) }) });
    await service.ready; service.claim();
    service.db.change(v => {
        v.accounts.push({ id: 'account', userId: 'one', token: 'synthetic', baseUrl: 'https://ilinkai.weixin.qq.com',
            enabled: true, allowedUsers: ['one', 'two', 'three'], cursor: '' });
        for (const peerId of ['one', 'two', 'three']) {
            v.peers.push({ accountId: 'account', peerId, contextToken: 'synthetic' });
            v.bindings.push({ id: 'binding-' + peerId, accountId: 'account', peerId, cwd: root, sessionId: 'session', replyMode: peerId === 'three' ? 'wechat' : 'all' });
        }
    });
    t.after(() => service.dispose());
    const event = { id: 'b'.repeat(64), target: { cwd: root, sessionId: 'session' }, source: { kind: 'thread' },
        status: 'completed', completedAt: Date.now() };
    return { service, supervisor, event };
}
test('settlement snapshots all eligible bindings exactly once and never replays a source WeChat reply', async t => {
    const { service, supervisor, event } = await serviceFixture(t);
    supervisor.emit('thread-result', event); supervisor.emit('thread-result', event);
    assert.equal(service.db.value.jobs.length, 2);
    assert.ok(service.db.value.jobs.every(j => j.status === 'ready' && j.turnId === event.id && j.directReply === undefined));
    service.db.change(v => v.jobs.push({ id: 'c'.repeat(64), accountId: 'account', peerId: 'one', status: 'running' }));
    supervisor.emit('thread-result', { ...event, id: 'd'.repeat(64), source: { kind: 'channel', id: 'c'.repeat(64) } });
    const forwarded = service.db.value.jobs.filter(j => j.turnId === 'd'.repeat(64));
    assert.deepEqual(forwarded.map(j => j.peerId), ['two']);
    supervisor.emit('thread-result', { ...event, id: 'e'.repeat(64), source: { kind: 'cron', id: 'cron' } });
    assert.equal(service.db.value.jobs.some(j => j.turnId === 'e'.repeat(64)), false, 'cron uses its durable scheduler admission');
});
test('scheduled subscriptions follow all-results bindings unless the task explicitly enables delivery', async t => {
    const { service, event } = await serviceFixture(t);
    assert.deepEqual(service.captureScheduledRecipients({ ...event, notificationMode: 'inherit' }).map(r => r.peerId), ['one', 'two']);
    const refs = service.captureScheduledRecipients({ ...event, notificationMode: 'on' });
    assert.deepEqual(refs.map(r => r.peerId), ['one', 'two', 'three']);
    assert.equal(service.scheduledRecipient(refs[2], { ...event, notificationMode: 'inherit' }), null);
    service.db.change(v => { v.bindings[0].replyMode = 'wechat'; });
    assert.equal(service.scheduledRecipient(refs[0], { ...event, notificationMode: 'inherit' }), null);
});
test('late completion notices, revoked permissions and missing reply context do not acquire extra recipients', async t => {
    const { service, event } = await serviceFixture(t);
    service.db.change(v => {
        v.bindings[0].excludedTurnId = event.id;
        v.bindings[1].boundAt = event.completedAt + 1;
    });
    service.admitThreadResult(event); assert.equal(service.db.value.jobs.length, 0);
    service.db.change(v => { delete v.bindings[0].excludedTurnId; v.bindings[1].boundAt = 0; v.peers = []; v.accounts[0].allowedUsers = ['one']; });
    service.admitThreadResult(event);
    assert.equal(service.db.value.jobs.length, 1);
    const job = service.job(digest(['weixin-thread', event.id, 'account', 'one']));
    assert.equal(job.status, 'ignored'); assert.equal(job.reason, 'reply-context-missing');
    service.db.change(v => { v.bindings[0].id = 'replacement'; });
    assert.equal(service.bindingFor(job), null, 'fixed binding identity cannot be transferred to a replacement');
});
