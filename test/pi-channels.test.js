const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-channels-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const { ChannelStore } = require('../server/channels/store');
const { WeixinAdapter, apiOrigin } = require('../server/channels/weixin-adapter');
const { archiveFiles, SOURCES } = require('../server/channels/weixin-component');
const wait = async fn => { for (let i = 0; i < 500; i++) { const value = await fn(); if (value) return value; await delay(30); } throw Error('Fixture timed out'); };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('optional storage claims a single owner, preserves unknown fields and refuses external edits', () => {
    const directory = path.join(root, 'store'), store = new ChannelStore(directory);
    assert.equal(fs.existsSync(directory), false);
    store.claim(); store.change(v => { v.futureField = { keep: true }; v.jobs.push({ id: 'one', status: 'running' }); });
    assert.throws(() => new ChannelStore(directory).claim(), /另一个/);
    store.close(); const reopened = new ChannelStore(directory); reopened.claim();
    assert.equal(reopened.value.jobs[0].status, 'uncertain'); assert.deepEqual(reopened.value.futureField, { keep: true });
    fs.appendFileSync(reopened.file, ' ');
    assert.throws(() => reopened.change(v => { v.accounts = []; }), /变化/);
    reopened.close();
});
test('upstream downloads are pinned and platform identities stay lossless', () => {
    assert.throws(() => archiveFiles(Buffer.from('untrusted'), SOURCES[0]), /校验/);
    for (const url of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com.evil.test', 'https://example.com', 'https://secret@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444']) assert.throws(() => apiOrigin(url));
    assert.equal(apiOrigin('https://ilinkai.weixin.qq.com/path'), 'https://ilinkai.weixin.qq.com');
    const message = WeixinAdapter.prototype.message({ message_type: 1, message_state: 2, message_id: '18446744073709551615', from_user_id: 'user', context_token: 'context', item_list: [{ type: 1, text_item: { text: 'hello' } }] });
    assert.equal(message.messageId, '18446744073709551615');
});

test('authenticated optional channel connects, binds and delivers once through the native worker', { timeout: 120000 }, async () => {
    const calls = [], sends = []; let hold = null, releaseModel, sendFailure = false, installed = false, sendHold = null, releaseSend;
    let replyText = 'Native channel reply';
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part; const input = JSON.parse(body); calls.push(input);
        if (hold) await hold;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const [delta, finish] of [[{ role: 'assistant', content: replyText }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'normal', defaultThinkingLevel: 'off', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'normal', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ envToken: () => 'synthetic' });
    const adapter = {
        loginStart: async () => ({ id: 'login-one', status: 'wait', matrix: [[true]], expiresAt: Date.now() + 30000 }),
        loginPoll: async () => ({ status: 'confirmed', account: { id: 'bot-one', userId: 'owner', token: 'PRIVATE_BOT_TOKEN', baseUrl: 'https://ilinkai.weixin.qq.com', allowedUsers: ['owner'], enabled: true, cursor: '' } }),
        notify: async () => ({}),
        poll: async (_a, signal) => { await delay(60000, undefined, { signal }); return { msgs: [] }; },
        message: raw => WeixinAdapter.prototype.message(raw),
        send: async (account, peer, text, clientId) => { sends.push({ account: account.id, peer: peer.peerId, text, clientId }); if (sendHold) await sendHold; if (sendFailure) throw Error('ambiguous send'); return { message_id: String(sends.length) }; }
    };
    const directory = path.join(root, 'channels');
    const gateway = createPiAgentGateway({ accessService: access, channelsOptions: { directory,
        componentFactory: () => ({ status: () => ({ installed, version: installed ? 'fixture' : null }), install: async () => { installed = true; }, uninstall: () => { installed = false; } }),
        adapterFactory: async () => adapter } });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = base;
    const service = gateway.channels;
    const snapshot = async () => (await fetch(base + '/api/pi/channels', { headers: { Authorization: 'Bearer synthetic' } })).json();
    const action = async (action, body = {}) => {
        const response = await fetch(base + '/api/pi/channels/weixin/actions', { method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...body, confirmed: true, expectedRevision: (await snapshot()).revision }) });
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const incoming = (id, text = 'USER_CHANNEL_REQUEST', user = 'owner') => ({ message_type: 1, message_state: 2, message_id: id, from_user_id: user, context_token: 'PRIVATE_CONTEXT_TOKEN', item_list: [{ type: 1, text_item: { text } }] });
    try {
        await service.ready;
        assert.equal(fs.existsSync(directory), false, 'nonusers have no connector data or background timer'); assert.equal(service.timer, undefined);
        service.error = 'synthetic storage failure';
        assert.throws(() => service.assertUnbound(cwd, 'unknown'), /核对/, 'unreadable bindings cannot prove that removal is safe');
        service.error = null;
        assert.equal((await fetch(base + '/api/pi/channels')).status, 401);
        await action('install'); await action('login'); await wait(() => service.db.value.accounts.length === 1);
        assert.doesNotMatch(JSON.stringify(await snapshot()), /PRIVATE_BOT_TOKEN|PRIVATE_CONTEXT_TOKEN/);
        const session = await gateway.store.createSession(cwd, 'Bound thread');
        await action('bind', { accountId: 'bot-one', peerId: 'owner', cwd, sessionId: session.id });
        assert.throws(() => service.assertUnbound(cwd, session.id), /解除/);
        service.receive('bot-one', { msgs: [incoming('1', 'PRIVATE_INTRUDER', 'intruder')], get_updates_buf: 'cursor-1' });
        assert.equal(service.db.value.jobs.length, 0);
        hold = new Promise(resolve => { releaseModel = resolve; });
        service.receive('bot-one', { msgs: [incoming('2'), incoming('2')], get_updates_buf: 'cursor-2' }); service.pump();
        await wait(() => calls.length === 1);
        const worker = gateway.supervisor.getActiveWorker(session.path);
        assert.ok(worker.channelRun); assert.ok(worker.lifecycle().blockers.includes('message-channel'));
        await assert.rejects(worker.request('prompt', { message: 'concurrent web request' }), /操作/);
        assert.equal((await fetch(base + '/api/pi/channels', { headers: { Authorization: `Bearer ${worker.navigationToken}` } })).status, 401);
        assert.equal(service.db.value.jobs.length, 1);
        releaseModel(); hold = null;
        await wait(() => service.db.value.jobs[0].status === 'delivered');
        assert.equal(calls.length, 1); assert.equal(sends.length, 1); assert.equal(sends[0].peer, 'owner'); assert.equal(sends[0].text, 'Native channel reply');
        assert.doesNotMatch(fs.readFileSync(service.db.file, 'utf8'), /USER_CHANNEL_REQUEST|Native channel reply/, 'receipt is not a transcript copy');
        service.receive('bot-one', { msgs: [incoming('2')] }); service.pump(); await delay(50); assert.equal(calls.length, 1);
        const entries = (await worker.request('get_entries')).entries;
        assert.equal(entries.filter(e => e.customType === 'pivane-channel-message').length, 1);
        assert.ok(entries.some(e => e.customType === 'pivane-channel-turn' && e.data.status === 'completed'));
        await worker.request('prompt', { message: 'web-only message' }); await wait(() => worker.isIdle()); assert.equal(sends.length, 1, 'web turns do not leak into the channel');
        replyText = 'Long reply '.repeat(500);
        sendHold = new Promise(resolve => { releaseSend = resolve; });
        const beforeRevoke = sends.length;
        service.receive('bot-one', { msgs: [incoming('revoke-during-send')] }); service.pump(); await wait(() => sends.length > beforeRevoke);
        await action('account', { accountId: 'bot-one', enabled: true, allowedUsers: ['other'] });
        releaseSend(); sendHold = null;
        await wait(() => service.db.value.jobs.at(-1).status === 'uncertain');
        assert.equal(sends.length, beforeRevoke + 1, 'revoking access between chunks prevents all remaining sends');
        await action('acknowledge', { jobId: service.db.value.jobs.at(-1).id });
        await action('account', { accountId: 'bot-one', enabled: true, allowedUsers: ['owner'] });
        replyText = 'Native channel reply';
        hold = new Promise(resolve => { releaseModel = resolve; });
        const beforeStop = calls.length;
        service.receive('bot-one', { msgs: [incoming('stop-target')] }); service.pump(); await wait(() => calls.length === beforeStop + 1);
        service.receive('bot-one', { msgs: [{ ...incoming('stop-command', '/stop'), context_token: undefined }] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'reviewed');
        await wait(() => service.db.value.jobs.at(-2).status === 'delivered');
        assert.match(sends.at(-1).text, /任务已停止/); assert.equal(calls.length, beforeStop + 1, '/stop must not invoke a model');
        releaseModel(); hold = null;
        sendFailure = true;
        service.receive('bot-one', { msgs: [incoming('3')] }); service.pump(); await wait(() => service.db.value.jobs.at(-1).status === 'uncertain');
        const count = calls.length, sent = sends.length;
        service.pump(); await delay(100); assert.equal(calls.length, count); assert.equal(sends.length, sent, 'ambiguous delivery is never automatically replayed');
        await action('acknowledge', { jobId: service.db.value.jobs.at(-1).id });
        const cold = await gateway.store.createSession(cwd, 'Cold target');
        await action('bind', { accountId: 'bot-one', peerId: 'owner', cwd, sessionId: cold.id });
        const getWorker = gateway.supervisor.getWorker.bind(gateway.supervisor);
        let releaseStartup, announceStartup;
        const startup = new Promise(resolve => { announceStartup = resolve; });
        const gate = new Promise(resolve => { releaseStartup = resolve; });
        gateway.supervisor.getWorker = async input => { announceStartup(); await gate; return getWorker(input); };
        service.receive('bot-one', { msgs: [incoming('disabled-during-start')] }); service.pump(); await startup;
        const beforeDisabled = calls.length;
        await action('account', { accountId: 'bot-one', enabled: false, allowedUsers: ['owner'] });
        releaseStartup(); await wait(() => service.runs.size === 0);
        gateway.supervisor.getWorker = getWorker;
        assert.equal(calls.length, beforeDisabled, 'disabling during startup must prevent model execution');
        assert.equal(service.db.value.jobs.at(-1).status, 'cancelled');
        await action('unbind', { accountId: 'bot-one', peerId: 'owner' });
        const stale = await gateway.store.createSession(cwd, 'Interrupted native channel turn');
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        const staleId = 'a'.repeat(64);
        SessionManager.open(stale.path).appendCustomEntry('pivane-channel-turn', { version: 1, id: staleId, sessionId: stale.id, status: 'running', startedAt: Date.now() });
        const staleWorker = await getWorker({ cwd, sessionPath: stale.path, sessionId: stale.id });
        const staleTimeout = new AbortController(), beforeStale = calls.length;
        try {
            const duplicate = await Promise.race([staleWorker.channelTurn({ id: staleId, peerId: 'owner', text: 'must not run again' }),
                delay(5000, undefined, { signal: staleTimeout.signal }).then(() => { throw Error('Stale native turn waited for a nonexistent run'); })]);
            assert.equal(duplicate.reused, true); assert.equal(duplicate.status, 'running');
            assert.equal(calls.length, beforeStale, 'an interrupted native turn cannot be restarted by duplicate ingress');
        } finally { staleTimeout.abort(); }
        await action('uninstall');
        assert.equal(installed, false); assert.ok((await gateway.store.getSession(cwd, session.id)).path, 'uninstall preserves native history');
    } finally {
        releaseModel?.(); releaseSend?.(); await gateway.dispose(); access.dispose(); await new Promise(r => server.close(r)); await new Promise(r => provider.close(r));
    }
});
