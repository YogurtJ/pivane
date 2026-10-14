const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const retention = require('../server/pi-managed-retention');
const { privateDir, atomicJson, backupRoots, recordInstallation, hash, readSafe } = require('../server/pi-maintenance-files');
const { PI_PACKAGES } = require('../server/pi-update-installer');
const { fixture } = require('./fixtures/retention.cjs');
const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' && 'Linux descriptor deletion boundary' }, fn);

test('retention preserves partial backups when no genuine complete restore point exists', t => {
    const f = fixture(t), id = f.backup(null, false), state = f.state();
    const plan = retention.planRetention(f.runtime, state);
    assert.deepEqual(plan.removeBackups, []);
    assert.ok(plan.incompleteBackups.includes(id));
});

test('retention preserves current and previous native restore backups beyond caps', t => {
    const f = fixture(t), previous = f.release(), active = f.release();
    const older = [f.backup(previous), f.backup(active)];
    for (let i = 0; i < 4; i++) f.backup(null);
    const plan = retention.planRetention(f.runtime, f.state(active, previous), { releases: 2, backups: 1 });
    for (const id of older) assert.ok(plan.keepBackups.includes(id));
});

function removable(t) {
    const f = fixture(t), releases = Array.from({ length: 4 }, () => f.release());
    const backups = Array.from({ length: 4 }, () => f.backup(null));
    const state = f.state(), limits = { releases: 2, backups: 1 };
    const plan = retention.planRetention(f.runtime, state, limits);
    assert.equal(plan.removeReleases.length, 2); assert.equal(plan.removeBackups.length, 3);
    return { ...f, releases, backups, currentState: state, limits, plan };
}
function quarantine(t) {
    const f = removable(t); f.moved = retention.moveToTrash(f.runtime, f.plan, f.currentState);
    f.trash = path.join(f.runtime, retention.TRASH); return f;
}
function slots(f, kind) { return fs.readdirSync(f.trash).filter(n => !kind || n.startsWith(kind + '-')).map(n => path.join(f.trash, n)); }

linuxTest('verified Linux pruning removes only genuine eligible releases/backups and unlinks nested links without following them', async t => {
    if (process.platform !== 'linux') return t.skip('Linux destructive boundary');
    const f = removable(t), outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(f.runtime, 'releases', f.plan.removeReleases[0], 'link'));
    f.plan = retention.planRetention(f.runtime, f.currentState, f.limits);
    const moved = retention.moveToTrash(f.runtime, f.plan, f.currentState);
    assert.equal(moved.releases.length, 2); assert.equal(moved.backups.length, 3);
    assert.equal(await retention.purgeTrash(f.runtime, f.limits), 5);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(path.join(f.runtime, retention.TRASH)), []);
    assert.equal(fs.readdirSync(path.join(f.runtime, 'releases')).length, 2);
    assert.equal(fs.readdirSync(path.join(f.runtime, 'backups')).length, 1);
});

linuxTest('off and per-kind limits govern queued quarantine and unknown old trash is preserved', async t => {
    const f = quarantine(t), unknown = privateDir(path.join(f.trash, 'backups-' + randomUUID()));
    fs.writeFileSync(path.join(unknown, 'keep'), 'unknown');
    assert.equal(await retention.purgeTrash(f.runtime, { releases: null, backups: null }), 0);
    assert.equal(slots(f).length, 6);
    assert.equal(await retention.purgeTrash(f.runtime, { releases: null, backups: 1 }), 3);
    assert.equal(slots(f, 'releases').length, 2); assert.ok(fs.existsSync(unknown));
    assert.equal(await retention.purgeTrash(f.runtime, { releases: 2, backups: null }), 2);
    assert.ok(fs.existsSync(path.join(unknown, 'keep')));
});

