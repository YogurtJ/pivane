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
    const calls = [], sends = [], typings = [], mediaSends = []; let hold = null, releaseModel, sendFailure = false, installed = false, sendHold = null, releaseSend;
    let replyText = 'Native channel reply';
    let deliverTool = false;
    const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part; const input = JSON.parse(body); calls.push(input);
        if (hold) await hold;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (deliverTool && input.messages.at(-1)?.role !== 'tool') {
            const call = { role: 'assistant', tool_calls: [{ index: 0, id: `deliver-${calls.length}`, type: 'function', function: { name: 'deliver_files', arguments: JSON.stringify({ requestId: `req-${calls.length}`, title: 'Channel deliverables', files: ['report.md', 'chart.png'] }) } }] };
            for (const [delta, finish] of [[call, null], [{}, 'tool_calls']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
            return res.end('data: [DONE]\n\n');
        }
        for (const [delta, finish] of [[{ role: 'assistant', content: replyText }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'normal', defaultThinkingLevel: 'off', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'normal', input: ['text'], contextWindow: 32000, maxTokens: 1000 }, { id: 'vision', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ envToken: () => 'synthetic' });
    const adapter = {
        loginStart: async () => ({ id: 'login-one', status: 'wait', matrix: [[true]], expiresAt: Date.now() + 30000 }),
        loginPoll: async () => ({ status: 'confirmed', account: { id: 'bot-one', userId: 'owner', token: 'PRIVATE_BOT_TOKEN', baseUrl: 'https://ilinkai.weixin.qq.com', allowedUsers: ['owner'], enabled: true, cursor: '' } }),
        notify: async () => ({}),
        typingTicket: async () => 'ticket-1',
        typing: async (_account, peer, ticket, active) => { typings.push({ peer: peer.peerId, ticket, active }); },
        downloadImage: async () => ({ type: 'image', mimeType: 'image/png', data: onePixelPng.toString('base64') }),
        poll: async (_a, signal) => { await delay(60000, undefined, { signal }); return { msgs: [] }; },
        message: raw => WeixinAdapter.prototype.message(raw),
        send: async (account, peer, text, clientId) => { sends.push({ account: account.id, peer: peer.peerId, text, clientId }); if (sendHold) await sendHold; if (sendFailure) throw Error('ambiguous send'); return { message_id: String(sends.length) }; },
        sendMedia: async (account, peer, media, clientId) => { mediaSends.push({ account: account.id, peer: peer.peerId, kind: media.kind, name: media.name, size: media.bytes.length, clientId }); return { message_id: `media-${mediaSends.length}` }; }
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
        assert.ok(typings.some(t => t.active === true && t.ticket === 'ticket-1'), 'typing indicator started');
        assert.ok(typings.some(t => t.active === false && t.ticket === 'ticket-1'), 'typing indicator cancelled on finish');
        assert.doesNotMatch(fs.readFileSync(service.db.file, 'utf8'), /USER_CHANNEL_REQUEST|Native channel reply/, 'receipt is not a transcript copy');
        service.receive('bot-one', { msgs: [incoming('2')] }); service.pump(); await delay(50); assert.equal(calls.length, 1);
        const entries = (await worker.request('get_entries')).entries;
        assert.equal(entries.filter(e => e.customType === 'pivane-channel-message').length, 1);
        assert.ok(entries.some(e => e.customType === 'pivane-channel-turn' && e.data.status === 'completed'));
        await worker.request('prompt', { message: 'web-only message' });
        await wait(() => service.db.value.jobs.some(j => j.kind === 'thread' && j.status === 'delivered'));
        assert.equal(sends.length, 2, 'bound web turns deliver their final result exactly once');
        await wait(() => service.runs.size === 0);
        await action('bind', { accountId: 'bot-one', peerId: 'owner', cwd, sessionId: session.id, replyMode: 'wechat' });
        const beforeWechatOnly = calls.length;
        await worker.request('prompt', { message: 'web turn with WeChat-only routing' });
        await wait(() => calls.length > beforeWechatOnly && worker.isIdle());
        assert.equal(sends.length, 2, 'WeChat-only mode excludes web results');
        hold = new Promise(resolve => { releaseModel = resolve; });
        const beforeBindingRun = calls.length;
        await worker.request('prompt', { message: 'bind while this web task is running' });
        await wait(() => calls.length > beforeBindingRun);
        await action('bind', { accountId: 'bot-one', peerId: 'owner', cwd, sessionId: session.id });
        releaseModel(); hold = null;
        await wait(() => sends.length === 3 && service.runs.size === 0);
        assert.equal(service.db.value.jobs.filter(j => j.kind === 'thread').length, 2, 'binding includes the unfinished turn without backfilling completed turns');
        // A completed channel turn can wait for delivery while a later web turn publishes private artifacts.
        fs.writeFileSync(path.join(cwd, 'report.md'), '# Web-only fixture report\n');
        fs.writeFileSync(path.join(cwd, 'chart.png'), onePixelPng);
        const originalReadOutcome = service.readOutcome.bind(service);
        let announceOutcome, releaseOutcome;
        const outcomeStarted = new Promise(resolve => { announceOutcome = resolve; });
        const outcomeGate = new Promise(resolve => { releaseOutcome = resolve; });
        service.readOutcome = async job => { announceOutcome(); await outcomeGate; return originalReadOutcome(job); };
        service.receive('bot-one', { msgs: [incoming('delayed-outgoing', 'Reply without files')] }); service.pump();
        const delayedJob = service.db.value.jobs.at(-1); await outcomeStarted;
        deliverTool = true;
        const beforeWebFiles = calls.length;
        await worker.request('prompt', { message: 'Publish files only for the web conversation' });
        await wait(() => calls.length >= beforeWebFiles + 2 && worker.isIdle()); deliverTool = false;
        releaseOutcome(); await wait(() => service.job(delayedJob.id).status === 'delivered');
        service.readOutcome = originalReadOutcome;
        await wait(() => mediaSends.length === 2 && service.runs.size === 0);
        assert.deepEqual((await service.readOutcome(delayedJob)).deliverables, [], 'delayed channel result never borrows later web files');
        mediaSends.length = 0;
        // Slash commands: /help, /status, /model, /new
        const callsBeforeSlash = calls.length;
        service.receive('bot-one', { msgs: [incoming('slash-help', '/help')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /可用指令/);
        service.receive('bot-one', { msgs: [incoming('slash-status', '/status')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /Bound thread/);
        // Image input with non-vision model warns user; switching via /model vision allows image input
        const incomingImage = id => ({ message_type: 1, message_state: 2, message_id: id, from_user_id: 'owner', context_token: 'PRIVATE_CONTEXT_TOKEN', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'enc-img-1', aes_key: Buffer.alloc(16, 1).toString('base64') } } }] });
        service.receive('bot-one', { msgs: [incomingImage('img-no-vision')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /不支持图片输入/);
        service.receive('bot-one', { msgs: [incoming('slash-model', '/model vision')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /fixture\/vision/);
        assert.equal(calls.length, callsBeforeSlash, 'slash commands do not invoke LLM');
        // /thinking, /name, /compact, /reload
        service.receive('bot-one', { msgs: [incoming('slash-thinking-list', '/thinking')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /当前思考等级/);
        service.receive('bot-one', { msgs: [incoming('slash-thinking-set', '/thinking off')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /切换为：off/);
        service.receive('bot-one', { msgs: [incoming('slash-name', '/name 重命名后的主线程')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /重命名为：重命名后的主线程/);
        service.receive('bot-one', { msgs: [incoming('slash-status-rich', '/status')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /重命名后的主线程/);
        assert.match(sends.at(-1).text, new RegExp(`会话 ID：${session.id}`));
        assert.match(sends.at(-1).text, /上下文：/);
        assert.match(sends.at(-1).text, /记录：共 \d+ 条消息/);
        service.receive('bot-one', { msgs: [incoming('slash-compact', '/compact')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /上下文/);
        service.receive('bot-one', { msgs: [incoming('slash-reload', '/reload')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /已重新加载当前线程的技能、提示词与扩展资源/);
        service.receive('bot-one', { msgs: [incoming('slash-confirm-none', '/confirm')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /未启用媒体卡片服务|没有媒体生成卡片/);
        // Now image input + deliver_files outbound media & file
        fs.writeFileSync(path.join(cwd, 'report.md'), '# Channel Report\n');
        fs.writeFileSync(path.join(cwd, 'chart.png'), onePixelPng);
        deliverTool = true;
        service.receive('bot-one', { msgs: [incomingImage('img-with-vision')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        deliverTool = false;
        assert.equal(mediaSends.length, 2, 'deliver_files sends both markdown file and png image to WeChat');
        assert.deepEqual(mediaSends.map(m => ({ kind: m.kind, name: m.name })), [{ kind: 'file', name: 'report.md' }, { kind: 'image', name: 'chart.png' }]);
        // Waiting confirmation notification
        hold = new Promise(resolve => { releaseModel = resolve; });
        const sendsBeforeWait = sends.length;
        service.receive('bot-one', { msgs: [incoming('wait-ui-turn', 'need confirmation')] }); service.pump();
        await wait(() => worker.channelRun);
        worker._handleEvent({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Confirm', message: 'Proceed?' });
        await wait(() => sends.length > sendsBeforeWait);
        assert.match(sends.at(-1).text, /等待交互确认/);
        worker.resolveUi('ui-1');
        releaseModel(); hold = null;
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        // Proactive scheduled task notification to bound WeChat DM
        const cronJob = await gateway.cron.save({
            id: '11111111-1111-4111-8111-111111111111', name: 'Daily digest', prompt: 'Digest prompt',
            enabled: false, weixinNotification: 'inherit', mode: 'work',
            target: { kind: 'thread', cwd, sessionId: session.id },
            schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' }
        });
        deliverTool = true;
        const beforeCronMedia = mediaSends.length;
        replyText = 'Scheduled morning digest body';
        const cronRun = await gateway.cron.action(cronJob.id, { action: 'run', revision: cronJob.revision, requestId: '22222222-2222-4222-8222-222222222222' });
        await wait(async () => { await gateway.cron.tick(); return gateway.cron.db.run(cronRun.id)?.status === 'completed'; });
        await wait(() => sends.some(s => s.text.includes('Scheduled morning digest body')));
        await wait(() => service.db.value.jobs.some(j => j.kind === 'cron' && j.status === 'delivered'));
        deliverTool = false;
        assert.equal(mediaSends.length, beforeCronMedia + 2, 'scheduled notification includes its own published files');
        assert.equal(gateway.cron.db.run(cronRun.id).channelNotify.status, 'accepted');
        const cronEvent = gateway.cron.db.run(cronRun.id).channelNotify.event;
        const jobsBeforeDuplicate = service.db.value.jobs.length;
        const sendsBeforeDuplicate = sends.length;
        assert.equal((await service.notifyScheduledRun(cronEvent)).status, 'accepted');
        service.pump(); await delay(40);
        assert.equal(service.db.value.jobs.length, jobsBeforeDuplicate, 'lost local admission acknowledgement cannot duplicate a channel job');
        assert.equal(sends.length, sendsBeforeDuplicate);
        const originalPump = service.pump.bind(service); service.pump = () => {};
        const deletionRun = await gateway.cron.action(cronJob.id, { action: 'run', revision: cronJob.revision, requestId: '33333333-3333-4333-8333-333333333333' });
        await wait(async () => { await gateway.cron.tick(); return service.db.value.jobs.some(j => j.cronRunId === deletionRun.id && j.status === 'ready'); });
        const deletionNotice = service.db.value.jobs.find(j => j.cronRunId === deletionRun.id);
        const beforeDeleteSend = sends.length;
        await gateway.cron.action(cronJob.id, { action: 'delete', revision: cronJob.revision });
        service.pump = originalPump; service.pump();
        await wait(() => service.job(deletionNotice.id).status === 'cancelled');
        assert.equal(sends.length, beforeDeleteSend, 'deleted cron tombstone revokes already-admitted notifications');
        // /new command creates and rebinds to a fresh thread, then /resume lists and switches back by index or keyword
        service.receive('bot-one', { msgs: [incoming('slash-new', '/new 新建的微信会话')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /已新建并绑定线程：新建的微信会话/);
        assert.notEqual(service.db.value.bindings[0].sessionId, session.id);
        service.receive('bot-one', { msgs: [incoming('slash-resume-list', '/resume')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /当前项目最近线程/);
        assert.match(sends.at(-1).text, /\[1\]/);
        service.receive('bot-one', { msgs: [incoming('slash-resume-kw', '/resume 重命名后的主线程')] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.match(sends.at(-1).text, /已切换微信绑定到线程：重命名后的主线程/);
        assert.equal(service.db.value.bindings[0].sessionId, session.id);
        replyText = 'Native channel reply';
        const { SessionManager: AuditSessionManager } = await import('@earendil-works/pi-coding-agent');
        const management = await gateway.store.createSession(cwd, 'Managed helper');
        AuditSessionManager.open(management.path).appendCustomEntry('pivane-extension-assistant', {});
        service.receive('bot-one', { msgs: [incoming('resume-management', '/resume ' + management.id)] }); service.pump();
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered');
        assert.equal(service.db.value.bindings[0].sessionId, session.id);
        assert.match(sends.at(-1).text, /管理助手线程不能绑定/);
        const nativeGetWorker = gateway.supervisor.getWorker.bind(gateway.supervisor);
        let announceCommand, releaseCommand;
        const commandStarted = new Promise(resolve => { announceCommand = resolve; });
        const commandGate = new Promise(resolve => { releaseCommand = resolve; });
        gateway.supervisor.getWorker = async input => { announceCommand(); await commandGate; return nativeGetWorker(input); };
        service.receive('bot-one', { msgs: [incoming('revoke-command', '/model normal')] }); service.pump(); await commandStarted;
        await action('account', { accountId: 'bot-one', enabled: false, allowedUsers: ['owner'] });
        assert.equal(service.db.value.jobs.at(-1).status, 'cancelled');
        releaseCommand(); await wait(() => service.runs.size === 0);
        gateway.supervisor.getWorker = nativeGetWorker;
        assert.equal((await worker.request('get_state')).model.id, 'vision', 'a cancelled command cannot mutate the real native model');
        assert.equal(service.db.value.jobs.at(-1).status, 'cancelled');
        await action('account', { accountId: 'bot-one', enabled: true, allowedUsers: ['owner'] });
        const nativeRequest = worker.client.request.bind(worker.client);
        let announceReload, releaseReload;
        const reloadStarted = new Promise(resolve => { announceReload = resolve; });
        const reloadGate = new Promise(resolve => { releaseReload = resolve; });
        const priorConfirmations = [worker.loadedAgentProfileConfirmed, worker.loadedAssistantProjectConfirmed];
        worker.loadedAgentProfileConfirmed = true; worker.loadedAssistantProjectConfirmed = true;
        worker.client.request = async (...args) => { if (args[0] === 'get_commands') { announceReload(); await reloadGate; } return nativeRequest(...args); };
        service.receive('bot-one', { msgs: [incoming('revoke-reload', '/reload')] }); service.pump(); await reloadStarted;
        await action('account', { accountId: 'bot-one', enabled: false, allowedUsers: ['owner'] });
        releaseReload(); await wait(() => service.runs.size === 0);
        worker.client.request = nativeRequest;
        assert.equal(service.db.value.jobs.at(-1).status, 'cancelled');
        assert.equal(worker.loadedAgentProfileConfirmed, true, 'cancelled reload preserves profile confirmation');
        assert.equal(worker.loadedAssistantProjectConfirmed, true, 'cancelled reload preserves project confirmation');
        [worker.loadedAgentProfileConfirmed, worker.loadedAssistantProjectConfirmed] = priorConfirmations;
        await action('account', { accountId: 'bot-one', enabled: true, allowedUsers: ['owner'] });
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
        const beforeWebStop = calls.length;
        service.receive('bot-one', { msgs: [incoming('web-stop-target')] }); service.pump();
        await wait(() => calls.length > beforeWebStop);
        await assert.rejects(worker.recoverQueue(false), /其他操作/, 'queue recovery remains exclusive while a channel turn runs');
        const stoppedControls = await worker.recoverQueue(true);
        assert.equal(stoppedControls.stopping, false, 'web stop waits for native abort acknowledgement');
        await wait(() => service.db.value.jobs.at(-1).status === 'delivered' && service.runs.size === 0);
        assert.match(sends.at(-1).text, /任务已停止/);
        assert.equal(calls.length, beforeWebStop + 1, 'web stop does not submit a new prompt or repeat the task');
        releaseModel(); hold = null;
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
