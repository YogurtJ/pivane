const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-deliver-runtime-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('managed deliver_files persists one native reference and browser reads the original snapshot after worker restart', { timeout: 120000 }, async () => {
    let pending = true, calls = 0;
    const provider = http.createServer(async (req, res) => {
        for await (const _chunk of req) {} calls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (pending) {
            pending = false;
            send({ role: 'assistant', tool_calls: [{ index: 0, id: `delivery-${calls}`, type: 'function', function: { name: 'deliver_files', arguments: JSON.stringify({ requestId: 'fixture', title: 'Report', files: ['report.md'] }) } }] });
            send({}, 'tool_calls');
        } else { send({ role: 'assistant', content: 'Fixture complete' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(cwd, 'report.md'), '# Original report');
    const { PiSessionStore } = require('../server/pi-session-store'), { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const { DeliverableService, ENTRY } = require('../server/pi-deliverables');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor(), service = new DeliverableService({ store, supervisor });
    const session = await store.createSession(cwd, 'Delivery runtime');
    try {
        let worker = await supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        assert.ok((await worker.getNativeResources()).tools.some(t => t.name === 'deliver_files'));
        const run = async () => {
            let off; const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
            try { await worker.request('prompt', { message: 'Deliver the report' }); await settled; } finally { off(); }
        };
        await run();
        const entries = await worker.request('get_entries');
        const ref = entries.entries.find(e => e.customType === ENTRY).data;
        const request = { cwd, sessionId: session.id, id: ref.id, index: '0' };
        assert.equal((await service.request(request)).content, '# Original report');
        fs.writeFileSync(path.join(cwd, 'report.md'), '# New disk version');
        pending = true; await run();
        assert.equal((await worker.request('get_entries')).entries.filter(e => e.customType === ENTRY).length, 1);
        await supervisor.stopSession(session.path);
        assert.equal((await service.request(request)).content, '# Original report');
        assert.equal(supervisor.workers.size, 0, 'browsing a closed session does not launch a worker');
        worker = await supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        assert.equal((await service.request(request)).content, '# Original report');
    } finally { await supervisor.dispose(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
});
