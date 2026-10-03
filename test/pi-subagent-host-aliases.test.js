const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const obsolete = '@earendil-works/pi-agent-core/node';

test('detached host aliases retain real dependency scope with Pi 1.0 native hook', () => {
    const code = `import {resolveHostPeerAliases} from './vendor/pi-subagents/src/runs/background/runner-aliases.js';
        const result=resolveHostPeerAliases(process.cwd()+'/node_modules/@earendil-works/pi-coding-agent');
        for (const [name,file] of Object.entries(result.aliases)) await import((await import('node:url')).pathToFileURL(file).href);
        console.log(JSON.stringify(result));`;
    const child = spawnSync(process.execPath, ['--import', './server/pi-subagent-native-loader.mjs', '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.deepEqual(result.missing, []);
    assert.equal(Object.hasOwn(result.aliases, obsolete), false);
    for (const file of Object.values(result.aliases)) {
        assert.equal(fs.realpathSync(file), file);
        assert.equal(file.startsWith(path.join(root, 'node_modules') + path.sep), true);
    }
});

test('host compatibility exception cannot hide other missing aliases or unknown host versions', async t => {
    const { resolveHostPeerAliases } = await import(pathToFileURL(path.join(root, 'server/pi-subagent-host-aliases.mjs')));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-host-alias-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const host = path.join(temp, 'host');
    const core = path.join(host, 'node_modules/@earendil-works/pi-agent-core');
    fs.mkdirSync(core, { recursive: true });
    function manifests(hostVersion, coreVersion, nodeExport) {
        fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: hostVersion, exports: { '.': './index.js' } }));
        const exports = { '.': './index.js' };
        if (nodeExport !== undefined) exports['./node'] = nodeExport;
        fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-agent-core', version: coreVersion, exports }));
        fs.writeFileSync(path.join(host, 'index.js'), ''); fs.writeFileSync(path.join(core, 'index.js'), '');
    }
    manifests('1.0.0', '1.0.0');
    const known = resolveHostPeerAliases(host);
    assert.equal(known.missing.includes(obsolete), false);
    assert.equal(known.missing.includes('@earendil-works/pi-tui'), true);
    for (const versions of [['1.0.1', '1.0.0'], ['1.0.0', '1.0.1'], ['0.99.1', '0.99.1']]) {
        manifests(...versions);
        assert.equal(resolveHostPeerAliases(host).missing.includes(obsolete), true);
    }
    manifests('1.0.0', '1.0.0', null);
    assert.equal(resolveHostPeerAliases(host).missing.includes(obsolete), true);
    manifests('1.0.0', '1.0.0', './missing.js');
    assert.equal(resolveHostPeerAliases(host).missing.includes(obsolete), true);
});
