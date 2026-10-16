'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REVIEWED_PI_VERSION } = require('../server/pi-reviewed-host');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-hooks-rpc-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd, path.join(agentDir, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const { PiRpcClient } = require('../server/pi-rpc-client');
const { setPromptSection } = require('../server/pi-hook-prompt');
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownedOrder = ['pivane_task_threads', 'pivane_agent_messages', 'assistant_profile_soul', 'assistant_project_instructions', 'pivane_profile_memory'];
const controlFile = path.join(root, 'hook-control');
const waitFor = async check => {
    const deadline = Date.now() + 15000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Hook RPC fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

// The helper must not flatten the native prompt or inspect the user/custom payload.
test('named hook sections preserve ordering, exact forced prefixes and fresh per-run options', async () => {
    const { normalizeBuildSystemPromptOptions, buildSystemPrompt, diffSystemPromptSections, buildSystemPromptSections } =
        await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js');
    const base = { cwd, customPrompt: 'NATIVE PREFIX', appendSystemPrompt: 'CONFIG ADDENDUM', sections: { existing: 'PREVIOUS EXTENSION' } };
    for (const messageType of ['user', 'custom']) {
        const options = normalizeBuildSystemPromptOptions(base);
        const event = { messageType, systemPromptOptions: options, get systemPrompt() { throw new Error('No flattening'); }, get prompt() { throw new Error('No absent prompt reads'); } };
        setPromptSection(event, 'assistant_profile_soul', 'SOUL');
        setPromptSection(event, 'pivane_profile_memory', 'MEMORY');
        assert.equal(options.forceSystemPrompt, undefined);
        assert.deepEqual(Object.keys(options.sections), ['existing', 'assistant_profile_soul', 'pivane_profile_memory']);
        const rendered = buildSystemPrompt(options);
        assert.match(rendered, /^NATIVE PREFIX/);
        assert.ok(rendered.indexOf('CONFIG ADDENDUM') < rendered.indexOf('PREVIOUS EXTENSION'));
        assert.ok(rendered.indexOf('<assistant_profile_soul>') < rendered.indexOf('<pivane_profile_memory>'));
        setPromptSection(event, 'pivane_profile_memory', 'MEMORY');
        assert.equal(buildSystemPrompt(options), rendered, 'named assignment cannot accumulate on repeated invocation');
        const next = normalizeBuildSystemPromptOptions(base);
        setPromptSection({ systemPromptOptions: next }, 'assistant_profile_soul', 'SOUL');
        setPromptSection({ systemPromptOptions: next }, 'pivane_profile_memory', 'MEMORY');
        assert.equal(diffSystemPromptSections(buildSystemPromptSections(options), buildSystemPromptSections(next)), undefined);
        options.forceSystemPrompt = 'EXACT FORCED PREFIX';
        setPromptSection(event, 'assistant_project_instructions', 'PROJECT', { wrapForced: true });
        setPromptSection(event, 'pivane_agent_messages', 'PERMISSION GUIDE');
        assert.equal(buildSystemPrompt(options), 'EXACT FORCED PREFIX\n\n<assistant_project_instructions>\nPROJECT\n</assistant_project_instructions>\n\nPERMISSION GUIDE');
    }
    assert.deepEqual(base.sections, { existing: 'PREVIOUS EXTENSION' });
});

test('provenance, speed and side permission hooks handle custom wakes without reading a user prompt', async () => {
    const dir = path.join(root, 'state-hooks'); fs.mkdirSync(dir);
    const branch = [], handlers = new Map();
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture: { models: [{ id: 'model', pivaneSpeed: {
        defaultLevel: 'fast', modes: { fast: { serviceTier: 'priority', costMultiplier: 2 } } } }] } } }));
    const { registerModelSpeed } = await import('../server/pi-model-speed-extension.mjs');
    const speed = registerModelSpeed({ on: (name, fn) => handlers.set(name, fn), appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }) }, { agentDir: dir });
    let idle = true;
    const ctx = { model: { provider: 'fixture', id: 'model', api: 'openai-completions' }, sessionManager: { getBranch: () => branch },
        isIdle: () => idle, hasPendingMessages: () => false };
    handlers.get('session_start')({}, ctx);
    const custom = { messageType: 'custom', message: { customType: 'fixture', content: 'wake' },
        get prompt() { throw new Error('Custom events have no prompt'); }, systemPromptOptions: { skills: [{ name: 'synthetic', filePath: path.join(cwd, 'SKILL.md') }] } };
    handlers.get('before_agent_start')(custom, ctx);
    handlers.get('before_agent_start')(custom, ctx);
    assert.equal(branch.length, 1, 'speed selection is persisted once');
    assert.equal(handlers.get('before_provider_request')({ payload: {} }, ctx).service_tier, 'priority');
    idle = false;
    assert.throws(() => speed.control(ctx, { ...speed.snapshot(ctx), level: 'standard' }), /等待/);
    const token = process.env.PI_WEB_NAVIGATION_TOKEN; process.env.PI_WEB_NAVIGATION_TOKEN = 'synthetic';
    try {
        const provenance = new Map();
        require('../server/pi-tool-provenance').registerToolProvenance({ on: (name, fn) => provenance.set(name, fn),
            getAllTools: () => [{ name: 'read', sourceInfo: { source: 'builtin' } }] });
        provenance.get('before_agent_start')(custom);
        const call = { toolName: 'read', toolCallId: 'synthetic-read', input: { path: 'SKILL.md' } };
        provenance.get('tool_call')(call, { mode: 'rpc', cwd });
        assert.equal(provenance.get('tool_result')(call).details.pivaneToolProvenance.skill.name, 'synthetic');
    } finally { if (token === undefined) delete process.env.PI_WEB_NAVIGATION_TOKEN; else process.env.PI_WEB_NAVIGATION_TOKEN = token; }
    const gate = new Map();
    require('../server/pi-side-tools').sideToolGate({ on: (name, fn) => gate.set(name, fn) });
    let confirms = 0, allow = true;
    const sideCtx = { cwd, hasUI: true, ui: { setStatus() {}, confirm: async () => { confirms++; return allow; } } };
    const write = () => gate.get('tool_call')({ toolName: 'write', input: { path: 'synthetic', content: 'fixture' } }, sideCtx);
    gate.get('before_agent_start')({ messageType: 'user', prompt: 'Authorized fixture' }, sideCtx);
    assert.equal(await write(), undefined); assert.equal(confirms, 1);
    gate.get('before_agent_start')(custom, sideCtx); allow = false;
    assert.equal((await write()).block, true); assert.equal(confirms, 2, 'custom wake cannot inherit the earlier write grant');
    assert.equal((await write()).block, true); assert.equal(confirms, 2, 'decline is not retried');
});

