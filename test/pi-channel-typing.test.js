const test = require('node:test');
const assert = require('node:assert/strict');
const { startTyping, typingSnapshot } = require('../server/channels/typing');
const { WeixinAdapter } = require('../server/channels/weixin-adapter');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const account = { id: 'bot', userId: 'owner', token: 'secret-token', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: true, allowedUsers: ['peer'] };
    const peer = { accountId: 'bot', peerId: 'peer', contextToken: 'secret-context', typingTicket: 'expired-persisted-ticket' };
    const calls = []; let tickets = 0;
    const service = { db: { value: { accounts: [account], peers: [peer] } }, stopping: false, isSuspended: () => false,
        adapter: { typingTicket: async () => `ticket-${++tickets}`, typing: async (a, p, ticket, active) => { calls.push({ ticket, active }); } } };
    return { account, peer, calls, service, tickets: () => tickets, next: async () => { t.mock.timers.tick(5000); await settle(); } };
}
test('expired cached ticket is ignored and rejected fresh ticket is refreshed with diagnostic recovery', async t => {
    const f = fixture(t); const send = f.service.adapter.typing;
    f.service.adapter.typing = async (...args) => { await send(...args); if (args[2] === 'ticket-1' && args[3]) throw Error('secret-provider-body'); };
    const stop = startTyping(f.service, f.account, 'peer'); await settle();
    assert.equal(typingSnapshot(f.service)[0].status, 'degraded');
    await f.next();
    assert.equal(f.tickets(), 2);
    assert.deepEqual(f.calls, [{ ticket: 'ticket-1', active: true }, { ticket: 'ticket-1', active: false }, { ticket: 'ticket-2', active: true }]);
    assert.equal(typingSnapshot(f.service)[0].status, 'active');
    assert.equal(typingSnapshot(f.service)[0].reason, null);
    assert.doesNotMatch(JSON.stringify(typingSnapshot(f.service)), /secret|ticket-/);
    assert.equal(f.peer.typingTicket, 'expired-persisted-ticket');
    const first = stop(); assert.equal(stop(), first); await first;
    assert.equal(f.calls.filter(c => !c.active).length, 2);
});
test('persistent rejection stops after two attempts without repeated timer spam', async t => {
    const f = fixture(t);
    f.service.adapter.typingTicket = async () => { f.calls.push('ticket'); throw Error('private'); };
    const stop = startTyping(f.service, f.account, 'peer'); await settle();
    await f.next(); await f.next(); await f.next();
    assert.deepEqual(f.calls, ['ticket', 'ticket']);
    assert.deepEqual(typingSnapshot(f.service)[0], { accountId: 'bot', peerId: 'peer', status: 'degraded', failures: 2, reason: 'ticket-failed' });
    await stop();
});
test('persistent active rejection also has a bounded refresh budget', async t => {
    const f = fixture(t); const send = f.service.adapter.typing;
    f.service.adapter.typing = async (...args) => { await send(...args); if (args[3]) throw Error('rejected'); };
    const stop = startTyping(f.service, f.account, 'peer'); await settle(); await f.next(); await f.next();
    assert.equal(f.tickets(), 2); assert.equal(f.calls.filter(c => c.active).length, 2);
    assert.equal(f.calls.filter(c => !c.active).length, 2); await stop();
});
test('slow active request never overlaps heartbeats and stop waits for late cancel', async t => {
    const f = fixture(t), pending = deferred(); const send = f.service.adapter.typing;
    f.service.adapter.typing = async (...args) => { await send(...args); if (args[3]) await pending.promise; };
    const stop = startTyping(f.service, f.account, 'peer'); await settle();
    await f.next(); await f.next(); assert.equal(f.calls.length, 1);
    const done = stop(); pending.resolve(); await done;
    await f.next(); assert.deepEqual(f.calls.map(c => c.active), [true, false]);
});
test('stop before ticket reply never sends a late active or unnecessary cancel', async t => {
    const f = fixture(t), pending = deferred(); f.service.adapter.typingTicket = () => pending.promise;
    const stop = startTyping(f.service, f.account, 'peer'); const done = stop();
    pending.resolve('late-ticket'); await done; await f.next(); assert.deepEqual(f.calls, []);
});
for (const change of ['disable', 'revoke', 'context', 'token', 'stopping', 'suspended']) {
    test(`${change} while active request is pending cancels late response and ends heartbeat`, async t => {
        const f = fixture(t), pending = deferred(); const send = f.service.adapter.typing;
        f.service.adapter.typing = async (...args) => { await send(...args); if (args[3]) await pending.promise; };
        const stop = startTyping(f.service, f.account, 'peer'); await settle();
        if (change === 'disable') f.account.enabled = false;
        if (change === 'revoke') f.account.allowedUsers = [];
        if (change === 'context') f.peer.contextToken = 'new-context';
        if (change === 'token') f.account.token = 'new-token';
        if (change === 'stopping') f.service.stopping = true;
        if (change === 'suspended') f.service.isSuspended = () => true;
        pending.resolve(); await settle(); await f.next(); await stop();
        assert.deepEqual(f.calls.map(c => c.active), [true, false]);
    });
}
test('revocation during ticket lookup sends nothing', async t => {
    const f = fixture(t), pending = deferred(); f.service.adapter.typingTicket = () => pending.promise;
    const stop = startTyping(f.service, f.account, 'peer'); f.account.allowedUsers = [];
    pending.resolve('late-ticket'); await settle(); await stop(); assert.deepEqual(f.calls, []);
});
test('next run gets a fresh context bound ticket and recovers diagnostics', async t => {
    const f = fixture(t); f.service.adapter.typingTicket = async () => '';
    await startTyping(f.service, f.account, 'peer')();
    f.peer.contextToken = 'new-context';
    f.service.adapter.typingTicket = async (a, p) => { assert.equal(p.contextToken, 'new-context'); return 'new-ticket'; };
    const stop = startTyping(f.service, f.account, 'peer'); await settle();
    assert.equal(typingSnapshot(f.service)[0].status, 'active'); await stop();
});
test('diagnostics are bounded, copied, and cancel failure is observable', async t => {
    const f = fixture(t);
    for (let i = 0; i < 105; i++) await startTyping(f.service, f.account, `unknown-${i}`)();
    assert.equal(typingSnapshot(f.service).length, 100);
    const snapshot = typingSnapshot(f.service); snapshot[0].status = 'mutated';
    assert.notEqual(typingSnapshot(f.service)[0].status, 'mutated');
    f.service.adapter.typing = async (a, p, ticket, active) => { if (!active) throw Error('secret'); };
    const stop = startTyping(f.service, f.account, 'peer'); await settle(); await stop();
    assert.equal(typingSnapshot(f.service).at(-1).reason, 'cancel-failed');
});

