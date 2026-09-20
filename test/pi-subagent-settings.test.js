const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-subagent-settings-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { PiNativeService } = require('../server/pi-native-service');
const { PiResourceService } = require('../server/pi-resource-service');
const { PiSubagentSettingsService } = require('../server/pi-subagent-settings-service');
const { PiSessionStore } = require('../server/pi-session-store');
const { installDefaults } = require('../server/pi-default-capabilities-installer');
const definition = require('../server/pi-default-capabilities')[0];
const native = new PiNativeService(new PiSessionStore());
const resources = new PiResourceService(native);
let catalogHook = null;
const service = new PiSubagentSettingsService(native, resources, { getModelSnapshot: async () => {
    if (catalogHook) await catalogHook();
    return { models: [{ provider: 'fixture', id: 'reasoner', available: true, thinkingLevels: ['off', 'medium', 'high'] }] };
} });
const globalFile = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('optional capability failure is nonfatal, durable, and never retried implicitly', async () => {
    const agentDir = path.join(root, 'optional'); let attempts = 0;
    const manager = { listConfiguredPackages: () => [], installAndPersist: async source => { attempts++; assert.equal(source, definition.source); throw new Error('secret must not be logged'); } };
    const messages = [];
    await installDefaults({ agentDir, manager, log: message => messages.push(message) });
    await installDefaults({ agentDir, manager });
    assert.equal(attempts, 1); assert.doesNotMatch(messages.join(''), /secret/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'pivane-default-capabilities.json'))).subagents.status, 'failed');
    const skipDir = path.join(root, 'skipped');
    await installDefaults({ agentDir: skipDir, manager, skip: true });
    await installDefaults({ agentDir: skipDir, manager }); assert.equal(attempts, 1);
    const existing = path.join(root, 'existing');
    await installDefaults({ agentDir: existing, manager: { ...manager, listConfiguredPackages: () => [{ source: 'npm:pi-subagents@0.1.0' }] } });
    assert.equal(attempts, 1, 'existing choices must not be upgraded');
    const successful = path.join(root, 'successful'); let installed = 0;
    await installDefaults({ agentDir: successful, manager: { ...manager, installAndPersist: async () => { installed++; } }, log: () => {} });
    await installDefaults({ agentDir: successful, manager, log: () => {} });
    assert.equal(installed, 1); assert.equal(attempts, 1, 'removal after installation must not trigger reinstall');
});

test('missing, disabled and incompatible plugins cannot accept subagent settings', async () => {
    fs.writeFileSync(globalFile, '{}');
    let snapshot = await service.snapshot(cwd);
    assert.equal(snapshot.plugin.status, 'missing'); assert.equal(snapshot.plugin.canInstall, true);
    await assert.rejects(service.save({ cwd, scope: 'global', expectedRevision: snapshot.revision, changes: { defaultModel: 'fixture/reasoner' } }), /插件/);
    const pkg = path.join(root, 'plugin'); fs.mkdirSync(path.join(pkg, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'index.js'), 'export default function() {}');
    fs.writeFileSync(path.join(pkg, 'agents/reviewer.md'), '---\nname: reviewer\nthinking: high\n---\nFixture');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pi-subagents', version: '0.1.0', pi: { extensions: ['./index.js'] } }));
    fs.writeFileSync(globalFile, JSON.stringify({ packages: [pkg], preserved: { sentinel: 123 } }));
    snapshot = await service.snapshot(cwd); assert.equal(snapshot.plugin.status, 'unsupported');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'pi-subagents', version: definition.version, pi: { extensions: ['./index.js'] } }));
    fs.writeFileSync(globalFile, JSON.stringify({ packages: [{ source: pkg, extensions: [] }], preserved: { sentinel: 123 } }));
    snapshot = await service.snapshot(cwd); assert.equal(snapshot.plugin.status, 'disabled');
    fs.writeFileSync(globalFile, JSON.stringify({ packages: [pkg], preserved: { sentinel: 123 }, subagents: { unknown: { enabled: true }, agentOverrides: { reviewer: { tools: ['read'] } } } }));
    snapshot = await service.snapshot(cwd); assert.equal(snapshot.plugin.status, 'ready'); assert.ok(snapshot.roles.some(role => role.name === 'reviewer'));
});

