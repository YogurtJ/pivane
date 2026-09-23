const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tools-trust-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
fs.mkdirSync(path.join(cwd, '.pi/prompts'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.pi/prompts/probe.md'), 'Fixture');
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, unknownFixture: { keep: true } }));
fs.writeFileSync(path.join(agent, 'extensions/probe.ts'), `export default function(pi) {
    pi.registerTool({ name: 'fixture_custom', label: 'Fixture', description: 'Never executed', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) });
}`);
const { PiSessionStore } = require('../server/pi-session-store');
const { PiNativeService } = require('../server/pi-native-service');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const service = new PiNativeService(new PiSessionStore());
async function save(values, scope = 'global') {
    const snapshot = await service.snapshot(cwd);
    return service.saveSettings({ cwd, scope, values, expectedRevision: snapshot.revision });
}
async function trust(decision) {
    const snapshot = await service.snapshot(cwd);
    return service.saveTrust({ cwd, decision, confirmed: true, expectedRevision: snapshot.revision });
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('default tools preserve empty, inherited and native defaults, with actual new-worker activation and strict CLI distinction', { timeout: 120000 }, async () => {
    const supervisor = new PiAgentSupervisor();
    const active = async worker => (await worker.getNativeResources()).tools.filter(t => t.active).map(t => t.name).sort();
    try {
        let snap = await service.snapshot(cwd);
        assert.equal(snap.settings.defaultTools.global, null);
        assert.deepEqual(snap.settings.defaultTools.value, ['read', 'bash', 'edit', 'write']);
        assert.ok(snap.schema.defaultTools.choices.includes('powershell'));
        const original = await supervisor.createEphemeralWorker(cwd);
        assert.ok((await active(original)).includes('bash'));
        await save({ defaultTools: [] });
        assert.deepEqual((await service.snapshot(cwd)).settings.defaultTools.value, []);
        assert.ok((await active(original)).includes('bash'), 'saving cannot alter an existing worker');
        await original.dispose();
        const empty = await supervisor.createEphemeralWorker(cwd);
        assert.deepEqual(await active(empty), ['fixture_custom', 'update_plan'], 'extension tools survive the empty built-in list');
        await empty.dispose();
        await save({ defaultTools: ['read', 'grep'] });
        await trust(true);
        await save({ defaultTools: [] }, 'project');
        snap = await service.snapshot(cwd);
        assert.equal(snap.settings.defaultTools.source, 'project');
        assert.deepEqual(snap.settings.defaultTools.value, []);
        await save({ defaultTools: ['ls'] }, 'project');
        const projectWorker = await supervisor.createEphemeralWorker(cwd);
        assert.deepEqual(await active(projectWorker), ['fixture_custom', 'ls', 'update_plan']);
        await projectWorker.dispose();
        await save({ defaultTools: null }, 'project');
        snap = await service.snapshot(cwd);
        assert.equal(snap.settings.defaultTools.source, 'global');
        assert.deepEqual(snap.settings.defaultTools.value, ['read', 'grep']);
        const strict = await supervisor.createEphemeralWorker(cwd, { extraArgs: ['--tools', 'read'] });
        assert.deepEqual(await active(strict), ['read'], 'CLI allowlist excludes extension tools');
        await strict.dispose();
        for (const value of ['read', ['unknown'], ['read', 'read'], [null], {}]) await assert.rejects(save({ defaultTools: value }), /设置/);
        await save({ defaultTools: null });
        snap = await service.snapshot(cwd);
        assert.equal(snap.settings.defaultTools.source, 'default');
        assert.deepEqual(snap.settings.defaultTools.value, snap.schema.defaultTools.defaults);
        const file = path.join(agent, 'settings.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(file)).unknownFixture, { keep: true });
        require('./private-file-helper.cjs').assertPrivateFile(file);
        assert.ok(fs.readdirSync(agent).some(name => name.startsWith('settings.json.bak-web-')));
    } finally { await supervisor.dispose(); await trust(null); }
});

test('global trust fallback respects saved/parent/launch decisions, global-only validation and stale revisions', { timeout: 120000 }, async () => {
    const supervisor = new PiAgentSupervisor();
    const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent');
    const trustStore = new ProjectTrustStore(agent);
    const runtimeTrust = async () => {
        const worker = await supervisor.createEphemeralWorker(cwd);
        try { return (await worker.getNativeResources()).projectTrusted; } finally { await worker.dispose(); }
    };
    try {
        for (const policy of ['ask', 'always', 'never']) {
            await save({ defaultProjectTrust: policy });
            const snap = await service.snapshot(cwd);
            assert.equal(snap.settings.defaultProjectTrust.value, policy);
            assert.equal(snap.trust.defaultPolicy, policy);
            assert.equal(snap.trust.effective, policy === 'always');
            assert.equal(await runtimeTrust(), policy === 'always');
        }
        await trust(true);
        assert.equal(await runtimeTrust(), true, 'never does not override explicit allow');
        await save({ defaultProjectTrust: 'always' });
        await trust(false);
        assert.equal(await runtimeTrust(), false, 'always does not override explicit deny');
        await trust(null); trustStore.set(root, false);
        assert.equal((await service.snapshot(cwd)).trust.savedPath, root);
        assert.equal(await runtimeTrust(), false, 'parent decision precedes fallback');
        process.env.PI_WEB_APPROVE_PROJECTS = 'true';
        assert.equal((await service.snapshot(cwd)).trust.override, true);
        assert.equal(await runtimeTrust(), true, 'launch override precedes saved decision');
        delete process.env.PI_WEB_APPROVE_PROJECTS; trustStore.set(root, null);
        for (const value of ['always', null]) await assert.rejects(save({ defaultProjectTrust: value }, 'project'), /设置/);
        for (const value of ['invalid', true, []]) await assert.rejects(save({ defaultProjectTrust: value }), /设置/);
        const old = await service.snapshot(cwd);
        await save({ defaultProjectTrust: 'never' });
        await assert.rejects(service.saveSettings({ cwd, scope: 'global', values: { defaultProjectTrust: 'always' }, expectedRevision: old.revision }), /变化/);
        await save({ defaultProjectTrust: null });
        const snap = await service.snapshot(cwd);
        assert.equal(snap.trust.defaultPolicy, 'ask');
        assert.equal(snap.settings.defaultProjectTrust.source, 'default');
    } finally { delete process.env.PI_WEB_APPROVE_PROJECTS; trustStore.set(root, null); await supervisor.dispose(); }
});
