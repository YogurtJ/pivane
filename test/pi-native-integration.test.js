const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-integration-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
delete process.env.PI_WEB_APPROVE_PROJECTS;
const cwd = path.join(root, 'project');
fs.mkdirSync(path.join(root, 'agent/extensions'), { recursive: true });
fs.mkdirSync(path.join(cwd, '.pi/prompts'), { recursive: true });
fs.mkdirSync(path.join(cwd, '.pi/skills/audit-skill'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.pi/prompts/audit-prompt.md'), '---\ndescription: Fixture\n---\nFixture');
fs.writeFileSync(path.join(cwd, '.pi/skills/audit-skill/SKILL.md'), '---\nname: audit-skill\ndescription: Fixture\n---\nFixture');
fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'PRIVATE_CONTEXT_SENTINEL');
fs.writeFileSync(path.join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'ask', enableInstallTelemetry: false }));
fs.writeFileSync(path.join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'synthetic-fixture', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
const { PiSessionStore } = require('../server/pi-session-store');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const store = new PiSessionStore();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('managed native extension commands cannot replace the session behind Supervisor', { timeout: 60000 }, async () => {
    const source = await store.createSession(cwd, 'source');
    const target = await store.createSession(cwd, 'target');
    fs.writeFileSync(path.join(root, 'agent/extensions/fixture.ts'), `export default function(pi) {
        pi.registerCommand('fixture-switch', { handler: async (_args, ctx) => { await ctx.switchSession(${JSON.stringify(target.path)}); } });
        pi.registerCommand('fixture-new', { handler: async (_args, ctx) => { await ctx.newSession(); } });
        pi.registerCommand('fixture-tree', { handler: async (_args, ctx) => { await ctx.navigateTree(ctx.sessionManager.getEntries()[0].id, { summarize: false }); } });
        pi.registerCommand('fixture-clone', { handler: async (_args, ctx) => { await ctx.fork(ctx.sessionManager.getLeafId(), { position: 'at' }); } });
    }`);
    const supervisor = new PiAgentSupervisor();
    try {
        const worker = await supervisor.getWorker({ cwd, sessionPath: source.path, sessionId: source.id });
        const events = []; worker.subscribe(e => events.push(e));
        const leaf = (await worker.request('get_entries')).leafId;
        for (const command of ['fixture-switch', 'fixture-new', 'fixture-clone', 'fixture-tree']) {
            await worker.request('prompt', { message: '/' + command });
            const state = await worker.request('get_state');
            assert.equal(state.sessionFile, source.path, command + ' must preserve native identity');
            assert.equal(state.sessionId, source.id);
            assert.equal((await worker.request('get_entries')).leafId, leaf, 'unmanaged navigation must not change leaf');
        }
        assert.equal(supervisor.workers.size, 1);
        assert.equal((await store.listSessions(cwd)).length, 2);
        assert.ok(events.some(e => e.method === 'notify' && /网页/.test(e.message)));
        const ephemeral = await supervisor.createEphemeralWorker(cwd);
        await ephemeral.request('prompt', { message: '/fixture-switch' });
        assert.equal((await ephemeral.request('get_state')).sessionFile, undefined);
    } finally { await supervisor.dispose(); }
});

test('runtime resource inventory is native metadata and follows trust only on the next worker', { timeout: 60000 }, async () => {
    const supervisor = new PiAgentSupervisor();
    const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent');
    try {
        let worker = await supervisor.createEphemeralWorker(cwd);
        const publicEvents = []; worker.subscribe(event => publicEvents.push(event));
        let inventory = await worker.getNativeResources();
        worker.client.emit('event', { type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ pi5Resources: 'late-unknown', data: 'PRIVATE_RESOURCE_SENTINEL' }) });
        assert.doesNotMatch(JSON.stringify(publicEvents), /pi5Resources|PRIVATE_RESOURCE_SENTINEL|PRIVATE_CONTEXT_SENTINEL/);
        assert.equal(inventory.projectTrusted, false);
        assert.ok(inventory.contextFiles.some(f => f.path === path.join(cwd, 'AGENTS.md')));
        assert.equal(inventory.skills.some(s => s.name === 'audit-skill'), false);
        const { PiSettingsService } = require('../server/pi-settings-service');
        const discovered = await new PiSettingsService({ cwd }).getResourceSnapshot(cwd);
        assert.equal(discovered.skills.some(s => s.name === 'audit-skill'), false, 'settings must honor the same project trust decision');
        assert.doesNotMatch(JSON.stringify(inventory), /PRIVATE_CONTEXT_SENTINEL|synthetic-fixture|pi5-web-navigate/);
        new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR).set(cwd, true);
        assert.equal((await worker.getNativeResources()).projectTrusted, false);
        await worker.dispose();
        worker = await supervisor.createEphemeralWorker(cwd);
        inventory = await worker.getNativeResources();
        assert.equal(inventory.projectTrusted, true);
        assert.ok(inventory.skills.some(s => s.name === 'audit-skill'));
        assert.ok(inventory.commands.some(s => s.name === 'audit-prompt'));
        assert.ok(inventory.tools.some(s => s.name === 'read' && s.active));
    } finally {
        new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR).set(cwd, null);
        await supervisor.dispose();
    }
});

