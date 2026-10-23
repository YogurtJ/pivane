const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-channel-delivery-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { ChannelsService } = require('../server/channels/service');
const { ChannelStore } = require('../server/channels/store');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(t) {
    const directory = path.join(root, String(Math.random())); const db = new ChannelStore(directory); db.claim(); t.after(() => db.close());
    db.change(v => Object.assign(v, {
        accounts: [{ id: 'bot', userId: 'owner', enabled: true, allowedUsers: ['peer'], token: 'synthetic', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: '' }],
        bindings: [{ id: 'binding', accountId: 'bot', peerId: 'peer', cwd: root, sessionId: 'thread' }],
        peers: [{ accountId: 'bot', peerId: 'peer', contextToken: 'synthetic' }]
    }));
    const event = { runId: 'run', jobId: 'cron-job', name: 'Report', status: 'completed', replyEntryId: 'reply', target: { cwd: root, sessionId: 'thread' } };
    const marker = status => ({ type: 'custom', customType: 'pivane-cron-run', data: { runId: 'run', sessionId: 'thread', status, ...(['settled', 'completed'].includes(status) ? { replyEntryId: 'reply' } : {}) } });
    const branch = [marker('prepared'), marker('running'), { type: 'custom_message', customType: 'pivane-cron-message', details: { runId: 'run' } },
        { type: 'custom', customType: 'pivane-deliverable', data: { id: 'own-report', manifestRevision: 'v1' } },
        { id: 'reply', type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Report complete' }] } }, marker('settled'), marker('completed'),
        { type: 'message', message: { role: 'user', content: 'Later web input' } },
        { type: 'custom', customType: 'pivane-deliverable', data: { id: 'later-private', manifestRevision: 'v2' } }];
    const sends = [], media = [], s = Object.create(ChannelsService.prototype);
    Object.assign(s, { db, ready: Promise.resolve(), stopping: false, error: null, mutating: false, runs: new Map(), operations: new Set(), isSuspended: () => false,
        canNotifyScheduled: () => true,
        store: { withSessionRead: async (_cwd, _id, fn) => fn({}, { manager: () => ({ getSessionId: () => 'thread', getBranch: () => branch, getEntries: () => branch }), validate() {} }) },
        adapter: { send: async (_a, _p, text) => { sends.push(text); return {}; }, sendMedia: async (_a, _p, value) => { media.push(value); return {}; } },
        deliverables: { manifest: async () => ({ manifest: { files: [] } }), root: async () => root },
        mediaRoot: root });
    event.recipients = s.captureScheduledRecipients(event);
    return { s, db, event, branch, sends, media };
}

test('cron admission persists only owned bounded artifacts, without inline network delivery', async t => {
    const { s, db, event, sends } = fixture(t);
    assert.equal((await s.notifyScheduledRun(event)).status, 'accepted');
    assert.equal(sends.length, 0); assert.equal(db.value.jobs[0].status, 'ready');
    assert.deepEqual(db.value.jobs[0].deliverables, [{ id: 'own-report', manifestRevision: 'v1' }]);
    assert.match(db.value.jobs[0].directReply, /Report complete/);
});

test('lost admission acknowledgement and reopened channel storage do not duplicate a job', async t => {
    const { s, db, event } = fixture(t); await s.notifyScheduledRun(event);
    const directory = db.directory; db.close(); const reopened = new ChannelStore(directory); reopened.claim(); t.after(() => reopened.close()); s.db = reopened;
    assert.equal((await s.notifyScheduledRun(event)).status, 'accepted'); assert.equal(reopened.value.jobs.length, 1);
});

test('replacement bindings cannot receive old frozen notifications', async t => {
    const { s, db, event } = fixture(t);
    db.change(v => { v.bindings[0].id = 'new-binding'; });
    assert.equal((await s.notifyScheduledRun(event)).status, 'skipped'); assert.equal(db.value.jobs.length, 0);
});

test('permission revoked while native results are read is checked again at admission', async t => {
    const { s, db, event } = fixture(t), read = s.store.withSessionRead;
    s.store.withSessionRead = async (...args) => { const result = await read(...args); db.change(v => { v.accounts[0].allowedUsers = []; }); return result; };
    assert.equal((await s.notifyScheduledRun(event)).status, 'skipped'); assert.equal(db.value.jobs.length, 0);
});

test('transient native read failure preserves local retry; missing proof never invents a reply', async t => {
    const { s, db, event, branch } = fixture(t), read = s.store.withSessionRead;
    s.store.withSessionRead = async () => { throw Error('Synthetic read race'); };
    assert.equal((await s.notifyScheduledRun(event)).status, 'retry'); assert.equal(db.value.jobs.length, 0);
    s.store.withSessionRead = read; branch.splice(5, 2);
    assert.equal((await s.notifyScheduledRun(event)).status, 'retry'); assert.equal(db.value.jobs.length, 0);
});

test('unacknowledged terminal cron receipts survive normal channel history trimming', t => {
    const { s, db } = fixture(t); s.scheduledAdmissionPending = id => id === 'run';
    db.change(v => { v.jobs = [{ id: 'protected', kind: 'cron', cronRunId: 'run', status: 'delivered' }, ...Array.from({ length: 4500 }, (_, i) => ({ id: 'old-' + i, status: 'delivered' }))]; s.trimJobs(v); });
    assert.equal(db.value.jobs.length, 4500); assert.equal(db.value.jobs[0].id, 'protected');
});

test('oversized or invalid attachments produce a partial delivery with specific explanation', async t => {
    const { s, db, event, sends, media } = fixture(t); await s.notifyScheduledRun(event);
    s.deliverables.manifest = async () => ({ manifest: { files: [
        { index: 0, name: 'large.pdf', size: 17 * 1024 * 1024, revision: 'r' },
        { index: 1, name: 'corrupt.txt', size: 4, revision: 'r' },
        { index: 2, name: 'good.txt', size: 4, revision: 'r' }
    ] } });
    s.deliverables.readObject = async (_root, filename) => ({ bytes: Buffer.from('text'), size: 4, revision: filename.endsWith('1.bin') ? 'wrong' : 'r' });
    await s.run(db.value.jobs[0].id, {});
    assert.equal(db.value.jobs[0].status, 'partial'); assert.equal(media.length, 1); assert.equal(media[0].name, 'good.txt');
    assert.match(sends[0], /large.pdf：超过 16 MiB/); assert.match(sends[0], /corrupt.txt：无法读取或校验/);
    assert.deepEqual(db.value.jobs[0].deliveryIssues.map(i => i.reason), ['size', 'unreadable']);
});

test('generated media still running is reported pending instead of being silently omitted', async t => {
    const { s } = fixture(t); s.mediaLabService = { chatRequests: { publicState: () => ({ attempts: [{ status: 'running' }] }) } };
    const issues = [];
    assert.deepEqual(await s.collectMediaAssets([{ id: 'plan', summary: 'Audio' }], 6, issues), []);
    assert.deepEqual(issues, [{ name: 'Audio', reason: 'pending' }]); assert.match(s.deliveryWarning(issues), /confirm/);
});

test('attachment limits are visible and diagnostic payload remains bounded', async t => {
    const { s } = fixture(t); s.deliverables.manifest = async () => ({ manifest: { files: Array.from({ length: 40 }, (_, i) => ({ index: i, name: 'f' + i, size: 4, revision: 'r' })) } });
    s.deliverables.readObject = async () => ({ bytes: Buffer.from('text'), size: 4, revision: 'r' });
    const issues = [], files = await s.collectDeliverables([{ id: 'report', manifestRevision: 'v' }], issues);
    assert.equal(files.length, 6); assert.equal(issues.length, 20); assert.equal(issues[0].reason, 'limit');
});

test('uncertain network delivery is never retried by ordinary pumping or admission retry', async t => {
    const { s, db, event, sends } = fixture(t); await s.notifyScheduledRun(event);
    s.adapter.send = async (_a, _p, body) => { sends.push(body); throw Error('ambiguous send'); };
    s.pump(); for (let i = 0; i < 100 && s.runs.size; i++) await delay(5);
    assert.equal(db.value.jobs[0].status, 'uncertain'); assert.equal(sends.length, 1);
    assert.equal((await s.notifyScheduledRun(event)).status, 'accepted'); s.pump(); await delay(20);
    assert.equal(sends.length, 1);
});

test('turning off scheduled notifications cancels an admitted unsent delivery', async t => {
    const { s, db, event, sends } = fixture(t); await s.notifyScheduledRun(event); s.canNotifyScheduled = () => false;
    s.pump(); assert.equal(db.value.jobs[0].status, 'cancelled'); assert.equal(sends.length, 0);
});
