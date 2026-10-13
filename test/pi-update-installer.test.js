'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stagePi, PI_PACKAGES, piPackageNames, verifyPiPackages } = require('../server/pi-update-installer');
const { privateDir, atomicJson, readSafe } = require('../server/pi-maintenance-files');

const legacyPackages = ['chord', 'pi-protocol', 'pi-server'].map(name => '@earendil-works/' + name);
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-pi-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function installed(root, manifest, version) {
    const lock = { packages: { '': { dependencies: manifest.dependencies } } };
    for (const name of piPackageNames(manifest)) {
        atomicJson(path.join(privateDir(path.join(root, 'node_modules', name)), 'package.json'), { version });
        lock.packages['node_modules/' + name] = { version };
    }
    atomicJson(path.join(root, 'package-lock.json'), lock);
    return lock;
}
function legacyManifest() {
    return { dependencies: {
        '@earendil-works/pi-coding-agent': '0.84.3', '@earendil-works/pi-ai': '0.84.3', '@earendil-works/pi-server': '0.84.3',
    }, overrides: {
        '@earendil-works/pi-tui': '0.84.3', '@earendil-works/pi-ai': '$@earendil-works/pi-ai',
        '@earendil-works/pi-server': {
            '@earendil-works/chord': '0.84.3', '@earendil-works/pi-agent-core': '0.84.3',
            '@earendil-works/pi-protocol': '0.84.3', '@earendil-works/pi-ai': '0.84.3',
        }, undici: '8.11.2', 'brace-expansion': '5.0.12',
    } };
}

test('current bound Pi install verifies all seven packages without retired experimental dependencies', async t => {
    const root = fixture(t), manifest = require('../package.json'), calls = [];
    assert.deepEqual(new Set(piPackageNames(manifest)), new Set(PI_PACKAGES));
    for (const name of legacyPackages) assert.equal(manifest.dependencies[name] || manifest.overrides[name], undefined);
    await stagePi({ root, directory: root, version: '1.2.0', env: { PATH: process.env.PATH },
        copy(_root, directory) { atomicJson(path.join(directory, 'package.json'), manifest); },
        run: async args => {
            calls.push(args);
            if (calls.length === 1) installed(root, JSON.parse(readSafe(path.join(root, 'package.json'))), '1.2.0');
        } });
    assert.equal(calls.length, 2, 'installation and credential-free probe run');
    assert.ok(fs.existsSync(path.join(root, 'PI_INSTALL_COMPLETE.json')));
});

test('historical Pi server overrides remain bounded to their declared packages and preserve security pins', async t => {
    const root = fixture(t), original = legacyManifest();
    let calls = 0;
    await stagePi({ root, directory: root, version: '0.85.1', env: { PATH: process.env.PATH },
        copy(_root, directory) { atomicJson(path.join(directory, 'package.json'), original); },
        run: async () => {
            if (++calls !== 1) return;
            const manifest = JSON.parse(readSafe(path.join(root, 'package.json')));
            assert.equal(manifest.overrides.undici, '8.11.2');
            assert.equal(manifest.overrides['brace-expansion'], '5.0.12');
            assert.equal(manifest.overrides['@earendil-works/pi-ai'], '$@earendil-works/pi-ai');
            assert.ok(Object.values(manifest.overrides['@earendil-works/pi-server']).every(value => value === '0.85.1'));
            assert.equal(manifest.overrides['@earendil-works/pi-codemode'], undefined, 'do not invent dependencies in older archives');
            installed(root, manifest, '0.85.1');
        } });
    assert.equal(calls, 2);
});

test('unknown official declarations and overrides fail before installation', async t => {
    for (const mutate of [
        manifest => { manifest.dependencies['@earendil-works/unknown'] = '1.2.0'; },
        manifest => { manifest.dependencies['@earendil-works/pi-ai'] = '^1.2.0'; },
        manifest => { manifest.overrides['@earendil-works/pi-tui'] = { unrelated: '1.2.0' }; },
        manifest => { manifest.overrides['@earendil-works/pi-ai'] = '$unrelated'; },
        manifest => { manifest.overrides['@earendil-works/pi-server'].undici = '8.11.2'; },
    ]) {
        const root = fixture(t), manifest = legacyManifest(); mutate(manifest);
        await assert.rejects(stagePi({ root, directory: root, version: '0.85.1',
            copy(_root, directory) { atomicJson(path.join(directory, 'package.json'), manifest); },
            run: async () => assert.fail('unknown layout must never run npm') }), /Unknown Pi/);
    }
});

test('Pi verification rejects stale transitive versions, root declarations and physical nested copies', t => {
    const root = fixture(t), manifest = structuredClone(require('../package.json'));
    const lock = installed(root, manifest, '1.2.0');
    verifyPiPackages(root, manifest, lock, '1.2.0');
    for (const name of PI_PACKAGES) {
        const location = 'node_modules/' + name;
        const staleLock = structuredClone(lock); staleLock.packages[location].version = '1.1.0';
        assert.throws(() => verifyPiPackages(root, manifest, staleLock, '1.2.0'), /does not match/);
        atomicJson(path.join(root, location, 'package.json'), { version: '1.1.0' });
        assert.throws(() => verifyPiPackages(root, manifest, lock, '1.2.0'), /does not match/);
        atomicJson(path.join(root, location, 'package.json'), { version: '1.2.0' });
    }
    const staleRoot = structuredClone(lock); staleRoot.packages[''].dependencies['@earendil-works/pi-ai'] = '1.1.0';
    assert.throws(() => verifyPiPackages(root, manifest, staleRoot, '1.2.0'), /does not match/);
    for (const name of legacyPackages) {
        const staleLock = structuredClone(lock); staleLock.packages['node_modules/' + name] = { version: '1.2.0' };
        assert.throws(() => verifyPiPackages(root, manifest, staleLock, '1.2.0'), /Unexpected installed/);
    }
    const nested = 'node_modules/other/node_modules/@earendil-works/pi-ai';
    lock.packages[nested] = { version: '1.1.0' };
    assert.throws(() => verifyPiPackages(root, manifest, lock, '1.2.0'), /Unexpected installed/);
    lock.packages[nested].version = '1.2.0';
    atomicJson(path.join(privateDir(path.join(root, nested)), 'package.json'), { version: '1.1.0' });
    assert.throws(() => verifyPiPackages(root, manifest, lock, '1.2.0'), /does not match/);
});
