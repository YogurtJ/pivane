const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
for (const key of Object.keys(process.env).filter(key => /^PI_SUBAGENT(?:_|S_)/.test(key))) delete process.env[key];
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-subagents-078-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('fork cache declares inherited tools while actual child calls retain the exact authorization boundary', async t => {
    const requests = [];
    const provider = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text); requests.push(body);
        const done = body.messages.some(message => message.role === 'tool');
        const delta = done ? { content: 'FORK_AUTHORITY_OK' } : { tool_calls: ['write', 'subagent', 'mcp__fixture__hidden'].map((name, index) => ({ index, id: `denied-${index}`, type: 'function', function: { name,
            arguments: JSON.stringify(name === 'write' ? { path: 'forbidden.txt', content: 'never' } : name === 'subagent' ? { agent: 'worker', task: 'never' } : { value: 'never' }) } })) };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fork', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
            delta: { role: 'assistant', ...delta }, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never', defaultProvider: 'fixture', defaultModel: 'fixture', pivaneBuiltins: { subagents: { extensions: [] } } }));
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{"mcpServers":{}}');
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const sdk = await import('@earendil-works/pi-coding-agent');
    const { default: runtime } = await import('../vendor/pi-subagents/src/runs/shared/subagent-prompt-runtime.js');
    const { default: createFactory } = await import('../server/pi-subagent-child-factory.mjs');
    const parent = sdk.SessionManager.create(cwd, path.join(root, 'parent'));
    const inherited = ['write', 'subagent', 'mcp__fixture__hidden'].map(name => ({ name, description: `Inherited ${name}`, parameters: { type: 'object', additionalProperties: true } }));
    parent.appendMessage({ role: 'system', content: 'PARENT_PREFIX', toolsAdded: inherited, timestamp: Date.now() - 1000 });
    parent.appendMessage({ role: 'user', content: 'Parent prefix', timestamp: Date.now() - 900 });
    parent.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Parent response' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now() - 800,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const fork = sdk.SessionManager.forkFrom(parent.getSessionFile(), cwd, path.join(root, 'fork'));
    const originalFork = fs.readFileSync(fork.getSessionFile(), 'utf8');
    const config = { cwd, agent: 'fixture', forkCacheKey: parent.getSessionId(), waitTool: { enabled: false }, requiredTools: ['read'] };
    const errors = [], factory = createFactory();
    t.after(() => factory.dispose());
    const child = await factory.create({ cwd, projectTrusted: false, parentSessionFile: parent.getSessionFile(), storage: { kind: 'file', sessionFile: fork.getSessionFile() }, model: 'fixture/fixture', tools: ['read'], extensionPaths: [], ambientExtensions: false, noSkills: true, noContextFiles: true, runtime: config,
        hooks: [{ name: 'fork-runtime', factory: pi => runtime(pi, config) }], onExtensionError: error => errors.push(String(error.error)) });
    try {
        await child.prompt('Try each inherited tool, then finish.');
        assert.equal(requests.length, 2);
        for (const name of inherited.map(tool => tool.name)) assert.ok(requests[0].tools.some(tool => tool.function.name === name), `${name} declaration preserved`);
        const denied = child.messages.filter(message => message.role === 'toolResult');
        assert.equal(denied.length, 3);
        assert.deepEqual(denied.map(message => message.toolName), inherited.map(tool => tool.name));
        for (const message of denied) {
            assert.equal(message.isError, true);
            assert.match(JSON.stringify(message.content), /not found|authorized tool allowlist/i);
        }
        assert.equal(requests[1].messages.filter(message => message.role === 'tool').length, 2, 'non-fanout child removes parent-only subagent history from provider context');
        assert.equal(fs.existsSync(path.join(cwd, 'forbidden.txt')), false);
        assert.ok(child.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('FORK_AUTHORITY_OK')));
        assert.deepEqual(errors, []);
        const saved = fs.readFileSync(fork.getSessionFile(), 'utf8');
        assert.ok(saved.startsWith(originalFork), 'inherited native branch bytes are preserved');
        assert.match(saved.slice(originalFork.length), /toolsRemoved/, 'native history records actual child tool removals');
    } finally { await child.dispose(); }
});