test('canonical role/default writes preserve unknown fields, enforce revisions and trust, and restore inheritance', async () => {
    let snapshot = await service.snapshot(cwd);
    const input = { cwd, scope: 'global', expectedRevision: snapshot.revision, changes: { defaultModel: 'fixture/reasoner', defaultThinking: 'medium', 'agentOverrides.reviewer.model': 'inherit', 'agentOverrides.reviewer.thinking': 'high' } };
    await service.save(input);
    await assert.rejects(service.save(input), /变化/);
    let data = JSON.parse(fs.readFileSync(globalFile));
    assert.equal(data.preserved.sentinel, 123); assert.equal(data.subagents.unknown.enabled, true); assert.deepEqual(data.subagents.agentOverrides.reviewer.tools, ['read']);
    snapshot = await service.snapshot(cwd);
    await assert.rejects(service.save({ ...input, scope: 'project', expectedRevision: snapshot.revision }), /信任/);
    await assert.rejects(service.save({ ...input, expectedRevision: snapshot.revision, changes: { 'agentOverrides.__proto__.model': 'inherit' } }), /不支持/);
    await assert.rejects(service.save({ ...input, expectedRevision: snapshot.revision, changes: { defaultModel: 'unknown/model' } }), /可用模型/);
    await service.save({ ...input, expectedRevision: snapshot.revision, changes: { 'agentOverrides.reviewer.model': null } });
    data = JSON.parse(fs.readFileSync(globalFile)); assert.equal(data.subagents.agentOverrides.reviewer.model, undefined); assert.deepEqual(data.subagents.agentOverrides.reviewer.tools, ['read']);
    require('./private-file-helper.cjs').assertPrivateFile(globalFile);
});

test('model lookup reserves shared mutex and rejects external edits before write', async () => {
    const snapshot = await service.snapshot(cwd);
    let resume; const gate = new Promise(resolve => { resume = resolve; });
    let entered; const started = new Promise(resolve => { entered = resolve; });
    catalogHook = async () => { entered(); await gate; };
    const saving = service.save({ cwd, scope: 'global', expectedRevision: snapshot.revision, changes: { defaultThinking: 'high' } });
    await started;
    assert.equal(native.busy, true);
    await assert.rejects(native.saveSettings({ cwd, scope: 'global', expectedRevision: (await native.context(cwd)).revision, values: { steeringMode: 'all' } }), /保存/);
    const external = JSON.parse(fs.readFileSync(globalFile)); external.external = true; fs.writeFileSync(globalFile, JSON.stringify(external));
    resume(); await assert.rejects(saving, /变化/); catalogHook = null;
    assert.equal(native.busy, false); assert.equal(JSON.parse(fs.readFileSync(globalFile)).external, true);
});

test('subagent HTTP settings enforce authentication, Origin, fixed install source and no worker creation', async () => {
    process.env.PI_WEB_TOKEN = 'subagent-fixture-token';
    process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
    const { once } = require('node:events');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway(), app = require('express')();
    app.use(require('express').json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/pi/settings/subagents`;
    const headers = { Authorization: 'Bearer subagent-fixture-token', 'Content-Type': 'application/json' };
    try {
        assert.equal((await fetch(base + '?cwd=' + encodeURIComponent(cwd))).status, 401);
        assert.equal((await fetch(base, { method: 'PUT', headers: { ...headers, Origin: 'http://other.invalid' }, body: '{}' })).status, 403);
        const response = await fetch(base + '?cwd=' + encodeURIComponent(cwd), { headers });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const snapshot = await response.json();
        assert.doesNotMatch(JSON.stringify(snapshot), /preserved|sentinel|tools|external/);
        for (const body of [{ cwd, expectedRevision: snapshot.revision, confirmed: false }, { cwd, expectedRevision: snapshot.revision, confirmed: true, source: 'npm:other' }]) {
            assert.equal((await fetch(base + '/install', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
        }
        assert.equal(gateway.supervisor.workers.size, 0);
    } finally { delete process.env.PI_WEB_TOKEN; await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
