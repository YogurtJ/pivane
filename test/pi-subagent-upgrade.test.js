const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-subagent-upgrade-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd, path.join(cwd, '.pi')]) fs.mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'temporary');
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('native MCP launch helpers preserve exact names, revisions and project trust', async () => {
    const resolver = await import('../server/pi-subagent-mcp-resolution.mjs');
    const config = { command: process.execPath, args: ['synthetic-mcp'], exposure: 'codemode' };
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { global: config } }));
    fs.writeFileSync(path.join(cwd, '.pi/mcp.json'), JSON.stringify({ mcpServers: { project: config } }));
    const { nativeMcpToolName } = await import('../server/pi-native-mcp.mjs');
    const selection = { name: nativeMcpToolName('global', 'a.b', () => true), selector: 'global/a.b' };
    process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT = JSON.stringify({ version: 1, tools: [
        { server: 'global', raw: 'a.b', name: selection.name, cwd, hash: resolver.configHash(config) },
        { server: 'project', raw: 'echo', name: 'mcp__project__echo', cwd, hash: resolver.configHash(config) },
    ] });
    const resolved = resolver.resolveMcpDirectToolResolution(['global/a.b', 'project/echo'], cwd);
    assert.equal(resolved.builtin, true);
    assert.deepEqual(resolved.selections, [selection]);
    assert.deepEqual(resolved.unresolvedSelectors, ['project/echo']);
    const host = { getMcpServers: () => ['global', 'project', 'runtime'].map(name => ({ name })) };
    const selections = [selection, { selector: 'project/echo' }, { selector: 'runtime/echo' }];
    assert.deepEqual(resolver.extensionOnlyMcpServers(selections, host, cwd, false), ['project', 'runtime']);
    assert.deepEqual(resolver.extensionOnlyMcpServers(selections, host, cwd, true), ['runtime']);
    assert.match(resolver.formatUnresolvedBuiltinMcpSelectors('reviewer', ['missing/echo']), /reviewer.*missing\/echo/);
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { global: { ...config, args: ['changed'] } } }));
    assert.deepEqual(resolver.resolveMcpDirectToolResolution(['global/a.b'], cwd).selections, []);
    delete process.env.PIVANE_NATIVE_MCP_TOOL_SNAPSHOT;
});

test('upgraded child factory honors inherited project trust and removes dynamically discovered skills', { timeout: 60000 }, async t => {
    const provider = http.createServer(async (req, res) => {
        for await (const chunk of req) { /* synthetic completion */ }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
            delta: { role: 'assistant', content: 'CHILD_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{"mcpServers":{}}');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'always',
        defaultProvider: 'fixture', defaultModel: 'fixture', pivaneBuiltins: { subagents: { extensions: [] } } }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic',
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'UNTRUSTED_PROJECT_CONTEXT_SENTINEL');
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), 'TRUSTED_IDENTITY_CONTEXT_SENTINEL');
    fs.writeFileSync(path.join(cwd, '.pi/settings.json'), JSON.stringify({ extensions: ['./forbidden.ts'] }));
    fs.writeFileSync(path.join(cwd, '.pi/forbidden.ts'), 'export default function() { throw new Error("UNTRUSTED_PROJECT_EXTENSION_EXECUTED"); }');
    const skills = path.join(root, 'dynamic-skills'), skill = path.join(skills, 'discovered');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: discovered\ndescription: DYNAMIC_SKILL_DISCOVERY_SENTINEL\n---\nSynthetic workflow.\n');
    const { default: createFactory } = await import('../server/pi-subagent-child-factory.mjs');
    const factory = createFactory();
    t.after(async () => { await factory.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    for (const noSkills of [false, true]) {
        const observed = [], errors = [];
        const child = await factory.create({ cwd, projectTrusted: false, storage: { kind: 'memory' }, model: 'fixture/fixture', tools: ['read'],
            extensionPaths: [], ambientExtensions: true, noSkills, noContextFiles: false, runtime: {},
            onExtensionError: error => errors.push(String(error.error)), hooks: [{ name: 'fixture-discovery', factory: pi => {
                pi.on('resources_discover', () => ({ skillPaths: [skills] }));
                pi.on('before_agent_start', (event, ctx) => { observed.push({ prompt: event.systemPrompt, trusted: ctx.isProjectTrusted() }); });
            } }] });
        try {
            await child.prompt('Reply CHILD_OK');
            assert.equal(observed.length, 1);
            assert.equal(observed[0].trusted, false, 'parent trust overrides the global always default');
            assert.doesNotMatch(observed[0].prompt, /UNTRUSTED_PROJECT_CONTEXT_SENTINEL/);
            assert.match(observed[0].prompt, /TRUSTED_IDENTITY_CONTEXT_SENTINEL/);
            assert.equal(observed[0].prompt.includes('DYNAMIC_SKILL_DISCOVERY_SENTINEL'), !noSkills);
            assert.deepEqual(errors, []);
        } finally { await child.dispose(); }
    }
});