test('native settings preserve scope, reject stale writes, and expose no private settings', async () => {
    const { PiNativeService } = require('../server/pi-native-service');
    const service = new PiNativeService(store);
    let snapshot = await service.snapshot(cwd);
    assert.equal(snapshot.trust.effective, false);
    await assert.rejects(service.saveSettings({ cwd, scope: 'project', values: { steeringMode: 'all' }, expectedRevision: snapshot.revision }), /信任/);
    await service.saveTrust({ cwd, decision: true, confirmed: true, expectedRevision: snapshot.revision });
    snapshot = await service.snapshot(cwd);
    await service.saveSettings({ cwd, scope: 'project', values: { steeringMode: 'all', 'compaction.reserveTokens': 8192 }, expectedRevision: snapshot.revision });
    await assert.rejects(service.saveSettings({ cwd, scope: 'global', values: { steeringMode: 'all' }, expectedRevision: snapshot.revision }), /变化/);
    snapshot = await service.snapshot(cwd);
    assert.equal(snapshot.settings.steeringMode.value, 'all');
    assert.equal(snapshot.settings.steeringMode.source, 'project');
    assert.equal(snapshot.settings['compaction.reserveTokens'].value, 8192);
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-fixture|defaultProvider|PRIVATE_CONTEXT/);
    await service.saveSettings({ cwd, scope: 'project', values: { steeringMode: null }, expectedRevision: snapshot.revision });
    snapshot = await service.snapshot(cwd);
    assert.notEqual(snapshot.settings.steeringMode.source, 'project');
    await assert.rejects(service.saveSettings({ cwd, scope: 'global', values: { shellPath: '/tmp/x' }, expectedRevision: snapshot.revision }), /设置/);
    await assert.rejects(service.saveSettings({ cwd, scope: 'global', values: { 'retry.maxRetries': -1 }, expectedRevision: snapshot.revision }), /设置/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'agent/settings.json'))).defaultProvider, 'fixture');
    require('./private-file-helper.cjs').assertPrivateFile(path.join(cwd, '.pi/settings.json'));
    await assert.rejects(service.snapshot('/etc'));
});

