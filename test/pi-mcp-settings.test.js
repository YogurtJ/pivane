const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiMcpSettingsService } = require('../server/pi-mcp-settings-service');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-')), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(agent); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.pi'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let trusted = false;
    const sdk = { getAgentDir: () => agent, ProjectTrustStore: class { getEntry() { return { decision: trusted }; } } };
    const service = new PiMcpSettingsService({ resolveProject: input => { if (input !== cwd) throw new Error('private path'); return fs.realpathSync(cwd); } }, { getSdk: async () => sdk });
    const write = (name, data) => fs.writeFileSync(path.join(agent, name), JSON.stringify(data));
    const save = async input => service.save({ cwd, scope: 'global', confirmed: true, expectedRevision: (await service.snapshot(cwd)).revision, ...input });
    return { root, agent, cwd, write, save, service, trust: () => { trusted = true; } };
}
test('saved GET is redacted and never evaluates references; explicit secret edits retain unknown fields', async t => {
    const f = fixture(t), marker = path.join(f.root, 'executed');
    f.write('mcp.json', { future: { preserved: true }, mcpServers: { local: { command: `!touch ${marker}`, args: ['secret-token'], env: { KEY: 'literal' }, unknown: 'unknown-secret', exposure: 'direct' }, remote: { url: 'https://user:secret@example.invalid/mcp?token=secret', headers: { Authorization: 'secret' }, oauth: { clientSecret: 'secret' } } } });
    const dto = await f.service.snapshot(f.cwd), text = JSON.stringify(dto);
    for (const secret of ['secret-token', 'literal', 'unknown-secret', 'touch', 'example.invalid']) assert.ok(!text.includes(secret));
    assert.equal(dto.servers[0].config.command, null); assert.deepEqual(dto.servers[0].secretFields['env.KEY'], { present: true }); assert.ok(!fs.existsSync(marker));
    await f.save({ action: 'upsert', name: 'local', config: { command: { op: 'keep' }, args: { op: 'replace', value: ['new'] }, env: { KEY: { op: 'remove' }, NEXT: { op: 'replace', value: '${NEXT}' } } } });
    const disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json')));
    assert.equal(disk.mcpServers.local.unknown, 'unknown-secret'); assert.deepEqual(disk.future, { preserved: true }); assert.deepEqual(disk.mcpServers.local.args, ['new']); assert.deepEqual(disk.mcpServers.local.env, { NEXT: '${NEXT}' });
    assert.equal(fs.statSync(path.join(f.agent, 'mcp.json')).mode & 0o777, 0o600);
    for (const config of [{ command: null }, { command: { op: 'keep', value: 'bad' } }, { env: { NEW: { op: 'keep' } } }, { exposure: 'invalid' }, { type: 'sse' }]) await assert.rejects(f.save({ action: 'upsert', name: 'local', config }), /^Error: MCP_/);
    await f.save({ action: 'patch', name: 'remote', patch: { headers: { Authorization: { op: 'keep' } }, oauth: { clientSecret: { op: 'remove' } } } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote.headers.Authorization, 'secret');
});
test('raw revisions include both scopes, settings and trust; trust, locks, parse and concurrent saves fail closed', async t => {
    const f = fixture(t); f.write('mcp.json', { mcpServers: {} });
    let dto = await f.service.snapshot(f.cwd);
    f.write('settings.json', { defaultProjectTrust: 'never' });
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: false, expectedRevision: dto.revision }), { code: 'MCP_CHANGED' });
    await assert.rejects(f.save({ scope: 'project', action: 'preferences', autoEnableCodemode: false }), { code: 'MCP_PROJECT_UNTRUSTED' });
    f.trust(); await f.save({ scope: 'project', action: 'preferences', autoEnableCodemode: false });
    assert.equal((await f.service.snapshot(f.cwd, 'project')).autoEnableCodemode.value, false);
    fs.mkdirSync(path.join(f.agent, 'mcp.json.lock'));
    await assert.rejects(f.save({ action: 'preferences', autoEnableCodemode: true }), { code: 'MCP_BUSY' });
    fs.rmdirSync(path.join(f.agent, 'mcp.json.lock'));
    dto = await f.service.snapshot(f.cwd);
    const input = { cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: true, expectedRevision: dto.revision };
    const pending = f.service.save(input); await assert.rejects(f.service.save(input), { code: 'MCP_BUSY' }); await pending;
    f.write('mcp.json', { mcpServers: { invalid: { type: 'sse', url: 'https://secret.invalid' } } });
    assert.equal((await f.service.snapshot(f.cwd)).servers[0].valid, false);
    fs.writeFileSync(path.join(f.agent, 'mcp.json'), '{bad-secret'); await assert.rejects(f.service.snapshot(f.cwd), { code: 'MCP_INVALID_JSON' });
    fs.unlinkSync(path.join(f.agent, 'mcp.json')); fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.agent, 'mcp.json')); await assert.rejects(f.service.snapshot(f.cwd));
});
test('changes during asynchronous validation/context fail before writing', async t => {
    const f = fixture(t); f.write('mcp.json', {});
    const dto = await f.service.snapshot(f.cwd), context = f.service.context.bind(f.service);
    f.service.context = async cwd => { const ctx = await context(cwd); f.write('trust.json', { changed: true }); return ctx; };
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: false, expectedRevision: dto.revision }), { code: 'MCP_CHANGED' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))), {});
});
