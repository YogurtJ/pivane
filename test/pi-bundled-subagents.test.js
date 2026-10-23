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
    const { factories = [], entry = wrapper, eventBus, ...sessionOptions } = extra;
    const settings = sdk.SettingsManager.create(cwd, agentDir);
    const paths = [entry];
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: paths, extensionFactories: factories, eventBus });
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
        await current.session.reload();
        assert.deepEqual(sorted(current.session), ['read']);
        current.session.setActiveToolsByName(['read', 'subagent', 'subagents_enable']);
        assert.deepEqual(sorted(current.session), ['read', 'subagent', 'subagents_enable'], 'explicit selection after real unload and completed reload restores supported tools');
    } finally { await current.close(); }
    for (const extra of [{ excludeTools: ['subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait', 'subagents_enable'] }, { noTools: 'all' }]) {
        const restricted = await open(sdk.SessionManager.open(fixture.file), extra);
        try { assert.ok(sorted(restricted.session).every(name => !delegation.includes(name) && name !== 'subagents_enable')); }
        finally { await restricted.close(); }
    }
});

test('owned pending supervisor requests retain selected replies without restoring revoked delegation', async () => {
    const { resolveSupervisorChannelDir, ensureSupervisorChannelDir } = await import('../vendor/pi-subagents/src/intercom/native-supervisor-channel.js');
    const { SUBAGENT_ASYNC_STARTED_EVENT } = await import('../vendor/pi-subagents/src/shared/types.js');
    const fixture = await disabledFixture('pending');
    const eventBus = sdk.createEventBus();
    const current = await open(sdk.SessionManager.open(fixture.file), { eventBus });
    const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(predicate()); };
    const request = suffix => {
        const id = 'pending-' + suffix, runId = 'owned-' + suffix;
        const channel = resolveSupervisorChannelDir(runId, 'fixture', 0); ensureSupervisorChannelDir(channel);
        fs.writeFileSync(path.join(channel, 'requests', id + '.json'), JSON.stringify({ type: 'subagent.supervisor.request', id, createdAt: Date.now(), expiresAt: Date.now() + 60000, reason: 'need_decision', message: 'Synthetic owned question', expectsReply: true, runId, agent: 'fixture', childIndex: 0, orchestratorSessionId: current.session.sessionId }));
        // Publish the owned run's lifecycle notification: macOS activates transport
        // on demand, so writing a request alone does not model a launched child.
        eventBus.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: runId, sessionId: current.session.sessionId, agent: 'fixture' });
        return { id, channel };
    };
    try {
        const effects = executions.length;
        const denied = request('revoked');
        await waitFor(() => current.session.messages.some(message => message.customType === 'subagent_supervisor_request' && JSON.stringify(message.details).includes(denied.id)));
        await current.session.waitForIdle();
        assert.equal(current.session.isIdle, true);
        assert.deepEqual(sorted(current.session), ['read']);
        assert.equal(executions.length, effects, 'a pending question executes no tool and grants no delegation');
        fs.rmSync(path.join(denied.channel, 'requests', denied.id + '.json'));
        current.session.setActiveToolsByName(['read', 'subagent_supervisor']);
        const allowed = request('selected');
        await waitFor(() => current.session.messages.some(message => message.customType === 'subagent_supervisor_request' && JSON.stringify(message.details).includes(allowed.id)));
        await current.session.waitForIdle();
        assert.equal(current.session.isIdle, true);
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

test('excluding only the loader keeps fresh delegation available while recorded removals and native restrictions win', async () => {
    const exclusion = { excludeTools: ['subagents_enable'] };
    const effects = executions.length;
    const fresh = await open(sdk.SessionManager.create(cwd, path.join(root, 'loader-excluded')), exclusion);
    try {
        assert.ok(sorted(fresh.session).includes('subagent'), 'fresh default selection exposes delegation when only its loader is excluded');
        assert.equal(fresh.session.getAllTools().some(tool => tool.name === 'subagents_enable'), false, 'excluded loader is unavailable');
        await fresh.session.prompt('Record the loader-excluded default selection without launching work.');
        assert.ok(requests.at(-1).tools.some(tool => tool.function.name === 'subagent'));
        assert.ok(!requests.at(-1).tools.some(tool => tool.function.name === 'subagents_enable'));
        assert.equal(executions.length, effects);
    } finally { await fresh.close(); }
    const fixture = await disabledFixture('loader-excluded-history');
    const resumed = await open(sdk.SessionManager.open(fixture.file), exclusion);
    try {
        assert.deepEqual(sorted(resumed.session), ['read'], 'excluding the loader cannot undo a recorded revocation');
        await resumed.session.reload();
        assert.deepEqual(sorted(resumed.session), ['read']);
        assert.deepEqual(fs.readFileSync(fixture.file), fixture.original);
    } finally { await resumed.close(); }
    for (const extra of [{ ...exclusion, tools: ['read'] }, { ...exclusion, noTools: 'all' }]) {
        const restricted = await open(sdk.SessionManager.create(cwd, path.join(root, 'loader-excluded-restricted')), extra);
        try {
            assert.deepEqual(sorted(restricted.session), extra.noTools ? [] : ['read']);
            assert.equal(restricted.session.getAllTools().some(tool => tool.name === 'subagents_enable'), false);
        } finally { await restricted.close(); }
    }
});

test('persisted cold dynamic selection changes to eager without activating an unselected supervisor', async () => {
    const configuration = path.join(agentDir, 'extensions/subagent/config.json');
    fs.mkdirSync(path.dirname(configuration), { recursive: true });
    const effects = executions.length;
    fs.writeFileSync(configuration, JSON.stringify({ toolActivation: 'dynamic' }));
    const manager = sdk.SessionManager.create(cwd, path.join(root, 'dynamic-to-eager'));
    const cold = await open(manager);
    try {
        assert.deepEqual(sorted(cold.session), ['read', 'subagents_enable']);
        await cold.session.prompt('Persist cold dynamic selection without delegation.');
        const changes = manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'system');
        assert.ok(changes.some(entry => entry.message.toolsAdded?.some(tool => tool.name === 'subagents_enable')));
        assert.ok(changes.every(entry => [...(entry.message.toolsAdded || []), ...(entry.message.toolsRemoved || [])].every(tool => tool.name !== 'subagent')));
    } finally { await cold.close(); }
    const file = manager.getSessionFile(), original = fs.readFileSync(file), count = requests.length;
    fs.writeFileSync(configuration, JSON.stringify({ toolActivation: 'eager' }));
    const eager = await open(sdk.SessionManager.open(file));
    try {
        assert.deepEqual(sorted(eager.session), ['read', 'subagent', 'contact_supervisor', 'bg_wait'].sort());
        assert.equal(eager.session.getAllTools().some(tool => tool.name === 'subagents_enable'), false);
        assert.deepEqual(fs.readFileSync(file), original);
        assert.equal(requests.length, count);
        assert.equal(executions.length, effects);
    } finally { await eager.close(); fs.rmSync(configuration); }
});