for (const corruption of ['object', 'manifest', 'counts', 'installation', 'marker', 'lock']) {
    linuxTest(`corrupt ${corruption} proof never establishes deletion eligibility or a protected restore point`, t => {
        const f = removable(t), id = f.backups.at(-1), dir = path.join(f.runtime, 'backups', id);
        if (corruption === 'object') fs.appendFileSync(path.join(dir, 'files', '00000000'), 'changed');
        if (corruption === 'manifest') fs.appendFileSync(path.join(dir, 'manifest.json'), ' ');
        if (corruption === 'installation') fs.appendFileSync(path.join(dir, 'installation.json'), ' ');
        if (corruption === 'counts') { const complete = JSON.parse(readSafe(path.join(dir, 'complete.json'))); complete.files++; atomicJson(path.join(dir, 'complete.json'), complete); }
        if (corruption === 'marker') atomicJson(path.join(f.runtime, 'releases', f.releases[0], 'PI_INSTALL_COMPLETE.json'), {});
        if (corruption === 'lock') fs.appendFileSync(path.join(f.runtime, 'releases', f.releases[0], 'package-lock.json'), ' ');
        const plan = retention.planRetention(f.runtime, f.currentState, f.limits);
        if (['marker', 'lock'].includes(corruption)) {
            assert.ok(plan.incompleteReleases.includes(f.releases[0])); assert.ok(!plan.removeReleases.includes(f.releases[0]));
        } else {
            assert.ok(plan.incompleteBackups.includes(id)); assert.ok(!plan.removeBackups.includes(id));
        }
        assert.throws(() => retention.moveToTrash(f.runtime, f.plan, f.currentState), /proofs changed/);
    });
}

linuxTest('no verified current/previous backup stops all removal; older valid corresponding backups survive corruption and numeric caps', t => {
    const f = fixture(t), previous = f.release(), active = f.release();
    const previousBackup = f.backup(previous), activeBackup = f.backup(active), corrupt = f.backup(active);
    fs.appendFileSync(path.join(f.runtime, 'backups', corrupt, 'files', '00000000'), 'corrupt');
    for (let i = 0; i < 4; i++) f.backup(null);
    const state = f.state(active, previous), limits = { releases: 2, backups: 1 };
    let plan = retention.planRetention(f.runtime, state, limits);
    assert.ok(plan.keepBackups.includes(previousBackup)); assert.ok(plan.keepBackups.includes(activeBackup));
    assert.ok(plan.incompleteBackups.includes(corrupt));
    fs.appendFileSync(path.join(f.runtime, 'backups', previousBackup, 'installation.json'), ' ');
    plan = retention.planRetention(f.runtime, state, limits);
    assert.equal(plan.skipped, 'missing-current-or-previous-restore-backup');
    assert.deepEqual(plan.removeBackups, []); assert.deepEqual(plan.removeReleases, []);
});

test('a retained backup protects its older corresponding release outside the release cap', t => {
    const f = fixture(t), oldest = f.release();
    for (let i = 0; i < 5; i++) f.release();
    f.backup(oldest); f.backup(null);
    const plan = retention.planRetention(f.runtime, f.state(), { releases: 2, backups: 3 });
    assert.ok(plan.keepReleases.includes(oldest)); assert.ok(!plan.removeReleases.includes(oldest));
});

test('partial, unknown, linked and in-progress items are preserved even with newer complete native backups', t => {
    const f = removable(t), partial = f.backup(null, false), linked = randomUUID();
    const outside = privateDir(path.join(f.root, 'outside')); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.symlinkSync(outside, path.join(f.runtime, 'backups', linked));
    privateDir(path.join(f.runtime, 'releases', 'external-staging'));
    const plan = retention.planRetention(f.runtime, f.currentState, f.limits);
    assert.ok(plan.incompleteBackups.includes(partial)); assert.ok(!plan.removeBackups.includes(linked));
    assert.throws(() => retention.planRetention(f.runtime, { ...f.currentState, job: { phase: 'backing-up' } }, f.limits), /settled/);
    assert.throws(() => retention.moveToTrash(f.runtime, { ...plan }, f.currentState), /verified plan/);
});

