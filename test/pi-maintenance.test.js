const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const { ManagedLauncher } = require('../server/pi-managed-launcher');
const { backupRoots, readSafe, privateDir, atomicJson, hash } = require('../server/pi-maintenance-files');
const { stagePi, PI_PACKAGES, installEnvironment } = require('../server/pi-update-installer');
const { assertPrivateFile } = require('./private-file-helper.cjs');
function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-maintenance-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function client() {
    const sent = [], value = new MaintenanceClient({ managed: true, nonce: 'fixture-nonce', send: message => sent.push(message) });
    value.receive({ nonce: 'fixture-nonce', type: 'maintenance-status', status: { supported: true, updateSupported: true, busy: false, storage: '/fixture/private' } });
    value.receive({ nonce: 'fixture-nonce', type: 'maintenance-activate' });
    return { value, sent };
}
const confirmed = ticket => ({ ticket, confirmed: true, externalWritersStopped: true, draftsSaved: true });

test('maintenance backup preserves bytes, verifies hashes and permissions, and records links without following them', t => {
    const root = fixture(t), data = privateDir(path.join(root, 'data')), directory = path.join(root, 'backup');
    fs.writeFileSync(path.join(data, 'auth.json'), 'synthetic credential');
    fs.mkdirSync(path.join(data, 'sessions')); fs.writeFileSync(path.join(data, 'sessions/thread.jsonl'), '{"native":true}\n');
    if (process.platform !== 'win32') fs.symlinkSync('/not/copied', path.join(data, 'external'));
    const result = backupRoots([data, path.join(data, 'sessions')], directory);
    assert.equal(result.files, 2);
    const manifest = JSON.parse(readSafe(path.join(directory, 'manifest.json')));
    assert.equal(manifest.roots.length, 1);
    for (const entry of manifest.entries.filter(e => e.type === 'file')) {
        const object = path.join(directory, 'files', entry.object);
        assertPrivateFile(object); assert.equal(hash(fs.readFileSync(object)), entry.sha256);
        assert.deepEqual(fs.readFileSync(object), fs.readFileSync(entry.path));
    }
    assertPrivateFile(path.join(directory, 'manifest.json')); assertPrivateFile(path.join(directory, 'complete.json'));
    if (process.platform !== 'win32') { assert.equal(result.symlinks, 1); assert.equal(fs.statSync(directory).mode & 0o777, 0o700); }
    assert.equal(require('../public/pi-file-policy').restricted(path.join(root, '.pivane-runtime/releases/secret')), true);
});

test('backup budgets, overlap and file changes fail without a complete marker', t => {
    const root = fixture(t), data = privateDir(path.join(root, 'data')), file = path.join(data, 'record'); fs.writeFileSync(file, 'fixture');
    assert.throws(() => backupRoots([data], path.join(data, 'nested')), /overlap/);
    assert.throws(() => backupRoots([file], path.join(root, 'small'), { maxBytes: 1 }), /budget/);
    assert.equal(fs.existsSync(path.join(root, 'small/complete.json')), false);
    const original = fs.readSync; let changed = false;
    fs.readSync = (...args) => { const result = original(...args); if (!changed) { changed = true; fs.appendFileSync(file, 'change'); } return result; };
    try { assert.throws(() => backupRoots([file], path.join(root, 'changing')), /grew|changed/); }
    finally { fs.readSync = original; }
    assert.equal(fs.existsSync(path.join(root, 'changing/complete.json')), false);
    if (process.platform !== 'win32') {
        fs.symlinkSync(data, path.join(root, 'alias'));
        assert.throws(() => readSafe(path.join(root, 'alias/record')), /Unsafe/);
        assert.throws(() => privateDir(path.join(root, 'alias')), /symlink/);
    }
});

