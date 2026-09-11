const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { buildContextSeed } = require('../server/pi-side-context');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { PiSideChatService } = require('../server/pi-side-chat');
const { PiSessionStore } = require('../server/pi-session-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-side-context-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 } };
const assistant = (text, extra = {}) => ({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture',
    content: [{ type: 'text', text }], usage, stopReason: 'stop', timestamp: 1, ...extra });
function snapshot(api = 'openai-completions') {
    return { model: { provider: 'fixture', id: 'fixture', api, contextWindow: 262144, maxTokens: 1000, input: ['text'] }, thinkingLevel: 'off',
        source: { cwd: root, sessionId: 'parent', name: 'Parent' }, systemPrompt: 'INHERITED_PROJECT_POLICY: main work remains in the parent.',
        messages: [
            { role: 'compactionSummary', summary: 'OLD_COMPACTION_DECISION', tokensBefore: 200000, timestamp: 0 },
            ...Array.from({ length: 18 }, (_, i) => ({ role: 'user', content: `EARLY_CONSTRAINT_${i}`, timestamp: 1 })),
            assistant('PROSE_NEXT_TO_TOOL', { stopReason: 'toolUse', content: [{ type: 'text', text: 'PROSE_NEXT_TO_TOOL' },
                { type: 'thinking', thinking: 'PRIVATE_REASONING_SIGNATURE' },
                { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/provider.ts' } },
                { type: 'toolCall', id: 'pending-2', name: 'bash', arguments: { command: `touch ${root}/must-not-execute` } }] }),
            { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: 'FULL_SOURCE_EVIDENCE\n' + 'code line\n'.repeat(16000) }], isError: false, timestamp: 2 },
            { role: 'toolResult', toolCallId: 'orphan', toolName: 'bash', content: [{ type: 'text', text: 'FAILED_TEST_EVIDENCE' }], isError: true, timestamp: 3 },
            { role: 'bashExecution', command: 'pwd', output: 'BASH_EVIDENCE', exitCode: 0, timestamp: 4 },
            { role: 'bashExecution', command: 'private', output: 'EXCLUDED_SHELL', excludeFromContext: true, timestamp: 4 },
            { role: 'branchSummary', summary: 'BRANCH_DECISION', fromId: 'branch-id', timestamp: 5 },
            assistant('PARTIAL_BEFORE_FAILURE', { stopReason: 'error', errorMessage: 'SOURCE_ERROR_DETAIL' }),
        ] };
}

test('full context preserves old constraints, summaries, mixed prose and complete tool evidence without fixed tail clipping', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const source = snapshot(), before = JSON.stringify(source);
    const result = buildContextSeed(source, sdk, root);
    assert.equal(JSON.stringify(source), before);
    const input = JSON.stringify(sdk.SessionManager.inMemory(root, {}, result.seed.entries).buildSessionContext().messages);
    for (const text of ['EARLY_CONSTRAINT_0', 'EARLY_CONSTRAINT_17', 'PROSE_NEXT_TO_TOOL', 'OLD_COMPACTION_DECISION', 'BRANCH_DECISION', 'FULL_SOURCE_EVIDENCE', 'FAILED_TEST_EVIDENCE', 'BASH_EVIDENCE', 'SOURCE_ERROR_DETAIL', 'pending-2']) assert.ok(input.includes(text), text);
    assert.ok(!input.includes('PRIVATE_REASONING_SIGNATURE'));
    assert.ok(!input.includes('EXCLUDED_SHELL'));
    assert.ok(!input.includes('"type":"toolCall"'));
    assert.ok(!input.includes('"role":"toolResult"'));
    assert.ok(result.bytes > 128 * 1024, 'must not use an argv-sized bootstrap');
    assert.ok(result.reference.estimatedTokens > 8192);
    assert.equal(result.reference.summaryCount, 2);
    assert.equal(result.reference.toolCalls, 2);
    assert.equal(result.reference.toolResults, 2);
    assert.equal(result.reference.omittedMessages, 0);
    assert.deepEqual(result.reference.preview, []);
    const small = { ...source, model: { ...source.model, contextWindow: 4096 } };
    assert.throws(() => buildContextSeed(small, sdk, root), /未截断背景/);
    const images = snapshot(); images.messages = [{ role: 'user', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], timestamp: 1 }];
    assert.equal(buildContextSeed(images, sdk, root).reference.omittedImages, 1);
    images.model.input.push('image');
    assert.equal(buildContextSeed(images, sdk, root).reference.images, 1);
});