test('native resource filters preserve sibling resources and project overrides; revisions reject stale writes', async () => {
    const { PiNativeService } = require('../server/pi-native-service');
    const { PiResourceService } = require('../server/pi-resource-service');
    const native = new PiNativeService(store), service = new PiResourceService(native);
    const initial = await native.snapshot(cwd);
    if (!initial.trust.effective) await native.saveTrust({ cwd, decision: true, confirmed: true, expectedRevision: initial.revision });
    const pkg = path.join(root, 'package'); fs.mkdirSync(path.join(pkg, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-package', pi: { prompts: ['prompts'] } }));
    for (const n of ['one', 'two']) fs.writeFileSync(path.join(pkg, 'prompts', n + '.md'), 'Fixture ' + n);
    let snap = await service.snapshot(cwd, 'global');
    await service.packageAction({ cwd, scope: 'global', action: 'install', source: pkg, confirmed: true, expectedRevision: snap.revision });
    snap = await service.snapshot(cwd, 'global');
    const named = name => r => path.basename(r.path) === name;
    const one = snap.resources.find(named('one.md'));
    assert.ok(one);
    await service.toggle({ cwd, scope: 'global', resourceId: one.id, state: 'off', confirmed: true, expectedRevision: snap.revision });
    await assert.rejects(service.toggle({ cwd, scope: 'global', resourceId: one.id, state: 'on', confirmed: true, expectedRevision: snap.revision }), /变化/);
    snap = await service.snapshot(cwd, 'global');
    assert.equal(snap.resources.find(named('one.md')).enabled, false);
    assert.equal(snap.resources.find(named('two.md')).enabled, true);
    snap = await service.snapshot(cwd, 'project');
    await service.toggle({ cwd, scope: 'project', resourceId: snap.resources.find(named('one.md')).id, state: 'on', confirmed: true, expectedRevision: snap.revision });
    snap = await service.snapshot(cwd, 'project');
    assert.equal(snap.resources.find(named('one.md')).enabled, true);
    await service.toggle({ cwd, scope: 'project', resourceId: snap.resources.find(named('one.md')).id, state: 'inherit', confirmed: true, expectedRevision: snap.revision });
    snap = await service.snapshot(cwd, 'project');
    assert.equal(snap.resources.find(named('one.md')).enabled, false);
    const skill = await service.readSkill({ cwd, scope: 'project', name: 'audit-skill' });
    await service.saveSkill({ cwd, scope: 'project', name: 'audit-skill', content: skill.content + '\nNew line', expectedRevision: skill.revision, confirmed: true });
    await assert.rejects(service.saveSkill({ cwd, scope: 'project', name: 'audit-skill', content: skill.content, expectedRevision: skill.revision, confirmed: true }), /变化/);
    assert.ok((await service.readSkill({ cwd, scope: 'project', name: 'audit-skill' })).content.endsWith('New line'));
});

test('Skills can be disabled and restored through native filters without deleting files or changing sibling resources', async () => {
    const { PiNativeService } = require('../server/pi-native-service');
    const { PiResourceService } = require('../server/pi-resource-service');
    const { PiSettingsService } = require('../server/pi-settings-service');
    const native = new PiNativeService(store), service = new PiResourceService(native);
    const trust = await native.snapshot(cwd);
    if (!trust.trust.effective) await native.saveTrust({ cwd, decision: true, confirmed: true, expectedRevision: trust.revision });
    const dir = path.join(root, 'agent/skills/ux-local'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md'), text = '---\nname: ux-local\ndescription: UX local fixture\n---\nKeep these instructions.\n';
    fs.writeFileSync(file, text); fs.writeFileSync(path.join(dir, 'helper.txt'), 'Keep this asset.');
    const pkg = path.join(root, 'ux-package'), pkgFile = path.join(pkg, 'skills/ux-package/SKILL.md'); fs.mkdirSync(path.dirname(pkgFile), { recursive: true });
    fs.writeFileSync(pkgFile, '---\nname: ux-package\ndescription: Package fixture\n---\nPackage instructions.\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ux-package', pi: { skills: ['skills'] } }));
    let snap = await service.snapshot(cwd, 'global');
    await service.packageAction({ cwd, scope: 'global', action: 'install', source: pkg, confirmed: true, expectedRevision: snap.revision });
    async function toggle(file, scope, state) {
        snap = await service.snapshot(cwd, scope); const resource = snap.resources.find(r => r.type === 'skills' && r.path === file); assert.ok(resource);
        await service.toggle({ cwd, scope, resourceId: resource.id, state, confirmed: true, expectedRevision: snap.revision });
        return service.snapshot(cwd, scope);
    }
    snap = await toggle(file, 'global', 'off');
    assert.equal(snap.resources.find(r => r.path === file).enabled, false);
    assert.equal(snap.resources.find(r => r.path === pkgFile).enabled, true);
    const settings = new PiSettingsService({ cwd });
    assert.ok(!(await settings.getResourceSnapshot(cwd)).skills.some(s => s.filePath === file), 'disabled Skill is absent from native discovered active Skills');
    snap = await toggle(file, 'global', 'on'); assert.equal(snap.resources.find(r => r.path === file).enabled, true);
    assert.ok((await settings.getResourceSnapshot(cwd)).skills.some(s => s.filePath === file));
    snap = await toggle(pkgFile, 'project', 'off'); assert.equal(snap.resources.find(r => r.path === pkgFile).enabled, false);
    assert.equal((await service.snapshot(cwd, 'global')).resources.find(r => r.path === pkgFile).enabled, true);
    snap = await toggle(pkgFile, 'project', 'inherit'); assert.equal(snap.resources.find(r => r.path === pkgFile).enabled, true);
    snap = await toggle(file, 'project', 'off'); assert.equal(snap.resources.find(r => r.path === file).enabled, false);
    assert.equal((await service.snapshot(cwd, 'global')).resources.find(r => r.path === file).enabled, true);
    snap = await toggle(file, 'project', 'inherit'); assert.equal(snap.resources.find(r => r.path === file).enabled, true);
    assert.equal(fs.readFileSync(file, 'utf8'), text); assert.equal(fs.readFileSync(path.join(dir, 'helper.txt'), 'utf8'), 'Keep this asset.');
    assert.ok(fs.existsSync(pkgFile));
});

test('advanced models save compatibility, sampling and prices without dropping unknown fields or accepting request overrides', async () => {
    const { PiSettingsService } = require('../server/pi-settings-service');
    const service = new PiSettingsService({ cwd });
    let info = await service.getModelAdvanced({ provider: 'fixture', modelId: 'fixture' });
    await service.saveModelAdvanced({ provider: 'fixture', modelId: 'fixture', expectedRevision: info.revision,
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }, samplingParams: { temperature: 0.7 },
        cost: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 } });
    let data = JSON.parse(fs.readFileSync(path.join(root, 'agent/models.json')));
    assert.equal(data.providers.fixture.apiKey, 'synthetic-fixture');
    assert.equal(data.providers.fixture.models[0].contextWindow, 32000);
    assert.equal(data.providers.fixture.models[0].cost.input, 2);
    assert.equal(data.providers.fixture.models[0].compat.supportsDeveloperRole, false);
    assert.equal(data.providers.fixture.models[0].samplingParams.temperature, 0.7);
    await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'fixture', expectedRevision: info.revision, compat: {} }), /变化/);
    info = await service.getModelAdvanced({ provider: 'fixture', modelId: 'fixture' });
    assert.doesNotMatch(JSON.stringify(info), /synthetic-fixture/);
    await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'fixture', expectedRevision: info.revision, samplingParams: { messages: [] } }), /参数/);
    await assert.rejects(service.saveModelAdvanced({ provider: 'fixture', modelId: 'fixture', expectedRevision: info.revision, cost: { input: -2 } }), /价格/);
    await service.saveModelAdvanced({ provider: 'fixture', modelId: 'fixture', expectedRevision: info.revision, compat: { maxTokensField: null } });
    data = JSON.parse(fs.readFileSync(path.join(root, 'agent/models.json')));
    assert.equal(data.providers.fixture.models[0].compat.maxTokensField, undefined);
    assert.equal(data.providers.fixture.models[0].compat.supportsDeveloperRole, false);
});

