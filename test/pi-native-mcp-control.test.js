const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const helper = () => import('../server/pi-native-mcp-control.mjs');
function api() {
    const commands = new Map(), events = new Map(), tools = new Map();
    return { commands, events, registerCommand: (name, command) => commands.set(name, command), on: (name, handler) => { const previous = events.get(name); events.set(name, async (...args) => { await previous?.(...args); return handler(...args); }); }, getMcpServers: () => [], getAllTools: () => [...tools.values()], getActiveTools: () => [], setActiveTools() {}, registerTool: tool => tools.set(tool.name, tool) };
}
function context(id = 'synthetic-session') { return { mode: 'rpc', cwd: '/synthetic', hasUI: true, sessionManager: { getSessionId: () => id }, isIdle: () => true, isProjectTrusted: () => true, ui: { notify() {}, input: async () => undefined } }; }
async function official() {
    const root = path.resolve(path.dirname(fileURLToPath((await helper()).nativePiEntry())), '..');
    return (await import(pathToFileURL(path.join(root, 'dist/extensions/mcp/index.js')).href)).createMcpExtension;
}
test('exact status parser omits stderr, malformed status, paths and unproven health', async () => {
    const { parseNativeMcpStatus } = await helper();
    const result = parseNativeMcpStatus('demo: connected, 2 tools (codemode-deferred)\nfailed: failed (direct)\n    command --token SECRET\nauth: needs sign-in, run /mcp login auth (hidden)\nconfig error: PRIVATE\noverridden: PRIVATE');
    assert.deepEqual(result.servers, [{ name: 'demo', state: 'connected', toolCount: 2, exposure: 'codemode-deferred' }, { name: 'failed', state: 'failed', toolCount: null, exposure: 'direct' }, { name: 'auth', state: 'needs-auth', toolCount: null, exposure: 'hidden' }]);
    assert.equal(result.unknown, true); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(parseNativeMcpStatus('x'.repeat(40000)).unknown, true);
});
test('capture preserves official command ownership across distinct APIs and isolated registrations', async () => {
    const { captureNativeMcpControl, requestRegisteredNativeMcpControl } = await helper(), createMcpExtension = await official();
    let transportCalls = 0;
    const pi = api(), ctx = context(), otherPi = api(), otherCtx = context('other-session');
    const factory = createMcpExtension({ loadConfig: () => ({ servers: [{ name: 'disabled', scope: 'global', source: '/synthetic/mcp.json', config: { command: 'SECRET_EXECUTABLE', enabled: false } }], errors: [] }), createTransport: () => { transportCalls++; throw Error('never'); } });
    captureNativeMcpControl(factory)(pi); captureNativeMcpControl(factory)(otherPi);
    const original = pi.commands.get('mcp').handler;
    await pi.events.get('session_start')({}, ctx); await otherPi.events.get('session_start')({}, otherCtx);
    const webApi = api(); assert.notEqual(webApi, pi);
    const snapshot = await requestRegisteredNativeMcpControl(ctx, { action: 'snapshot' });
    assert.deepEqual(snapshot.servers, [{ name: 'disabled', state: 'disabled', toolCount: null, exposure: 'codemode' }]);
    assert.equal(transportCalls, 0); assert.equal(pi.commands.get('mcp').handler, original);
    const reconnect = await requestRegisteredNativeMcpControl(ctx, { action: 'reconnect', server: 'disabled', confirmed: true });
    assert.ok(reconnect.notices.some(item => item.kind === 'error')); assert.ok(!JSON.stringify(reconnect).includes('SECRET'));
    const duplicate = api(); captureNativeMcpControl(factory)(duplicate);
    await assert.rejects(duplicate.events.get('session_start')({}, ctx), { code: 'MCP_DUPLICATE_RUNTIME' });
    await duplicate.events.get('session_shutdown')();
    await pi.events.get('session_shutdown')();
    assert.equal((await requestRegisteredNativeMcpControl(ctx, { action: 'snapshot' })).notices[0].kind, 'unknown');
    assert.equal((await requestRegisteredNativeMcpControl(otherCtx, { action: 'snapshot' })).servers[0].state, 'disabled');
    await otherPi.events.get('session_shutdown')();
});
test('official isolated enabled server injected transport failure stays redacted through reconnect', async t => {
    const { captureNativeMcpControl, requestRegisteredNativeMcpControl } = await helper(), createMcpExtension = await official();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-mcp-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pi = api(), ctx = context('failure-session'); ctx.cwd = directory; let attempts = 0;
    captureNativeMcpControl(createMcpExtension({ loadConfig: () => ({ servers: [{ name: 'broken', scope: 'global', source: path.join(directory, 'mcp.json'), config: { command: 'synthetic-secret', exposure: 'direct' } }], errors: [] }), credentials: { tokens: () => undefined }, logPath: path.join(directory, 'mcp.log'), createTransport: () => { attempts++; throw Error('PRIVATE TOKEN stderr --password secret'); } }))(pi);
    await pi.events.get('session_start')({}, ctx);
    const status = await requestRegisteredNativeMcpControl(ctx, { action: 'snapshot' });
    assert.equal(status.servers[0].state, 'failed'); assert.equal(attempts, 1); assert.ok(!JSON.stringify(status).includes('PRIVATE'));
    const reconnect = await requestRegisteredNativeMcpControl(ctx, { action: 'reconnect', server: 'broken', confirmed: true });
    assert.equal(attempts, 2); assert.equal(reconnect.servers[0].state, 'failed'); assert.ok(!JSON.stringify(reconnect).includes('TOKEN'));
    await pi.events.get('session_shutdown')();
});
test('busy reserve persists until official handler settles; OAuth input stays native and raw errors suppressed', async () => {
    const { captureNativeMcpControl, requestNativeMcpControl } = await helper();
    const pi = api(), ctx = context(); let release, receivedInput = false; const shown = [];
    ctx.ui.input = async () => { receivedInput = true; }; ctx.ui.notify = message => shown.push(message);
    captureNativeMcpControl(p => p.registerCommand('mcp', { handler: async (args, c) => {
        if (args.startsWith('login')) {
            c.ui.notify('Sign in to MCP server "demo" in your browser:\nhttps://example.invalid/auth?state=synthetic', 'info');
            await c.ui.input('official pending dialog');
            await new Promise(resolve => { release = resolve; });
            c.ui.notify('TOKEN transport --password SECRET', 'error');
        } else c.ui.notify('demo: needs sign-in, run /mcp login demo (direct)', 'info');
    } }))(pi);
    const pending = requestNativeMcpControl(pi, ctx, { action: 'login', server: 'demo', confirmed: true });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(requestNativeMcpControl(pi, ctx, { action: 'snapshot' }), { code: 'MCP_RUNTIME_BUSY' });
    release(); const result = await pending;
    assert.equal(receivedInput, true); assert.equal(shown.length, 1); assert.equal(result.notices[0].kind, 'authorization'); assert.ok(!JSON.stringify(result).includes('SECRET'));
    await assert.rejects(requestNativeMcpControl(pi, { ...ctx, isIdle: () => false }, { action: 'snapshot' }), { code: 'MCP_RUNTIME_NOT_IDLE' });
    assert.equal((await requestNativeMcpControl(api(), ctx, { action: 'snapshot' })).notices[0].kind, 'unknown');
});
test('official native loopback server discovers tools without tools/call or model requests', async t => {
    const http = require('node:http');
    const { captureNativeMcpControl, requestRegisteredNativeMcpControl } = await helper(), createMcpExtension = await official();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-http-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const methods = [];
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let text = ''; req.on('data', data => { text += data; }); req.on('end', () => {
            const message = JSON.parse(text); methods.push(message.method);
            if (message.id === undefined) { res.writeHead(202); res.end(); return; }
            const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'fixture_read', description: 'synthetic', inputSchema: { type: 'object' } }] } : {};
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const pi = api(), ctx = context('loopback-session'); ctx.cwd = directory;
    captureNativeMcpControl(createMcpExtension({ loadConfig: () => ({ servers: [{ name: 'fixture', scope: 'global', source: path.join(directory, 'mcp.json'), config: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'synthetic-fixture' }, exposure: 'direct' } }], errors: [] }), credentials: { tokens: () => undefined }, logPath: path.join(directory, 'mcp.log') }))(pi);
    await pi.events.get('session_start')({}, ctx);
    try {
        const status = await requestRegisteredNativeMcpControl(ctx, { action: 'snapshot' });
        assert.equal(status.servers[0].state, 'connected'); assert.equal(status.servers[0].toolCount, 1);
        assert.ok(status.tools.some(tool => tool.name === 'mcp__fixture__fixture_read'));
        assert.ok(methods.includes('initialize')); assert.ok(methods.includes('tools/list')); assert.ok(!methods.includes('tools/call'));
    } finally { await pi.events.get('session_shutdown')(); }
});

