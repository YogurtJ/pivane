const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-profile-wiring-')));
const agentDir = path.join(root, 'agent');
const projects = [path.join(root, 'math'), path.join(root, 'systems')];
for (const dir of [agentDir, ...projects]) fs.mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
const { ProfileMemoryConfiguration } = require('../server/profile-memory/config');

// This gate is optional for installations without the optional memory package.
// Release validation supplies the exact reviewed bundle and requires zero skips.
test('private memory config fails closed and never leaks executable settings to unbound workers', async t => {
    const configuration = new ProfileMemoryConfiguration({ getAgentDir: async () => agentDir });
    const configRoot = path.join(agentDir, 'pivane-profiles');
    const file = path.join(configRoot, 'runtime.json');
    fs.mkdirSync(configRoot, { recursive: true });
    assert.deepEqual((await configuration.snapshot()).capability, { installed: false, autoLearn: false });
    fs.writeFileSync(file, '{bad-json');
    assert.equal((await configuration.snapshot()).bundlePath, null);
    fs.writeFileSync(file, JSON.stringify({ version: 1, bundlePath: '/nonexistent/bundle.mjs' }));
    assert.equal((await configuration.snapshot()).capability.installed, false);
    assert.deepEqual(await configuration.environment(null), { PIVANE_HERMES_BUNDLE: undefined, PIVANE_PROFILE_MEMORY_REVIEW_MODEL: undefined });
    fs.unlinkSync(file);
    t.after(() => { if (!bundle) fs.rmSync(root, { recursive: true, force: true }); });
});

test('assembled HTTP and real RPC isolate profile memory across projects without paid requests', { skip: !bundle, timeout: 90000 }, async t => {
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const calls = [];
    const marker = 'synthetic-kinetic-42';
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part;
        const body = JSON.parse(raw); calls.push(body);
        const last = body.messages.at(-1);
        const wantsWrite = JSON.stringify(last?.content || '').includes('fixture remember');
        const action = wantsWrite ? 'memory_add' : 'memory_search';
        const args = wantsWrite ? { target: 'memory', content: marker } : { query: marker };
        const delta = last?.role === 'tool' ? { role: 'assistant', content: 'Fixture completed.' }
            : { role: 'assistant', tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: action, arguments: JSON.stringify(args) } }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: last?.role === 'tool' ? 'stop' : 'tool_calls' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
        models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    fs.writeFileSync(path.join(agentDir, 'pivane-profiles', 'runtime.json'), JSON.stringify({ version: 1, bundlePath: bundle,
        reviewModel: { provider: 'fixture', modelId: 'fixture' } }));
    const configuration = new ProfileMemoryConfiguration();
    assert.deepEqual((await configuration.snapshot()).capability, { installed: true, autoLearn: true });
    const gateway = createPiAgentGateway({ accessService: new WorkspaceAccessService({ envToken: () => 'fixture-token' }), deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
        await gateway.dispose();
        server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const call = async (method, url, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi${url}`, { method,
            headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
    };
    assert.deepEqual((await call('GET', '/status')).profileMemory, { installed: true, autoLearn: true });
    const createProfile = async name => {
        const { revision } = await call('GET', '/profiles');
        return (await call('PUT', '/profiles', { expectedRevision: revision, profile: { name, description: '', soul: `Fixture ${name}`,
            enabled: true, memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true } } })).profile;
    };
    const study = await createProfile('Study'), dev = await createProfile('Development');
    const makeWorker = async (cwd, profileId) => {
        const session = await call('POST', '/sessions', { cwd, profileId });
        const worker = await gateway.supervisor.getWorker({ cwd, sessionId: session.id, sessionPath: session.path });
        return { session, worker };
    };
    const source = await makeWorker(projects[0], study.id);
    const same = await makeWorker(projects[1], study.id);
    const other = await makeWorker(projects[1], dev.id);
    const none = await makeWorker(projects[0], null);
    const names = async worker => (await worker.getNativeResources()).tools.map(tool => tool.name);
    for (const target of [source, same, other]) {
        const tools = await names(target.worker); assert.ok(tools.includes('memory_add')); assert.ok(tools.includes('session_search'));
        assert.equal(target.worker.client.env.PIVANE_HERMES_BUNDLE, bundle);
        assert.equal(target.worker.client.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL, undefined, 'autoLearn=false sends no review model');
    }
    assert.equal((await names(none.worker)).includes('memory_add'), false);
    assert.equal(none.worker.client.env.PIVANE_HERMES_BUNDLE, undefined);
    const prompt = async (worker, message) => {
        let timer, unsubscribe;
        const done = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Fixture did not settle')), 20000);
            unsubscribe = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); });
        });
        try { await worker.request('prompt', { message }); await done; }
        finally { clearTimeout(timer); unsubscribe?.(); }
        return calls.at(-1).messages.filter(message => message.role === 'tool').at(-1)?.content;
    };
    await prompt(source.worker, 'fixture remember');
    assert.match(await prompt(same.worker, 'fixture recall'), new RegExp(marker));
    assert.doesNotMatch(await prompt(other.worker, 'fixture recall'), new RegExp(marker));
    const listing = await call('GET', `/profiles/${study.id}/memory?kind=memories`);
    assert.equal(listing.status, 'ready'); assert.ok(listing.items.some(item => item.content === marker));
    const foreign = await call('GET', `/profiles/${dev.id}/memory?kind=memories`);
    assert.equal(foreign.items.some(item => item.content === marker), false);
});