test('held parent completion and supervisor messages append results without waking until user resumes', async () => {
    const { createParentWake } = await import('../vendor/pi-subagents/src/shared/parent-wake.js');
    const messages = [], wakes = [], manager = { getSessionId: () => 'synthetic-parent' };
    const wake = createParentWake({ sendMessage: (message, options) => messages.push({ message, options }), sendUserMessage: (...args) => wakes.push(args) });
    wake.bindSession({ sessionManager: manager, isIdle: () => true });
    wake.userAborted();
    for (const customType of ['subagent-notify', 'subagent-supervisor-request']) wake.sendMessage({ customType, content: 'SAVED_RESULT' }, { triggerTurn: true });
    assert.equal(wakes.length, 0);
    assert.deepEqual(messages.map(entry => entry.options), [{ triggerTurn: false }, { triggerTurn: false }]);
    assert.equal(wake.isPending(), false);
    assert.equal(wake.isHeld(), true);
    wake.agentStarted();
    wake.sendMessage({ customType: 'subagent-notify', content: 'NEXT_RESULT' }, { triggerTurn: true });
    assert.equal(wakes.length, 0, 'Pi 1.2+ wakes directly from the extension notice');
    assert.equal(messages.at(-1).options.triggerTurn, true);
    assert.equal(messages.at(-1).message.content, 'NEXT_RESULT');
    assert.equal(wake.isPending(), true);
    wake.sendMessage({ customType: 'subagent-notify', content: 'COALESCED_RESULT' }, { triggerTurn: true });
    assert.equal(wakes.length, 0);
    assert.equal(messages.at(-1).options.triggerTurn, false, 'notices share one pending parent wake');
});

test('timed-out child retains streamed partial output and includes its saved file in completion', async () => {
    const { runChildSession } = await import('../vendor/pi-subagents/src/runs/background/run-child-session.js');
    const { buildCompletionDetails, formatSingleCompletion } = await import('../vendor/pi-subagents/src/runs/background/notify.js');
    const { timedOutRunSummary } = await import('../vendor/pi-subagents/src/runs/shared/partial-output.js');
    let listener, timeout, finishPrompt, disposed = false;
    const child = { messages: [], subscribe: callback => { listener = callback; return () => {}; }, steer: async () => {}, followUp: async () => {}, abort: async () => finishPrompt(), dispose: async () => { disposed = true; },
        prompt: async () => { const finished = new Promise(resolve => { finishPrompt = resolve; }); listener({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'PARTIAL_RESULT_SENTINEL' + 'x'.repeat(3000) }] } }); timeout(); await finished; } };
    const result = await runChildSession({ factory: { create: async () => child }, launch: { session: { ambientExtensions: false, hooks: [], runtime: {} }, config: { agent: 'fixture' }, toolPlan: {}, capture: { finalDrainHeld: () => false } }, prompt: 'Synthetic partial', writeOutputLine: () => {}, appendChildEvent: () => {}, registerTimeout: callback => { timeout = callback; } });
    assert.equal(disposed, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.outputPartial, true);
    assert.match(result.finalOutput, /Partial output before timeout:\nPARTIAL_RESULT_SENTINEL/);
    const summary = timedOutRunSummary('Subagent timed out.', `fixture:\n${result.finalOutput}`, [{ outputPartial: true }]);
    const output = path.join(root, 'partial.md'); fs.writeFileSync(output, result.finalOutput);
    const notice = formatSingleCompletion(buildCompletionDetails({ id: 'partial-run', agent: 'fixture', success: false, timedOut: true, exitCode: 1, summary,
        results: [{ agent: 'fixture', output: result.finalOutput, artifactPaths: { outputPath: output }, outputPartial: true, error: result.error }] }));
    assert.match(notice, /PARTIAL_RESULT_SENTINEL/);
    assert.match(notice, /partial\.md/);
});

test('official cost walks persisted child tool results and de-duplicates run identity', async () => {
    const { collectSubagentCost } = await import('../vendor/pi-subagents/src/slash/subagent-cost.js');
    const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.2, turns: 2 };
    const result = { type: 'message', message: { role: 'toolResult', toolName: 'subagent', details: { mode: 'single', results: [{ agent: 'fixture', runId: 'child-run', usage, sessionFile: '/synthetic/session' }] } } };
    const report = collectSubagentCost({ cwd, sessionManager: { getBranch: () => [result, result], getSessionFile: () => undefined } }, { baseCwd: cwd });
    assert.equal(report.children.length, 1);
    assert.deepEqual(report.childTotal, usage);
    assert.deepEqual(report.total, usage);
});