test('Pi 1.0 official OAuth store owns normalized server-and-URL keys and legacy takeover', async () => {
    const root = path.resolve(path.dirname(fileURLToPath((await helper()).nativePiEntry())), '..');
    const { McpOAuthCredentialStore } = await import(pathToFileURL(path.join(root, 'dist/extensions/mcp/oauth.js')).href);
    const url = 'https://example.invalid/mcp';
    const legacy = { tokens: { access_token: 'synthetic-only', token_type: 'Bearer' }, future: { keep: true } };
    let content = JSON.stringify({ [url]: legacy, unrelated: { keep: true } });
    const backend = { withLock(fn) { const { result, next } = fn(content); if (next !== undefined) content = next; return result; } };
    const store = new McpOAuthCredentialStore(backend);
    assert.deepEqual(store.forServer('dev-radius', url).load(), legacy);
    assert.deepEqual(Object.keys(JSON.parse(content)).sort(), ['mcp__dev_radius|https://example.invalid/mcp', 'unrelated']);
    assert.deepEqual(store.tokens('dev_radius', url), legacy.tokens, 'namespace aliases use the same official key');
    assert.equal(store.tokens('other-account', url), undefined, 'same URL with another server name shares no grant');
    const other = { tokens: { access_token: 'other-synthetic-only', token_type: 'Bearer' } };
    store.forServer('other-account', url).save(other);
    assert.equal(store.remove('dev-radius', url), true);
    assert.deepEqual(store.tokens('other-account', url), other.tokens);
    assert.deepEqual(JSON.parse(content).unrelated, { keep: true });
});