test('bounded injected transport surfaces discarded HTTP 200 application errors and recovers', async t => {
    const f = fixture(t);
    const { createTransport, BASE } = require('../server/channels/weixin-adapter');
    require('node-fetch');
    let reply = '{"ret":7,"errmsg":"secret-response"}', fetches = 0;
    t.mock.method(require.cache[require.resolve('node-fetch')], 'exports', async (url, options) => {
        fetches++;
        assert.equal(options.redirect, 'error'); assert.equal(options.size, 2 * 1024 * 1024);
        assert.ok(options.signal instanceof AbortSignal);
        return { ok: true, status: 200, headers: {}, buffer: async () => Buffer.from(reply) };
    });
    const transport = createTransport(new AbortController().signal);
    const api = { getConfig: async () => ({ ret: 0, typing_ticket: 'fresh-ticket' }),
        // Matches the reviewed upstream behavior: raw application reply discarded.
        sendTyping: async params => { await transport(BASE + '/ilink/bot/sendtyping', { method: 'POST', body: JSON.stringify(params.body) }); } };
    f.service.adapter = new WeixinAdapter({ api });
    const stop = startTyping(f.service, f.account, 'peer'); await settle();
    assert.equal(typingSnapshot(f.service)[0].status, 'degraded');
    assert.doesNotMatch(JSON.stringify(typingSnapshot(f.service)), /secret-response/);
    reply = '{}'; await f.next();
    assert.equal(typingSnapshot(f.service)[0].status, 'active');
    await stop(); assert.equal(fetches, 4);
    for (const body of ['{"ret":0}', '{"errcode":0}', '{}']) {
        reply = body; await transport(BASE + '/ilink/bot/sendtyping');
    }
    for (const body of ['{"ret":1}', '{"errcode":9}', 'secret-invalid-json', '', 'null', '[]']) {
        reply = body;
        await assert.rejects(transport(BASE + '/ilink/bot/sendtyping'), error => error.message === '微信输入状态请求失败');
    }
    reply = 'not-json';
    const other = await transport(BASE + '/ilink/bot/getconfig');
    assert.equal(await other.text(), 'not-json');
    await assert.rejects(transport('https://evil.test/ilink/bot/sendtyping'), /不受信任/);
});
test('adapter rejects ticket application errors and sanitizes provider exceptions', async () => {
    const account = { baseUrl: 'https://ilinkai.weixin.qq.com', token: 'secret' }, peer = { peerId: 'peer', contextToken: 'context' };
    const adapter = new WeixinAdapter({ api: { getConfig: async () => ({ ret: 0, errcode: 5, typing_ticket: 'rejected' }),
        sendTyping: async () => { throw Error('secret-provider-response'); } } });
    await assert.rejects(adapter.typingTicket(account, peer), /微信输入状态请求失败/);
    await assert.rejects(adapter.typing(account, peer, 'ticket'), error => error.message === '微信输入状态请求失败');
    adapter.api.sendTyping = async () => ({ errcode: 4 });
    await assert.rejects(adapter.typing(account, peer, 'ticket'), /微信输入状态请求失败/);
});