test('maintenance confirmation is single-use, version-bound, idle-checked and protected against late IPC', () => {
    const { value, sent } = client(); let paused = 0;
    const release = value.enter();
    assert.throws(() => value.review({ action: 'update', version: '0.85.1' }, () => true), /正在处理/); release();
    const ticket = value.review({ action: 'update', version: '0.85.1' }, () => true);
    assert.throws(() => value.execute({ ...confirmed(ticket.id), version: '9.0.0' }, { idle: () => true, pause() {} }), /确认/);
    assert.throws(() => value.execute(confirmed(ticket.id), { idle: () => false, pause() {} }), /正在处理/);
    const accepted = value.execute(confirmed(ticket.id), { idle: () => true, pause() { paused++; } });
    assert.equal(paused, 1); assert.equal(accepted.id, ticket.id); assert.equal(sent[0].version, '0.85.1'); assert.equal(value.locked, true);
    assert.throws(() => value.enter(), /维护/);
    assert.throws(() => value.execute(confirmed(ticket.id), { idle: () => true, pause() {} }), /失效/);
    for (const message of [{ type: 'maintenance-release', id: 'old' }, { type: 'maintenance-rejected', id: 'old' },
        { type: 'maintenance-status', status: { job: { id: 'old' }, busy: false } }]) value.receive({ nonce: 'fixture-nonce', ...message });
    value.receive({ nonce: 'wrong', type: 'maintenance-activate' }); assert.equal(value.locked, true);
    value.receive({ nonce: 'fixture-nonce', type: 'maintenance-release', id: ticket.id }); assert.equal(value.locked, false);
});

test('failed schedule pause never submits; unknown handoff never unlocks or replays', () => {
    const { value, sent } = client();
    const first = value.review({ action: 'backup' }, () => true);
    assert.throws(() => value.execute(confirmed(first.id), { idle: () => true, pause() { throw Error('synthetic'); } }), /暂停失败/);
    assert.equal(value.locked, false); assert.equal(sent.length, 0);
    const second = value.review({ action: 'restart' }, () => true); value.send = () => { throw Error('disconnected'); };
    assert.throws(() => value.execute(confirmed(second.id), { idle: () => true, pause() {} }), /未知/);
    assert.equal(value.locked, true);
});

test('RPC disposal is shared and waits for the actual exit after SIGKILL', async t => {
    const { EventEmitter } = require('node:events');
    const { PiRpcClient } = require('../server/pi-rpc-client');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = new EventEmitter(), signals = [];
    Object.assign(child, { pid: 123, exitCode: null, signalCode: null, kill: signal => { signals.push(signal); return true; } });
    const rpc = new PiRpcClient({ cwd: process.cwd() }); rpc.child = child;
    let finished = false; const stopping = rpc.dispose(); stopping.then(() => { finished = true; });
    assert.equal(rpc.dispose(), stopping); assert.deepEqual(signals, ['SIGTERM']);
    t.mock.timers.tick(2500); await Promise.resolve();
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(finished, false);
    child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); await stopping; assert.equal(finished, true);
});

test('offline restore verifies metadata, preserves post-update data and restores original native bytes', async t => {
    const root = fixture(t); packageFixture(root);
    const data = privateDir(path.join(root, 'data')), file = path.join(data, 'session.jsonl');
    fs.writeFileSync(file, 'original native bytes\n');
    const id = randomUUID(), directory = path.join(root, '.pivane-runtime/backups', id);
    backupRoots([data], directory);
    const { recordInstallation } = require('../server/pi-maintenance-files');
    recordInstallation(directory, { release: null, package: JSON.parse(readSafe(path.join(root, 'package.json'))), lock: {} });
    const { inspectBackup, restoreBackup } = require('../server/pi-maintenance-restore');
    assert.equal(inspectBackup(root, id).files, 1);
    fs.writeFileSync(file, 'post-update native bytes\n'); fs.writeFileSync(path.join(data, 'new-file'), 'new data');
    const result = await restoreBackup(root, id);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original native bytes\n'); assert.equal(fs.existsSync(path.join(data, 'new-file')), false);
    const saved = JSON.parse(readSafe(path.join(result.safetyBackup, 'manifest.json')));
    assert.ok(saved.entries.some(e => e.path.endsWith('new-file')));
    assert.equal(JSON.parse(readSafe(path.join(root, '.pivane-runtime/state.json'))).needsRecovery, false);
    fs.appendFileSync(path.join(directory, 'installation.json'), ' ');
    assert.throws(() => inspectBackup(root, id), /checksum/);
});

function packageFixture(root) {
    const original = require('../package.json');
    const piDir = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, 'package.json'), JSON.stringify({ version: original.dependencies['@earendil-works/pi-coding-agent'] }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...original, pivaneCompatibility: undefined }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
}

