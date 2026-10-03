const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate, convert } = require('../scripts/migrate-native-mcp.cjs');
test('explicit MCP migration keeps originals private, merges reviewed transports and never prints credentials', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-migrate-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { unknown: { retained: true }, settings: { directTools: true }, mcpServers: {
        browser: { lifecycle: 'lazy', requestTimeoutMs: 90000 }, remote: { url: 'https://example.invalid/mcp', auth: 'bearer', bearerToken: 'synthetic-$SECRET' },
    } };
    const settings = { packages: ['npm:pi-mcp-adapter@2.33.0', 'npm:other'], sentinel: 7, subagents: { maxDepth: 3 } };
    const defaultsFile = path.join(root, 'defaults.json');
    fs.writeFileSync(defaultsFile, JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: ['fixture.js'] } } }));
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify(config)); fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    const dry = await migrate({ agentDir: root, defaultsFile });
    assert.equal(dry.applied, false); assert.doesNotMatch(JSON.stringify(dry), /synthetic/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'))), config);
    const result = await migrate({ agentDir: root, defaultsFile, apply: true });
    assert.equal(result.applied, true); assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    const native = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json')));
    assert.equal(native.mcpServers.browser.timeout, 90); assert.equal(native.mcpServers.browser.command, process.execPath);
    assert.equal(native.mcpServers.remote.headers.Authorization, 'Bearer synthetic-$$SECRET');
    assert.equal(native.mcpServers.remote.bearerToken, undefined); assert.deepEqual(native.unknown, config.unknown);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'settings.json')));
    assert.deepEqual(saved.packages, ['npm:other']); assert.equal(saved.sentinel, 7); assert.deepEqual(saved.subagents, settings.subagents);
    assert.equal(fs.readFileSync(path.join(result.backup, 'mcp.json'), 'utf8'), JSON.stringify(config));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'mcp.json')).mode & 0o777, 0o600);
    const repeat = await migrate({ agentDir: root, apply: true }); assert.equal(repeat.applied, false);
});
test('bearer command and environment expressions remain unevaluated native header references', () => {
    const command = { mcpServers: { command: { url: 'https://example.invalid', bearerToken: '!printf synthetic' } } };
    if (process.platform === 'win32') assert.throws(() => convert(command), /explicitly reviewed Windows header command/);
    else assert.match(convert(command).mcpServers.command.headers.Authorization, /^!token=\$\(printf synthetic\)/);
    const config = convert({ mcpServers: {
        env: { url: 'https://example.invalid', bearerToken: '${TOOLS_TOKEN}' },
        escaped: { url: 'https://example.invalid', bearerToken: '!!literal' },
    } });
    assert.equal(config.mcpServers.env.headers.Authorization, 'Bearer ${TOOLS_TOKEN}');
    assert.equal(config.mcpServers.escaped.headers.Authorization, 'Bearer !literal');
});

test('unsupported imported/plugin definitions in either migration source fail without writes or backups', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-imports-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const rules = [{ imports: ['other-client'] }, { settings: { agentPluginPaths: ['plugin'] } }, { settings: { claudePluginPaths: ['plugin'] } }];
    const configFile = path.join(root, 'mcp.json'), settingsFile = path.join(root, 'settings.json'), defaultsFile = path.join(root, 'defaults.json');
    for (const rule of rules) for (const source of ['primary', 'defaults']) for (const apply of [false, true]) {
        const primary = { mcpServers: {}, ...(source === 'primary' ? rule : {}) };
        const defaults = { mcpServers: { fixture: { command: 'fixture' } }, ...(source === 'defaults' ? rule : {}) };
        const raws = [JSON.stringify(primary), JSON.stringify({ sentinel: true }), JSON.stringify(defaults)];
        [configFile, settingsFile, defaultsFile].forEach((file, i) => fs.writeFileSync(file, raws[i]));
        await assert.rejects(migrate({ agentDir: root, defaultsFile, apply }), /Imported\/plugin/);
        [configFile, settingsFile, defaultsFile].forEach((file, i) => assert.equal(fs.readFileSync(file, 'utf8'), raws[i]));
        assert.equal(fs.existsSync(path.join(root, '.pivane-migrations')), false);
        assert.equal(fs.existsSync(path.join(root, '.pivane-native-mcp-migration.lock')), false);
    }
});

test('unsupported legacy transports and authorization policies fail before writing', () => {
    for (const server of [{ url: 'https://example.invalid', type: 'sse' }, { command: 'fixture', includeTools: ['safe'] },
        { command: 'fixture', socket: '/tmp/mcp' }, { command: 'fixture', requestHeadersCommand: { command: 'secret' } }]) {
        assert.throws(() => convert({ mcpServers: { fixture: server } }), /Unsupported/);
    }
});