for (const replacement of ['state', 'runtime', 'parent', 'source']) {
    linuxTest(`stale ${replacement} stops quarantine before deleting or overwriting anything`, t => {
        const f = removable(t);
        if (replacement === 'state') atomicJson(path.join(f.runtime, 'state.json'), { ...f.currentState, revision: 2 });
        else {
            const target = replacement === 'runtime' ? f.runtime : replacement === 'parent' ? path.join(f.runtime, 'backups') : path.join(f.runtime, 'backups', f.plan.removeBackups[0]);
            fs.renameSync(target, target + '-old'); privateDir(target);
        }
        assert.throws(() => retention.moveToTrash(f.runtime, f.plan, f.currentState), /changed|ENOENT/);
        assert.equal(fs.existsSync(path.join(f.runtime, retention.TRASH)), false);
    });
}

linuxTest('exclusive quarantine slot collision stops before rename and never overwrites destination', t => {
    const f = removable(t), original = fs.mkdirSync; let sentinel;
    t.mock.method(fs, 'mkdirSync', function(dir, options) {
        const result = original(dir, options);
        if (String(dir).includes('/backups-') && String(dir).includes('/proc/self/fd/')) {
            original(String(dir) + '/item', { mode: 0o700 }); sentinel = String(dir) + '/item/sentinel'; fs.writeFileSync(sentinel, 'collision');
        }
        return result;
    });
    assert.throws(() => retention.moveToTrash(f.runtime, f.plan, f.currentState), /destination already exists/);
    const trash = path.join(f.runtime, retention.TRASH), slot = fs.readdirSync(trash)[0];
    assert.equal(fs.readFileSync(path.join(trash, slot, 'item/sentinel'), 'utf8'), 'collision');
    assert.ok(fs.existsSync(path.join(f.runtime, 'backups', f.plan.removeBackups[0])));
    assert.ok(sentinel);
});

linuxTest('source replacement in rename window is quarantined without proof and never purged', async t => {
    const f = removable(t), rename = fs.renameSync; let swapped = false;
    t.mock.method(fs, 'renameSync', function(source, target) {
        if (!swapped && String(target).endsWith('/item')) {
            swapped = true;
            rename(source, path.join(f.root, 'original-preserved'));
            fs.mkdirSync(source, { mode: 0o700 }); fs.writeFileSync(String(source) + '/foreign', 'keep');
        }
        return rename(source, target);
    });
    assert.throws(() => retention.moveToTrash(f.runtime, f.plan, f.currentState), /identity/);
    const trash = path.join(f.runtime, retention.TRASH), slot = fs.readdirSync(trash)[0];
    assert.equal(fs.existsSync(path.join(trash, slot, 'proof.json')), false);
    assert.equal(await retention.purgeTrash(f.runtime, f.limits), 0);
    assert.equal(fs.readFileSync(path.join(trash, slot, 'item/foreign'), 'utf8'), 'keep');
    assert.ok(fs.existsSync(path.join(f.root, 'original-preserved/manifest.json')));
});

for (const replacement of ['runtime', 'trash', 'slot', 'item', 'contents', 'proof']) {
    linuxTest(`queued trash ${replacement} replacement fails closed`, async t => {
        const f = quarantine(t), slot = slots(f)[0];
        if (replacement === 'contents') fs.writeFileSync(path.join(slot, 'item/foreign'), 'keep');
        else if (replacement === 'proof') fs.writeFileSync(path.join(slot, 'proof.json'), '{}');
        else {
            const target = replacement === 'runtime' ? f.runtime : replacement === 'trash' ? f.trash : replacement === 'slot' ? slot : path.join(slot, 'item');
            fs.renameSync(target, target + '-old'); privateDir(target);
            if (replacement === 'slot') fs.copyFileSync(path.join(target + '-old', 'proof.json'), path.join(target, 'proof.json'));
            if (replacement === 'runtime') atomicJson(path.join(f.runtime, 'state.json'), f.currentState);
        }
        if (['runtime', 'trash', 'proof'].includes(replacement)) {
            await retention.purgeTrash(f.runtime, f.limits).catch(() => {});
        } else await assert.rejects(retention.purgeTrash(f.runtime, f.limits), /changed|identity|contents/);
        if (replacement === 'contents') assert.equal(fs.readFileSync(path.join(slot, 'item/foreign'), 'utf8'), 'keep');
        if (replacement === 'proof') assert.ok(fs.existsSync(path.join(slot, 'item')));
    });
}

