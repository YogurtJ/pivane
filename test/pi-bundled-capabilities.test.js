const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { catalog, packagePath, memoryBundle } = require('../server/pi-bundled-capabilities');
const { ProfileMemoryConfiguration } = require('../server/profile-memory/config');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-bundled-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
const settingsFile = path.join(agentDir, 'settings.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('vendor inventory is byte-identical upstream and excludes dependency trees', () => {
    const files = require('../scripts/vendor-files.cjs').vendorFiles(path.resolve(__dirname, '..'));
    assert.equal(files.length, 1344);
    assert.equal(files.some(file => file.includes('/node_modules/')), false);
    for (const entry of catalog) assert.ok(files.includes(`${entry.directory}/LICENSE`));
});

test('bundled memory supersedes obsolete paths without rewriting data or executable configuration', async () => {
    const directory = path.join(agentDir, 'pivane-profiles'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'runtime.json');
    const bytes = JSON.stringify({ version: 1, bundlePath: '/old/missing-install/profile-memory-bundle.mjs', reviewModel: { provider: 'fixture', modelId: 'legacy' } });
    fs.writeFileSync(file, bytes);
    const config = new ProfileMemoryConfiguration({ getAgentDir: async () => agentDir });
    assert.equal((await config.snapshot()).bundlePath, memoryBundle());
    assert.equal((await config.snapshot()).capability.installed, true);
    assert.deepEqual((await config.snapshot()).reviewModel, { provider: 'fixture', modelId: 'legacy' });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal((await config.environment(null)).PIVANE_HERMES_BUNDLE, undefined);
});

test('managed inventory preserves legacy filters, respects trust, and saves portable bundled toggles', async () => {
    const { PiNativeService } = require('../server/pi-native-service');
    const { PiResourceService } = require('../server/pi-resource-service');
    const { PiSessionStore } = require('../server/pi-session-store');
    const native = new PiNativeService(new PiSessionStore()), resources = new PiResourceService(native);
    const legacy = { packages: [{ source: 'npm:pi-subagents@0.1.0', skills: [] }, 'npm:pi-hermes-memory@0.9.9'], sentinel: 9 };
    fs.writeFileSync(settingsFile, JSON.stringify(legacy));
    let snapshot = await resources.snapshot(cwd);
    assert.equal(snapshot.packages.length, 1);
    assert.equal(snapshot.packages[0].managedBy, 'pivane');
    assert.equal(snapshot.resources.filter(r => r.type === 'skills' && r.enabled && r.source === packagePath(catalog[0])).length, 0);
    const extension = snapshot.resources.find(r => r.type === 'extensions' && r.source === packagePath(catalog[0]));
    assert.ok(extension.enabled);
    await resources.toggle({ cwd, scope: 'global', expectedRevision: snapshot.revision, resourceId: extension.id, confirmed: true, state: 'off' });
    snapshot = await resources.snapshot(cwd);
    assert.equal(snapshot.resources.find(r => r.id === extension.id).enabled, false);
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(saved.packages, legacy.packages); assert.equal(saved.sentinel, 9);
    assert.deepEqual(saved.pivaneBuiltins.subagents.extensions, ['-index.js']);
    for (const action of ['install', 'update', 'remove']) await assert.rejects(resources.packageAction({ cwd, scope: 'global', action,
        source: packagePath(catalog[0]), confirmed: true, expectedRevision: snapshot.revision }), /Pivane/);
    await resources.toggle({ cwd, scope: 'global', expectedRevision: snapshot.revision, resourceId: extension.id, confirmed: true, state: 'inherit' });
    assert.equal((await resources.snapshot(cwd)).resources.find(r => r.id === extension.id).enabled, true);
    await native.saveTrust({ cwd, expectedRevision: (await native.context(cwd)).revision, decision: true, confirmed: true });
    const toggle = async (scope, state) => {
        const current = await resources.snapshot(cwd);
        const target = current.resources.find(r => r.type === 'extensions' && r.source === packagePath(catalog[0]));
        await resources.toggle({ cwd, scope, expectedRevision: current.revision, resourceId: target.id, confirmed: true, state });
    };
    await toggle('global', 'off'); await toggle('project', 'on');
    assert.equal((await resources.snapshot(cwd)).resources.find(r => r.type === 'extensions').enabled, true);
    await toggle('project', 'inherit'); await toggle('global', 'on');
    assert.equal((await resources.snapshot(cwd)).resources.find(r => r.type === 'extensions').enabled, true, 'restoring inheritance must not leave an implicit blanket exclusion');
});