test('managed RPC abort keeps the parent stopped when its detached child finishes', { timeout: 60000 }, async t => {
    let childResponse, parentResponse, parentRequests = 0;
    const observedRequests = [];
    const provider = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const child = JSON.stringify(body.messages.at(-1)?.content).includes('Return HELD_CHILD_RESULT');
        observedRequests.push({ child, tools: body.tools?.map(tool => tool.function.name) });
        if (child) childResponse = res;
        else if (++parentRequests === 1) parentResponse = res;
        else complete(res, 'USER_RESUMED');
    });
    const complete = (res, content) => res.end(`data: ${JSON.stringify({ id: 'stop', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const { PiSessionStore } = require('../server/pi-session-store');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    t.after(async () => { await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never', defaultProvider: 'fixture', defaultModel: 'fixture' }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(agentDir, 'agents/held.md'), '---\nname: held\ndescription: Synthetic held child\nmodel: fixture/fixture\ntools: read\n---\nReturn a synthetic result.\n');
    fs.writeFileSync(path.join(agentDir, 'extensions/held-launch.ts'), `export default function(pi) { pi.registerCommand('held-launch', {description:'fixture',handler:async(_args,ctx)=>{
        const requestId='held-launch-'+(_args||'first');
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('held launch timeout')),10000);const off=pi.events.on('subagents:rpc:v1:reply:'+requestId,reply=>{clearTimeout(timer);off();ctx.ui.notify('HELD_LAUNCH:'+JSON.stringify(reply));resolve();});
        pi.events.emit('subagents:rpc:v1:request',{version:1,requestId,method:'spawn',source:{extension:'fixture'},params:{agent:'held',task:'Return HELD_CHILD_RESULT',async:true}});});}});}`);
    const saved = await store.createSession(cwd, 'Stopped parent fixture');
    const worker = await supervisor.getWorker({ cwd, sessionPath: saved.path, sessionId: saved.id });
    const waitFor = async predicate => { for (let i = 0; i < 150 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(predicate(), JSON.stringify({ launched, observedRequests })); };
    let launched;
    worker.subscribe(event => { if (event.type === 'extension_ui_request' && event.message?.startsWith('HELD_LAUNCH:')) launched = JSON.parse(event.message.slice(12)); });
    await worker.request('prompt', { message: '/held-launch' });
    await waitFor(() => launched && childResponse);
    assert.equal(launched.success, true, JSON.stringify(launched));
    assert.notEqual(launched.data?.isError, true, JSON.stringify(launched));
    await worker.request('prompt', { message: 'Wait in this parent turn.' });
    await waitFor(() => parentResponse);
    await worker.request('abort');
    await waitFor(() => worker.isIdle());
    assert.equal(parentRequests, 1);
    complete(childResponse, 'HELD_CHILD_RESULT');
    await waitFor(() => fs.readFileSync(saved.path, 'utf8').includes('The user stopped the parent turn.'));
    await waitFor(() => !worker.retainsBackgroundWork());
    assert.equal(parentRequests, 1, 'detached completion appends its notice without a provider request');
    const entries = fs.readFileSync(saved.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(entries.some(entry => entry.type === 'custom_message' && entry.customType === 'subagent-notify' && entry.content.includes('HELD_CHILD_RESULT')));
    assert.ok(worker.isIdle());
    await worker.request('prompt', { message: 'Read the saved result now.' });
    await waitFor(() => parentRequests === 2 && worker.isIdle());

    // A new explicitly launched fixture exercises private controls on an actual
    // detached process, including the retained paused state after interrupt.
    launched = undefined; childResponse = undefined;
    await worker.request('prompt', { message: '/held-launch second' });
    await waitFor(() => launched && childResponse);
    assert.equal(launched.success, true, JSON.stringify(launched));
    let status = await worker.subagentRequest({ method: 'status', params: {} });
    const active = status.snapshot.runs.find(run => run.state === 'running');
    assert.ok(active, JSON.stringify(status));
    await assert.rejects(worker.subagentRequest({ method: 'interrupt', params: { id: 'foreign-run' } }), /No interrupt-capable run found in this session\./);
    status = await worker.subagentRequest({ method: 'status', params: {} });
    assert.equal(status.snapshot.runs.find(run => run.id === active.id)?.state, 'running', 'unknown interrupt never falls back to an unrelated child');
    const steered = await worker.subagentRequest({ method: 'steer', params: { id: active.id, message: 'Synthetic follow-up', mode: 'follow_up' } });
    assert.notEqual(steered.isError, true, JSON.stringify(steered));
    const interrupted = await worker.subagentRequest({ method: 'interrupt', params: { id: active.id } });
    assert.notEqual(interrupted.isError, true, JSON.stringify(interrupted));
    // Paused is a logical state; stop requires the detached runner's actual
    // terminal proof. Observe that proof before the one stop request.
    for (let i = 0; i < 150; i++) {
        status = await worker.subagentRequest({ method: 'status', params: { id: active.id } });
        if (status.snapshot?.runs.find(run => run.id === active.id)?.state === 'paused'
            && /^Process terminal: observed(?:\s|$)/m.test(status.text)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.snapshot?.runs.find(run => run.id === active.id)?.state, 'paused', JSON.stringify(status));
    assert.match(status.text, /^Process terminal: observed(?:\s|$)/m);
    const stopped = await worker.subagentRequest({ method: 'stop', params: { id: active.id } });
    assert.equal(stopped.state, 'stopping', JSON.stringify(stopped));
    for (let i = 0; i < 150; i++) {
        status = await worker.subagentRequest({ method: 'status', params: {} });
        if (status.snapshot?.runs.find(run => run.id === active.id)?.state === 'stopped') break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.snapshot?.runs.find(run => run.id === active.id)?.state, 'stopped', JSON.stringify(status));
    await waitFor(() => worker.isIdle() && !worker.retainsBackgroundWork());
});

test('official activation keeps auto, explicit dynamic and recorded-session selection distinct without launching work', async () => {
    const { registerSubagentToolActivation } = await import('../vendor/pi-subagents/src/extension/tool-activation.js');
    const declaration = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
    const fixture = (mode, messages = [], compat) => {
        const handlers = new Map(), tools = new Map(['read', 'subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait'].map(name => [name, declaration(name)]));
        let active = ['read', 'subagent', 'contact_supervisor'];
        const pi = { registerTool: tool => tools.set(tool.name, tool), getAllTools: () => [...tools.values()], getActiveTools: () => active,
            setActiveTools: names => { active = names; }, on: (event, callback) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(callback); } };
        const ctx = { model: { api: 'openai-completions', compat }, sessionManager: { buildSessionContext: () => ({ messages }) } };
        registerSubagentToolActivation(pi, { mode, advertisedPrompt: async () => '' });
        for (const handler of handlers.get('session_start') || []) handler({}, ctx);
        return { pi, ctx, handlers, tools, active: () => active };
    };
    const auto = fixture('auto');
    const delegationTools = ['subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait'];
    assert.deepEqual(auto.active(), ['read', ...delegationTools]);
    const dynamic = fixture('dynamic');
    assert.deepEqual(dynamic.active(), ['read', 'subagents_enable']);
    const enabled = await dynamic.tools.get('subagents_enable').execute();
    assert.notEqual(enabled.isError, true);
    assert.deepEqual(dynamic.active(), ['read', 'subagents_enable', ...delegationTools]);
    const nativeDynamic = fixture('auto', [], { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true });
    assert.deepEqual(nativeDynamic.active(), ['read', 'subagents_enable']);
    const recorded = fixture('auto', [{ role: 'system', content: '', toolsAdded: ['read', 'subagent', 'contact_supervisor'].map(declaration), timestamp: 1 }]);
    recorded.ctx.model.compat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true };
    for (const handler of recorded.handlers.get('before_agent_start') || []) handler({ systemPromptOptions: {} }, recorded.ctx);
    assert.deepEqual(recorded.active(), ['read', 'subagent', 'contact_supervisor', 'subagent_supervisor'], 'model switching keeps recorded eager tools without adding unrecorded bg_wait');
    const loaderHistory = fixture('auto', [{ role: 'system', content: '', toolsAdded: ['read', 'subagents_enable'].map(declaration), timestamp: 1 }]);
    assert.deepEqual(loaderHistory.active(), ['read', 'subagents_enable'], 'resumed dynamic transcript stays dynamic on a static-tools model');
});
