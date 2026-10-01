const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiMcpRuntimeControl } = require('../server/pi-mcp-runtime-control');

test('worker slot remains occupied through native UI, ignores unknown replies and rejects stale identity', async () => {
    let release, control; const events = [];
    const worker = { shell: { runtimeId: 'runtime' }, managed: true, noSession: false, disposed: false,
        resourceResults: new Map(), modelCatalog: {}, retainsBackgroundWork: () => false, navigationToken: 'fixture-token',
        _broadcast: event => events.push(event), exclusive: async fn => fn(), client: { request: async (type, payload) => {
            if (type === 'get_commands') return { commands: [{ source: 'extension', path: path.resolve('server/pi-web-session-extension.ts'), name: 'pivane-web-navigate', description: 'mcp-v1' }] };
            const input = JSON.parse(payload.message.slice(payload.message.indexOf(' ') + 1));
            control.handle({ pivaneMcp: input.id, authorization: { server: 'fixture', url: 'https://example.invalid/oauth?state=synthetic' } });
            await new Promise(resolve => { release = resolve; });
            control.handle({ pivaneMcp: input.id, success: true, data: { servers: [] } });
        } } };
    control = new PiMcpRuntimeControl(worker);
    assert.equal(control.handle({ pivaneMcp: 'unknown', success: true, data: { secret: 'never' } }), true);
    const pending = control.request({ runtimeId: 'runtime', action: 'login', server: 'fixture', confirmed: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(control.busy, true); assert.equal(control.authorization.server, 'fixture');
    await assert.rejects(control.request({ runtimeId: 'runtime', action: 'snapshot' }), { code: 'MCP_RUNTIME_BUSY' });
    await assert.rejects(control.request({ runtimeId: 'stale', action: 'snapshot' }), { code: 'MCP_RUNTIME_CHANGED' });
    release(); assert.equal((await pending).runtimeId, 'runtime');
    assert.equal(control.busy, false); assert.equal(control.authorization, null);
    assert.equal(events.at(-1).authorization, null);
});

test('actual unique managed worker bridges native MCP status across ESM and web extension APIs', { timeout: 90000 }, async t => {
    const http = require('node:http'), { once } = require('node:events');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-worker-')));
    const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
    const prior = {};
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') })) { prior[key] = process.env[key]; process.env[key] = value; }
    const methods = []; const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let raw = ''; for await (const part of req) raw += part;
        const message = JSON.parse(raw); methods.push(message.method);
        if (message.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : {};
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'synthetic-only' }, exposure: 'codemode' } } }));
    const { PiSessionStore } = require('../server/pi-session-store'), { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    t.after(async () => { await supervisor.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); });
    const session = await store.createSession(cwd, 'fixture');
    const express = require('express'), app = express(), router = express.Router(); app.use(express.json()); app.use(router);
    const { PiMcpSettingsService } = require('../server/pi-mcp-settings-service');
    const mcpSettingsService = new PiMcpSettingsService(store);
    const settingsService = { loginService: { assertIdle() {} } }, nativeService = { busy: false };
    require('../server/routes/mcp').mountMcpSettingsRoutes(router, { mcpSettingsService, settingsService });
    require('../server/routes/mcp-runtime').mountMcpRuntimeRoutes(router, { store, supervisor, settingsService, nativeService, mcpSettingsService });
    const api = app.listen(0, '127.0.0.1'); await once(api, 'listening');
    t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
    const base = `http://127.0.0.1:${api.address().port}`;
    const config = await fetch(`${base}/settings/mcp?cwd=${encodeURIComponent(cwd)}&scope=global`);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(await config.json()).includes('synthetic-only'), false);
    const closed = await fetch(`${base}/sessions/${session.id}/mcp?cwd=${encodeURIComponent(cwd)}&runtimeId=missing`);
    assert.equal(closed.status, 409); assert.equal(supervisor.workers.size, 0, 'management must not start a closed worker');
    const worker = await supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
    const loaded = await fetch(`${base}/sessions/${session.id}/mcp?cwd=${encodeURIComponent(cwd)}&runtimeId=${worker.shell.runtimeId}`);
    assert.equal(loaded.status, 200); assert.equal((await loaded.json()).servers[0].state, 'connected');
    const malformed = await fetch(`${base}/sessions/${session.id}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, runtimeId: worker.shell.runtimeId, action: 'reconnect', server: 'fixture' }) });
    assert.equal(malformed.status, 409); assert.equal((await malformed.json()).code, 'MCP_INVALID_ACTION');
    const snapshot = await worker.mcpControl.request({ runtimeId: worker.shell.runtimeId, action: 'snapshot' });
    assert.equal(snapshot.servers[0].name, 'fixture'); assert.equal(snapshot.servers[0].state, 'connected'); assert.equal(snapshot.servers[0].toolCount, 1);
    assert.ok(snapshot.tools.some(tool => tool.name === 'mcp__fixture__echo'));
    const before = fs.readFileSync(session.path);
    await worker.mcpControl.request({ runtimeId: worker.shell.runtimeId, action: 'reconnect', server: 'fixture', confirmed: true });
    assert.ok(methods.filter(method => method === 'initialize').length >= 2);
    assert.equal(methods.includes('tools/call'), false);
    assert.deepEqual(fs.readFileSync(session.path), before, 'management commands never create user/model messages');
    await assert.rejects(worker.mcpControl.request({ runtimeId: 'old-runtime', action: 'snapshot' }), { code: 'MCP_RUNTIME_CHANGED' });
    await worker.reloadResources();
    assert.equal((await worker.mcpControl.request({ runtimeId: worker.shell.runtimeId, action: 'snapshot' })).servers[0].state, 'connected');
});