test('staged install pins the entire Pi family, uses no model credentials and verifies the exact installed lock', async t => {
    const root = fixture(t), dir = path.join(root, 'release'), calls = [];
    const result = await stagePi({ root, directory: dir, version: '0.85.1', env: { PATH: process.env.PATH, HOME: os.homedir(), OPENAI_API_KEY: 'must-not-pass', PI_WEB_TOKEN: 'must-not-pass' },
        copy(_root, target) { privateDir(target); packageFixture(target); privateDir(path.join(target, 'vendor')); atomicJson(path.join(target, 'vendor/manifest.json'), { version: 1, packages: [] }); },
        run: async (args, options) => {
            calls.push({ args, options }); assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.PI_WEB_TOKEN, undefined);
            if (calls.length === 1) {
                assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--registry=https://registry.npmjs.org'));
                const manifest = JSON.parse(readSafe(path.join(dir, 'package.json')));
                assert.equal(manifest.overrides['@earendil-works/pi-server'], undefined);
                for (const name of PI_PACKAGES) assert.equal(manifest.dependencies[name] || manifest.overrides[name],
                    manifest.overrides[name]?.startsWith('$') ? manifest.dependencies[name] : '0.85.1');
                assert.equal(manifest.overrides.undici, '8.11.2');
                assert.equal(manifest.overrides['brace-expansion'], '5.0.12');
                const packages = { '': { dependencies: manifest.dependencies } };
                for (const name of PI_PACKAGES) { const p = privateDir(path.join(dir, 'node_modules', name)); atomicJson(path.join(p, 'package.json'), { version: '0.85.1' }); packages['node_modules/' + name] = { version: '0.85.1' }; }
                atomicJson(path.join(dir, 'package-lock.json'), { packages });
            } else if (args.includes('rebuild')) {
                assert.ok(!args.includes('better-sqlite3')); assert.ok(args.includes('esbuild'));
            } else if (args[0].endsWith('install-bundled-capabilities.cjs')) {
                assert.equal(options.cwd, dir);
            } else { assert.ok(options.env.PI_UPDATE_PROBE.startsWith(dir)); assert.equal(options.env.PI_OFFLINE, '1'); }
        } });
    assert.equal(result, dir); assert.equal(calls.length, 4); assert.ok(fs.existsSync(path.join(dir, 'PI_INSTALL_COMPLETE.json')));
    await assert.rejects(stagePi({ root, directory: path.join(root, 'bad'), version: 'latest' }), /exact/);
    let installCalled = false;
    await assert.rejects(stagePi({ root, directory: path.join(root, 'bound'), version: '0.99.2',
        copy(_root, target) { privateDir(target); atomicJson(path.join(target, 'package.json'), require('../package.json')); },
        run: async () => { installCalled = true; } }), /bound/);
    assert.equal(installCalled, false, 'a bound release never installs an unreviewed Pi version');
    const envDir = privateDir(path.join(root, 'env'));
    const env = installEnvironment({ PATH: 'fixture', npm_config_token: 'secret', NODE_OPTIONS: 'bad', HTTPS_PROXY: 'http://localhost:1' }, envDir);
    assert.equal(env.npm_config_token, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.HTTPS_PROXY, 'http://localhost:1');
});

test('launcher stages first, waits for actual exit, backs up before activation and preserves the old installation', async t => {
    const root = fixture(t); packageFixture(root);
    const data = privateDir(path.join(root, 'data')); fs.writeFileSync(path.join(data, 'native.jsonl'), 'fixture');
    const events = [], launcher = new ManagedLauncher({ root, stage: async ({ directory }) => { events.push('stage'); privateDir(directory); packageFixture(directory); },
        backup: (inputs, directory) => { events.push('backup'); assert.equal(launcher.child, null); return backupRoots(inputs, directory); } });
    launcher.status = () => ({ supported: true, updateSupported: true, busy: Boolean(launcher.operation), job: launcher.state.job });
    launcher.send = message => events.push(message.type);
    launcher.backupInputs = [data]; launcher.child = {};
    let exit; launcher.stopChild = () => new Promise(resolve => { events.push('stop'); exit = () => { launcher.child = null; resolve(); }; });
    launcher.boot = async id => { events.push('boot:' + id); launcher.child = {}; };
    const id = randomUUID(); const operation = launcher.execute({ id, action: 'update', version: '0.85.1' });
    while (!exit) await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes('backup'), false);
    await launcher.execute({ id: randomUUID(), action: 'restart' }); assert.equal(events.includes('maintenance-rejected'), true);
    exit(); await operation;
    assert.equal(launcher.state.active, id); assert.equal(launcher.state.job.phase, 'succeeded');
    assert.ok(events.indexOf('backup') < events.indexOf('boot:' + id)); assert.ok(fs.existsSync(path.join(root, 'package.json')));
    assert.equal(launcher.operation, null);
});

