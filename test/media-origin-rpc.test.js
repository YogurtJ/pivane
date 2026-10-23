const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { MediaLabService } = require('../server/media-lab-service');
const { MediaChatRequests } = require('../server/media-chat-requests');
const { MEDIA_PLAN_ENTRY } = require('../server/pi-media-plan-format');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-origin-rpc-')));
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
fs.mkdirSync(path.join(root, 'agent/extensions'), { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('managed RPC persists provenance before execution, keeps a cancelled card through reopen/compaction, and scopes native navigation', { timeout: 60000 }, async () => {
    const { PiSessionStore } = require('../server/pi-session-store');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const { getSdk } = require('../server/pi-session-store');
    const { SessionManager } = await getSdk();
    let source, worker, nextTool = 'media_generate', posts = 0, reads = 0, executionRequests = 0;
    const accepted = Promise.withResolvers(), release = Promise.withResolvers();
    const lab = new MediaLabService({ profile: { models: [{ id: 'fixture-image', name: 'Fixture', kind: 'image', adapter: 'http-json',
        parameters: { prompt: { type: 'text', required: true } }, connection: { url: 'http://fixture.invalid/generate', outputPath: ['image'], mimeType: 'image/png' } }] },
        ttsService: { getPublicConfig: () => ({ providers: [] }) }, videoService: { getConfig: async () => ({ models: [] }) },
        fetch: async () => { posts++; await release.promise; return { ok: true, json: async () => ({ image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' }) }; },
        saveExternal: async () => ({ url: '/images/synthetic.png' }) });
    lab.chatRequests = new MediaChatRequests({ lab, file: path.join(root, 'requests.json') });
    const server = http.createServer(async (req, res) => {
        try {
            res.setHeader('Content-Type', 'application/json');
            if (req.url.startsWith('/api/media-agent/capabilities/')) return res.end(JSON.stringify({ lab: await lab.catalog('image') }));
            let raw = ''; for await (const chunk of req) raw += chunk;
            const input = JSON.parse(raw);
            if (req.url === '/api/media-agent/validate') {
                if (input.stage === 'prepare') return res.end(JSON.stringify(await lab.prepareChatPlan(input)));
                executionRequests++;
                const saved = SessionManager.open(source.path).getBranch().find(entry => entry.customType === MEDIA_PLAN_ENTRY);
                assert.equal(saved.data.toolCallId, 'stable-media-call');
                assert.equal(saved.data.plan.id, input.planId);
                assert.doesNotMatch(fs.readFileSync(source.path, 'utf8'), /executionToken/);
                await lab.executeChatPlan(input, { image: true });
                accepted.resolve(saved);
                await release.promise; // Cancellation must still stop this HTTP wait.
                await lab.chatRequests.execution;
                return res.end(JSON.stringify({ plan: saved.data.plan }));
            }
            if (req.url === '/api/media-agent/chat-results') { reads++; return res.end(JSON.stringify(lab.chatRequests.results(input.keys))); }
            assert.equal(req.url, '/v1/chat/completions');
            res.setHeader('Content-Type', 'text/event-stream');
            const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
            const tool = nextTool; nextTool = null;
            if (tool) {
                send({ role: 'assistant', tool_calls: [{ index: 0, id: tool === 'media_generate' ? 'stable-media-call' : 'results-call', type: 'function', function: { name: tool,
                    arguments: JSON.stringify(tool === 'media_generate' ? { modelId: 'fixture-image', summary: 'Cancelled wait', parameters: { prompt: 'Synthetic' } } : {}) } }] }, null);
                send({}, 'tool_calls');
            } else { send({ role: 'assistant', content: 'Synthetic reply' }, null); send({}, 'stop'); }
            res.end('data: [DONE]\n\n');
        } catch (error) { accepted.reject(error); res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin; process.env.PI_WORKSPACE_INTERNAL_TOKEN = 'synthetic';
    fs.writeFileSync(path.join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', compaction: { keepRecentTokens: 50, reserveTokens: 1000 }, enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic', baseUrl: origin + '/v1', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(root, 'agent/extensions/compact.ts'), `export default function(pi) { pi.on('session_before_compact', e => ({ compaction: { summary: 'Synthetic summary', firstKeptEntryId: e.branchEntries.findLast(e => e.type === 'message').id, tokensBefore: 20000 } })); }`);
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    const events = [];
    const open = async () => { worker = await supervisor.getWorker({ cwd, sessionId: source.id, sessionPath: source.path }); worker.subscribe(event => events.push(event)); };
    const prompt = async message => {
        const settled = Promise.withResolvers();
        const unsubscribe = worker.subscribe(event => { if (event.type === 'agent_settled') settled.resolve(); });
        try { await worker.request('prompt', { message }); await settled.promise; } finally { unsubscribe(); }
    };
    const cards = async () => (await worker.request('get_messages')).messages.filter(message => message.customType === MEDIA_PLAN_ENTRY);
    try {
        source = await store.createSession(cwd, 'Media origin'); await open();
        const running = prompt('Generate a fixture image');
        const saved = await accepted.promise;
        await worker.request('abort'); await running;
        assert.equal(posts, 1); assert.equal(executionRequests, 1);
        assert.ok(events.some(event => event.type === 'entry_appended' && event.entry.id === saved.id), 'live native append is broadcast with existing runtime/sequence');
        assert.equal((await cards())[0].details.plan.id, saved.data.plan.id);
        release.resolve(); await lab.chatRequests.execution;
        assert.equal(lab.chatRequests.publicState(saved.data.plan.id).attempts[0].status, 'done');
        await supervisor.stopSession(source.path); await open();
        assert.equal((await cards()).length, 1, 'reopen recovers source after the error tool result');
        nextTool = 'media_results'; await prompt('Read existing results');
        assert.equal(reads, 1); assert.equal(posts, 1); assert.equal(executionRequests, 1);
        const results = (await worker.request('get_messages')).messages.find(message => message.toolName === 'media_results');
        assert.equal(JSON.parse(results.content[0].text).cards[0].key, saved.data.plan.id);
        await worker.request('compact');
        assert.equal((await cards()).length, 1, 'source survives outside compacted provider context');
        const snapshot = await worker.request('get_entries');
        const user = snapshot.entries.find(entry => entry.type === 'message' && entry.message.role === 'user');
        const preview = await worker.historyRequest('preview', { entryId: user.id });
        await worker.exclusive(rpc => worker.navigate(rpc, { mode: 'tree', input: {
            entryId: user.id, expectedLeafId: preview.leafId, revision: preview.revision, summarize: false } }));
        assert.equal((await cards()).length, 0, 'navigation before provenance removes the card from the current branch');
        assert.equal(posts, 1); assert.equal(executionRequests, 1);
    } finally {
        release.resolve(); await lab.chatRequests.execution; await supervisor.dispose();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
});