const modeConfiguration = path.join(agentDir, 'extensions/subagent/config.json');
const configureMode = mode => {
    fs.mkdirSync(path.dirname(modeConfiguration), { recursive: true });
    fs.writeFileSync(modeConfiguration, JSON.stringify({ toolActivation: mode }));
};
const directDelegation = ['subagent', 'contact_supervisor', 'bg_wait'];
async function modeFixture(mode, state, name) {
    configureMode(mode);
    const manager = sdk.SessionManager.create(cwd, path.join(root, name));
    const current = await open(manager);
    const names = state === 'never-mentioned' ? ['read', ...(mode === 'eager' ? [] : ['subagents_enable'])]
        : ['read', ...directDelegation, ...(state === 'removed' ? ['subagent_supervisor'] : [])];
    current.session.setActiveToolsByName(names);
    await current.session.prompt('Persist the chosen native loadout.');
    if (state === 'removed') {
        current.session.setActiveToolsByName(['read']);
        await current.session.prompt('Persist explicit delegation removal.');
    }
    const changes = manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'system').map(entry => entry.message);
    const mentions = changes.flatMap(message => [...(message.toolsAdded || []), ...(message.toolsRemoved || [])]);
    if (state === 'never-mentioned') assert.ok(mentions.every(tool => tool.name !== 'subagent'));
    if (state === 'active') assert.ok(changes.some(message => message.toolsAdded?.some(tool => tool.name === 'subagent')));
    if (state === 'removed') assert.ok(changes.some(message => message.toolsRemoved?.some(tool => tool.name === 'subagent')));
    return { ...current, manager, original: fs.readFileSync(manager.getSessionFile()) };
}

