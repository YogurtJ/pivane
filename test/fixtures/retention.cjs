const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { privateDir, atomicJson, backupRoots, recordInstallation, hash, readSafe } = require('../../server/pi-maintenance-files');
const { PI_PACKAGES } = require('../../server/pi-update-installer');
function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-retention-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = privateDir(path.join(root, '.pivane-runtime'));
    for (const kind of ['releases', 'backups']) privateDir(path.join(runtime, kind));
    const pkg = { name: 'pivane', version: '1.8.0', dependencies: Object.fromEntries(PI_PACKAGES.map(n => [n, '1.2.0'])) };
    const lock = { version: pkg.version, packages: { '': { version: pkg.version, dependencies: pkg.dependencies }, ...Object.fromEntries(PI_PACKAGES.map(n => ['node_modules/' + n, { version: '1.2.0' }])) } };
    function install(dir) {
        privateDir(dir); atomicJson(path.join(dir, 'package.json'), pkg); atomicJson(path.join(dir, 'package-lock.json'), lock);
        for (const name of PI_PACKAGES) { const target = privateDir(path.join(dir, 'node_modules', name)); atomicJson(path.join(target, 'package.json'), { version: '1.2.0' }); }
    }
    install(root);
    let clock = Date.now() / 1000 - 100000;
    const tick = file => fs.utimesSync(file, clock += 60, clock);
    function release(complete = true) {
        const id = randomUUID(), dir = path.join(runtime, 'releases', id); install(dir);
        const marker = path.join(dir, 'PI_INSTALL_COMPLETE.json');
        if (complete) atomicJson(marker, { version: '1.2.0', completedAt: new Date().toISOString(), lockSha256: hash(readSafe(path.join(dir, 'package-lock.json'))) }); if (complete) tick(marker);
        return id;
    }
    const data = privateDir(path.join(root, 'data')); fs.writeFileSync(path.join(data, 'native.jsonl'), 'synthetic native bytes\n');
    function backup(releaseId = null, complete = true) {
        const id = randomUUID(), dir = privateDir(path.join(runtime, 'backups', id));
        if (complete) { backupRoots([data], dir); recordInstallation(dir, { release: releaseId, package: pkg, lock }); tick(path.join(dir, 'complete.json')); }
        tick(dir); return id;
    }
    function state(active = null, previous = null) { const value = { version: 1, active, previous, job: null }; atomicJson(path.join(runtime, 'state.json'), value); return value; }
    return { root, runtime, release, backup, state, pkg, lock, data };
}

module.exports = { fixture };
