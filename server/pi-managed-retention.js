const fs = require('node:fs');
const path = require('node:path');
const { readSafe, inside } = require('./pi-maintenance-files');

// Retention for managed releases and pre-change backups. It runs only while the
// launcher holds the installation lock and no maintenance operation is active.
// Removal first renames a directory into a private trash area, so a partially
// deleted release or backup is never visible under its original identity.
const DEFAULT_RETENTION = Object.freeze({ releases: 5, backups: 3 });
const MINIMUM = Object.freeze({ releases: 2, backups: 1 });
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TRASH = 'retention-trash';

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
    const result = [];
    for (const name of fs.readdirSync(parent).sort()) {
        if (!ID.test(name)) continue;
        const dir = path.join(parent, name), stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) continue;
        result.push({ id: name, dir, mtimeMs: stat.mtimeMs });
    }
    return result;
}
const regularFile = file => { try { const stat = fs.lstatSync(file); return stat.isFile() ? stat : null; } catch { return null; } };
const newestFirst = (a, b) => b.order - a.order || a.id.localeCompare(b.id);

// Plans without changing anything. Unknown, linked and incomplete releases are
// never removed: an external deployment may still be staging them.
function planRetention(directory, state, limits = DEFAULT_RETENTION) {
    if (!state || state.version !== 1 || state.needsRecovery) throw new Error('Retention requires a settled maintenance state');
    const releasesDir = path.join(directory, 'releases'), backupsDir = path.join(directory, 'backups');
    const plan = { keepReleases: [], removeReleases: [], incompleteReleases: [], keepBackups: [], removeBackups: [], incompleteBackups: [] };

    const backups = realDirectories(backupsDir).map(item => {
        const complete = regularFile(path.join(item.dir, 'complete.json'));
        let valid = false;
        if (complete && regularFile(path.join(item.dir, 'installation.json'))) {
            try { valid = typeof JSON.parse(readSafe(path.join(item.dir, 'complete.json'))).installationSha256 === 'string'; } catch { valid = false; }
        }
        return { ...item, valid, order: valid ? complete.mtimeMs : item.mtimeMs };
    }).sort(newestFirst);
    const complete = backups.filter(b => b.valid), partial = backups.filter(b => !b.valid);
    const keptBackups = limits.backups === null ? complete : complete.slice(0, limits.backups);
    plan.keepBackups = keptBackups.map(b => b.id);
    if (limits.backups !== null) plan.removeBackups = complete.slice(limits.backups).map(b => b.id);
    // Interrupted copies are removed only after a newer complete backup exists.
    const newestComplete = complete[0]?.order ?? Infinity;
    for (const b of partial) (limits.backups !== null && b.order < newestComplete ? plan.removeBackups : plan.incompleteBackups).push(b.id);

    // Releases needed to restore any retained backup stay, together with active and previous.
    const protectedReleases = new Set([state.active, state.previous].filter(Boolean));
    for (const b of keptBackups) {
        const installation = JSON.parse(readSafe(path.join(b.dir, 'installation.json'), 32 * 1024 * 1024));
        if (installation.release !== null && installation.release !== undefined) {
            if (typeof installation.release !== 'string' || !ID.test(installation.release)) throw new Error('Retained backup has an invalid release reference');
            protectedReleases.add(installation.release);
        }
    }
    const releases = realDirectories(releasesDir).map(item => {
        const marker = regularFile(path.join(item.dir, 'PI_INSTALL_COMPLETE.json'));
        return { ...item, complete: Boolean(marker), order: marker ? marker.mtimeMs : item.mtimeMs };
    }).sort(newestFirst);
    const completeReleases = releases.filter(r => r.complete);
    plan.incompleteReleases = releases.filter(r => !r.complete).map(r => r.id);
    const newest = new Set(limits.releases === null ? completeReleases.map(r => r.id) : completeReleases.slice(0, limits.releases).map(r => r.id));
    for (const r of completeReleases) (newest.has(r.id) || protectedReleases.has(r.id) ? plan.keepReleases : plan.removeReleases).push(r.id);
    for (const id of protectedReleases) if (!plan.keepReleases.includes(id) && !plan.incompleteReleases.includes(id)) plan.missingReleases = [...(plan.missingReleases || []), id];
    if (plan.removeReleases.some(id => protectedReleases.has(id)) || plan.removeBackups.some(id => plan.keepBackups.includes(id))) throw new Error('Retention plan overlaps protected items');
    return plan;
}

// Moves planned items into trash after re-reading state; deletion of the trash
// happens separately so a large backup never blocks startup or a maintenance job.
function moveToTrash(directory, plan, expectedState) {
    if (!plan.removeBackups.length && !plan.removeReleases.length) return { releases: [], backups: [] };
    const stateFile = path.join(directory, 'state.json');
    const current = JSON.parse(readSafe(stateFile));
    if (current.active !== expectedState.active || current.previous !== expectedState.previous || current.needsRecovery) throw new Error('Maintenance state changed before retention');
    const trash = path.join(directory, TRASH);
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    if (fs.realpathSync.native(trash) !== trash || !inside(directory, trash)) throw new Error('Retention trash must be a real private directory');
    const moved = { releases: [], backups: [] };
    for (const [kind, ids] of [['backups', plan.removeBackups], ['releases', plan.removeReleases]]) {
        for (const id of ids) {
            if (!ID.test(id) || kind === 'releases' && (id === current.active || id === current.previous)) throw new Error('Refusing to remove a protected item');
            const source = path.join(directory, kind, id);
            const stat = fs.lstatSync(source);
            if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(source) !== source) continue;
            fs.renameSync(source, path.join(trash, `${kind}-${id}`));
            moved[kind].push(id);
        }
    }
    return moved;
}

async function purgeTrash(directory) {
    const trash = path.join(directory, TRASH);
    if (!fs.existsSync(trash)) return 0;
    if (fs.lstatSync(trash).isSymbolicLink() || fs.realpathSync.native(trash) !== trash) throw new Error('Retention trash must be a real directory');
    let count = 0;
    for (const name of fs.readdirSync(trash)) {
        if (!/^(?:releases|backups)-[a-f0-9-]{36}$/.test(name)) continue;
        await fs.promises.rm(path.join(trash, name), { recursive: true, force: true }); count++;
    }
    return count;
}

module.exports = { DEFAULT_RETENTION, retentionLimits, planRetention, moveToTrash, purgeTrash, TRASH };
