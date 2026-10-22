const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-bundled-subagents-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const directory of [agentDir, cwd]) fs.mkdirSync(directory);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
const wrapper = path.resolve(__dirname, '../server/pi-bundled-subagents.mjs');
const delegation = ['subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait'];
const sorted = session => session.getActiveToolNames().sort();
let sdk, runtime, model, provider, nextTool, executions = [], requests = [];
test.before(async () => {
    sdk = await import('@earendil-works/pi-coding-agent');
    provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        const tool = nextTool; nextTool = undefined;
        const delta = tool ? { tool_calls: [{ index: 0, id: 'explicit-control', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: 'Native selection recorded.' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const settings = { enableInstallTelemetry: false, defaultProjectTrust: 'never', defaultTools: ['read'], defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false } };
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    const models = { providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024 }] } } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models));
    runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'catalog.json'), allowModelNetwork: false });
    model = runtime.getModel('fixture', 'fixture');
});
test.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
async function open(manager, extra = {}) {
    const { factories = [], entry = wrapper, ...sessionOptions } = extra;
    const settings = sdk.SettingsManager.create(cwd, agentDir);
    const paths = [entry];
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: paths, extensionFactories: factories });
    await loader.reload();
    const errors = [];
    const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, settingsManager: settings, resourceLoader: loader, sessionManager: manager, ...sessionOptions });
    session.subscribe(event => { if (event.type === 'tool_execution_start') executions.push(event.toolName); });
    const before = manager.getSessionFile() && fs.existsSync(manager.getSessionFile()) ? fs.readFileSync(manager.getSessionFile()) : null;
    const count = requests.length, effects = executions.length;
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(String(error.error)) });
    assert.equal(requests.length, count, 'binding makes no provider request');
    assert.equal(executions.length, effects, 'binding executes no tools');
    if (before) assert.deepEqual(fs.readFileSync(manager.getSessionFile()), before, 'binding preserves existing native bytes');
    return { session, paths, errors, async close() { paths.length = 0; await session.reload(); session.dispose(); assert.deepEqual(errors, []); } };
}
async function disabledFixture(name) {
    const manager = sdk.SessionManager.create(cwd, path.join(root, name));
    const first = await open(manager);
    assert.ok(sorted(first.session).includes('subagent'));
    await first.session.prompt('Persist eager selection.');
    const enabledLeaf = manager.getLeafId();
    first.session.setActiveToolsByName(['read']);
    await first.session.prompt('Persist deliberate removal of all delegation sentinels.');
    assert.deepEqual(sorted(first.session), ['read']);
    const disabledLeaf = manager.getLeafId(), file = manager.getSessionFile();
    const original = fs.readFileSync(file);
    assert.ok(manager.getBranch().some(entry => entry.type === 'message' && entry.message.toolsRemoved?.some(tool => tool.name === 'subagent')));
    await first.close();
    return { file, original, enabledLeaf, disabledLeaf };
}

test('bundled wrapper retains native removals across reopen, reload and tree navigation without changing history', async () => {
    const fresh = await open(sdk.SessionManager.create(cwd, path.join(root, 'unpersisted')));
    try {
        fresh.session.setActiveToolsByName(['read']);
        await fresh.session.reload();
        assert.deepEqual(sorted(fresh.session), ['read'], 'an unpersisted choice before the first prompt survives reload');
    } finally { await fresh.close(); }
    const fixture = await disabledFixture('resume');
    const current = await open(sdk.SessionManager.open(fixture.file));
    try {
        assert.deepEqual(sorted(current.session), ['read']);
        await current.session.reload();
        assert.deepEqual(sorted(current.session), ['read'], 'reload cannot resurrect removed sentinels');
        assert.deepEqual(fs.readFileSync(fixture.file), fixture.original);
        await current.session.navigateTree(fixture.enabledLeaf, { summarize: false });
        assert.ok(sorted(current.session).includes('subagent'), 'enabled branch keeps its native selection');
        await current.session.navigateTree(fixture.disabledLeaf, { summarize: false });
        assert.deepEqual(sorted(current.session), ['read'], 'disabled branch takes precedence over prior enabled branch');
        assert.deepEqual(fs.readFileSync(fixture.file), fixture.original);
        await current.session.prompt('Keep the resumed selection.');
        assert.deepEqual(sorted(current.session), ['read']);
        assert.deepEqual(requests.at(-1).tools.map(tool => tool.function.name), ['read']);
        assert.ok(fs.readFileSync(fixture.file).subarray(0, fixture.original.length).equals(fixture.original));
        assert.deepEqual(executions, []);
    } finally { await current.close(); }
});