test('native REST requires token and same origin; settings do not start workers and refuse linked config paths', async () => {
    const { once } = require('node:events');
    process.env.PI_WEB_TOKEN = 'native-fixture-token';
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway();
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/pi`, url = base + '/settings/native?cwd=' + encodeURIComponent(cwd);
    const headers = { Authorization: 'Bearer native-fixture-token', 'Content-Type': 'application/json' };
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { ...headers, Origin: 'http://other.invalid' } })).status, 403);
        const response = await fetch(url, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const value = await response.json();
        const saved = await fetch(base + '/settings/native', { method: 'PUT', headers, body: JSON.stringify({ cwd, scope: 'global', expectedRevision: value.revision, values: { followUpMode: 'all' } }) });
        assert.equal(saved.status, 200);
        const invalid = await fetch(base + '/settings/native/trust', { method: 'PUT', headers, body: JSON.stringify({ cwd, decision: true, confirmed: false, expectedRevision: value.revision }) });
        assert.equal(invalid.status, 400);
        assert.equal(gateway.supervisor.workers.size, 0);
        const other = path.join(root, 'linked-project'); fs.mkdirSync(other); fs.symlinkSync(path.join(cwd, '.pi'), path.join(other, '.pi'));
        const linked = await fetch(base + '/settings/native?cwd=' + encodeURIComponent(other), { headers }); assert.equal(linked.status, 400);
        const { PiNativeService } = require('../server/pi-native-service');
        const native = new PiNativeService(store), snapshot = await native.snapshot(cwd);
        fs.mkdirSync(path.join(root, 'agent/settings.json.lock'));
        await assert.rejects(native.saveSettings({ cwd, scope: 'global', values: { followUpMode: 'all' }, expectedRevision: snapshot.revision }), /写入|读取/);
        fs.rmdirSync(path.join(root, 'agent/settings.json.lock'));
    } finally { delete process.env.PI_WEB_TOKEN; await gateway.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