linuxTest('linked trash and linked quarantine slots do not touch external data', async t => {
    const f = removable(t), outside = privateDir(path.join(f.root, 'outside')); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.symlinkSync(outside, path.join(f.runtime, retention.TRASH));
    assert.throws(() => retention.moveToTrash(f.runtime, f.plan, f.currentState), /ENOTDIR|ELOOP/);
    await assert.rejects(retention.purgeTrash(f.runtime, f.limits), /ENOTDIR|ELOOP/);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});

linuxTest('missing descriptor capability and unsafe namespace permissions preserve eligible data', async t => {
    const f = removable(t), storage = require('../server/pi-retention-storage');
    const mock = t.mock.method(storage, 'directoryIdentity', () => { throw new Error('kernel descriptor unavailable'); });
    const plan = retention.planRetention(f.runtime, f.currentState, f.limits);
    assert.match(plan.skipped, /descriptor unavailable/);
    assert.deepEqual(retention.moveToTrash(f.runtime, plan, f.currentState), { releases: [], backups: [] });
    mock.mock.restore(); fs.chmodSync(path.join(f.runtime, 'backups'), 0o777);
    const unsafe = retention.planRetention(f.runtime, f.currentState, f.limits);
    assert.match(unsafe.skipped, /permissions/);
    assert.equal(fs.readdirSync(path.join(f.runtime, 'backups')).length, 4);
});