test('later explicit selection and subagents_enable override old removals and survive a live reload', async () => {
    const fixture = await disabledFixture('reenable');
    const explicit = await open(sdk.SessionManager.open(fixture.file), { tools: ['read', 'subagents_enable', ...delegation] });
    assert.deepEqual(sorted(explicit.session), ['read', 'subagents_enable', ...delegation].sort(), 'explicit tools win at binding');
    await explicit.close();
    const current = await open(sdk.SessionManager.open(fixture.file));
    try {
        current.session.setActiveToolsByName(['read', 'subagents_enable']);
        await current.session.reload();
        assert.deepEqual(sorted(current.session), ['read', 'subagents_enable'], 'live reload preserves an unpersisted explicit selection');
        nextTool = { name: 'subagents_enable', arguments: {} };
        await current.session.prompt('Explicitly enable delegation without launching work.');
        assert.deepEqual(sorted(current.session), ['read', 'subagents_enable', ...delegation].sort());
        assert.deepEqual(executions, ['subagents_enable']);
        await current.session.reload();
        assert.deepEqual(sorted(current.session), ['read', 'subagents_enable', ...delegation].sort());
    } finally { await current.close(); }
});

test('new CLI process --tools and explicit post-unload selection recover tools while exclusions and noTools remain authoritative', async () => {
    const fixture = await disabledFixture('cli');
    const cli = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
    const probe = path.join(root, 'inspect-selection.mjs');
    fs.writeFileSync(probe, `export default function(pi){pi.on('session_start',()=>process.stdout.write('SELECTION:'+JSON.stringify(pi.getActiveTools())+'\\n'));}`);
    const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--session', fixture.file, '--no-extensions', '-e', wrapper, '-e', probe, '--tools', 'read,subagent,subagents_enable', '--no-skills', '--no-prompt-templates'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '', queried = false;
    const query = () => { if ((output + error).includes('SELECTION:') && !queried) { queried = true; child.stdin.write('{"id":"selection-probe","type":"get_state"}\n'); } };
    child.stdout.on('data', chunk => {
        output += chunk; query();
        if (output.includes('"id":"selection-probe"')) child.stdin.end();
    });
    child.stderr.on('data', chunk => { error += chunk; query(); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    try {
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, error);
        const line = (output + '\n' + error).split('\n').find(line => line.startsWith('SELECTION:'));
        assert.ok(line, output + error);
        assert.deepEqual(JSON.parse(line.slice(10)).sort(), ['read', 'subagent', 'subagents_enable']);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); }
    const current = await open(sdk.SessionManager.open(fixture.file));
    try {
        current.paths.length = 0; await current.session.reload();
        assert.equal(current.session.getAllTools().some(tool => tool.name === 'subagent'), false);
        current.paths.push(wrapper);
        await current.session.reload({ beforeSessionStart: () => current.session.setActiveToolsByName(['read', 'subagent', 'subagents_enable']) });
        assert.deepEqual(sorted(current.session), ['read', 'subagent', 'subagents_enable'], 'explicit positive selection after real unload restores supported tools');
    } finally { await current.close(); }
    for (const extra of [{ excludeTools: ['subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait', 'subagents_enable'] }, { noTools: 'all' }]) {
        const restricted = await open(sdk.SessionManager.open(fixture.file), extra);
        try { assert.ok(sorted(restricted.session).every(name => !delegation.includes(name) && name !== 'subagents_enable')); }
        finally { await restricted.close(); }
    }
});

