const test = require('node:test');
const assert = require('node:assert/strict');
const { REVIEWED_PI_VERSION } = require('../server/pi-reviewed-host');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-json-cancel-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function loopback(t, call) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let body = ''; for await (const chunk of req) body += chunk;
        const message = JSON.parse(body);
        requests.push(message);
        if (message.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = message.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : message.method === 'tools/list'
                ? { tools: ['value', 'typed'].map(name => ({ name, description: 'Synthetic any JSON result',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: true }, ...(name === 'typed' ? { outputSchema: {} } : {}) })) }
                : await call(message, req, res);
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests };
}
async function nativeSession(t, url) {
    const sdk = await import('@earendil-works/pi-coding-agent');
    assert.equal(sdk.VERSION, REVIEWED_PI_VERSION);
    const { nativeExtensionFactories } = await import('../server/pi-native-mcp.mjs');
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
        url, headers: { Authorization: 'synthetic-only' }, exposure: 'codemode',
    } } }));
    const settings = sdk.SettingsManager.inMemory({ enableInstallTelemetry: false, defaultProjectTrust: 'never' });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true,
        noPromptTemplates: true, noContextFiles: true, extensionFactories: await nativeExtensionFactories() });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
        modelsStorePath: path.join(agentDir, 'model-store.json'), refreshOnCreate: false, allowModelNetwork: false });
    const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager: settings,
        resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd),
        model: { provider: 'fixture', id: 'chat', api: 'openai-completions', name: 'Synthetic', input: ['text'], contextWindow: 32000, maxTokens: 1000 } });
    const errors = [];
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    t.after(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); assert.deepEqual(errors, []); });
    for (let i = 0; i < 100; i++) {
        if (session.getAllTools().some(tool => tool.name === 'mcp__fixture__typed')) return session;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Native MCP tools did not connect');
}

test('native MCP and codemode preserve any JSON structuredContent, missing content and error results', async t => {
    const calls = [];
    const remote = await loopback(t, message => {
        assert.equal(message.method, 'tools/call');
        calls.push(message.params);
        const { value, failure, withText } = message.params.arguments;
        return { structuredContent: value, ...(withText ? { content: [{ type: 'text', text: 'RAW_TEXT' }] } : {}),
            isError: failure, _meta: { private: 'synthetic-meta' } };
    });
    const session = await nativeSession(t, remote.url);
    const native = session.agent.state.tools.find(tool => tool.name === 'codemode');
    let count = 0;
    for (const name of ['value', 'typed']) for (const value of [null, false, true, 0, 42, '', '双字😀', [], [null, 1], { nested: [false, { ok: true }] }]) {
        for (const failure of [false, true]) {
            const id = `json-${++count}`, args = { value, failure, withText: count % 2 === 0 };
            session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'codemode', arguments: {} }],
                provider: 'fixture', api: 'openai-completions', model: 'chat', stopReason: 'toolUse', timestamp: Date.now() });
            const result = await native.execute(id, { code: `return await tools.mcp__fixture__${name}(${JSON.stringify(args)});` });
            assert.equal(result.isError, undefined, 'structured MCP errors resolve to the script');
            const returned = JSON.parse(result.content.slice(1).map(block => block.text).join(''));
            assert.deepEqual(returned, { content: args.withText ? [{ type: 'text', text: 'RAW_TEXT' }] : [], structuredContent: value, isError: failure });
            assert.equal(returned._meta, undefined);
            assert.equal(result.details.calls[0].status, failure ? 'error' : 'ok');
        }
    }
    assert.equal(calls.length, count, 'one server call per script, including errors');
});

// Gate the documented OAuth provider interface so abort occurs while token
// acquisition or 401 recovery is pending, before the transport can dispatch.
// Gates replace network timing; the real McpClient and HTTP transport own
// request cancellation, retries and notifications.
for (const phase of ['token', 'recovery']) {
    test(`native HTTP MCP cancellation during delayed OAuth ${phase} never dispatches or replays the cancelled call`, { timeout: 10000 }, async t => {
        const { McpClient, StreamableHttpTransport, McpAbortError } = await import('@earendil-works/pi-mcp');
        const entered = deferred(), release = deferred(), finished = deferred();
        let delayed = false, recovered = false, recoveries = 0;
        const remote = await loopback(t, (message, _req, res) => {
            if (message.method === 'tools/call' && phase === 'recovery' && !recovered) {
                res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' }); res.end(); return;
            }
            return { content: [{ type: 'text', text: 'accepted' }] };
        });
        const provider = {
            async token() {
                if (phase === 'token' && delayed) { entered.resolve(); await release.promise; finished.resolve(); }
                if (phase === 'recovery' && recoveries > 0 && !recovered) await release.promise;
                return recovered ? 'synthetic-new' : 'synthetic-old';
            },
            async onUnauthorized() {
                recoveries++; entered.resolve(); await release.promise; recovered = true; finished.resolve();
            },
        };
        const transport = new StreamableHttpTransport({ url: remote.url, authProvider: provider });
        const client = new McpClient({ name: 'fixture', version: '1' });
        t.after(async () => { release.resolve(); await client.close(); });
        await client.connect(transport);
        delayed = true;
        const controller = new AbortController();
        const pending = client.callTool('effect', { key: 'cancelled' }, { signal: controller.signal });
        const rejected = assert.rejects(pending, McpAbortError);
        await entered.promise;
        controller.abort('synthetic cancel');
        await rejected;
        const survivor = client.callTool('effect', { key: 'survivor' });
        assert.equal(remote.requests.filter(message => message.method === 'tools/call' && message.params.arguments.key === 'survivor').length, 0);
        release.resolve();
        await finished.promise;
        delayed = false;
        // A surviving request waits behind recovery and proves the connection
        // stays usable. Server request order makes the absence check causal.
        assert.deepEqual(await survivor, { content: [{ type: 'text', text: 'accepted' }] });
        const cancelled = remote.requests.filter(message => message.method === 'tools/call' && message.params.arguments.key === 'cancelled');
        assert.equal(cancelled.length, phase === 'token' ? 0 : 1, 'cancel prevents dispatch after auth resolves; a challenged request is never retried');
        assert.equal(remote.requests.filter(message => message.method === 'tools/call' && message.params.arguments.key === 'survivor').length, 1);
        assert.equal(recoveries, phase === 'recovery' ? 1 : 0);
    });
}