test('installation and backup failures retain the original release and never replay the operation', async t => {
    for (const phase of ['installing', 'backing-up']) {
        const root = privateDir(path.join(fixture(t), phase)); packageFixture(root); const calls = [];
        const launcher = new ManagedLauncher({ root, env: { PI_WEB_TOKEN: 'private failure' }, stage: async () => { if (phase === 'installing') throw Error('private failure'); }, backup: () => { throw Error('private backup failure'); } });
        launcher.status = () => ({ supported: true, updateSupported: true }); launcher.send = () => {};
        launcher.child = {}; launcher.backupInputs = [path.join(root, 'package.json')];
        launcher.stopChild = async () => { calls.push('stop'); launcher.child = null; };
        launcher.boot = async id => { calls.push('boot'); assert.equal(id, null); launcher.child = {}; };
        await launcher.execute({ id: randomUUID(), action: phase === 'installing' ? 'update' : 'backup', version: '0.85.1' });
        assert.equal(launcher.state.active, null); assert.equal(launcher.state.job.phase, 'failed'); assert.equal(launcher.state.job.error, phase);
        assert.deepEqual(calls, phase === 'installing' ? [] : ['stop', 'boot']);
        assert.ok(!JSON.stringify(launcher.state).includes('private failure'));
    }
});

test('application startup failure waits for candidate exit and boots retained release', async t => {
    const root = fixture(t); packageFixture(root);
    const events = [], launcher = new ManagedLauncher({ root, env: {}, stageApp: async () => { events.push('stage'); } });
    launcher.send = () => {}; launcher.child = {};
    launcher.backupInputs = [path.join(root, 'package.json')];
    launcher.stopChild = async () => { events.push('exit'); launcher.child = null; };
    launcher.boot = async id => { events.push(id ? 'candidate' : 'previous'); launcher.child = {}; if (id) throw Error('synthetic startup failure'); };
    await launcher.execute({ id: randomUUID(), action: 'application', version: '1.2.3', release: { version: '1.2.3', sha256: 'a'.repeat(64) } });
    assert.deepEqual(events, ['stage', 'exit', 'candidate', 'exit', 'previous']);
    assert.equal(launcher.state.active, null); assert.equal(launcher.state.job.phase, 'failed'); assert.ok(launcher.state.job.backup);
});

test('application tickets preserve reviewed hash and reject browser overrides', () => {
    const { value, sent } = client(); value.state.appUpdateSupported = true;
    const release = { version: '1.2.3', sha256: 'a'.repeat(64) };
    const ticket = value.review({ action: 'application', version: release.version, release }, () => true);
    release.sha256 = 'b'.repeat(64);
    assert.throws(() => value.execute({ ...confirmed(ticket.id), release }, { idle: () => true, pause() {} }), /确认/);
    value.execute(confirmed(ticket.id), { idle: () => true, pause() {} });
    assert.equal(sent[0].release.sha256, 'a'.repeat(64));
});

test('launcher restart marks interrupted work without replay and does not mutate state before owning the process lock', t => {
    const root = fixture(t); packageFixture(root); const launcher = new ManagedLauncher({ root });
    const saved = { version: 1, active: null, previous: null, job: { id: randomUUID(), phase: 'installing', action: 'update' } };
    atomicJson(launcher.stateFile, saved);
    const another = new ManagedLauncher({ root });
    assert.deepEqual(JSON.parse(readSafe(launcher.stateFile)), saved);
    another.loadState(); assert.equal(another.state.job.phase, 'interrupted'); assert.equal(another.operation, null);
});

const retention = require('../server/pi-managed-retention');
const { fixture: retentionFixture } = require('./fixtures/retention.cjs');

test('retention limits default to five releases and three backups, accept off and reject unsafe values', () => {
    assert.deepEqual(retention.retentionLimits({}), { releases: 5, backups: 3 });
    assert.deepEqual(retention.retentionLimits({ PIVANE_RETAIN_RELEASES: '8', PIVANE_RETAIN_BACKUPS: 'off' }), { releases: 8, backups: null });
    assert.deepEqual(retention.retentionLimits({ PIVANE_RETAIN_RELEASES: '1', PIVANE_RETAIN_BACKUPS: '0' }), { releases: 5, backups: 3 });
    assert.deepEqual(retention.retentionLimits({ PIVANE_RETAIN_RELEASES: '-3', PIVANE_RETAIN_BACKUPS: '2.5' }), { releases: 5, backups: 3 });
});

