const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readSafe, hash, atomicJson } = require('./pi-maintenance-files');
const { inspectBackupContents } = require('./pi-maintenance-backup');
const { exactVersion, verifyPiPackages, PI_PACKAGES } = require('./pi-update-installer');
const { validApplicationVersion } = require('./pi-application-installer');
const storage = require('./pi-retention-storage');
const DEFAULT_RETENTION = Object.freeze({ releases: 5, backups: 3 });
const MINIMUM = Object.freeze({ releases: 2, backups: 1 });
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TRASH = 'retention-trash';
const plans = new WeakMap();
function retentionLimits(env = {}) {
    const read = (name, kind) => {
        const raw = String(env[name] ?? '').trim();
        if (!raw) return DEFAULT_RETENTION[kind];
        if (raw.toLowerCase() === 'off') return null;
        const value = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
        return Number.isInteger(value) && value >= MINIMUM[kind] ? value : DEFAULT_RETENTION[kind];
    };
    return { releases: read('PIVANE_RETAIN_RELEASES', 'releases'), backups: read('PIVANE_RETAIN_BACKUPS', 'backups') };
}
function realDirectories(parent) {
    if (!fs.existsSync(parent)) return [];
    if (!fs.lstatSync(parent).isDirectory() || fs.realpathSync.native(parent) !== parent) throw new Error('Retention parent must be a real directory');
    const names = fs.readdirSync(parent).sort();
    if (names.length > 10000) throw new Error('Retention directory budget exceeded');
    return names.filter(name => ID.test(name)).flatMap(id => {
        const dir = path.join(parent, id), stat = fs.lstatSync(dir, { bigint: true });
        return stat.isDirectory() && fs.realpathSync.native(dir) === dir ? [{ id, dir, stamp: storage.stamp(stat) }] : [];
    });
}
function releaseProof(root, id) {
    if (id !== null && !ID.test(id || '')) throw new Error('Invalid retained release reference');
    const dir = id === null ? root : path.join(root, '.pivane-runtime/releases', id);
    if (fs.realpathSync.native(dir) !== dir) throw new Error('Linked retained release');
    const pkg = JSON.parse(readSafe(path.join(dir, 'package.json')));
    const lockBytes = readSafe(path.join(dir, 'package-lock.json'), 16 * 1024 * 1024), lock = JSON.parse(lockBytes);
    if (pkg.name !== 'pivane' || !validApplicationVersion(pkg.version) || !exactVersion(pkg.dependencies?.[PI_PACKAGES[0]])
        || lock.packages?.['']?.version !== pkg.version) throw new Error('Invalid native installation metadata');
    if (id === null) verifyPiPackages(dir, pkg, lock, pkg.dependencies[PI_PACKAGES[0]]);
    if (id !== null) {
        const marker = JSON.parse(readSafe(path.join(dir, 'PI_INSTALL_COMPLETE.json')));
        if (!exactVersion(marker.version) || !Number.isFinite(Date.parse(marker.completedAt)) || marker.lockSha256 !== hash(lockBytes)) throw new Error('Invalid native install proof');
        verifyPiPackages(dir, pkg, lock, marker.version);
    }
    return { dir, pkg, lock, lockSha256: hash(lockBytes) };
}
function backupProof(root, item, budget) {
    const proof = inspectBackupContents(item.dir, budget), installation = proof.installation;
    if (!proof.manifest.roots.length || !Number.isFinite(Date.parse(proof.manifest.createdAt))) throw new Error('Incomplete native backup scope');
    const release = releaseProof(root, installation.release);
    if (installation.package.version !== release.pkg.version || PI_PACKAGES.some(n => installation.package.dependencies?.[n] !== release.pkg.dependencies?.[n])
        || hash(Buffer.from(JSON.stringify(installation.lock))) !== hash(Buffer.from(JSON.stringify(release.lock)))) throw new Error('Matching native installation changed');
    const complete = fs.lstatSync(path.join(item.dir, 'complete.json'), { bigint: true });
    return { ...item, release: installation.release, order: complete.mtimeNs, proof };
}
const newestFirst = (a, b) => a.order === b.order ? a.id.localeCompare(b.id) : a.order > b.order ? -1 : 1;
function planRetention(directory, state, limits = DEFAULT_RETENTION, { completedJobId } = {}) {
    if (!state || state.version !== 1 || state.needsRecovery || state.job && !['succeeded', 'failed', 'interrupted'].includes(state.job.phase) && !(state.job.phase === 'retaining' && ID.test(completedJobId || '') && state.job.id === completedJobId)) throw new Error('Retention requires a settled maintenance state');
    if ([state.active, state.previous].some(id => id !== null && !ID.test(id || ''))) throw new Error('Invalid retention state identity');
    for (const kind of ['releases', 'backups']) if (limits[kind] !== null && (!Number.isInteger(limits[kind]) || limits[kind] < MINIMUM[kind] || limits[kind] > 9999)) throw new Error('Invalid retention limits');
    const root = path.dirname(directory);
    if (path.basename(directory) !== '.pivane-runtime' || fs.realpathSync.native(directory) !== directory) throw new Error('Invalid retention root');
    const plan = { keepReleases: [], removeReleases: [], incompleteReleases: [], keepBackups: [], removeBackups: [], incompleteBackups: [] };
    const releases = [], backups = [], items = [];
    const budget = { bytes: 50 * 1024 ** 3, entries: 100000 };
    let proofBudgetExceeded = false;
    for (const item of realDirectories(path.join(directory, 'releases'))) {
        try { releaseProof(root, item.id); const marker = fs.lstatSync(path.join(item.dir, 'PI_INSTALL_COMPLETE.json'), { bigint: true }); releases.push({ ...item, order: marker.mtimeNs }); }
        catch { plan.incompleteReleases.push(item.id); }
    }
    for (const item of realDirectories(path.join(directory, 'backups'))) {
        try { backups.push(backupProof(root, item, budget)); }
        catch { plan.incompleteBackups.push(item.id); if (budget.bytes < 0 || budget.entries < 0) proofBudgetExceeded = true; }
    }
    backups.sort(newestFirst); releases.sort(newestFirst);
    const protectedReleases = new Set([state.active ?? null, state.previous ?? null]);
    for (const id of protectedReleases) releaseProof(root, id);
    const kept = new Set((limits.backups === null ? backups : backups.slice(0, limits.backups)).map(b => b.id));
    // At least one genuinely verified native restore point per current/previous
    // installation is required before any destructive action, beyond the cap.
    const missingBackups = [];
    for (const id of protectedReleases) {
        const backup = backups.find(b => b.release === id);
        if (backup) kept.add(backup.id); else missingBackups.push(id);
    }
    for (const b of backups) {
        if (kept.has(b.id)) { plan.keepBackups.push(b.id); protectedReleases.add(b.release); }
        else if (limits.backups !== null) { plan.removeBackups.push(b.id); items.push({ ...b, kind: 'backups' }); }
    }
    const newest = new Set((limits.releases === null ? releases : releases.slice(0, limits.releases)).map(r => r.id));
    for (const r of releases) {
        if (newest.has(r.id) || protectedReleases.has(r.id)) plan.keepReleases.push(r.id);
        else { plan.removeReleases.push(r.id); items.push({ ...r, kind: 'releases' }); }
    }
    // Incomplete/malformed items never establish a restore point or eligibility.
    if (missingBackups.length || proofBudgetExceeded) { plan.skipped = proofBudgetExceeded ? 'verification-budget-exceeded' : 'missing-current-or-previous-restore-backup'; plan.removeBackups = []; plan.removeReleases = []; }
    let context;
    try {
        context = { directory, stateHash: storage.stateProof(directory), roots: Object.fromEntries([root, directory, ...['releases', 'backups'].map(k => path.join(directory, k))].filter(p => fs.existsSync(p)).map(p => [p, storage.directoryIdentity(p, p !== root)])), items, limits: { ...limits }, completedJobId };
    } catch (error) { plan.skipped = error.message; }
    plans.set(plan, context); return plan;
}
function moveToTrash(directory, plan, expectedState) {
    if (!plan.removeBackups.length && !plan.removeReleases.length || plan.skipped) return { releases: [], backups: [] };
    const context = plans.get(plan);
    if (!context || context.directory !== directory) throw new Error('Retention requires its verified plan');
    const handles = [];
    const moved = { releases: [], backups: [] };
    try {
        for (const [dir, expected] of Object.entries(context.roots)) handles.push(storage.pin(dir, expected, dir !== path.dirname(directory)));
        const guard = () => { for (const handle of handles) storage.check(handle); if (storage.stateProof(directory) !== context.stateHash) throw new Error('Maintenance state changed before retention'); };
        guard();
        const state = JSON.parse(readSafe(path.join(directory, 'state.json')));
        if (state.active !== expectedState.active || state.previous !== expectedState.previous) throw new Error('Maintenance state changed before retention');
        // Repeat bounded native proof verification before moving anything; a
        // protected restore point changed since planning must stop all pruning.
        const fresh = planRetention(directory, state, context.limits, { completedJobId: context.completedJobId });
        if (fresh.skipped || !storage.equal(fresh, plan)) throw new Error('Retention proofs changed');
        const trashPath = path.join(directory, TRASH);
        if (!fs.existsSync(trashPath)) fs.mkdirSync(handles.find(h => h.directory === directory).at(TRASH), { mode: 0o700 });
        const trash = storage.pin(trashPath); handles.push(trash);
        for (const item of context.items) {
            if (!(item.kind === 'releases' ? plan.removeReleases : plan.removeBackups).includes(item.id)) continue;
            guard();
            const source = storage.pin(item.dir); handles.push(source);
            if (!storage.equal(storage.stamp(fs.fstatSync(source.fd, { bigint: true })), item.stamp)) throw new Error('Retention source changed');
            const slotName = `${item.kind}-${item.id}-${randomUUID()}`;
            fs.mkdirSync(trash.at(slotName), { mode: 0o700 }); // exclusive reservation
            const slot = storage.pin(path.join(trashPath, slotName)); handles.push(slot);
            guard();
            if (fs.readdirSync(slot.at('.')).length) throw new Error('Retention destination already exists');
            const parent = handles.find(h => h.directory === path.join(directory, item.kind));
            if (!storage.equal(storage.stamp(fs.lstatSync(parent.at(item.id), { bigint: true })), item.stamp)) throw new Error('Retention source changed');
            // Controlled private slot, NOT a kernel no-replace rename primitive.
            fs.renameSync(parent.at(item.id), slot.at('item'));
            const target = storage.pin(path.join(slot.directory, 'item'), source.identity);
            try {
                if (!storage.equal(storage.identity(fs.fstatSync(source.fd, { bigint: true })), target.identity) || require('./pi-file-descriptor').descriptorPathSync(source.fd) !== target.directory) throw new Error('Quarantined retention identity mismatch');
                // No deletion occurs without this last-written native identity proof.
                atomicJson(path.join(slot.directory, 'proof.json'), { version: 1, kind: item.kind, id: item.id, roots: Object.fromEntries(handles.filter(h => h !== source && h !== slot).map(h => [h.directory, h.identity])), slot: slot.identity, item: target.identity, tree: storage.snapshotTree(target) });
                moved[item.kind].push(item.id);
            } finally { target.close(); }
            handles.splice(handles.indexOf(source), 1); source.close();
            handles.splice(handles.indexOf(slot), 1); slot.close();
        }
        return moved;
    } finally { for (const handle of handles.reverse()) handle.close(); }
}
async function purgeTrash(directory, limits = DEFAULT_RETENTION, { signal, completedJobId } = {}) {
    if (limits.releases === null && limits.backups === null) return 0;
    storage.supported();
    const trashPath = path.join(directory, TRASH);
    if (!fs.existsSync(trashPath)) return 0;
    const handles = [];
    try {
        const root = storage.pin(path.dirname(directory), undefined, false); handles.push(root);
        const runtime = storage.pin(directory); handles.push(runtime);
        const trash = storage.pin(trashPath); handles.push(trash);
        const stateHash = storage.stateProof(directory), state = JSON.parse(readSafe(path.join(directory, 'state.json')));
        if (state.version !== 1 || state.needsRecovery) throw new Error('Retention requires settled state');
        // Verify actual protected native backups again before touching old trash.
        const protection = planRetention(directory, state, limits, { completedJobId });
        if (protection.skipped) throw new Error('Retention protected backups are unavailable');
        const guard = () => { if (signal?.aborted) throw new Error('Retention cancelled'); for (const h of handles) storage.check(h); if (storage.stateProof(directory) !== stateHash) throw new Error('Retention state changed during purge'); };
        let count = 0;
        const names = fs.readdirSync(trash.at('.')).sort();
        if (names.length > 10000) throw new Error('Retention trash budget exceeded');
        for (const name of names) {
            const match = /^(releases|backups)-([a-f0-9-]{36})-([a-f0-9-]{36})$/.exec(name);
            if (!match || !ID.test(match[2]) || !ID.test(match[3]) || limits[match[1]] === null) continue;
            guard();
            const dir = path.join(trashPath, name);
            // Unknown/old/unproved trash is preserved, including interrupted moves.
            if (!fs.existsSync(path.join(dir, 'proof.json'))) continue;
            let proof;
            try { proof = JSON.parse(readSafe(path.join(dir, 'proof.json'), 32 * 1024 * 1024)); } catch { continue; }
            if (proof.version !== 1 || proof.kind !== match[1] || proof.id !== match[2]) continue;
            try { fs.lstatSync(path.join(directory, proof.kind, proof.id)); throw new Error('Quarantined source identity was reused'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (proof.kind === 'releases' && [state.active, state.previous].includes(proof.id)) throw new Error('Protected release in retention trash');
            const handleCount = handles.length;
            let slot;
            try {
                const allowedRoots = [path.dirname(directory), directory, path.join(directory, 'releases'), path.join(directory, 'backups'), trashPath];
                if (!proof.roots || Object.keys(proof.roots).some(p => !allowedRoots.includes(p))) throw new Error('Unknown retention proof root');
                for (const [savedPath, expected] of Object.entries(proof.roots)) {
                    const existing = handles.find(h => h.directory === savedPath);
                    if (existing) { if (!storage.equal(existing.identity, expected)) throw new Error('Retention trash root changed'); }
                    else handles.push(storage.pin(savedPath, expected));
                }
                slot = storage.pin(dir, proof.slot); handles.push(slot);
                if (!storage.equal(fs.readdirSync(slot.at('.')).sort(), ['item', 'proof.json'])) throw new Error('Unknown retention slot contents');
                for (const h of [root, runtime, trash]) if (!storage.equal(proof.roots?.[h.directory], h.identity)) throw new Error('Retention trash root changed');
                const item = storage.pin(path.join(dir, 'item'), proof.item); handles.push(item);
                try { await storage.removeTree(item, guard, signal, proof.tree); guard(); fs.rmdirSync(slot.at('item')); }
                finally { handles.pop(); item.close(); }
                guard(); fs.unlinkSync(slot.at('proof.json')); fs.rmdirSync(trash.at(name)); count++;
            } finally { while (handles.length > handleCount) handles.pop().close(); }
        }
        return count;
    } finally { for (const h of handles.reverse()) h.close(); }
}
module.exports = { DEFAULT_RETENTION, retentionLimits, planRetention, moveToTrash, purgeTrash, TRASH };