test('bundled subagent runs against a synthetic provider, with native host controls and no old factory execution', { timeout: 120000 }, async t => {
    let childRequests = 0;
    const provider = http.createServer(async (req, res) => {
        for await (const _chunk of req) { /* synthetic request only */ }
        childRequests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'BUNDLED_CHILD_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const marker = path.join(root, 'old-factory-loaded');
    const oldPackages = catalog.map(entry => {
        const directory = path.join(root, 'old', entry.name); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: entry.name, version: '0.0.1', type: 'module', pi: { extensions: ['./index.js'] } }));
        fs.writeFileSync(path.join(directory, 'index.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); export default () => {};`);
        return directory;
    });
    fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agents/fixture.md'), '---\nname: fixture\ndescription: Synthetic integration child\nmodel: fixture/fixture\ntools: read\n---\nReply with BUNDLED_CHILD_OK.\n');
    const settings = { defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false, defaultProjectTrust: 'never',
        packages: [...oldPackages, 'npm:pi-subagents@0.69.0', 'npm:pi-hermes-memory@0.9.9'], extensions: oldPackages.map(dir => path.join(dir, 'index.js')) };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
        models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    fs.writeFileSync(path.join(agentDir, 'extensions/fixture-spawn.ts'), `export default function(pi) {
        pi.registerCommand('fixture-spawn', { description: 'Synthetic child launch', handler: async (_args, ctx) => {
            const requestId = 'fixture-spawn';
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('spawn timeout')), 30000);
                const off = pi.events.on('subagents:rpc:v1:reply:' + requestId, reply => { clearTimeout(timer); off(); ctx.ui.notify('FIXTURE_SPAWN:' + JSON.stringify(reply)); resolve(); });
                pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'spawn', source: { extension: 'fixture' }, params: { agent: 'fixture', task: 'Reply BUNDLED_CHILD_OK', async: true } });
            });
        } });
        pi.registerCommand('fixture-workflow', { description: 'Synthetic workflow protocol', handler: async (args, ctx) => {
            const requestId = 'fixture-workflow-' + (args === 'old' ? 'old' : 'new');
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('workflow timeout')), 30000);
                const off = pi.events.on('subagents:rpc:v1:reply:' + requestId, reply => { clearTimeout(timer); off(); ctx.ui.notify('FIXTURE_WORKFLOW:' + JSON.stringify(reply)); resolve(); });
                pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'spawn', source: { extension: 'fixture' },
                    params: args === 'old' ? { workflowScript: 'return \"WORKFLOW_RPC_OK\";', async: true } : { script: 'return \"WORKFLOW_RPC_OK\";', async: true } });
            });
        } });
        pi.registerCommand('fixture-foreground', { description: 'Synthetic foreground child', handler: async (_args, ctx) => {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('foreground timeout')), 30000);
                const off = pi.events.on('prompt-template:subagent:response', reply => {
                    if (reply.requestId !== 'fixture-foreground') return;
                    clearTimeout(timer); off(); ctx.ui.notify('FIXTURE_FOREGROUND:' + JSON.stringify(reply)); resolve();
                });
                pi.events.emit('prompt-template:subagent:request', { requestId: 'fixture-foreground', ownerRunId: 'fixture-owner', nodeId: 'fixture-node', cwd: ctx.cwd, agent: 'fixture', task: 'Reply BUNDLED_CHILD_OK', context: 'fresh', result: { kind: 'text' } });
            });
        } });
    }`);
    const { PiSessionStore } = require('../server/pi-session-store');
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
    const store = new PiSessionStore(), supervisor = new PiAgentSupervisor();
    t.after(async () => { await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    const session = await store.createSession(cwd, 'Bundled fixture');
    const worker = await supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
    const resources = await worker.getNativeResources();
    assert.equal(resources.tools.filter(item => item.name === 'subagents_enable').length, 1);
    assert.ok(resources.skills.some(item => item.name === 'pi-subagents'));
    assert.equal(resources.tools.some(item => item.name === 'memory_add'), false);
    assert.equal(fs.existsSync(marker), false);
    let launch;
    const off = worker.subscribe(event => { if (event.type === 'extension_ui_request' && event.message?.startsWith('FIXTURE_SPAWN:')) launch = JSON.parse(event.message.slice(14)); });
    await worker.request('prompt', { message: '/fixture-spawn' });
    for (let i = 0; i < 300 && !launch; i++) await new Promise(resolve => setTimeout(resolve, 100));
    off(); assert.equal(launch?.success, true, JSON.stringify(launch));
    assert.notEqual(launch.data?.isError, true, JSON.stringify(launch));
    let status;
    for (let i = 0; i < 60; i++) {
        status = await worker.subagentRequest({ method: 'status', params: {} });
        if (status.snapshot?.runs.some(run => ['complete', 'failed', 'cancelled'].includes(run.state))) break;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(childRequests > 0, JSON.stringify(status));
    assert.ok(status.snapshot?.runs.some(run => run.state === 'complete'), JSON.stringify(status));
    assert.equal(fs.existsSync(marker), false, 'child tool plan must not execute old factories');
    const cost = await worker.subagentRequest({ method: 'cost' }); assert.ok(cost.cost);
    let foreground;
    const offForeground = worker.subscribe(event => { if (event.type === 'extension_ui_request' && event.message?.startsWith('FIXTURE_FOREGROUND:')) foreground = JSON.parse(event.message.slice(19)); });
    await worker.request('prompt', { message: '/fixture-foreground' });
    for (let i = 0; i < 300 && !foreground; i++) await new Promise(resolve => setTimeout(resolve, 100));
    offForeground(); assert.ok(foreground, 'foreground response');
    assert.match(JSON.stringify(foreground), /BUNDLED_CHILD_OK/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), JSON.stringify(settings));
    for (const legacy of [false, true]) {
        let workflow;
        const offWorkflow = worker.subscribe(event => { if (event.type === 'extension_ui_request' && event.message?.startsWith('FIXTURE_WORKFLOW:')) workflow = JSON.parse(event.message.slice(17)); });
        await worker.request('prompt', { message: '/fixture-workflow' + (legacy ? ' old' : '') });
        for (let i = 0; i < 300 && !workflow; i++) await new Promise(resolve => setTimeout(resolve, 100));
        offWorkflow(); assert.ok(workflow, 'workflow RPC response');
        assert.equal(workflow.success, !legacy, JSON.stringify(workflow));
        if (legacy) assert.match(JSON.stringify(workflow), /workflowScript was removed/);
        else {
            let completed;
            for (let i = 0; i < 100; i++) {
                completed = await worker.subagentRequest({ method: 'status', params: {} });
                if (completed.snapshot?.runs.some(run => run.kind === 'workflow' && ['complete', 'failed'].includes(run.state))) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(completed.snapshot?.runs.some(run => run.kind === 'workflow' && run.state === 'complete'), JSON.stringify(completed));
        }
    }
    for (let i = 0; i < 300 && (!worker.isIdle() || worker.retainsBackgroundWork()); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(worker.isIdle() && !worker.retainsBackgroundWork(), 'completion notifications settled before reload');
    // Native reload must recompute resource filters without restarting or losing
    // the current session. The old package factories remain blocked.
    settings.pivaneBuiltins = { subagents: { extensions: [] } };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    await worker.reloadResources();
    assert.equal((await worker.getNativeResources()).tools.some(item => item.name === 'subagents_enable'), false);
    settings.pivaneBuiltins.subagents.extensions = ['+index.js'];
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    await worker.reloadResources();
    assert.equal((await worker.getNativeResources()).tools.filter(item => item.name === 'subagents_enable').length, 1);
    assert.equal(fs.existsSync(marker), false);
});
