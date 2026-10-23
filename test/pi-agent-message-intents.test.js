const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AgentMessages } = require('../server/pi-agent-messages');
const { TaskCatalog } = require('../server/pi-task-catalog');
const { MESSAGE_OUT, MESSAGE_IN, receiveAgentMessages, messageIdFor } = require('../server/pi-agent-message-format');

async function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-message-intent-')));
    const cwd = path.join(root, 'project'), directory = path.join(root, 'sessions');
    fs.mkdirSync(cwd); fs.mkdirSync(directory);
    for (const [key, value] of Object.entries({ PI_WEB_NAVIGATION_TOKEN: 'synthetic', PI_WORKSPACE_INTERNAL_ORIGIN: 'http://127.0.0.1:1', PI_CODING_AGENT_DIR: path.join(root, 'agent') })) {
        const previous = process.env[key]; process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const { SessionManager } = await require('../server/pi-session-store').getSdk();
    const open = name => {
        const file = path.join(directory, name + '.jsonl'); fs.writeFileSync(file, '', { mode: 0o600 });
        return SessionManager.open(file, undefined, cwd);
    };
    const sender = open('sender'), recipient = open('recipient');
    const source = { cwd, sessionId: sender.getSessionId() };
    const entries = manager => fs.readFileSync(manager.getSessionFile(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const f = { sender, recipient, source, phases: [], deliveries: 0, wakes: 0, recipientIdle: false, afterService: () => {},
        decode: data => data, append: (type, data) => sender.appendCustomEntry(type, data), sourceId: source.sessionId };
    const worker = { cwd, sessionId: recipient.getSessionId(), isIdle: () => f.recipientIdle, agentMessages: async ({ messages }) => {
        const saved = entries(sender).filter(entry => entry.type === 'custom' && entry.customType === MESSAGE_OUT);
        for (const message of messages) assert.ok(saved.some(entry => entry.data.messageId === message.messageId), 'native intent must already exist on disk before delivery');
        f.deliveries += messages.length;
        return receiveAgentMessages({ sendMessage: (message, options) => {
            if (options.triggerTurn) f.wakes++;
            else recipient.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        } }, { cwd, isIdle: () => true, hasPendingMessages: () => false, sessionManager: recipient }, { messages });
    } };
    const supervisor = { workers: new Map([[sender.getSessionFile(), source], [recipient.getSessionFile(), worker]]),
        getActiveWorker: file => file === recipient.getSessionFile() ? worker : source };
    const makeService = () => {
        f.catalog = new TaskCatalog({ store: { resolveProject: value => { assert.equal(value, cwd); return cwd; } }, directory: () => directory });
        f.service = new AgentMessages({ catalog: f.catalog, supervisor, limits: { pumpMs: 1e9, recoveryMs: 0 } });
    };
    makeService();
    f.restart = async () => { await f.service.dispose(); await f.catalog.dispose(); makeService(); };
    t.after(async () => { await f.service.dispose(); await f.catalog.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const events = new Map(), tools = new Map();
    const extension = path.join(__dirname, '../server/pi-agent-messages-extension.ts');
    const { registerAgentMessages } = require(process.env.PIVANE_TEST_PI_JITI).createJiti(extension)(extension);
    registerAgentMessages({ on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool), appendEntry: (...args) => f.append(...args) });
    const sessionManager = new Proxy(sender, { get(target, key) {
        if (key === 'getSessionId') return () => f.sourceId;
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const context = { mode: 'rpc', cwd, sessionManager };
    events.get('session_start')({}, context);
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const input = JSON.parse(options.body); f.phases.push(input.phase);
        if (input.phase === 'publish') assert.ok(entries(sender).some(entry => entry.customType === MESSAGE_OUT && entry.data.messageId === input.messageId));
        const data = await f.service.send(source, input);
        await f.afterService(input, data);
        return { ok: true, status: 200, json: async () => f.decode(data, input) };
    });
    f.run = (controller = new AbortController(), id = 'stable-call') => tools.get('agent_message').execute(id,
        { action: 'send', to: recipient.getSessionId(), message: 'Synthetic durable intent', wake: false }, controller.signal, () => {}, context);
    f.outbox = () => entries(sender).filter(entry => entry.type === 'custom' && entry.customType === MESSAGE_OUT);
    f.inbox = () => entries(recipient).filter(entry => entry.type === 'custom_message' && entry.customType === MESSAGE_IN);
    f.messageId = messageIdFor(source.sessionId, 'tool-stable-call');
    return f;
}

test('real SDK outbox is persisted before publication and stable tool identity cannot duplicate delivery', async t => {
    const f = await fixture(t); f.recipientIdle = true;
    const result = await f.run();
    assert.equal(result.details.status, 'delivered'); assert.equal(result.details.messageId, f.messageId);
    assert.deepEqual(f.phases, ['prepare', 'publish']); assert.equal(f.outbox().length, 1); assert.equal(f.inbox().length, 1);
    assert.equal(result.details.record, undefined, 'private preparation payload is omitted from the model result');
    await f.run();
    assert.equal(f.outbox().length, 1); assert.equal(f.inbox().length, 1); assert.equal(f.deliveries, 1); assert.equal(f.wakes, 0);
    await f.restart();
    await assert.rejects(f.service.send(f.source, { phase: 'prepare', requestId: 'tool-stable-call', to: f.recipient.getSessionId(),
        message: 'different body after cold indexing', hop: 0, wake: false }), /different message/);
});

test('a lost prepare response leaves no native intent, delivery, or restart recovery', async t => {
    const f = await fixture(t); f.recipientIdle = true;
    f.decode = () => { throw new SyntaxError('truncated response'); };
    await assert.rejects(f.run(), /preparation failed/);
    assert.equal(f.outbox().length, 0); assert.equal(f.service.queue.size, 0); assert.equal(f.deliveries, 0);
    await f.restart(); await f.service.recover(); await f.service.pump();
    assert.equal(f.service.queue.size, 0); assert.equal(f.inbox().length, 0);
});

test('cancellation after prepare but before append leaves no intent or delivery', async t => {
    const f = await fixture(t), controller = new AbortController();
    f.afterService = input => { if (input.phase === 'prepare') controller.abort(); };
    await assert.rejects(f.run(controller), /preparation failed/);
    assert.deepEqual(f.phases, ['prepare']); assert.equal(f.outbox().length, 0); assert.equal(f.service.queue.size, 0);
});

test('source identity change while preparing prevents append and publication', async t => {
    const f = await fixture(t);
    f.afterService = () => { f.sourceId = f.recipient.getSessionId(); };
    await assert.rejects(f.run(), /Source thread changed/);
    assert.equal(f.outbox().length, 0); assert.deepEqual(f.phases, ['prepare']); assert.equal(f.service.queue.size, 0);
});

for (const mode of ['throw', 'no-ack']) test(`native append ${mode} cannot publish`, async t => {
    const f = await fixture(t);
    f.append = () => { if (mode === 'throw') throw new Error('synthetic storage error'); };
    await assert.rejects(f.run(), error => error.message.includes(f.messageId) && error.message.includes('do not resend'));
    assert.deepEqual(f.phases, ['prepare']); assert.equal(f.outbox().length, 0); assert.equal(f.service.queue.size, 0);
});

test('cancellation after native commit recovers from the source JSONL without a publish retry', async t => {
    const f = await fixture(t), controller = new AbortController(), append = f.append;
    f.append = (...args) => { append(...args); controller.abort(); };
    await assert.rejects(f.run(controller), error => error.message.includes(f.messageId));
    assert.deepEqual(f.phases, ['prepare']); assert.equal(f.outbox().length, 1); assert.equal(f.service.queue.size, 0);
    await f.restart(); await f.service.recover();
    assert.deepEqual([...f.service.queue.keys()], [f.messageId]);
    f.recipientIdle = true; await f.service.pump();
    assert.equal(f.inbox().length, 1); assert.equal(f.deliveries, 1);
    f.service.queue.clear(); await f.service.recover(); await f.service.pump();
    assert.equal(f.inbox().length, 1); assert.equal(f.deliveries, 1); assert.deepEqual(f.phases, ['prepare']);
});

test('lost publication response while the recipient is busy survives process state loss and delivers once', async t => {
    const f = await fixture(t);
    f.decode = (data, input) => { if (input.phase === 'publish') throw new SyntaxError('truncated publication response'); return data; };
    await assert.rejects(f.run(), error => error.message.includes(f.messageId) && error.message.includes('Use status'));
    assert.deepEqual(f.phases, ['prepare', 'publish']); assert.equal(f.outbox().length, 1); assert.equal(f.inbox().length, 0);
    await f.restart(); await f.service.recover();
    assert.equal((await f.service.lookup(f.source, { messageId: f.messageId })).status, 'queued');
    f.recipientIdle = true; await f.service.pump();
    assert.equal(f.inbox().length, 1); assert.equal(f.deliveries, 1);
    await f.restart(); await f.service.recover(); await f.service.pump();
    assert.equal(f.inbox().length, 1); assert.equal(f.deliveries, 1); assert.equal(f.outbox().length, 1);
});