test('official memory RPC accepts large context with no tool protocol, hides inherited history and keeps billing separate', { timeout: 120000 }, async t => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    const requests = [];
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        assert.ok(!body.tools?.length);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
        if (new URL(req.url, 'http://fixture').pathname.endsWith('/messages')) {
            send({ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } }, 'message_start');
            send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
            send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SIDE_ONLY_ANSWER' } }, 'content_block_delta');
            send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
            send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }, 'message_delta');
            send({ type: 'message_stop' }, 'message_stop'); res.end();
        } else if (new URL(req.url, 'http://fixture').pathname.endsWith('/responses')) {
            const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SIDE_ONLY_ANSWER', annotations: [] }] };
            send({ type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress', output: [] } });
            send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
            send({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
            send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'SIDE_ONLY_ANSWER' });
            send({ type: 'response.output_item.done', output_index: 0, item });
            send({ type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
            res.end();
        } else {
            send({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'SIDE_ONLY_ANSWER' }, finish_reason: null }] });
            send({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
            res.end('data: [DONE]\n\n');
        }
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses']) {
        await t.test(api, async () => {
            const source = snapshot(api);
            fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
                baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api, apiKey: 'fixture-key', models: [{ ...source.model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
            } } }));
            fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }));
            const supervisor = new PiAgentSupervisor(), service = new PiSideChatService({ store: new PiSessionStore(), supervisor });
            const owner = { readyState: 1 }, events = [];
            try {
                const prepared = await service.prepare(owner, { cwd: root, captureContext: async () => structuredClone(source) }, { mode: 'context' }, () => true);
                const side = service.claim(prepared.ticket, { close() {} }, event => events.push(event));
                const opened = await side.ready;
                assert.deepEqual(opened.messages, []);
                assert.equal(opened.stats.cost, 0);
                assert.equal(opened.stats.tokens.total, 0);
                assert.equal(opened.stats.contextUsage.tokens, null);
                assert.ok(!side.worker.client.child.spawnargs.some(arg => arg.includes('INHERITED_PROJECT_POLICY') || arg.includes('FULL_SOURCE_EVIDENCE')));
                await side.handle({ type: 'prompt', message: 'SIDE_ONLY_QUESTION' });
                const deadline = Date.now() + 15000;
                while (!events.some(event => event.type === 'agent_settled')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
                const output = await side.handle({ type: 'get_messages' });
                assert.equal(output.messages.length, 2);
                assert.ok(JSON.stringify(output).includes('SIDE_ONLY_ANSWER'));
                assert.ok(!JSON.stringify(output).includes('EARLY_CONSTRAINT'));
                const stats = await side.handle({ type: 'get_session_stats' });
                assert.equal(stats.cost, 0);
                assert.equal(stats.userMessages, 1); assert.equal(stats.assistantMessages, 1);
                assert.ok(!fs.existsSync(path.join(root, 'must-not-execute')));
                const body = JSON.stringify(requests.at(-1));
                assert.ok(body.includes('INHERITED_PROJECT_POLICY'));
                assert.ok(body.includes('OLD_COMPACTION_DECISION'));
                assert.ok(body.includes('EARLY_CONSTRAINT_0'));
                assert.ok(body.includes('SOURCE_ERROR_DETAIL'));
                assert.ok(body.includes('FULL_SOURCE_EVIDENCE'));
                assert.ok(!body.includes('"type":"tool_use"') && !body.includes('"type":"tool_result"'));
                assert.equal((await new PiSessionStore().listSessions(root)).length, 0);
                await side.worker.request('compact', { customInstructions: 'Preserve the side discussion.' }, 30000);
                const compacted = await side.handle({ type: 'get_messages' });
                assert.equal(compacted.messages.length, 2, 'UI history is still selected by the durable in-memory boundary after compaction');
                assert.ok(!JSON.stringify(compacted).includes('FULL_SOURCE_EVIDENCE'));
                assert.equal((await side.handle({ type: 'get_session_stats' })).contextUsage.tokens, null);
                assert.ok(!JSON.stringify(events).includes('EARLY_CONSTRAINT_0'), 'native events must not replay private inherited context to the side browser');
            } finally { await service.dispose(); await supervisor.dispose(); }
        });
    }
});