test('native OAuth cancellation and unknown notifications keep the fixed notice whitelist', async () => {
    const { captureNativeMcpControl, requestNativeMcpControl, parseNativeMcpStatus } = await helper();
    const pi = api(), ctx = context(); const shown = [];
    ctx.ui.notify = message => shown.push(message);
    captureNativeMcpControl(p => p.registerCommand('mcp', { handler: async (args, c) => {
        if (args.startsWith('login')) {
            c.ui.notify('Sign in to MCP server "dev-radius" in your browser:\nhttps://example.invalid/auth\nPRIVATE', 'info');
            c.ui.notify('Sign-in cancelled.', 'info');
            c.ui.notify('PRIVATE diagnostics', 'info');
        } else c.ui.notify('dev-radius: needs sign-in, run /mcp login dev-radius (codemode)', 'info');
    } }))(pi);
    const result = await requestNativeMcpControl(pi, ctx, { action: 'login', server: 'dev-radius', confirmed: true });
    assert.equal(result.outcome, 'cancelled'); assert.deepEqual(result.notices, [{ kind: 'cancelled', code: 'MCP_NATIVE_SIGN_IN_CANCELLED' }]);
    assert.deepEqual(shown, []); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|example\.invalid/);
    assert.deepEqual(parseNativeMcpStatus('dev-radius: starting (codemode)\nother: connecting (deferred)').servers,
        [{ name: 'dev-radius', state: 'starting', toolCount: null, exposure: 'codemode' }, { name: 'other', state: 'connecting', toolCount: null, exposure: 'deferred' }]);
});