test('native mode matrix preserves recorded choices and activates only never-mentioned eager defaults', async t => {
    const modes = ['auto', 'dynamic', 'eager'], states = ['never-mentioned', 'active', 'removed'];
    try {
        for (const source of modes) for (const target of modes) for (const state of states) for (const lifecycle of ['reopen', 'reload']) {
            await t.test(`${source} -> ${target}; ${state}; ${lifecycle}`, async () => {
                const fixture = await modeFixture(source, state, `matrix-${source}-${target}-${state}-${lifecycle}`);
                let current = fixture;
                try {
                    const count = requests.length, effects = executions.length;
                    if (lifecycle === 'reopen') {
                        await fixture.close(); configureMode(target);
                        current = await open(sdk.SessionManager.open(fixture.manager.getSessionFile()));
                    } else { configureMode(target); await current.session.reload(); }
                    const eagerDefaults = target === 'eager' && (lifecycle === 'reopen' || source !== 'eager');
                    const expected = state === 'removed' ? ['read'] : state === 'active' || eagerDefaults
                        ? ['read', ...directDelegation] : ['read', ...(source === 'eager' ? [] : ['subagents_enable'])];
                    assert.deepEqual(sorted(current.session), expected.sort());
                    assert.equal(current.session.getAllTools().some(tool => tool.name === 'subagents_enable'), target !== 'eager');
                    assert.equal(sorted(current.session).includes('subagent_supervisor'), false, 'mode changes do not select the reply tool');
                    assert.deepEqual(fs.readFileSync(fixture.manager.getSessionFile()), fixture.original);
                    assert.equal(requests.length, count, 'mode transition makes no provider request');
                    assert.equal(executions.length, effects, 'mode transition executes no tools');
                } finally { await current.close(); }
            });
        }
    } finally { fs.rmSync(modeConfiguration, { force: true }); }
});

test('eager reload preserves completed native selections and conservatively rejects indistinguishable in-reload additions', async () => {
    const fixture = await modeFixture('eager', 'removed', 'reload-authority');
    try {
        await fixture.session.reload({ beforeSessionStart: () => fixture.session.setActiveToolsByName(['read', ...directDelegation]) });
        assert.deepEqual(sorted(fixture.session), ['read'], 'an in-reload callback is not observable authority to reverse the same automatic default additions');
        fixture.session.setActiveToolsByName(['read', ...directDelegation]);
        assert.deepEqual(sorted(fixture.session), ['read', ...directDelegation].sort(), 'selection after reload is explicit and supported');
        await fixture.session.reload();
        assert.deepEqual(sorted(fixture.session), ['read', ...directDelegation].sort(), 'a completed native selection before reload is retained even before a prompt persists it');
        fixture.session.setActiveToolsByName(['read']);
        await fixture.session.reload();
        assert.deepEqual(sorted(fixture.session), ['read'], 'the consumed handoff cannot reuse the previous enabled selection');
        assert.deepEqual(fs.readFileSync(fixture.manager.getSessionFile()), fixture.original);
    } finally { await fixture.close(); fs.rmSync(modeConfiguration, { force: true }); }
});

