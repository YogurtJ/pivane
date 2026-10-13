const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-120-integration-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function loopback(t, handler) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = raw && req.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : undefined;
        requests.push({ method: req.method, path: req.url, body });
        if (req.url === '/mcp' && req.method !== 'POST') {
            res.writeHead(req.method === 'DELETE' ? 204 : 405); res.end(); return;
        }
        await handler(req, res, body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { base: `http://127.0.0.1:${server.address().port}`, requests };
}
function rpc(res, body, result) {
    if (body.id === undefined) { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
}

test('native MCP registers and calls tools before slow resources/list, then lists and reads only on demand', { timeout: 15000 }, async t => {
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const remote = await loopback(t, async (_req, res, body) => {
        if (body.id === undefined) return rpc(res, body, {});
        if (body.method === 'initialize') return rpc(res, body, { protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'resources', version: '1' } });
        if (body.method === 'tools/list') return rpc(res, body, { tools: [{ name: 'value', description: 'Synthetic tool', inputSchema: { type: 'object' } }] });
        if (body.method === 'tools/call') return rpc(res, body, { content: [{ type: 'text', text: 'tool ready' }] });
        if (body.method === 'resources/list') {
            entered.resolve(); await release.promise;
            return rpc(res, body, { resources: [{ uri: 'fixture://resource', name: 'Fixture resource' }] });
        }
        assert.equal(body.method, 'resources/read');
        return rpc(res, body, { contents: [{ uri: body.params.uri, text: 'explicit resource contents' }] });
    });
    const sdk = await import('@earendil-works/pi-coding-agent');
    const { nativeExtensionFactories } = await import('../server/pi-native-mcp.mjs');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
        url: remote.base + '/mcp', headers: { Authorization: 'synthetic-only' }, exposure: 'direct'
    } } }));
    const settingsManager = sdk.SettingsManager.inMemory({ enableInstallTelemetry: false, defaultProjectTrust: 'never' });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
        noSkills: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: await nativeExtensionFactories() });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
        resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
    t.after(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); });
    await session.bindExtensions({ mode: 'print' });
    for (let i = 0; !session.getAllTools().some(tool => tool.name === 'mcp__fixture__value'); i++) {
        assert.ok(i < 100, 'tool registration must complete while resource list remains blocked');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const methods = () => remote.requests.map(request => request.body?.method);
    assert.equal(methods().includes('resources/list'), false, 'startup must not issue eager enumeration');
    assert.equal(methods().includes('resources/templates/list'), false);
    const tool = session.agent.state.tools.find(tool => tool.name === 'mcp__fixture__value');
    assert.equal((await tool.execute('synthetic-call', {})).content[0].text, 'tool ready');
    const { McpClient, StreamableHttpTransport } = await import('@earendil-works/pi-mcp');
    const client = new McpClient({ name: 'explicit-resource-reader', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHttpTransport({ url: remote.base + '/mcp' }));
    let settled = false;
    const listed = client.listResources().then(result => { settled = true; return result; });
    await entered.promise;
    assert.equal(settled, false, 'explicit listing waits at the resource barrier');
    assert.equal(methods().filter(method => method === 'resources/list').length, 1);
    release.resolve();
    assert.deepEqual(await listed, [{ uri: 'fixture://resource', name: 'Fixture resource' }]);
    assert.deepEqual(await client.readResource('fixture://resource'), { contents: [{ uri: 'fixture://resource', text: 'explicit resource contents' }] });
    assert.equal(methods().filter(method => method === 'resources/read').length, 1);
});

test('native OAuth discovery and authorization response issuer validation reject before token exchange or MCP dispatch', { timeout: 15000 }, async t => {
    let mode = 'valid', base;
    const remote = await loopback(t, (req, res, body) => {
        const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
        if (req.method === 'GET' && req.url.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: base + '/mcp', authorization_servers: [base + '/issuer'] });
        if (req.method === 'GET' && req.url.includes('well-known')) {
            if (mode === 'no-metadata') { res.writeHead(404); return res.end(); }
            return json({ issuer: base + (mode === 'wrong-metadata' ? '/foreign' : '/issuer'),
                authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
        }
        if (req.url === '/token') return json({ access_token: 'synthetic-access', token_type: 'Bearer' });
        assert.equal(req.url, '/mcp');
        if (body.method === 'initialize') return rpc(res, body, { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'authorized', version: '1' } });
        if (body.method === 'tools/list') return rpc(res, body, { tools: [] });
        if (body.id === undefined) return rpc(res, body, {});
        assert.equal(body.method, 'tools/call');
        return rpc(res, body, { content: [{ type: 'text', text: 'authorized' }] });
    });
    base = remote.base;
    const { authorizeMcp, OAuthIssuerMismatchError, adaptOAuthProvider } = await import('@earendil-works/pi-mcp/oauth');
    const { McpClient, StreamableHttpTransport } = await import('@earendil-works/pi-mcp');
    let savedTokens;
    const provider = {
        redirectUrl: base + '/callback', clientMetadata: { redirect_uris: [base + '/callback'] },
        clientInformation: () => ({ client_id: 'synthetic-client' }), tokens: () => savedTokens,
        saveTokens: tokens => { savedTokens = tokens; }, codeVerifier: () => 'synthetic-verifier',
        saveCodeVerifier() {}, redirectToAuthorization() { throw new Error('No interactive authorization expected'); }
    };
    const exchangeAndCall = async iss => {
        await authorizeMcp(provider, { serverUrl: base + '/mcp', authorizationCode: 'synthetic-code', ...(iss === undefined ? {} : { iss }) });
        const client = new McpClient({ name: 'authorized-control', version: '1' });
        try {
            await client.connect(new StreamableHttpTransport({ url: base + '/mcp', authProvider: adaptOAuthProvider(provider) }));
            return await client.callTool('effect', {});
        } finally { await client.close(); }
    };
    const counts = () => ({ tokens: remote.requests.filter(request => request.path === '/token').length,
        tools: remote.requests.filter(request => request.body?.method === 'tools/call').length });
    assert.equal((await exchangeAndCall(base + '/issuer')).content[0].text, 'authorized');
    assert.deepEqual(counts(), { tokens: 1, tools: 1 }, 'valid issuer reaches the real token and tool HTTP boundaries');
    for (const [scenario, iss] of [['valid', undefined], ['valid', base + '/foreign'], ['valid', base + '/issuer/'],
        ['wrong-metadata', base + '/issuer'], ['no-metadata', base + '/issuer']]) {
        mode = scenario; savedTokens = undefined;
        const before = counts();
        await assert.rejects(exchangeAndCall(iss), OAuthIssuerMismatchError, `${scenario}: ${iss}`);
        assert.deepEqual(counts(), before, 'issuer rejection must not exchange the code or dispatch a tool');
        assert.equal(savedTokens, undefined);
    }
});
