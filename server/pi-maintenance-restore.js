const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { privateDir, readSafe, copySafe, backupRoots, recordInstallation, atomicJson } = require('./pi-maintenance-files');
const { replaceFileSync } = require('./pi-win32-native');
const { ManagedLauncher } = require('./pi-managed-launcher');
const { PI_PACKAGES } = require('./pi-update-installer');
function inspectBackup(root, id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Use a backup ID from this installation');
    root = fs.realpathSync.native(root);
    const directory = path.join(root, '.pivane-runtime/backups', id);
    if (fs.realpathSync.native(directory) !== directory) throw new Error('Backup directory must not be an alias');
    const proof = require('./pi-maintenance-backup').inspectBackupContents(directory);
    const { installation } = proof;
    const launcher = new ManagedLauncher({ root });
    const release = launcher.releasePath(installation.release);
    const installed = JSON.parse(readSafe(path.join(release, 'package.json')));
    if (installed.version !== installation.package?.version || PI_PACKAGES.some(name => installed.dependencies?.[name] !== installation.package?.dependencies?.[name])) throw new Error('The matching retained installation is unavailable');
    return { root, ...proof };
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