test('retention keeps newest releases, active, previous and every release a retained backup needs', t => {
    const { runtime, release, backup } = retentionFixture(t);
    const ids = Array.from({ length: 9 }, () => release());
    const staging = release(false);
    const oldBackup = backup(ids[0]), currentBackup = backup(ids[4]);
    const kept = [backup(ids[1]), backup(null), backup(ids[2])];
    const interrupted = backup(null, false); kept.push(backup(ids[3]));
    const state = { version: 1, active: ids[4], previous: ids[0], job: null };
    atomicJson(path.join(runtime, 'state.json'), state);
    const plan = retention.planRetention(runtime, state);
    assert.deepEqual(new Set(plan.keepBackups), new Set([oldBackup, currentBackup, ...kept.slice(1)]));
    assert.deepEqual(new Set(plan.removeBackups), new Set([kept[0]]));
    // Newest five (4..8) plus previous (0) and backup dependencies (2, 3); 1 is only needed by a removed backup.
    assert.deepEqual(new Set(plan.keepReleases), new Set([ids[0], ids[2], ids[3], ...ids.slice(4)]));
    assert.deepEqual(plan.removeReleases, [ids[1]]);
    assert.deepEqual(plan.incompleteReleases, [staging]);
    assert.ok(plan.incompleteBackups.includes(interrupted));
    // A partial backup newer than every complete backup may still be in progress and is not removed.
    const newest = backup(null, false);
    assert.ok(retention.planRetention(runtime, state).incompleteBackups.includes(newest));
    assert.throws(() => retention.planRetention(runtime, { ...state, needsRecovery: true }), /settled/);
});

test('launcher retention moves old items to trash, purges them and stops when state changes', { skip: process.platform !== 'linux' }, async t => {
    const { root, runtime, release, backup } = retentionFixture(t);
    const ids = Array.from({ length: 7 }, () => release());
    const backups = ids.map(id => backup(id));
    const launcher = new ManagedLauncher({ root, env: {} });
    launcher.state = { version: 1, active: ids[6], previous: ids[0], job: null }; atomicJson(launcher.stateFile, launcher.state);
    const changed = { ...launcher.state, previous: ids[1] }; atomicJson(launcher.stateFile, changed);
    await launcher.cleanup();
    assert.equal(fs.readdirSync(path.join(runtime, 'backups')).length, 7, 'a changed state stops retention before removal');
    assert.ok(launcher.lastRetention.error);
    atomicJson(launcher.stateFile, launcher.state);
    await launcher.cleanup();
    assert.deepEqual(new Set(fs.readdirSync(path.join(runtime, 'backups'))), new Set([backups[0], ...backups.slice(4)]));
    // Newest five (2..6) plus previous (0); 4..6 also back retained backups.
    assert.deepEqual(new Set(fs.readdirSync(path.join(runtime, 'releases'))), new Set([ids[0], ...ids.slice(2)]));
    assert.deepEqual(fs.readdirSync(path.join(runtime, retention.TRASH)), []);
    assert.equal(launcher.lastRetention.quarantinedReleases, 1); assert.equal(launcher.lastRetention.quarantinedBackups, 3);
    assert.equal(launcher.releasePath(ids[6]), path.join(runtime, 'releases', ids[6]));
});

test('a successful maintenance backup applies retention after the new backup completes', { skip: process.platform !== 'linux' }, async t => {
    const { root, runtime, backup } = retentionFixture(t);
    const old = [backup(null), backup(null), backup(null), backup(null)];
    const data = privateDir(path.join(root, 'data')); fs.writeFileSync(path.join(data, 'native.jsonl'), 'fixture');
    const launcher = new ManagedLauncher({ root, env: {} });
    launcher.send = () => {}; launcher.backupInputs = [data]; launcher.child = {};
    launcher.stopChild = async () => { launcher.child = null; };
    launcher.boot = async () => { launcher.child = {}; };
    const id = randomUUID(); await launcher.execute({ id, action: 'backup' });
    assert.equal(launcher.state.job.phase, 'succeeded');
    assert.deepEqual(new Set(fs.readdirSync(path.join(runtime, 'backups'))), new Set([...old.slice(2), id]));
    assert.match(launcher.state.job.output, /Retention: kept/);
});