test('unsupported platform never uses pathname-only purge', () => {
    const { execFileSync } = require('node:child_process');
    const output = execFileSync(process.execPath, ['-e', `Object.defineProperty(process, 'platform', { value: 'freebsd' }); require('./server/pi-managed-retention').purgeTrash('/unused').then(() => process.exit(2), e => console.log(e.message));`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.match(output, /requires Linux directory descriptors/);
});

linuxTest('purge cancellation and real filesystem error report partial completion and preserve remaining quarantine', async t => {
    const f = quarantine(t), controller = new AbortController(); controller.abort();
    await assert.rejects(retention.purgeTrash(f.runtime, f.limits, { signal: controller.signal }), /cancelled/);
    assert.equal(slots(f).length, 5);
    const unlink = fs.unlinkSync; let count = 0;
    t.mock.method(fs, 'unlinkSync', function(file) { if (++count === 2) throw new Error('synthetic EIO'); return unlink(file); });
    await assert.rejects(retention.purgeTrash(f.runtime, f.limits), /EIO/);
    assert.equal(slots(f).length, 5);
    assert.equal(count, 2);
});

const { ManagedLauncher } = require('../server/pi-managed-launcher');
test('async cleanup reserves admission before awaits, is shared, waits for actual completion and shutdown does not replay', async t => {
    const f = fixture(t); f.backup(null); const state = f.state();
    const launcher = new ManagedLauncher({ root: f.root, env: {} }); launcher.state = state;
    const messages = []; launcher.send = m => messages.push(m); let finish, calls = 0, stopping = 0;
    t.mock.method(retention, 'purgeTrash', async (_directory, _limits, { signal }) => { calls++; await new Promise(resolve => { finish = resolve; }); assert.equal(signal.aborted, true); return 0; });
    launcher.stopChild = async () => { stopping++; };
    const cleaning = launcher.cleanup(); assert.equal(launcher.cleanup(), cleaning); assert.equal(launcher.status().busy, true);
    await launcher.execute({ id: randomUUID(), action: 'backup' });
    assert.equal(messages.at(-1).type, 'maintenance-rejected');
    await Promise.resolve(); assert.equal(calls, 1);
    let closed = false; const closing = launcher.close(); closing.then(() => { closed = true; });
    assert.equal(launcher.close(), closing); await Promise.resolve(); assert.equal(closed, false); assert.equal(stopping, 0);
    finish(); await cleaning; await closing;
    assert.equal(stopping, 1); assert.equal(calls, 1); assert.equal(launcher.status().busy, false);
});

test('cleanup error is observable, releases admission only on completion and preserves the successful main operation', async t => {
    const f = fixture(t); f.backup(null); const launcher = new ManagedLauncher({ root: f.root, env: {} }); launcher.state = f.state();
    t.mock.method(retention, 'purgeTrash', async () => { throw new Error('synthetic purge error'); });
    await launcher.cleanup(); assert.equal(launcher.lastRetention.phase, 'failed'); assert.equal(launcher.status().busy, false);
    assert.equal(launcher.operation, null); assert.equal(launcher.state.job, null);
});

test('maintenance remains nonterminal during cleanup and unexpected child exit is recorded as failure', async t => {
    const f = fixture(t), launcher = new ManagedLauncher({ root: f.root, env: {} }); launcher.state = f.state();
    launcher.backupInputs = [f.data]; launcher.child = {}; launcher.send = () => {};
    launcher.stopChild = async () => { launcher.child = null; };
    launcher.boot = async () => { launcher.child = {}; };
    let finish;
    t.mock.method(retention, 'purgeTrash', () => new Promise(resolve => { finish = resolve; }));
    const operation = launcher.execute({ id: randomUUID(), action: 'backup' });
    for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
    assert.ok(finish); assert.equal(launcher.state.job.phase, 'retaining'); assert.equal(launcher.status().busy, true);
    launcher.child = null; finish(0); await operation;
    assert.equal(launcher.state.job.phase, 'failed'); assert.equal(launcher.state.job.error, 'starting');
    assert.notEqual(launcher.state.job.exitCode, 0);
    assert.doesNotMatch(launcher.state.job.output, /Completed\. Running/);
});

test('startup shutdown during async cleanup waits once and never boots or activates a child', async t => {
    const f = fixture(t); f.backup(null); f.state();
    const launcher = new ManagedLauncher({ root: f.root, env: {} }), messages = [];
    launcher.send = message => messages.push(message); let finish, boots = 0;
    launcher.boot = async () => { boots++; };
    t.mock.method(retention, 'purgeTrash', () => new Promise(resolve => { finish = resolve; }));
    const starting = launcher.start(); const failed = assert.rejects(starting, /stopping/);
    for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish); const closing = launcher.close(); const closeFailed = assert.rejects(closing, /stopping/);
    assert.equal(launcher.close(), closing); finish(0); await failed; await closeFailed;
    assert.equal(boots, 0); assert.equal(launcher.guard.listening, false);
    assert.equal(messages.some(m => m.type === 'maintenance-activate'), false);
});

linuxTest('queued parent swap and a state change during asynchronous purge preserve remaining data', async t => {
    const f = quarantine(t), original = path.join(f.runtime, 'backups');
    fs.renameSync(original, original + '-old'); privateDir(original);
    await assert.rejects(retention.purgeTrash(f.runtime, f.limits), /protected backups/);
    assert.equal(slots(f).length, 5);
    fs.rmdirSync(original); fs.renameSync(original + '-old', original);
    const first = slots(f)[0], item = path.join(first, 'item');
    // Native proof owns the exact tree. Add many synthetic files, then mint a
    // fresh controlled proof solely for exercising the async yield boundary.
    for (let i = 0; i < 130; i++) fs.writeFileSync(path.join(item, 'bulk-' + i), 'synthetic');
    const storage = require('../server/pi-retention-storage'), pinned = storage.pin(item);
    const proof = JSON.parse(readSafe(path.join(first, 'proof.json'))); proof.tree = storage.snapshotTree(pinned); pinned.close(); atomicJson(path.join(first, 'proof.json'), proof);
    const scheduled = setImmediate(() => atomicJson(path.join(f.runtime, 'state.json'), { ...f.currentState, revision: 2 }));
    t.after(() => clearImmediate(scheduled));
    await assert.rejects(retention.purgeTrash(f.runtime, f.limits), /state changed/);
    assert.ok(fs.existsSync(item)); assert.ok(fs.readdirSync(item).length > 0); assert.equal(slots(f).length, 5);
});

linuxTest('a reused source identity prevents purging the previously quarantined object', async t => {
    const f = quarantine(t), slot = slots(f)[0], proof = JSON.parse(readSafe(path.join(slot, 'proof.json')));
    privateDir(path.join(f.runtime, proof.kind, proof.id));
    await assert.rejects(retention.purgeTrash(f.runtime, f.limits), /source identity was reused/);
    assert.ok(fs.existsSync(path.join(slot, 'item')));
});
