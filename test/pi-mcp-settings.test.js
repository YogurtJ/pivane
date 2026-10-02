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
test('namespace collisions are rejected across scopes and existing native losers are marked invalid', async t => {
    const f = fixture(t), local = { command: 'synthetic' }; f.trust();
    const add = name => ({ action: 'upsert', name, config: { command: { op: 'replace', value: 'synthetic' } } });
    f.write('mcp.json', { mcpServers: { 'dev-radius': local } });
    await assert.rejects(f.save(add('dev_radius')), { code: 'MCP_NAMESPACE_CONFLICT' });
    await assert.rejects(f.save({ ...add('dev_radius'), scope: 'project' }), { code: 'MCP_NAMESPACE_CONFLICT' });
    await f.save({ ...add('dev-radius'), scope: 'project' }); // exact-name project override remains supported
    f.write('mcp.json', { mcpServers: {} });
    await assert.rejects(f.save(add('dev_radius')), { code: 'MCP_NAMESPACE_CONFLICT' });
    fs.writeFileSync(path.join(f.cwd, '.pi/mcp.json'), '{}');
    f.write('mcp.json', { mcpServers: { 'dev-radius': local, dev_radius: local } });
    const rows = (await f.service.snapshot(f.cwd)).servers;
    assert.equal(rows[0].valid, true); assert.equal(rows[1].valid, false);
    assert.equal(rows[1].error, 'MCP_NAMESPACE_CONFLICT');
    assert.deepEqual(rows[1].config, {});
    const { loadNativeMcpConfig } = await import('../server/pi-native-mcp.mjs');
    const native = loadNativeMcpConfig({ cwd: f.cwd, agentDir: f.agent, projectTrusted: true });
    assert.deepEqual(native.servers.map(row => row.name), ['dev-radius']);
    await f.save({ action: 'patch', name: 'dev-radius', patch: { description: 'Unrelated edit' } });
    await f.save({ action: 'remove', name: 'dev_radius' });
    assert.equal((await f.service.snapshot(f.cwd)).servers.length, 1);
    // Native skips project provider auth even when stdio retains an ignored URL.
    f.write('mcp.json', {});
    const ignored = { type: 'stdio', command: 'synthetic', url: 'https://example.invalid', auth: { provider: 'fixture' } };
    fs.writeFileSync(path.join(f.cwd, '.pi/mcp.json'), JSON.stringify({ mcpServers: { 'dev-radius': ignored } }));
    await f.save({ ...add('dev_radius'), scope: 'project' });
    const project = (await f.service.snapshot(f.cwd, 'project')).servers;
    assert.equal(project[0].valid, false); assert.equal(project[1].valid, true);
    assert.deepEqual(loadNativeMcpConfig({ cwd: f.cwd, agentDir: f.agent, projectTrusted: true }).servers.map(row => row.name), ['dev_radius']);
});

