const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-connection-rpc-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_OFFLINE = '1';
const { MediaAgentService } = require('../server/media-agent-service');
const { connectionSchema, connectionTemplates, validateConnectionDraft, createConnectionDraft } = require('../server/media-connection-planner');

test('real connection planner RPC reads only the protocol schema, redacts keys and returns an unsaved model draft', { timeout: 45000 }, async t => {
    const requests = [], tools = [], apiKey = 'media-fixture-private-token';
    const internalToken = 'connection-fixture-internal-token';
    const model = { ...connectionTemplates()[0].model, remoteModel: 'fixture-image-model' };
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url.startsWith('/api/media-agent/')) assert.equal(req.headers.authorization, `Bearer ${internalToken}`);
            if (req.url === '/api/media-agent/connection-schema') { tools.push('schema'); res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(connectionSchema())); }
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw);
            if (req.url === '/api/media-agent/connection/validate') {
                tools.push('draft'); res.setHeader('Content-Type','application/json');
                return res.end(JSON.stringify({ ok: true, draft: validateConnectionDraft(body.draft, body.current) }));
            }
            assert.equal(req.url, '/v1/chat/completions'); requests.push(body);
            assert.deepEqual(body.tools.map(item => item.function.name).sort(), ['media_get_connection_schema','media_plan_connection']);
            assert.equal(JSON.stringify(body.messages).includes(apiKey), false);
            assert.equal(JSON.stringify(body.messages).includes(internalToken), false);
            assert.ok(JSON.stringify(body.messages).includes('[REDACTED]'));
            const first = requests.length === 1;
            assert.ok(requests.length <= 2);
            const name = first ? 'media_get_connection_schema' : 'media_plan_connection';
            const args = first ? {} : { summary: 'Connection fixture draft', model, warnings: ['Confirm the service model requirements before saving.'] };
            res.writeHead(200, { 'Content-Type':'text/event-stream' });
            for (const chunk of [
                { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
            ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
            res.end('data: [DONE]\n\n');
        } catch (error) { res.writeHead(400, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    process.env.PI_WORKSPACE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    // Managed processes inherit an owning workspace identity. Bind this fixture
    // explicitly so running tests inside an Agent cannot call its real workspace.
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = process.env.PI_WORKSPACE_BASE_URL;
    process.env.PI_WORKSPACE_INTERNAL_TOKEN = internalToken;
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'llm-fixture-key', baseUrl: process.env.PI_WORKSPACE_BASE_URL + '/v1', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false } }));
    const provider = { id: 'media-fixture', baseUrl: 'https://media.example.invalid/v1', credentialOrigin: 'https://media.example.invalid', auth: { mode: 'bearer' } };
    const providers = { read: () => ({ document: { providers: [provider] } }), find: () => provider, credentials: { get: async () => apiKey } };
    const agent = new MediaAgentService({ rootDir: path.join(__dirname, '..') });
    const result = await createConnectionDraft(agent, providers, { providerId: provider.id, kind: 'image', remoteModel: model.remoteModel,
        documentation: `POST /images/generations, Authorization: Bearer ${apiKey}\nJSON response data[0].b64_json.`, cwd: root });
    assert.equal(result.draft.model.remoteModel, model.remoteModel); assert.equal(result.draft.model.http.path, '/images/generations');
    assert.equal(result.draft.execution.count, 0); assert.equal(result.fallbackUsed, false);
    assert.deepEqual(tools, ['schema','draft']); assert.equal(requests.length, 2);
    const files = fs.readdirSync(root, { recursive: true });
    assert.equal(files.some(file => file.endsWith('.jsonl') || file.endsWith('connections.json')), false);
});
