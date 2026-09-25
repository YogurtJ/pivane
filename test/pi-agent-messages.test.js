const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-messages-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { MESSAGE_IN, MESSAGE_OUT, MESSAGE_WAKE } = require('../server/pi-agent-message-format');
const deadline = async (fn, ms = 30000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error('Timed out waiting for fixture');
};
const lastText = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

test('Unrelated threads message each other, wake a closed recipient, reply, and never duplicate or loop', { timeout: 180000 }, async () => {
    const calls = []; let callId = 0;
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part;
        const input = JSON.parse(body); calls.push(input);
        const messages = input.messages, last = messages.at(-1);
        const all = messages.map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content : []).map(b => b.text || '').join('')).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        const tool = args => { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${++callId}`, type: 'function', function: { name: 'agent_message', arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls'); };
        const say = text => { chunk({ role: 'assistant', content: text }); chunk({}, 'stop'); };
        const lastContent = last.role === 'tool' ? String(last.content) : lastText(last);
        if (last.role === 'tool' && lastContent.includes('"threads"')) {
            const threads = JSON.parse(lastContent).threads;
            tool({ action: 'send', to: threads.find(row => row.name === 'Thread B').id, message: 'QUESTION_FIXTURE: which port?', query: '', messageId: '' });
        } else if (last.role === 'tool') say(`TOOL_DONE ${lastContent.includes('"delivered"') || lastContent.includes('"queued"') ? 'ok' : 'bad'}`);
        else if (lastContent.includes('SEND_FIXTURE')) tool({ action: 'threads' });
        else if (all.includes('QUESTION_FIXTURE') && !all.includes('ANSWER_FIXTURE') && lastContent.includes('New Agent message')) {
            const match = all.match(/Agent message from thread "Thread A" \(session ([^)]+)\); messageId ([a-f0-9]{64})/);
            tool({ action: 'send', to: match[1], message: 'ANSWER_FIXTURE: 8080', replyTo: match[2] });
        } else if (lastContent.includes('New Agent message')) say('A_GOT_ANSWER');
        else say('PLAIN_OK');
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'model', defaultThinkingLevel: 'off', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'model', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const access = new WorkspaceAccessService({ envToken: () => 'fixture-web-token' });
    const gateway = createPiAgentGateway({ accessService: access });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = base;
    const api = async (route, body, token) => {
        const response = await fetch(base + '/api/pi' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    try {
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        const entries = file => SessionManager.open(file).getEntries();
        const a = await gateway.store.createSession(cwd, 'Thread A');
        const b = await gateway.store.createSession(cwd, 'Thread B');
        const c = await gateway.store.createSession(cwd, 'Thread C');
        const aWorker = await gateway.supervisor.getWorker({ cwd, sessionPath: a.path, sessionId: a.id });
        const token = aWorker.navigationToken;
        assert.ok((await aWorker.getNativeResources()).tools.some(tool => tool.name === 'agent_message'));
        assert.equal((await api('/agent-messages/threads', {}, 'fixture-web-token')).status, 403, 'web identity is not a source thread');
        const listed = await deadline(async () => { const r = await api('/agent-messages/threads', {}, token); return r.status === 200 && r; });
        assert.deepEqual(listed.data.threads.map(row => row.name).sort(), ['Thread A', 'Thread B', 'Thread C']);
        assert.equal(listed.data.threads.find(row => row.id === a.id).relation, 'self');
        assert.equal(listed.data.threads.find(row => row.id === b.id).status, 'closed');
        assert.equal((await api('/agent-messages/send', { requestId: 'self', to: a.id, message: 'x', hop: 0 }, token)).status, 400);
        assert.equal((await api('/agent-messages/send', { requestId: 'none', to: 'missing', message: 'x', hop: 0 }, token)).status, 400);
        assert.equal((await api('/agent-messages/send', { requestId: 'long', to: b.id, message: 'x'.repeat(16001), hop: 0 }, token)).status, 400);
        assert.equal(gateway.supervisor.getActiveWorker(b.path), undefined);

        // A user turn in A: list threads, message closed B. B wakes, answers with replyTo, A wakes on the answer.
        await aWorker.request('prompt', { message: 'SEND_FIXTURE' });
        await deadline(() => entries(a.path).some(entry => entry.type === 'custom_message' && entry.customType === MESSAGE_IN));
        await deadline(() => entries(a.path).some(entry => entry.type === 'message' && entry.message.role === 'assistant' && lastText(entry.message).includes('A_GOT_ANSWER')));
        await deadline(() => !aWorker.activity.snapshot().busy);
        const bEntries = entries(b.path);
        const question = bEntries.find(entry => entry.type === 'custom_message' && entry.customType === MESSAGE_IN);
        assert.ok(question.content.startsWith('[Agent message from thread "Thread A"'));
        assert.equal(question.content.slice(question.details.bodyOffset), 'QUESTION_FIXTURE: which port?');
        assert.deepEqual([question.details.from.sessionId, question.details.hop, question.details.wake], [a.id, 0, true]);
        assert.equal(bEntries.filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 0, 'Agent messages never impersonate the user');
        assert.ok(bEntries.some(entry => entry.type === 'custom_message' && entry.customType === MESSAGE_WAKE && entry.display === false));
        const answer = entries(a.path).find(entry => entry.type === 'custom_message' && entry.customType === MESSAGE_IN);
        assert.equal(answer.details.replyTo, question.details.messageId);
        assert.equal(answer.details.conversationId, question.details.conversationId);
        assert.equal(answer.details.hop, 1, 'the woken turn continues the automatic chain');
        const outA = entries(a.path).filter(entry => entry.type === 'custom' && entry.customType === MESSAGE_OUT);
        const outB = bEntries.filter(entry => entry.type === 'custom' && entry.customType === MESSAGE_OUT);
        assert.equal(outA.length, 1); assert.equal(outB.length, 1);
        assert.equal(outA[0].data.messageId, question.details.messageId);
        assert.doesNotMatch(JSON.stringify(calls), new RegExp(token), 'worker credential never reaches the model');
        const status = await api('/agent-messages/status', { messageId: question.details.messageId }, token);
        assert.equal(status.data.status, 'delivered');
        const bWorker = gateway.supervisor.getActiveWorker(b.path);
        assert.ok(bWorker, 'the sleeping recipient was started');
        assert.equal((await api('/agent-messages/status', { messageId: question.details.messageId }, bWorker.navigationToken)).status, 400, 'status is scoped to the sender');

        // Replaying the same recovery record neither duplicates nor wakes again.
        const before = calls.length, service = gateway.agentThreads.messages;
        service.queue.clear();
        await service.recover(); service.recoveredAt.clear();
        await service.recover(); await service.pump();
        await deadline(() => bWorker.isIdle());
        assert.equal(entries(b.path).filter(entry => entry.customType === MESSAGE_IN).length, 1);
        await bWorker.agentMessages({ messages: [{ ...outA[0].data }] });
        assert.equal(entries(b.path).filter(entry => entry.customType === MESSAGE_IN).length, 1, 'recipient deduplicates by messageId');
        assert.equal(calls.length, before, 'no replayed model turn');

        // A deep automatic chain is delivered without waking the recipient.
        const deep = await api('/agent-messages/send', { requestId: 'deep', to: b.id, message: 'DEEP_FIXTURE', hop: 6 }, token);
        assert.equal(deep.status, 200, JSON.stringify(deep));
        assert.equal(deep.data.wake, false); assert.equal(deep.data.wakeSuppressed, 'hop-limit');
        await deadline(() => entries(b.path).some(entry => entry.customType === MESSAGE_IN && entry.content.includes('DEEP_FIXTURE')));
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(calls.length, before, 'hop-limited message does not start a turn');
        const same = await api('/agent-messages/send', { requestId: 'deep', to: b.id, message: 'DEEP_FIXTURE', hop: 6 }, token);
        assert.equal(same.data.reused, true);
        assert.equal((await api('/agent-messages/send', { requestId: 'deep', to: b.id, message: 'changed', hop: 6 }, token)).status, 400);

        // A note (wake=false) to a closed thread waits for it to open and does not start it.
        const note = await api('/agent-messages/send', { requestId: 'note', to: c.id, message: 'NOTE_FIXTURE', hop: 0, wake: false }, token);
        assert.equal(note.data.status, 'waiting-for-recipient');
        await new Promise(resolve => setTimeout(resolve, 2000));
        assert.equal(gateway.supervisor.getActiveWorker(c.path), undefined, 'a note does not start the recipient');
        await gateway.supervisor.getWorker({ cwd, sessionPath: c.path, sessionId: c.id });
        await deadline(() => entries(c.path).some(entry => entry.customType === MESSAGE_IN && entry.content.includes('NOTE_FIXTURE')));
        assert.equal(calls.length, before, 'a delivered note does not start a turn');
        await deadline(async () => (await api('/agent-messages/status', { messageId: note.data.messageId }, token)).data.status === 'delivered');
    } finally {
        await gateway.dispose(); access.dispose(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