test('shared native verification budget bounds actual bytes read across multiple grown backup objects and preserves valid restore controls', t => {
    const { inspectBackupContents } = require('../server/pi-maintenance-backup');
    const { inspectBackup } = require('../server/pi-maintenance-restore');
    const { recordInstallation } = require('../server/pi-maintenance-files');
    const { descriptorPathSync } = require('../server/pi-file-descriptor');
    const root = fixture(t); packageFixture(root);
    const data = path.join(root, 'one-byte'); fs.writeFileSync(data, 'x');
    const objects = new Set(), directories = [];
    for (let i = 0; i < 4; i++) {
        const id = randomUUID(), dir = path.join(root, '.pivane-runtime/backups', id);
        backupRoots([data], dir);
        recordInstallation(dir, { release: null, package: JSON.parse(readSafe(path.join(root, 'package.json'))), lock: {} });
        directories.push({ id, dir }); objects.add(path.join(dir, 'files/00000000'));
    }
    const originalRead = fs.readSync; let actualBytes = 0;
    t.mock.method(fs, 'readSync', function(fd, ...args) {
        const isObject = objects.has(descriptorPathSync(fd));
        const count = originalRead(fd, ...args); if (isObject) actualBytes += count; return count;
    });
    const controlBudget = { bytes: 3, entries: 20 };
    for (const { dir, id } of directories.slice(0, 2)) {
        assert.equal(inspectBackupContents(dir, controlBudget).bytes, 1);
        assert.equal(inspectBackup(root, id).files, 1);
    }
    assert.equal(actualBytes, 4, 'two valid bounded proofs and two native restore inspections read one byte each');
    actualBytes = 0;
    const sharedBudget = { bytes: 3, entries: 20 };
    for (const { dir } of directories.slice(2)) {
        fs.appendFileSync(path.join(dir, 'files/00000000'), 'abc');
        assert.throws(() => inspectBackupContents(dir, sharedBudget), /Unsafe backup object|checksum|changed/);
        assert.equal(fs.statSync(path.join(dir, 'files/00000000')).size, 4, 'corrupt backup is preserved');
    }
    assert.equal(sharedBudget.bytes, 1, 'both failed proofs charge their declared byte before attempting data reads');
    t.diagnostic(JSON.stringify({ sharedBudget: 3, chargedDeclaredBytes: 2, actualGrownObjectBytesRead: actualBytes, attemptedProofs: 2 }));
    assert.ok(actualBytes <= 2, 'actual object reads cannot exceed the declared bytes charged to the shared budget');
});

test('backup hash limits actual read requests after descriptor fstat growth and rejects short reads without weakening identity checks', t => {
    const { hashFileSafe } = require('../server/pi-maintenance-files');
    const { descriptorPathSync } = require('../server/pi-file-descriptor');
    const root = fixture(t), file = path.join(root, 'object'); fs.writeFileSync(file, 'x');
    const originalStat = fs.fstatSync, originalRead = fs.readSync; let changed = false, actualBytes = 0, requestedBytes = 0;
    t.mock.method(fs, 'fstatSync', function(fd, ...args) {
        const stat = originalStat(fd, ...args);
        if (!changed && descriptorPathSync(fd) === file) { changed = true; fs.appendFileSync(file, 'abc'); }
        return stat;
    });
    t.mock.method(fs, 'readSync', function(fd, buffer, offset, length, position) {
        const isObject = descriptorPathSync(fd) === file;
        if (isObject) requestedBytes += length;
        const count = originalRead(fd, buffer, offset, length, position); if (isObject) actualBytes += count; return count;
    });
    assert.throws(() => hashFileSafe(file, 1), /changed/);
    t.diagnostic(JSON.stringify({ approvedDescriptorBytes: 1, grownPhysicalBytes: 4, actualBytesRead: actualBytes, requestedBytes }));
    assert.equal(actualBytes, 1); assert.equal(requestedBytes, 1);
    fs.writeFileSync(file, 'abcd'); changed = false; actualBytes = 0;
    fs.fstatSync.mock.restore();
    t.mock.method(fs, 'fstatSync', function(fd, ...args) {
        const stat = originalStat(fd, ...args);
        if (!changed && descriptorPathSync(fd) === file) { changed = true; fs.truncateSync(file, 1); }
        return stat;
    });
    assert.throws(() => hashFileSafe(file, 4), /changed/);
    assert.equal(actualBytes, 1);
});
