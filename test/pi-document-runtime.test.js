const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-runtime-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('raw upload to managed read_document uses current native branch and survives worker restart without copying contents into prompt', { timeout: 120000 }, async () => {
    let reference, stage = 0; const requests = [];
    const provider = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (stage < 2) {
            const action = stage++ === 0 ? 'inspect' : 'read';
            send({ role: 'assistant', tool_calls: [{ index: 0, id: `document-${stage}`, type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ id: reference.id, action, start: 1, count: 2 }) } }] }); send({}, 'tool_calls');
        } else { send({ role: 'assistant', content: 'Fixture document read complete' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-office-token' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    try {
        const { zip, docxFiles } = require('./document-fixtures.cjs'), session = await gateway.store.createSession(cwd, 'Documents');
        const query = new URLSearchParams({ cwd, sessionId: session.id, requestId: 'runtime', name: '合同.docx' });
        const uploaded = await fetch(`${origin}/api/pi/uploads?${query}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-office-token', 'Content-Type': 'application/octet-stream' }, body: zip(docxFiles()) });
        assert.equal(uploaded.status, 200); const result = await uploaded.json(); reference = result.reference;
        let worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        assert.ok((await worker.getNativeResources()).tools.some(tool => tool.name === 'read_document'));
        let off; const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
        try { await worker.request('prompt', { message: 'Summarize uploaded file\n' + result.marker }); await settled; } finally { off(); }
        const snapshot = await worker.request('get_entries'), toolResults = snapshot.entries.filter(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'read_document').map(entry => entry.message);
        assert.equal(toolResults.length, 2); assert.ok(toolResults.every(message => !message.isError), JSON.stringify(toolResults));
        const parsed = toolResults[1].details.pivaneDocument; assert.equal(parsed.items[0].text, '合同 & 分析'); assert.equal(parsed.items.length, 2);
        assert.equal(worker.documentReads, 0); assert.equal(gateway.documents.active, 0);
        assert.ok(!JSON.stringify(requests[0].messages).includes('合同 & 分析'), 'First model request only receives file references, not contents');
        await gateway.supervisor.stopSession(session.path);
        assert.equal((await gateway.documents.branch({ cwd, sessionId: session.id })).references.length, 1); assert.equal(gateway.supervisor.workers.size, 0);
        worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        assert.equal((await gateway.documents.read(worker, { id: reference.id, action: 'read', start: 3, count: 1 })).items[0].text, '项目\t预算');
        const wrongToken = await fetch(`${origin}/api/pi/uploads/read`, { method: 'POST', headers: { Authorization: 'Bearer incorrect', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: reference.id }) }); assert.equal(wrongToken.status, 401);
    } finally {
        await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]);
    }
});
