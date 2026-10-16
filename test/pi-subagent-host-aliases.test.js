const test = require('node:test');
const assert = require('node:assert/strict');
const { REVIEWED_PI_VERSION } = require('../server/pi-reviewed-host');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const obsolete = '@earendil-works/pi-agent-core/node';
const chord = '@earendil-works/chord';

test('official detached host aliases retain reviewed Pi dependency scope without a host redirect', () => {
    const code = `import {resolveHostPeerAliases} from './vendor/pi-subagents/src/runs/background/runner-aliases.js';
        import {VERSION} from '@earendil-works/pi-coding-agent';
        const result=resolveHostPeerAliases(process.cwd()+'/node_modules/@earendil-works/pi-coding-agent');
        for (const [name,file] of Object.entries(result.aliases)) await import((await import('node:url')).pathToFileURL(file).href);
        console.log(JSON.stringify({version:VERSION,...result}));`;
    const child = spawnSync(process.execPath, ['--import', './server/pi-subagent-native-loader.mjs', '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.version, REVIEWED_PI_VERSION);
    assert.deepEqual(result.missing, []);
    assert.equal(Object.hasOwn(result.aliases, obsolete), false);
    assert.equal(Object.hasOwn(result.aliases, chord), false);
    assert.equal(fs.existsSync(path.join(root, 'server/pi-subagent-host-aliases.mjs')), false);
    for (const file of Object.values(result.aliases)) {
        assert.equal(fs.realpathSync(file), file);
        assert.equal(file.startsWith(fs.realpathSync.native(path.join(root, 'node_modules')) + path.sep), true);
    }
});

test('official detached preflight requires declared Chord and declared node targets but permits absent optional exports', async t => {
    const { resolveHostPeerAliases } = await import('../vendor/pi-subagents/src/runs/background/runner-aliases.js');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-host-alias-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const host = path.join(temp, 'host');
    const core = path.join(host, 'node_modules/@earendil-works/pi-agent-core');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(host, 'index.js'), ''); fs.writeFileSync(path.join(core, 'index.js'), '');
    const manifests = (dependencies = {}, nodeExport) => {
        fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.2.0', exports: { '.': './index.js' }, dependencies }));
        const exports = { '.': './index.js' };
        if (nodeExport !== undefined) exports['./node'] = nodeExport;
        fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-agent-core', version: '1.2.0', exports }));
    };
    manifests();
    assert.equal(resolveHostPeerAliases(host).missing.includes(obsolete), false);
    assert.equal(resolveHostPeerAliases(host).missing.includes(chord), false);
    assert.equal(resolveHostPeerAliases(host).missing.includes('@earendil-works/pi-tui'), true);
    manifests({}, './missing.js');
    assert.equal(resolveHostPeerAliases(host).missing.includes(obsolete), true);
    fs.writeFileSync(path.join(core, 'node.js'), '');
    manifests({}, './node.js');
    assert.equal(resolveHostPeerAliases(host).aliases[obsolete], fs.realpathSync(path.join(core, 'node.js')));
    manifests({ [chord]: '0.1.0' });
    assert.equal(resolveHostPeerAliases(host).missing.includes(chord), true);
    assert.equal(resolveHostPeerAliases(host).missing.includes(chord + '/context'), true);
    fs.writeFileSync(path.join(host, 'package.json'), '{broken');
    assert.equal(resolveHostPeerAliases(host).missing.includes(chord), true, 'unreadable manifest fails closed');
});
