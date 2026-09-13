const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { privateDir, readSafe, copySafe, backupRoots, hashFileSafe, recordInstallation, atomicJson, hash, inside } = require('./pi-maintenance-files');
const { replaceFileSync } = require('./pi-win32-native');
const { ManagedLauncher } = require('./pi-managed-launcher');
const { PI_PACKAGES } = require('./pi-update-installer');
function inspectBackup(root, id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Use a backup ID from this installation');
    root = fs.realpathSync.native(root);
    const directory = path.join(root, '.pivane-runtime/backups', id);
    if (fs.realpathSync.native(directory) !== directory) throw new Error('Backup directory must not be an alias');
    const bytes = readSafe(path.join(directory, 'manifest.json'), 128 * 1024 * 1024);
    const complete = JSON.parse(readSafe(path.join(directory, 'complete.json')));
    if (hash(bytes) !== complete.sha256) throw new Error('Backup manifest checksum mismatch');
    const installationBytes = readSafe(path.join(directory, 'installation.json'), 32 * 1024 * 1024);
    if (hash(installationBytes) !== complete.installationSha256) throw new Error('Installation backup checksum mismatch');
    const manifest = JSON.parse(bytes), installation = JSON.parse(installationBytes);
    if (manifest.version !== 1 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.entries) || !Array.isArray(manifest.directories)
        || manifest.entries.length + manifest.directories.length > 100000 || manifest.roots.some(p => typeof p !== 'string' || !path.isAbsolute(p) || inside(p, directory) || inside(directory, p))) throw new Error('Invalid backup scope');
    const permitted = file => typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && manifest.roots.some(r => inside(r, file));
    if (manifest.directories.some(file => !permitted(file))) throw new Error('Invalid backup directory');
    const seen = new Set(); let total = 0;
    for (const entry of manifest.entries) {
        if (!permitted(entry.path) || seen.has(entry.path)) throw new Error('Invalid or duplicated backup entry'); seen.add(entry.path);
        if (entry.type === 'symlink') { if (typeof entry.link !== 'string') throw new Error('Invalid backup link'); continue; }
        if (entry.type !== 'file' || !/^\d{8}$/.test(entry.object) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Invalid backup object');
        const actual = hashFileSafe(path.join(directory, 'files', entry.object)); total += actual.bytes;
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || total > 50 * 1024 ** 3) throw new Error('Backup object checksum or budget mismatch');
    }
    const launcher = new ManagedLauncher({ root });
    const release = launcher.releasePath(installation.release);
    const installed = JSON.parse(readSafe(path.join(release, 'package.json')));
    if (installed.version !== installation.package?.version || PI_PACKAGES.some(name => installed.dependencies?.[name] !== installation.package?.dependencies?.[name])) throw new Error('The matching retained installation is unavailable');
    return { root, directory, manifest, installation, files: seen.size, bytes: total };
}
async function restoreBackup(root, id) {
    root = fs.realpathSync.native(root);
    const port = 40000 + createHash('sha256').update(root).digest().readUInt32BE(0) % 20000;
    const guard = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(port, '127.0.0.1', resolve); });
    try {
        const plan = inspectBackup(root, id);
        if (process.platform === 'win32' && plan.manifest.entries.some(e => e.type === 'symlink')) throw new Error('This backup contains links; restore those with native Windows tools while stopped');
        const stateFile = path.join(root, '.pivane-runtime/state.json');
        const state = fs.existsSync(stateFile) ? JSON.parse(readSafe(stateFile)) : { version: 1, active: null, previous: null };
        const safetyId = randomUUID(), safetyDir = path.join(root, '.pivane-runtime/backups', safetyId);
        const safety = backupRoots(plan.manifest.roots, safetyDir);
        const currentRoot = new ManagedLauncher({ root }).releasePath(state.active);
        recordInstallation(safetyDir, { release: state.active, package: JSON.parse(readSafe(path.join(currentRoot, 'package.json'))), lock: JSON.parse(readSafe(path.join(currentRoot, 'package-lock.json'), 16 * 1024 * 1024)) });
        state.needsRecovery = true; atomicJson(stateFile, state);
        const parent = file => {
            const directory = path.dirname(file);
            if (fs.realpathSync.native(directory) !== directory) throw new Error('Restore parent changed or is a symlink');
        };
        const syncParent = file => {
            if (process.platform === 'win32') return;
            const fd = fs.openSync(path.dirname(file), 'r');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        };
        const wanted = new Set(plan.manifest.entries.map(e => e.path));
        const current = JSON.parse(readSafe(path.join(safetyDir, 'manifest.json'), 128 * 1024 * 1024));
        // Preserve all post-update files in the safety snapshot before removing additions.
        for (const entry of current.entries) if (!wanted.has(entry.path)) { parent(entry.path); fs.unlinkSync(entry.path); syncParent(entry.path); }
        for (const directory of [...plan.manifest.directories].sort((a, b) => a.length - b.length)) {
            if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory()) throw new Error('Restore directory has changed type');
            privateDir(directory); syncParent(directory);
        }
        const budget = { bytes: 0, files: 0, maxBytes: 50 * 1024 ** 3, maxFiles: 100000 };
        for (const entry of plan.manifest.entries) {
            parent(entry.path);
            if (entry.type === 'symlink') {
                try { fs.unlinkSync(entry.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                fs.symlinkSync(entry.link, entry.path); syncParent(entry.path); continue;
            }
            const temp = entry.path + '.' + randomUUID() + '.restore';
            try {
                const actual = copySafe(path.join(plan.directory, 'files', entry.object), temp, budget);
                if (actual.sha256 !== entry.sha256) throw new Error('Backup object changed during restore');
                if (process.platform !== 'win32') {
                    fs.chmodSync(temp, entry.mode & 0o700);
                    const fd = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                }
                replaceFileSync(temp, entry.path); syncParent(entry.path);
            } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
        }
        state.active = plan.installation.release;
        state.needsRecovery = false;
        state.job = { id: randomUUID(), action: 'restore', phase: 'succeeded', finishedAt: new Date().toISOString(), backup: safety };
        atomicJson(stateFile, state);
        return { restored: id, files: plan.files, safetyBackup: safety.directory };
    } finally { await new Promise(resolve => guard.close(resolve)); }
}
module.exports = { inspectBackup, restoreBackup };