test('representative native mode transitions retain exclusion, allowlist, hidden and noTools precedence', async t => {
    const hiddenEntry = path.join(root, 'matrix-hidden-subagent.mjs');
    fs.writeFileSync(hiddenEntry, `import bundled from ${JSON.stringify(require('node:url').pathToFileURL(wrapper).href)};export default function(pi){return bundled(new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>pi.registerTool(tool.name==='subagent'?{...tool,exposure:'hidden'}:tool);return Reflect.get(target,key);}}));}`);
    const cases = [
        { name: 'cold dynamic -> eager; loader excluded', source: 'dynamic', target: 'eager', state: 'never-mentioned', extra: { excludeTools: ['subagents_enable'] }, expected: ['read', ...directDelegation] },
        { name: 'active auto -> dynamic; loader excluded', source: 'auto', target: 'dynamic', state: 'active', extra: { excludeTools: ['subagents_enable'] }, expected: ['read', ...directDelegation] },
        { name: 'removed eager -> auto; loader excluded', source: 'eager', target: 'auto', state: 'removed', extra: { excludeTools: ['subagents_enable'] }, expected: ['read'] },
        { name: 'cold dynamic -> eager; read allowlist', source: 'dynamic', target: 'eager', state: 'never-mentioned', extra: { tools: ['read'] }, expected: ['read'] },
        { name: 'active eager -> auto; read allowlist', source: 'eager', target: 'auto', state: 'active', extra: { tools: ['read'] }, expected: ['read'] },
        { name: 'removed auto -> eager; read allowlist', source: 'auto', target: 'eager', state: 'removed', extra: { tools: ['read'] }, expected: ['read'] },
        { name: 'removed dynamic -> eager; explicit subagent allowlist', source: 'dynamic', target: 'eager', state: 'removed', extra: { tools: ['read', 'subagent'] }, expected: ['read', 'subagent'] },
        { name: 'cold dynamic -> eager; hidden subagent', source: 'dynamic', target: 'eager', state: 'never-mentioned', extra: { entry: hiddenEntry }, expected: ['read', 'contact_supervisor', 'bg_wait'] },
        { name: 'active eager -> eager; hidden subagent', source: 'eager', target: 'eager', state: 'active', extra: { entry: hiddenEntry }, expected: ['read', 'contact_supervisor', 'bg_wait'] },
        { name: 'removed auto -> eager; hidden subagent', source: 'auto', target: 'eager', state: 'removed', extra: { entry: hiddenEntry }, expected: ['read'] },
        { name: 'cold dynamic -> eager; noTools', source: 'dynamic', target: 'eager', state: 'never-mentioned', extra: { noTools: 'all' }, expected: [] },
        { name: 'active eager -> auto; noTools', source: 'eager', target: 'auto', state: 'active', extra: { noTools: 'all' }, expected: [] },
        { name: 'removed auto -> eager; noTools', source: 'auto', target: 'eager', state: 'removed', extra: { noTools: 'all' }, expected: [] },
    ];
    try {
        for (const [index, item] of cases.entries()) await t.test(item.name, async () => {
            const fixture = await modeFixture(item.source, item.state, `permissions-${index}`);
            await fixture.close(); configureMode(item.target);
            const current = await open(sdk.SessionManager.open(fixture.manager.getSessionFile()), item.extra);
            try {
                const count = requests.length, effects = executions.length;
                assert.deepEqual(sorted(current.session), [...item.expected].sort());
                await current.session.reload();
                assert.deepEqual(sorted(current.session), [...item.expected].sort());
                assert.deepEqual(fs.readFileSync(fixture.manager.getSessionFile()), fixture.original);
                assert.equal(requests.length, count);
                assert.equal(executions.length, effects);
            } finally { await current.close(); }
        });
    } finally { fs.rmSync(modeConfiguration, { force: true }); }
});

test('recorded supervisor selection remains usable across eager reopen and reload', async () => {
    const fixture = await modeFixture('dynamic', 'active', 'selected-supervisor');
    fixture.session.setActiveToolsByName(['read', ...directDelegation, 'subagent_supervisor']);
    await fixture.session.prompt('Persist explicit supervisor selection.');
    const original = fs.readFileSync(fixture.manager.getSessionFile());
    await fixture.close(); configureMode('eager');
    const current = await open(sdk.SessionManager.open(fixture.manager.getSessionFile()));
    try {
        const expected = ['read', ...directDelegation, 'subagent_supervisor'].sort();
        assert.deepEqual(sorted(current.session), expected);
        await current.session.reload();
        assert.deepEqual(sorted(current.session), expected);
        assert.deepEqual(fs.readFileSync(fixture.manager.getSessionFile()), original);
    } finally { await current.close(); fs.rmSync(modeConfiguration, { force: true }); }
});
