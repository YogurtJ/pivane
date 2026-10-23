const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-management-compat-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { TaskCatalog } = require('../server/pi-task-catalog');
const { AgentMessages } = require('../server/pi-agent-messages');
const { MESSAGE_OUT, messageIdFor, outboundMessage } = require('../server/pi-agent-message-format');
const { assistantProfile } = require('../server/pi-extension-assistant');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const marker of ['pivane-extension-assistant', 'pi5-extension-assistant', 'pivane-profile-authoring', 'pi5-profile-authoring']) {
    test(`${marker} is neither addressable nor a publish/recovery recipient`, async t => {
        const cwd = path.join(root, marker); fs.mkdirSync(cwd);
        const store = new PiSessionStore(), { SessionManager } = await getSdk();
        const source = await store.createSession(cwd, 'Source');
        const normal = await store.createSession(cwd, 'Normal');
        const blocked = await store.createSession(cwd, 'Management');
        const ordinaryMarkerText = await store.createSession(cwd, 'Marker text is not an identity');
        const manager = SessionManager.open(blocked.path);
        manager.appendCustomEntry(marker, { version: 1, sessionId: blocked.id, scope: 'global', language: 'en' });
        if (marker.endsWith('extension-assistant')) assert.equal(assistantProfile(manager)?.kind, 'extensions', 'native identity already recognizes this alias');
        SessionManager.open(ordinaryMarkerText.path).appendCustomMessageEntry(marker, marker, true, {});
        const requestId = 'saved-before-compat-fix', messageId = messageIdFor(source.id, requestId);
        const record = outboundMessage({ version: 1, messageId, requestId, from: { cwd, sessionId: source.id }, to: { cwd, sessionId: blocked.id },
            text: 'Synthetic legacy queued intent', wake: true, hop: 0, conversationId: messageId, replyTo: null, sentAt: new Date().toISOString() });
        SessionManager.open(source.path).appendCustomEntry(MESSAGE_OUT, record);
        const worker = { cwd, sessionId: source.id };
        let starts = 0;
        const supervisor = { workers: new Map([[source.path, worker]]), getActiveWorker: () => null,
            getWorker: async () => { starts++; throw new Error('No target worker may be started'); } };
        const catalog = new TaskCatalog({ store });
        const service = new AgentMessages({ catalog, supervisor, limits: { pumpMs: 1e9, recoveryMs: 0 } });
        t.after(async () => { await service.dispose(); await catalog.dispose(); });
        const listing = await service.threads(worker, {});
        assert.deepEqual(new Set(listing.threads.map(row => row.id)), new Set([source.id, normal.id, ordinaryMarkerText.id]));
        const indexed = catalog.threads(await catalog.project(cwd)).find(row => row.id === blocked.id);
        assert.equal(indexed.special, marker.replace(/^pi5-/, 'pivane-'));
        await assert.rejects(service.send(worker, { phase: 'prepare', requestId: 'new-send', to: blocked.id, message: 'Do not deliver', hop: 0 }), /cannot receive/);
        await assert.rejects(service.send(worker, { phase: 'publish', messageId }), /unavailable/);
        await service.recover(); await service.pump();
        assert.equal(service.queue.size, 0); assert.equal(starts, 0);
        const prepared = await service.send(worker, { phase: 'prepare', requestId: 'normal-send', to: normal.id, message: 'Allowed ordinary target', hop: 0, wake: false });
        assert.equal(prepared.status, 'prepared'); assert.equal(prepared.to.sessionId, normal.id);
        assert.equal(service.queue.size, 0, 'preparation still cannot bypass native outbox publication');
    });
}

test('a previously persisted legacy management binding cannot start work or send pending replies', async t => {
    const cwd = path.join(root, 'persisted-binding'); fs.mkdirSync(cwd);
    const store = new PiSessionStore(), { SessionManager } = await getSdk();
    const target = await store.createSession(cwd, 'Legacy management');
    SessionManager.open(target.path).appendCustomEntry('pi5-extension-assistant', { version: 1, sessionId: target.id, scope: 'global', language: 'en' });
    let starts = 0, sends = 0;
    const { ChannelsService } = require('../server/channels/service');
    const service = new ChannelsService({ store, directory: path.join(root, 'legacy-channel-state'),
        supervisor: { on() {}, removeListener() {}, getActiveWorker: () => null, getWorker: async () => { starts++; throw new Error('Target worker must not start'); } },
        componentFactory: () => ({ status: () => ({ installed: false }) }) });
    t.after(() => service.dispose());
    await service.ready; service.claim();
    service.adapter = { send: async () => { sends++; return { message_id: 'fixture' }; } };
    const id = messageIdFor(target.id, 'previously-admitted');
    service.db.change(value => {
        value.accounts.push({ id: 'bot', userId: 'owner', token: 'synthetic', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: true, allowedUsers: ['owner'], cursor: '' });
        value.peers.push({ accountId: 'bot', peerId: 'owner', contextToken: 'synthetic' });
        value.bindings.push({ id: 'old-binding', accountId: 'bot', peerId: 'owner', cwd, sessionId: target.id, replyMode: 'all' });
        value.jobs.push({ id, accountId: 'bot', peerId: 'owner', bindingId: 'old-binding', target: { cwd, sessionId: target.id }, status: 'queued', text: 'do not run', at: Date.now() });
    });
    const binding = structuredClone(service.db.value.bindings[0]);
    await assert.rejects(service.run(id, { target: { cwd, sessionId: target.id } }), /管理助手线程不能绑定/);
    service.updateJob(id, { status: 'ready', directReply: 'do not send' });
    await assert.rejects(service.run(id, { target: { cwd, sessionId: target.id } }), /管理助手线程不能绑定/);
    assert.equal(starts, 0); assert.equal(sends, 0);
    assert.deepEqual(service.db.value.bindings[0], binding, 'existing records are preserved for explicit user reconciliation');
});