test('reviewed Pi native RPC preserves owned hook payloads across task/message/cron wakes, tools, nextTurn, slow queueing and cancellation', { timeout: 90000 }, async t => {
    assert.ok(bundle, 'runner supplies the reviewed memory bundle');
    const sdk = await import('@earendil-works/pi-coding-agent');
    assert.equal(sdk.VERSION, REVIEWED_PI_VERSION);
    assert.equal(fs.realpathSync.native(sdk.getPackageDir()), fs.realpathSync.native(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent')));
    const calls = [], clients = [];
    let switchTools = false;
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); calls.push(body);
        const tool = switchTools; switchTools = false;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
            delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'loadout-fixture', type: 'function', function: { name: 'fixture_switch', arguments: '{}' } }] }
                : { role: 'assistant', content: 'FIXTURE DONE' }, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    t.after(async () => {
        for (const client of clients) await client.dispose();
        provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'PHYSICAL PROJECT SCOPE: preserve existing files and permissions.');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
        defaultThinkingLevel: 'off', defaultProjectTrust: 'always', enableInstallTelemetry: false, compaction: { enabled: false } }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
        models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const profile = { id: profileId, name: 'Synthetic', description: '', soul: 'SOUL SCOPE: respect saved authorization.', enabled: true,
        memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: false } };
    const project = { id: projectId, name: 'Synthetic project', description: '', cwd, instructions: 'LOGICAL PROJECT SCOPE: write only owned files.',
        profileIds: [profileId], archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const profileRoot = path.join(agentDir, 'pivane-profiles', 'data', profileId);
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, '.profile-root'), '');
    fs.writeFileSync(path.join(agentDir, 'pivane-profiles', 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile], defaults: {} }));
    fs.writeFileSync(path.join(agentDir, 'pivane-profiles', 'assistant-projects.json'), JSON.stringify({ version: 1, projects: [project] }));
    // Seed through the document/index transaction before opening a worker.
    const content = 'MEMORY SCOPE: synthetic durable fact.';
    const index = await require('../server/profile-memory/document-index').documentIndex(profileRoot, 'memory', bundle, null, content);
    try { index.mark(); fs.writeFileSync(path.join(profileRoot, 'MEMORY.md'), content); index.sync(); } finally { index.close(); }
    const makeSession = (kind) => {
        const initial = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions'));
        fs.writeFileSync(initial.getSessionFile(), '', { flag: 'wx', mode: 0o600 });
        const manager = sdk.SessionManager.open(initial.getSessionFile(), undefined, cwd);
        const sessionId = manager.getSessionId();
        manager.appendCustomEntry('pivane-agent-profile', { version: 1, sessionId, profileId: kind === 'task' ? profileId : null });
        if (kind === 'task') {
            manager.appendCustomEntry('pivane-assistant-project', { version: 1, sessionId, cwd, projectId });
            manager.appendCustomEntry('pivane-agent-task', { version: 1, sessionId, requestId: 'fixture-task', source: { sessionId: 'synthetic-source', cwd } });
            manager.appendCustomMessageEntry('pivane-agent-task-message', 'SAVED TASK SCOPE: synthetic task, no external changes.', true);
        } else if (kind === 'authoring') manager.appendCustomEntry('pivane-profile-authoring', { version: 1, sessionId, profileId: null, profileRevision: null, language: 'en' });
        else manager.appendCustomEntry('pivane-extension-assistant', { version: 1, sessionId, scope: 'project', language: 'en' });
        return manager;
    };
    const start = async kind => {
        const manager = makeSession(kind), sessionId = manager.getSessionId(), sessionPath = manager.getSessionFile();
        const profileContext = { version: 1, profileId, sessionId, sessionPath, cwd, profileRoot, sessionsRoot: path.join(agentDir, 'sessions'),
            memory: { enabled: true, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: false } };
        const client = new PiRpcClient({ cwd, sessionPath, extraArgs: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
            '-e', path.join(__dirname, 'fixtures/pi-hooks-extension.ts')], projectApproval: true,
            env: { PI_WEB_NAVIGATION_TOKEN: 'synthetic', PI_WORKSPACE_INTERNAL_ORIGIN: 'http://127.0.0.1:1',
                PIVANE_HOOK_FIXTURE_CONTROL: controlFile, PIVANE_HERMES_BUNDLE: kind === 'task' ? bundle : undefined,
                PIVANE_AGENT_PROFILE_CONTEXT: kind === 'task' ? JSON.stringify(profileContext) : undefined,
                PIVANE_ASSISTANT_PROJECT_CONTEXT: kind === 'task' ? JSON.stringify({ version: 1, projectId, sessionId, sessionPath, cwd,
                    revision: require('../server/pi-assistant-project-registry').projectRevision(project), instructions: project.instructions }) : undefined,
                PIVANE_PROFILE_AUTHORING_CONTEXT: kind === 'authoring' ? JSON.stringify({ version: 1, sessionId, sessionPath, cwd, profileId: null, profileRevision: null }) : undefined } });
        clients.push(client);
        const events = [], starts = [];
        client.on('event', event => {
            events.push(event);
            if (event.type === 'extension_ui_request' && event.method === 'notify') {
                try { const data = JSON.parse(event.message); if (data.hookFixture === 'start') starts.push(data); } catch {}
            }
        });
        await client.start();
        return { client, manager, events, starts };
    };
    const command = (target, input) => target.client.request('prompt', { message: '/hook_fixture ' + JSON.stringify(input) });
    const settled = target => target.events.filter(event => event.type === 'agent_settled').length;
    const run = async (target, submit) => {
        const count = settled(target), before = calls.length;
        await submit(); await waitFor(() => settled(target) > count);
        assert.equal(target.starts.at(-1).version, REVIEWED_PI_VERSION);
        assert.equal(target.events.filter(event => event.type === 'extension_error').length, 0, JSON.stringify(target.events));
        return calls.slice(before);
    };
    const target = await start('task');
    let payloads = await run(target, () => command(target, { action: 'task', requestId: 'fixture-task' }));
    assert.equal(target.starts.at(-1).customType, 'pivane-agent-task-start');
    assert.deepEqual(target.starts.at(-1).sections, ownedOrder);
    assert.equal(target.starts.at(-1).forced, false);
    assert.match(JSON.stringify(payloads), /SAVED TASK SCOPE/);
    const checkPayloads = payloads => {
        for (const request of payloads) {
            const text = JSON.stringify(request.messages);
            for (const marker of ['SOUL SCOPE:', 'LOGICAL PROJECT SCOPE:', 'MEMORY SCOPE:', 'Pivane task threads:', 'Pivane Agent messages:'])
                assert.equal(text.split(marker).length - 1, 1, `${marker} must appear once per provider payload`);
            assert.match(text, /PHYSICAL PROJECT SCOPE/);
            assert.ok(text.indexOf('PHYSICAL PROJECT SCOPE') < text.indexOf('Pivane task threads:'));
            assert.ok(text.indexOf('Pivane task threads:') < text.indexOf('Pivane Agent messages:'));
            assert.ok(text.indexOf('SOUL SCOPE:') < text.indexOf('LOGICAL PROJECT SCOPE:'));
            assert.ok(text.indexOf('LOGICAL PROJECT SCOPE:') < text.indexOf('MEMORY SCOPE:'));
        }
    };
    checkPayloads(payloads);
    switchTools = true;
    payloads = await run(target, () => target.client.request('prompt', { message: 'Exercise a tool loadout change.' }));
    assert.equal(payloads.length, 2);
    assert.ok(payloads[0].tools.some(tool => tool.function.name === 'read'));
    assert.equal(payloads[1].tools.some(tool => tool.function.name === 'read'), false);
    checkPayloads(payloads);
    await command(target, { action: 'nextTurn' });
    // Native pendingMessageCount covers steering/follow-up, not nextTurn custom context.
    payloads = await run(target, () => command(target, { action: 'custom', text: 'Consume nextTurn context in a custom wake.' }));
    assert.match(JSON.stringify(payloads), /NEXT TURN CONTEXT/); checkPayloads(payloads);
    const record = { version: 1, messageId: 'c'.repeat(64), conversationId: 'd'.repeat(64), requestId: 'synthetic-message',
        from: { sessionId: 'synthetic-sender', cwd, name: 'Synthetic' }, to: { sessionId: target.manager.getSessionId(), cwd, name: '' },
        text: 'AGENT MESSAGE SCOPE: retain recipient permissions.', wake: true, hop: 0, replyTo: null, sentAt: new Date().toISOString() };
    payloads = await run(target, () => command(target, { action: 'wake', messages: [record] }));
    assert.equal(target.starts.at(-1).customType, 'pivane-agent-message-wake');
    assert.match(JSON.stringify(payloads), /AGENT MESSAGE SCOPE/); checkPayloads(payloads);
    const cronInput = { action: 'start', runId: 'e'.repeat(64), sessionId: target.manager.getSessionId(), name: 'Synthetic cron',
        scheduledAt: Date.now(), timeZone: 'UTC', prompt: 'CRON SAVED SCOPE: finish without external calls.', mode: 'text', maxCalls: 3,
        maxTokens: 10000, maxDurationSeconds: 30, profile: { id: profileId, revision: require('../server/pi-profile-registry').profileRevision(profile) } };
    payloads = await run(target, () => command(target, { action: 'cron', input: cronInput }));
    assert.equal(target.starts.at(-1).customType, 'pivane-cron-message');
    assert.deepEqual(target.starts.at(-1).sections, ['pivane_scheduled_task', ...ownedOrder]);
    assert.ok(payloads[0].tools.every(tool => tool.function.name === 'cron_silent'));
    assert.match(JSON.stringify(payloads), /does not|Do not create other tasks/); checkPayloads(payloads);
    await command(target, { action: 'cron', input: { action: 'finish', runId: cronInput.runId } });
    payloads = await run(target, () => target.client.request('prompt', { message: 'Ordinary turn after cron.' }));
    assert.deepEqual(target.starts.at(-1).sections, ownedOrder); checkPayloads(payloads);
    fs.writeFileSync(controlFile + '.force', '');
    payloads = await run(target, () => command(target, { action: 'custom', text: 'Forced custom wake.' }));
    assert.equal(target.starts.at(-1).forced, true);
    assert.ok(payloads[0].messages[0].content.startsWith('EXACT FORCED PREFIX\n\nPivane task threads:'));
    assert.match(payloads[0].messages[0].content, /<assistant_profile_soul>\nSOUL SCOPE:/);
    const forcedText = payloads[0].messages[0].content;
    payloads = await run(target, () => command(target, { action: 'custom', text: 'Repeat forced custom wake.' }));
    assert.equal(payloads[0].messages[0].content, forcedText, 'forced suffixes do not accumulate across runs');
    fs.unlinkSync(controlFile + '.force');
    // A custom wake queued during a slow hook belongs to the same native run.
    fs.writeFileSync(controlFile, '');
    const startsBefore = target.starts.length, settledBefore = settled(target);
    await command(target, { action: 'custom', text: 'SLOW WAKE' });
    await waitFor(() => target.starts.length > startsBefore);
    assert.equal((await target.client.request('get_state')).isStreaming, true);
    await command(target, { action: 'custom', text: 'QUEUED DURING HOOK' });
    assert.equal(target.starts.length, startsBefore + 1, 'busy startup cannot start a second hook');
    await target.client.request('follow_up', { message: 'USER QUEUED DURING HOOK' });
    assert.equal((await target.client.request('get_state')).pendingMessageCount, 1);
    const beforeSlowCalls = calls.length;
    fs.unlinkSync(controlFile); await waitFor(() => settled(target) > settledBefore);
    checkPayloads(calls.slice(beforeSlowCalls));
    assert.match(JSON.stringify(calls.slice(beforeSlowCalls)), /QUEUED DURING HOOK/);
    assert.match(JSON.stringify(calls.slice(beforeSlowCalls)), /USER QUEUED DURING HOOK/);
    assert.equal(target.starts.length, startsBefore + 1);
    // Abort reserves cancellation while the hook is still pending; no request may escape.
    fs.writeFileSync(controlFile, '');
    const cancelStarts = target.starts.length, cancelSettled = settled(target), beforeCancelCalls = calls.length;
    await command(target, { action: 'custom', text: 'CANCEL DURING HOOK' });
    await waitFor(() => target.starts.length > cancelStarts);
    let abortCompleted = false;
    const abort = target.client.request('abort').then(() => { abortCompleted = true; });
    assert.equal((await target.client.request('get_state')).isStreaming, true);
    assert.equal(abortCompleted, false, 'abort waits for the slow hook/run to settle');
    fs.unlinkSync(controlFile); await abort; await waitFor(() => settled(target) > cancelSettled);
    assert.equal(calls.length, beforeCancelCalls, 'cancelling startup never calls the provider');
    assert.equal(target.events.filter(event => event.type === 'agent_settled').at(-1).aborted, true);
    assert.equal((await target.client.request('get_state')).isStreaming, false);
    const authoring = await start('authoring');
    payloads = await run(authoring, () => command(authoring, { action: 'custom', text: 'Draft custom wake.' }));
    assert.ok(authoring.starts.at(-1).sections.includes('pivane_profile_authoring'));
    assert.match(JSON.stringify(payloads), /No profile files, settings or credentials may be changed/);
    assert.equal(authoring.starts.at(-1).sections.includes('assistant_profile_soul'), false);
    const assistant = await start('assistant');
    payloads = await run(assistant, () => command(assistant, { action: 'custom', text: 'Assistant custom wake.' }));
    assert.equal(assistant.starts.at(-1).sections[0], 'pivane_extension_assistant');
    assert.match(JSON.stringify(payloads), /Do not bypass its rejection via the shell/);
    assert.equal(assistant.starts.at(-1).sections.includes('assistant_profile_soul'), false);
    assert.equal(calls.some(body => JSON.stringify(body).includes('/srv/pivane/')), false, 'metadata must stay on the isolated Pi package');
    if (process.env.PI_HOOK_TEST_EVIDENCE) fs.writeFileSync(process.env.PI_HOOK_TEST_EVIDENCE, JSON.stringify({
        piVersion: sdk.VERSION, piPackageDir: sdk.getPackageDir(), starts: clients.map((client, index) => ({
            kind: ['task', 'authoring', 'assistant'][index], starts: [target, authoring, assistant][index].starts })),
        payloads: calls.map(body => ({ tools: body.tools.map(tool => tool.function.name), messages: body.messages })),
        assertions: ['one owned block per ordinary provider payload', 'physical project then task/messages/SOUL/project/memory order',
            'native sections survive tool loadout changes and nextTurn custom wakes', 'cron restrictions and profile revision preserved',
            'forced prefix/suffix stable across repeated wakes', 'slow custom wake is busy and queued messages join its run',
            'abort during slow startup stays busy until settlement and makes zero provider calls'],
    }, null, 2) + '\n');
});
