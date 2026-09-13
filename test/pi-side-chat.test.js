const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-side-chat-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_TOKEN = 'side-test-token';
process.env.PI_WEB_APPROVE_PROJECTS = 'true';
process.env.PI_OFFLINE = '1';
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { buildSideReference, PiSideChatService } = require('../server/pi-side-chat');

const userText = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('');

async function waitFor(check) {
    const end = Date.now() + 12000;
    while (!await check()) { if (Date.now() > end) throw new Error('Side fixture timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

async function connect(url) {
    const socket = new WebSocket(url);
    const events = [], pending = new Map(); let next = 0;
    socket.on('message', raw => {
        const event = JSON.parse(raw); events.push(event);
        if (event.type === 'response' && pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
    });
    socket.call = (type, payload = {}) => new Promise(resolve => { const id = `side-test-${++next}`; pending.set(id, resolve); socket.send(JSON.stringify({ type, id, ...payload })); });
    socket.events = events;
    await once(socket, 'open'); return socket;
}

test('side references are bounded complete text, excluding thinking, tools, images and unfinished replies', async () => {
    const { estimateTokens } = await import('@earendil-works/pi-coding-agent');
    const messages = [
        { role: 'compactionSummary', summary: 'Prior decisions' },
        { role: 'user', content: 'Original request' },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'Completed answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'Current request' }, { type: 'image', data: 'PRIVATE_IMAGE' }] },
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Unfinished tools' }, { type: 'toolCall', id: 'x' }] },
        { role: 'toolResult', content: 'PRIVATE_TOOL_OUTPUT' },
        { role: 'assistant', stopReason: 'pending', content: 'PRIVATE_PARTIAL' }
    ];
    const model = { contextWindow: 16000 };
    const result = buildSideReference(messages, { mode: 'recent' }, model, estimateTokens);
    assert.equal(result.reference.messageCount, 3);
    assert.equal(result.reference.summaryIncluded, true);
    assert.ok(result.systemPrompt.includes('Current request'));
    for (const secret of ['PRIVATE_THINKING', 'PRIVATE_IMAGE', 'PRIVATE_TOOL_OUTPUT', 'PRIVATE_PARTIAL', 'Unfinished tools']) assert.ok(!result.systemPrompt.includes(secret));
    const large = buildSideReference([{ role: 'user', content: 'A'.repeat(200000) }, ...messages], { mode: 'recent', count: 12 }, model, estimateTokens);
    assert.ok(large.reference.omittedMessages > 0);
    assert.ok(large.reference.estimatedTokens <= large.reference.tokenBudget);
    assert.ok(Buffer.byteLength(large.systemPrompt) < 96000);
    assert.throws(() => buildSideReference(messages, { mode: 'quote', quote: 'A'.repeat(25000) }, model, estimateTokens));
    assert.throws(() => buildSideReference(messages, { mode: 'recent', count: 99 }, model, estimateTokens));
    const blank = buildSideReference(messages, { mode: 'blank' }, model, estimateTokens);
    assert.equal(blank.reference.characters, 0);
    assert.ok(!blank.systemPrompt.includes('Original request'));
});

test('side tickets expire, are single-use and cannot survive parent release or pending preparation', async () => {
    const source = { cwd: root, request: async type => type === 'get_state' ? { model: { provider: 'fixture', id: 'fixture', contextWindow: 16000 }, sessionId: 'parent' } : { messages: [] } };
    const service = new PiSideChatService({ store: { resolveProject: value => value }, supervisor: {}, ticketMs: 20, maxConnections: 1 });
    const owner = { readyState: 1 }, secondOwner = { readyState: 1 };
    const prepared = await service.prepare(owner, source, { mode: 'blank' }, () => true);
    assert.equal(service.tickets.size, 1);
    await assert.rejects(service.prepare(secondOwner, source, { mode: 'blank' }, () => true), /并发/);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.throws(() => service.claim(prepared.ticket, {}, () => {}), /失效/);
    await service.prepare(owner, source, { mode: 'blank' }, () => true);
    await service.releaseParent(owner);
    assert.equal(service.tickets.size, 0);
    let release;
    const preparing = service.prepare(owner, { ...source, request: () => new Promise(resolve => { release = resolve; }) }, { mode: 'blank' }, () => true);
    await service.releaseParent(owner);
    release({ model: { provider: 'fixture', id: 'fixture', contextWindow: 16000 }, sessionId: 'parent' });
    await assert.rejects(preparing, /切换/);
    assert.equal(service.tickets.size, 0);
    const fullPreparing = service.prepare(owner, { ...source, captureContext: () => new Promise(resolve => { release = resolve; }) }, { mode: 'context' }, () => true);
    await service.releaseParent(owner);
    release({});
    await assert.rejects(fullPreparing, /切换/);
    assert.equal(service.tickets.size, 0);
    await assert.rejects(service.prepare(owner, source, { mode: 'blank', retainOnSwitch: 'yes' }, () => true), /无效/);
    await assert.rejects(service.prepare(owner, { ...source, noSession: true }, { mode: 'blank', retainOnSwitch: true }, () => true), /临时/);
    const unclaimed = await service.prepare(owner, source, { mode: 'blank', retainOnSwitch: true }, () => true);
    await service.releaseParent(owner);
    assert.throws(() => service.claim(unclaimed.ticket, {}, () => {}), /失效/);
    await service.dispose();
});

test('claimed retained startup survives parent release, still consumes a slot, and explicit source cleanup disposes it', async () => {
    const model = { provider: 'fixture', id: 'fixture', contextWindow: 16000 };
    const source = { cwd: root, sessionId: 'parent', request: async () => ({ model, sessionId: 'parent' }) };
    let readyWorker, disposed = 0, closed = 0;
    const worker = { request: async type => type === 'get_state' ? { model, sessionId: 'side' } : type === 'get_messages' ? { messages: [] } : {},
        subscribe: () => () => {}, dispose: async () => { disposed++; } };
    const service = new PiSideChatService({ store: { resolveProject: value => value }, maxConnections: 1,
        supervisor: { createEphemeralWorker: () => new Promise(resolve => { readyWorker = resolve; }) } });
    const owner = { readyState: 1 };
    const prepared = await service.prepare(owner, source, { mode: 'blank', retainOnSwitch: true }, () => true);
    const events = [];
    const side = service.claim(prepared.ticket, { close: () => { closed++; } }, event => events.push(event));
    await service.releaseParent(owner);
    assert.equal(service.parents.size, 0); assert.equal(closed, 0);
    await assert.rejects(service.prepare({ readyState: 1 }, source, { mode: 'blank' }, () => true), /并发/);
    readyWorker(worker);
    assert.equal((await side.ready).retainOnSwitch, true);
    await service.releaseSource(root, 'parent', 'deleted');
    assert.equal(disposed, 1); assert.equal(closed, 1); assert.equal(service.connections.size, 0);
    assert.ok(events.some(event => event.type === 'gateway_side_parent_ended' && event.reason === 'deleted'));
    await service.dispose();
});

test('real side RPC is tool-free, ephemeral, parallel, auth-protected and isolated from both persistent and temporary parents', { timeout: 120000 }, async t => {
    const requests = [], held = new Map();
    function answer(res, text) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
    }
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        const last = body.messages.filter(message => message.role === 'user').at(-1);
        const text = typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (text.endsWith('HOLD')) { held.set(text, res); return; }
        answer(res, `Reply: ${text}`);
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
    const marker = path.join(root, 'extension-loaded');
    const extensionProvider = { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-key',
        models: [{ id: 'extension-fixture', input: ['text'], reasoning: false, contextWindow: 16000, maxTokens: 1000 }] };
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'sentinel.ts'), `import {writeFileSync} from 'node:fs'; export default function(pi) { writeFileSync(${JSON.stringify(marker)}, 'loaded'); pi.registerCommand('sentinel', {handler: async () => {}}); pi.registerProvider('extension-only', ${JSON.stringify(extensionProvider)}); }`);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'DO_NOT_LOAD_PROJECT_CONTEXT_IN_SIDE');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-key', models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 16000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }));
    const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    const settings = fs.readFileSync(settingsPath);
    const gateway = createPiAgentGateway();
    // Keep the synthetic provider traffic scoped to main/side conversation behavior.
    gateway.titles.saveSettings({ enabled: false });
    const app = express(); app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const wss = gateway.attachWebSocket(server);
    t.after(async () => {
        for (const socket of wss.clients) socket.terminate();
        for (const res of held.values()) res.destroy();
        await gateway.dispose(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const url = `ws://127.0.0.1:${server.address().port}/api/pi/ws`;
    const auth = { token: 'side-test-token' };
    const denied = await connect(url);
    const deniedClosed = once(denied, 'close'); denied.send(JSON.stringify({ type: 'open_side_chat', ticket: 'invalid' }));
    assert.equal((await deniedClosed)[0], 4401);
    const session = await gateway.store.createSession(root, 'Main fixture');
    const main = await connect(url);
    assert.equal((await main.call('open_session', { ...auth, cwd: root, sessionId: session.id })).success, true);
    main.send('null');
    await waitFor(() => main.events.some(event => event.error === 'Invalid gateway command'));
    assert.ok(fs.existsSync(marker)); fs.unlinkSync(marker);
    const source = gateway.supervisor.getActiveWorker(session.path);
    assert.equal((await main.call('prompt', { message: 'MAIN HOLD' })).success, true);
    await waitFor(() => held.has('MAIN HOLD'));
    const before = fs.readFileSync(session.path);
    const prepared = await main.call('prepare_side_chat', { mode: 'context' });
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.equal(prepared.data.reference.systemIncluded, true);
    assert.equal(prepared.data.reference.omittedMessages, 0);
    assert.deepEqual(prepared.data.reference.preview, [], 'full background is not returned to the browser');
    assert.ok(!JSON.stringify(main.events).includes('DO_NOT_LOAD_PROJECT_CONTEXT_IN_SIDE'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'NEW_PROJECT_TEXT_MUST_NOT_LOAD_IN_SIDE');
    const side = await connect(url);
    const opened = await side.call('open_side_chat', { ...auth, ticket: prepared.data.ticket });
    assert.equal(opened.success, true, JSON.stringify(opened));
    assert.equal(opened.data.state.model.id, 'fixture');
    assert.equal(opened.data.state.sessionFile, undefined);
    assert.deepEqual(opened.data.messages, [], 'inherited main messages stay out of the side transcript');
    assert.equal(opened.data.stats.totalMessages, 0);
    assert.equal(opened.data.stats.cost, 0);
    assert.equal(fs.existsSync(marker), false, 'side startup must not load global extensions');
    const sideWorker = [...gateway.supervisor.ephemeralWorkers][0];
    assert.equal(sideWorker.client.noSession, true);
    assert.equal(sideWorker.client.sessionPath, undefined);
    assert.ok(sideWorker.client.child.spawnargs.includes('--no-approve'));
    assert.ok(!sideWorker.client.child.spawnargs.includes('--approve'), 'env approval cannot override the restricted profile');
    assert.ok((await sideWorker.request('get_commands')).commands.every(command => command.sourceInfo?.source === 'inline'), 'only Pi built-in inline commands remain');
    assert.equal((await side.call('prompt', { message: '/llama' })).success, false, 'built-in management commands cannot be dispatched from side chat');
    assert.equal((await side.call('prompt', { message: '/sentinel' })).success, false);
    assert.equal((await main.call('open_side_chat', { ticket: prepared.data.ticket })).success, false);
    const replay = await connect(url);
    assert.equal((await replay.call('open_side_chat', { ...auth, ticket: prepared.data.ticket })).success, false); replay.close();
    for (const type of ['bash', 'set_model', 'follow_up', 'steer', 'open_session', 'prepare_side_chat', 'compact', 'get_entries', 'get_tree']) assert.equal((await side.call(type, { message: 'Never forward', command: 'touch side-file' })).success, false);
    assert.equal((await side.call('prompt', { message: 'Explain side', images: [] })).success, false);
    assert.equal((await side.call('prompt', { message: 'Explain side' })).success, true);
    await waitFor(() => side.events.some(event => event.type === 'agent_settled'));
    const request = requests.find(body => JSON.stringify(body.messages).includes('Explain side'));
    assert.ok(!request.tools?.length, 'side model receives no tools');
    assert.ok(JSON.stringify(request.messages).includes('MAIN HOLD'));
    assert.ok(JSON.stringify(request.messages).includes('DO_NOT_LOAD_PROJECT_CONTEXT_IN_SIDE'), 'inherits existing main system/project instructions');
    assert.ok(!JSON.stringify(request.messages).includes('NEW_PROJECT_TEXT_MUST_NOT_LOAD_IN_SIDE'), 'does not reload project context in the side runtime');
    assert.ok(!(await side.call('get_messages')).data.messages.some(message => userText(message).includes('MAIN HOLD')));
    assert.deepEqual(fs.readFileSync(session.path), before, 'side prompts never enter the main JSONL');
    assert.equal(source.activity.snapshot().busy, true);
    assert.equal((await main.call('prompt', { message: '/btw must-not-leak' })).success, false);
    answer(held.get('MAIN HOLD'), 'Main completed'); held.delete('MAIN HOLD');
    await waitFor(() => !source.activity.snapshot().busy);
    assert.equal((await main.call('prompt', { message: 'MAIN NEW CONTEXT' })).success, true);
    await waitFor(() => !source.activity.snapshot().busy);
    assert.equal((await side.call('prompt', { message: 'Follow up' })).success, true);
    await waitFor(() => requests.some(body => body.messages.some(message => message.role === 'user' && userText(message) === 'Follow up')));
    await waitFor(async () => !(await side.call('get_state')).data.isStreaming);
    const follow = requests.find(body => body.messages.some(message => message.role === 'user' && userText(message) === 'Follow up'));
    assert.ok(follow);
    assert.ok(JSON.stringify(follow.messages).includes('Reply: Explain side'));
    assert.ok(!JSON.stringify(follow.messages).includes('MAIN NEW CONTEXT'), 'reference remains frozen');
    assert.ok(!JSON.stringify((await main.call('get_messages')).data).includes('Explain side'));
    assert.equal((await side.call('prompt', { message: 'SIDE HOLD' })).success, true);
    await waitFor(() => held.has('SIDE HOLD'));
    assert.equal((await side.call('abort')).success, true);
    assert.equal(source.disposed, false);
    assert.equal((await side.call('quit_side_chat')).success, true);
    await waitFor(() => gateway.supervisor.ephemeralWorkers.size === 0);
    assert.deepEqual(fs.readFileSync(settingsPath), settings);
    assert.equal((await gateway.store.listSessions(root)).length, 1, 'no side JSONL or parallel session history');
    const temp = await connect(url);
    assert.equal((await temp.call('open_ephemeral', { ...auth, cwd: root })).success, true);
    const tempPrepared = await temp.call('prepare_side_chat', { mode: 'context' });
    const tempSide = await connect(url);
    const tempOpened = await tempSide.call('open_side_chat', { ...auth, ticket: tempPrepared.data.ticket });
    assert.equal(tempOpened.success, true, JSON.stringify(tempOpened));
    assert.equal(gateway.supervisor.ephemeralWorkers.size, 2);
    temp.close();
    await waitFor(() => gateway.supervisor.ephemeralWorkers.size === 0);
    const early = await main.call('prepare_side_chat', { mode: 'blank' });
    const closing = await connect(url); closing.send(JSON.stringify({ type: 'open_side_chat', ...auth, ticket: early.data.ticket })); closing.close();
    await once(closing, 'close');
    await waitFor(() => gateway.sideChat.connections.size === 0 && gateway.supervisor.ephemeralWorkers.size === 0);
    assert.equal(source.disposed, false);
    await t.test('retained side survives parent switch, finishes in background and is reclaimed by quit or source deletion', async () => {
        const retainedPlan = await main.call('prepare_side_chat', { mode: 'context', retainOnSwitch: true });
        assert.equal(retainedPlan.success, true);
        const kept = await connect(url);
        const result = await kept.call('open_side_chat', { ...auth, ticket: retainedPlan.data.ticket });
        assert.equal(result.success, true); assert.equal(result.data.retainOnSwitch, true);
        assert.equal((await kept.call('prompt', { message: 'KEEP HOLD' })).success, true);
        await waitFor(() => held.has('KEEP HOLD'));
        const sourceBytes = fs.readFileSync(session.path);
        main.close();
        await waitFor(() => !gateway.sideChat.parents.has(main) && source.subscribers.size === 0);
        assert.equal(kept.readyState, WebSocket.OPEN);
        assert.equal((await kept.call('get_state')).data.isStreaming, true);
        answer(held.get('KEEP HOLD'), 'BACKGROUND COMPLETED'); held.delete('KEEP HOLD');
        await waitFor(() => kept.events.some(event => event.type === 'agent_settled'));
        assert.ok(JSON.stringify((await kept.call('get_messages')).data).includes('BACKGROUND COMPLETED'));
        assert.deepEqual(fs.readFileSync(session.path), sourceBytes);
        const returned = await connect(url);
        assert.equal((await returned.call('open_session', { ...auth, cwd: root, sessionId: session.id })).success, true);
        assert.equal(gateway.supervisor.getActiveWorker(session.path), source, 'returning still uses the single managed parent worker');
        assert.equal((await kept.call('prompt', { message: 'CONTINUE RETAINED' })).success, true);
        await waitFor(async () => !(await kept.call('get_state')).data.isStreaming);
        assert.ok(JSON.stringify(requests.at(-1).messages).includes('BACKGROUND COMPLETED'));
        assert.equal((await returned.call('quit_session')).success, true);
        await waitFor(() => kept.readyState === WebSocket.CLOSED && gateway.sideChat.connections.size === 0);
        returned.close();

        const reopened = await connect(url);
        assert.equal((await reopened.call('open_session', { ...auth, cwd: root, sessionId: session.id })).success, true);
        const deletionPlan = await reopened.call('prepare_side_chat', { mode: 'blank', retainOnSwitch: true });
        const deleting = await connect(url);
        assert.equal((await deleting.call('open_side_chat', { ...auth, ticket: deletionPlan.data.ticket })).success, true);
        reopened.close();
        await waitFor(() => deleting.readyState === WebSocket.OPEN && gateway.sideChat.parents.size === 0);
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/${session.id}?cwd=${encodeURIComponent(root)}`, { method: 'DELETE', headers: { Authorization: 'Bearer side-test-token' } });
        assert.equal(response.status, 200);
        await waitFor(() => deleting.readyState === WebSocket.CLOSED && gateway.supervisor.ephemeralWorkers.size === 0);
        assert.ok(deleting.events.some(event => event.type === 'gateway_side_parent_ended' && event.reason === 'deleted'));
        assert.equal((await gateway.store.listSessions(root)).length, 0);
    });
    main.close();
    await t.test('extension-only providers fail closed and standard registration restores side chat without loading extensions', async () => {
        const { PiSettingsService } = require('../server/pi-settings-service');
        const settingsService = new PiSettingsService({ cwd: root });
        const parent = await gateway.supervisor.createEphemeralWorker(root, { extraArgs: ['--provider', 'extension-only', '--model', 'extension-fixture'] });
        const owner = { readyState: 1 }, socket = { close() {} };
        fs.unlinkSync(marker);
        try {
            const missing = await gateway.sideChat.prepare(owner, parent, { mode: 'blank' }, () => true);
            const failed = gateway.sideChat.claim(missing.ticket, socket, () => {});
            await assert.rejects(failed.ready, /Unknown provider "extension-only"/);
            await gateway.sideChat.releaseParent(owner);
            assert.equal(fs.existsSync(marker), false);
            assert.equal(parent.disposed, false);
            assert.equal(gateway.supervisor.ephemeralWorkers.size, 1, 'failed side leaves no orphan worker');
            const { modelsPath } = await settingsService.paths();
            const config = settingsService.readModelsFile(modelsPath);
            const { apiKey, ...definition } = extensionProvider;
            config.providers['extension-only'] = definition;
            await settingsService.writeModelsFile(config);
            await settingsService.saveApiKey('extension-only', apiKey);
            const ready = await gateway.sideChat.prepare(owner, parent, { mode: 'blank' }, () => true);
            const events = [];
            const restored = gateway.sideChat.claim(ready.ticket, socket, event => events.push(event));
            const opened = await restored.ready;
            assert.equal(opened.state.model.provider, 'extension-only');
            assert.equal(opened.state.model.id, 'extension-fixture');
            assert.ok(!JSON.stringify(opened).includes(apiKey));
            assert.equal(fs.existsSync(marker), false, 'standard provider needs no extension factory');
            await restored.handle({ type: 'prompt', message: 'STANDARD PROVIDER REGISTRATION' });
            await waitFor(() => events.some(event => event.type === 'agent_settled'));
            const payload = requests.find(body => JSON.stringify(body.messages).includes('STANDARD PROVIDER REGISTRATION'));
            assert.ok(payload && !payload.tools?.length);
            assert.ok(events.some(event => event.type === 'message_end' && userText(event.message).includes('Reply: STANDARD PROVIDER REGISTRATION')));
            assert.deepEqual(fs.readFileSync(settingsPath), settings);
            assert.equal((await gateway.store.listSessions(root)).length, 0);
        } finally {
            await gateway.sideChat.releaseParent(owner);
            await parent.dispose();
        }
    });
});
