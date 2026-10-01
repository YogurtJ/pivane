const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tool-settings-'));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(agent); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'always', unknown: { keep: true }, codemode: { future: 42 } }));
const { PiNativeService } = require('../server/pi-native-service');
const service = new PiNativeService({ resolveProject: input => { assert.equal(input, cwd); return cwd; } });
const snapshot = () => service.snapshot(cwd);
async function save(values, scope = 'global') { const s = await snapshot(); return service.saveSettings({ cwd, scope, values, expectedRevision: s.revision }); }
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('native settings preserve custom selections, ordered modifiers, empty overrides and codemode nested fields', async () => {
    let s = await snapshot();
    assert.ok(s.schema.defaultTools.choices.includes('codemode'));
    assert.ok(s.schema.defaultTools.choices.includes('tool_search'));
    assert.equal(s.settings['codemode.inlineBudget'].value, 3000);
    await save({ defaultTools: ['fixture_custom', '+codemode', '-fixture_custom', '+fixture_custom'], 'codemode.mode': 'only', 'codemode.inlineBudget': 0 });
    s = await snapshot();
    assert.deepEqual(s.settings.defaultTools.global, ['fixture_custom', '+codemode', '-fixture_custom', '+fixture_custom']);
    assert.deepEqual(s.settings.defaultTools.value, ['codemode', 'fixture_custom']);
    await save({ defaultTools: ['-fixture_custom', '+tool_search'] }, 'project');
    assert.deepEqual((await snapshot()).settings.defaultTools.value, ['codemode', 'tool_search']);
    await save({ defaultTools: [] }, 'project');
    assert.deepEqual((await snapshot()).settings.defaultTools.value, []);
    await save({ defaultTools: [] });
    await save({ defaultTools: ['+tool_search', '-tool_search', '+codemode'] }, 'project');
    assert.deepEqual((await snapshot()).settings.defaultTools.value, ['codemode']);
    await save({ defaultTools: null }, 'project');
    assert.deepEqual((await snapshot()).settings.defaultTools.value, []);
    await save({ 'codemode.mode': null, 'codemode.inlineBudget': 1000000 });
    const data = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json')));
    assert.deepEqual(data.unknown, { keep: true }); assert.equal(data.codemode.future, 42);
    assert.equal(data.codemode.mode, undefined);
    require('./private-file-helper.cjs').assertPrivateFile(path.join(agent, 'settings.json'));
});
test('validation, trust, revision and lock boundaries fail closed', async () => {
    for (const defaultTools of [['+'], ['-'], ['bad name'], [null], Array(1025).fill('read'), ['a'.repeat(501)]]) await assert.rejects(save({ defaultTools }), /设置值/);
    for (const value of [-1, 1.1, 1000001, Number.MAX_SAFE_INTEGER + 1, '3000']) await assert.rejects(save({ 'codemode.inlineBudget': value }), /设置值/);
    await assert.rejects(save({ 'codemode.mode': 'off' }), /设置值/);
    await assert.rejects(save({ autoEnableCodemode: true }), /不支持/);
    const s = await snapshot(); await save({ 'codemode.mode': 'on' });
    await assert.rejects(service.saveSettings({ cwd, scope: 'global', values: { defaultTools: [] }, expectedRevision: s.revision }), e => e.status === 409);
    await save({ defaultProjectTrust: 'never' });
    await assert.rejects(save({ defaultTools: ['+codemode'] }, 'project'), /信任项目/);
    const lock = path.join(agent, 'settings.json.lock'); fs.mkdirSync(lock);
    try { await assert.rejects(save({ defaultTools: [] }), /读取原生设置|正在写入/); } finally { fs.rmdirSync(lock); }
    assert.equal(service.busy, false);
});
test('malformed saved tool preferences fail closed without repair', async () => {
    const file = path.join(agent, 'settings.json'), original = fs.readFileSync(file);
    try {
        for (const preferences of [{ defaultTools: 'read' }, { defaultTools: ['+'] }, { codemode: { mode: 'off' } }, { codemode: { inlineBudget: -1 } }]) {
            fs.writeFileSync(file, JSON.stringify(preferences));
            await assert.rejects(snapshot(), /设置值无效/);
            assert.deepEqual(JSON.parse(fs.readFileSync(file)), preferences);
        }
    } finally { fs.writeFileSync(file, original); }
});
test('external settings changes between context and write are rejected under the lock', async () => {
    const file = path.join(agent, 'settings.json'), original = fs.readFileSync(file);
    const originalContext = service.context.bind(service);
    const revision = (await snapshot()).revision;
    service.context = async input => { const ctx = await originalContext(input); fs.writeFileSync(file, JSON.stringify({ ...ctx.global, externalFixture: true })); return ctx; };
    try {
        await assert.rejects(service.saveSettings({ cwd, scope: 'global', values: { defaultTools: ['read'] }, expectedRevision: revision }), e => e.status === 409);
        assert.equal(JSON.parse(fs.readFileSync(file)).externalFixture, true);
        assert.equal(fs.existsSync(file + '.lock'), false);
    } finally { service.context = originalContext; fs.writeFileSync(file, original); }
});
