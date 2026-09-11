const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { MediaAgentService } = require('../server/media-agent-service');
const { MediaLabService } = require('../server/media-lab-service');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lab-rpc-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';

test('native restricted Pi RPC reads live requirements and returns a structured lab plan without execution or session files', { timeout: 45000 }, async t => {
    const model = { id: 'rpc-image', name: 'RPC model fixture', kind: 'image', adapter: 'manual', instructions: 'A fixture-specific palette object is required.', parameters: {
        prompt: { type: 'textarea', required: true }, palette: { type: 'json', required: true }, quality: { type: 'select', choices: ['draft', 'final'], default: 'draft' }
    } };
    const lab = new MediaLabService({ profile: { directory: root, models: [model], image: {} },
        videoService: { getConfig: async () => ({ models: [] }) }, ttsService: { getPublicConfig: () => ({ providers: [] }) },
        generateImage: () => { throw new Error('Generation must not be called'); } });
    const workspaceToken = 'fixture-internal-access-token';
    const requests = [], toolReads = [];
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url.startsWith('/api/media-agent/') && req.headers.authorization !== `Bearer ${workspaceToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'planning fixture requires authentication' }));
            }
            if (req.url === '/api/media-agent/capabilities/image') {
                toolReads.push('capabilities'); res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ lab: await lab.catalog('image') }));
            }
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw);
            if (req.url === '/api/media-agent/validate') {
                toolReads.push('validate'); res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ ok: true, plan: await lab.plan(body.plan) }));
            }
            assert.equal(req.url, '/v1/chat/completions');
            requests.push(body);
            assert.ok(!JSON.stringify(body).includes(workspaceToken), 'internal access credential never enters model payload');
            assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['media_get_capabilities', 'media_plan_request']);
            const first = requests.length === 1;
            assert.ok(requests.length <= 2, 'terminating plan tool must end the RPC turn');
            const name = first ? 'media_get_capabilities' : 'media_plan_request';
            const args = first ? { kind: 'image' } : { modelId: model.id, summary: 'Fixture plan', parameters: { prompt: 'An abstract poster', palette: { colors: ['navy','mint'] }, quality: 'final' } };
            if (!first) assert.ok(JSON.stringify(body.messages).includes('fixture-specific palette'));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const chunks = [
                { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
            ];
            for (const chunk of chunks) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`);
            res.end('data: [DONE]\n\n');
        } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    process.env.PI_WORKSPACE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = process.env.PI_WORKSPACE_BASE_URL;
    process.env.PI_WORKSPACE_INTERNAL_TOKEN = workspaceToken;
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: {
        fixture: { api: 'openai-completions', apiKey: 'fixture-not-a-secret', baseUrl: `${process.env.PI_WORKSPACE_BASE_URL}/v1`, models: [
            { id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
        ] }
    } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false } }));
    // A shell may inherit another workspace URL. Managed planning must still use its owning instance.
    process.env.PI_WORKSPACE_BASE_URL = 'http://127.0.0.1:1';
    const planner = new MediaAgentService({ rootDir: path.join(__dirname, '..') });
    planner.mediaLabService = lab;
    const result = await planner.createLabPlan({ kind: 'image', selectedModelId: model.id, instruction: 'Plan a fixture poster', cwd: root });
    assert.equal(result.plan.modelId, model.id);
    assert.deepEqual(result.plan.parameters.palette, { colors: ['navy','mint'] });
    assert.equal(result.plan.parameters.quality, 'final');
    assert.equal(result.plannerModel.provider, 'fixture');
    assert.equal(result.fallbackUsed, false);
    assert.deepEqual(toolReads, ['capabilities', 'validate']);
    assert.equal(lab.tickets.size, 0, 'planner must not mint confirmation tickets');
    assert.equal(requests.length, 2);
    const files = fs.readdirSync(root, { recursive: true });
    assert.equal(files.some(file => file.endsWith('.jsonl')), false, 'planner must not persist a parallel session');
});