test('owned pending supervisor requests retain selected replies without restoring revoked delegation', async () => {
    const { resolveSupervisorChannelDir, ensureSupervisorChannelDir } = await import('../vendor/pi-subagents/src/intercom/native-supervisor-channel.js');
    const fixture = await disabledFixture('pending');
    const current = await open(sdk.SessionManager.open(fixture.file));
    const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(predicate()); };
    const request = suffix => {
        const id = 'pending-' + suffix, runId = 'owned-' + suffix;
        const channel = resolveSupervisorChannelDir(runId, 'fixture', 0); ensureSupervisorChannelDir(channel);
        fs.writeFileSync(path.join(channel, 'requests', id + '.json'), JSON.stringify({ type: 'subagent.supervisor.request', id, createdAt: Date.now(), expiresAt: Date.now() + 60000, reason: 'need_decision', message: 'Synthetic owned question', expectsReply: true, runId, agent: 'fixture', childIndex: 0, orchestratorSessionId: current.session.sessionId }));
        return { id, channel };
    };
    try {
        const effects = executions.length;
        const denied = request('revoked');
        await waitFor(() => current.session.messages.some(message => message.customType === 'subagent_supervisor_request' && JSON.stringify(message.details).includes(denied.id)));
        await current.session.agent.waitForIdle();
        assert.deepEqual(sorted(current.session), ['read']);
        assert.equal(executions.length, effects, 'a pending question executes no tool and grants no delegation');
        fs.rmSync(path.join(denied.channel, 'requests', denied.id + '.json'));
        current.session.setActiveToolsByName(['read', 'subagent_supervisor']);
        const allowed = request('selected');
        await waitFor(() => current.session.messages.some(message => message.customType === 'subagent_supervisor_request' && JSON.stringify(message.details).includes(allowed.id)));
        await current.session.agent.waitForIdle();
        assert.deepEqual(sorted(current.session), ['read', 'subagent_supervisor']);
        nextTool = { name: 'subagent_supervisor', arguments: { action: 'reply', replyTo: allowed.id, message: 'Synthetic authorized reply' } };
        await current.session.prompt('Reply to the synthetic owned request within the current tool selection.');
        assert.ok(fs.existsSync(path.join(allowed.channel, 'replies', allowed.id + '.json')));
        assert.deepEqual(executions.slice(effects), ['subagent_supervisor']);
        assert.deepEqual(sorted(current.session), ['read', 'subagent_supervisor']);
        assert.ok(fs.readFileSync(fixture.file).subarray(0, fixture.original.length).equals(fixture.original));
    } finally { await current.close(); }
});

test('hidden definitions and eager configuration keep native precedence at the bundled boundary', async () => {
    const fixture = await disabledFixture('hidden');
    const hiddenPath = path.join(root, 'hidden-subagent.mjs');
    fs.writeFileSync(hiddenPath, `import bundled from ${JSON.stringify(require('node:url').pathToFileURL(wrapper).href)};export default function(pi){return bundled(new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>pi.registerTool(tool.name==='subagent'?{...tool,exposure:'hidden'}:tool);return Reflect.get(target,key);}}));}`);
    const hidden = await open(sdk.SessionManager.open(fixture.file), { tools: ['read', 'subagent'], entry: hiddenPath });
    try { assert.deepEqual(sorted(hidden.session), ['read']); }
    finally { await hidden.close(); }
    const configuration = path.join(agentDir, 'extensions/subagent/config.json');
    fs.mkdirSync(path.dirname(configuration), { recursive: true });
    fs.writeFileSync(configuration, JSON.stringify({ toolActivation: 'dynamic' }));
    const dynamic = await open(sdk.SessionManager.create(cwd, path.join(root, 'dynamic')));
    try { assert.deepEqual(sorted(dynamic.session), ['read', 'subagents_enable']); }
    finally { await dynamic.close(); }
    fs.writeFileSync(configuration, JSON.stringify({ toolActivation: 'eager' }));
    const eager = await open(sdk.SessionManager.create(cwd, path.join(root, 'eager')));
    try { assert.ok(sorted(eager.session).includes('subagent')); assert.ok(!eager.session.getAllTools().some(tool => tool.name === 'subagents_enable')); }
    finally { await eager.close(); fs.rmSync(configuration); }
});