test('changes during asynchronous validation/context fail before writing', async t => {
    const f = fixture(t); f.write('mcp.json', {});
    const dto = await f.service.snapshot(f.cwd), context = f.service.context.bind(f.service);
    f.service.context = async cwd => { const ctx = await context(cwd); f.write('trust.json', { changed: true }); return ctx; };
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: false, expectedRevision: dto.revision }), { code: 'MCP_CHANGED' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))), {});
});
test('Pi 1.0 fields retain secrets and unknown members while native URL and callback rules apply', async t => {
    const f = fixture(t), marker = path.join(f.root, 'oauth-executed');
    f.write('mcp.json', { mcpServers: { remote: { url: 'https://example.invalid/mcp', description: '<script>docs</script>', exposure: 'codemode-deferred', toolExposure: { find: 'codemode-deferred' }, oauth: { clientName: `!touch ${marker}`, authServerMetadataUrl: 'https://private.invalid/metadata?secret=hidden', future: 'private-future' }, auth: { provider: 'fixture-provider', future: 'private-auth' } } } });
    let dto = await f.service.snapshot(f.cwd), remote = dto.servers[0];
    assert.equal(remote.config.description, '<script>docs</script>');
    assert.equal(remote.exposure, 'codemode'); assert.equal(remote.config.toolExposure.find, 'codemode');
    assert.equal(remote.config.auth.provider, 'fixture-provider'); assert.equal(remote.config.auth.future, null);
    for (const key of ['clientName', 'authServerMetadataUrl']) { assert.equal(remote.config.oauth[key], null); assert.deepEqual(remote.secretFields[`oauth.${key}`], { present: true }); }
    assert.ok(!JSON.stringify(dto).includes('private.invalid')); assert.ok(!fs.existsSync(marker));
    await f.save({ action: 'patch', name: 'remote', patch: { description: 'Search docs', oauth: { clientName: { op: 'keep' }, authServerMetadataUrl: { op: 'replace', value: 'http://[::1]/metadata' } }, auth: { provider: 'new-provider' } } });
    let disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote;
    assert.equal(disk.oauth.clientName, `!touch ${marker}`); assert.equal(disk.oauth.future, 'private-future'); assert.equal(disk.auth.future, 'private-auth');
    for (const patch of [
        { description: 'x'.repeat(4097) }, { description: 42 },
        { oauth: { clientName: { op: 'replace', value: '' } } },
        { oauth: { authServerMetadataUrl: { op: 'replace', value: 'http://example.invalid/metadata' } } },
        { oauth: { authServerMetadataUrl: { op: 'replace', value: '${METADATA_URL}' } } },
        { oauth: { callbackUrl: { op: 'replace', value: 'http://localhost:1234/callback' }, callbackPort: 5678 } },
        { url: { op: 'replace', value: 'http://example.invalid/mcp' } },
        { type: 'stdio', command: { op: 'replace', value: 'mock' } },
        { auth: { provider: '' } }, { auth: { future: 'changed' } },
        { oauth: { clientName: 'plain-value' } }
    ]) await assert.rejects(f.save({ action: 'patch', name: 'remote', patch }), /^Error: MCP_/);
    await f.save({ action: 'patch', name: 'remote', patch: { description: null, oauth: { clientName: { op: 'remove' }, authServerMetadataUrl: { op: 'remove' } }, auth: null } });
    disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote;
    assert.equal(disk.description, undefined); assert.deepEqual(disk.oauth, { future: 'private-future' }); assert.equal(disk.auth, undefined);
});
test('provider auth is global HTTP only; newly selected providers cannot override an Authorization header', async t => {
    const f = fixture(t); f.trust();
    f.write('mcp.json', { mcpServers: { remote: { url: 'https://example.invalid/mcp', headers: { aUtHoRiZaTiOn: '${MOCK}' }, auth: { provider: 'existing' }, oauth: { clientName: 'retained' } } } });
    await f.save({ action: 'patch', name: 'remote', patch: { enabled: false } });
    await assert.rejects(f.save({ action: 'patch', name: 'remote', patch: { auth: { provider: 'different' } } }), { code: 'MCP_AUTH_HEADER_CONFLICT' });
    await f.save({ action: 'patch', name: 'remote', patch: { headers: { aUtHoRiZaTiOn: { op: 'remove' } }, auth: { provider: 'different' } } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote.oauth.clientName, 'retained');
    for (const url of ['https://example.invalid/mcp', 'http://localhost/mcp', 'http://127.0.0.1/mcp', 'http://[::1]/mcp']) {
        await f.save({ action: 'upsert', name: 'allowed', config: { url: { op: 'replace', value: url }, auth: { provider: 'fixture' } } });
        await assert.rejects(f.save({ scope: 'project', action: 'upsert', name: 'blocked', config: { url: { op: 'replace', value: url }, auth: { provider: 'fixture' } } }), { code: 'MCP_INVALID_SERVER' });
    }
    await assert.rejects(f.save({ action: 'upsert', name: 'stdio', config: { command: { op: 'replace', value: 'mock' }, auth: { provider: 'fixture' } } }), { code: 'MCP_INVALID_SERVER' });
    fs.writeFileSync(path.join(f.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { blocked: { url: 'https://example.invalid/mcp', auth: { provider: 'fixture' } } } }));
    const dto = await f.service.snapshot(f.cwd, 'project'); assert.equal(dto.servers[0].valid, false); assert.deepEqual(dto.servers[0].config, {});
    await assert.rejects(f.save({ scope: 'project', action: 'patch', name: 'blocked', patch: { enabled: false } }), { code: 'MCP_INVALID_SERVER' });
    await f.save({ scope: 'project', action: 'patch', name: 'blocked', patch: { auth: null } });
    assert.equal((await f.service.snapshot(f.cwd, 'project')).servers[0].valid, true);
});
