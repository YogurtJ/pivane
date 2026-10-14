const path = require('node:path');
const { readSafe, hashFileSafe, hash, inside } = require('./pi-maintenance-files');

// Shared native restore proof. This function never writes to backup or source data.
function inspectBackupContents(directory, budget = { bytes: 50 * 1024 ** 3, entries: 100000 }) {
    const bytes = readSafe(path.join(directory, 'manifest.json'), 128 * 1024 * 1024);
    const complete = JSON.parse(readSafe(path.join(directory, 'complete.json')));
    if (hash(bytes) !== complete.sha256) throw new Error('Backup manifest checksum mismatch');
    const installationBytes = readSafe(path.join(directory, 'installation.json'), 32 * 1024 * 1024);
    if (hash(installationBytes) !== complete.installationSha256) throw new Error('Installation backup checksum mismatch');
    const manifest = JSON.parse(bytes), installation = JSON.parse(installationBytes);
    if (manifest.version !== 1 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.entries) || !Array.isArray(manifest.directories)
        || manifest.entries.length + manifest.directories.length > 100000 || manifest.roots.some(p => typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || inside(p, directory) || inside(directory, p))) throw new Error('Invalid backup scope');
    const permitted = file => typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && manifest.roots.some(r => inside(r, file));
    if (new Set(manifest.directories).size !== manifest.directories.length || manifest.directories.some(file => !permitted(file))) throw new Error('Invalid backup directory');
    const declaredBytes = manifest.entries.reduce((sum, entry) => {
        if (entry.type !== 'file') return sum;
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Invalid backup byte count');
        return sum + entry.bytes;
    }, 0);
    budget.bytes -= declaredBytes; budget.entries -= manifest.entries.length + manifest.directories.length;
    if (budget.bytes < 0 || budget.entries < 0) throw new Error('Backup verification budget exceeded');
    const seen = new Set(), objects = new Set(); let total = 0;
    for (const entry of manifest.entries) {
        if (!permitted(entry.path) || seen.has(entry.path)) throw new Error('Invalid or duplicated backup entry'); seen.add(entry.path);
        if (entry.type === 'symlink') { if (typeof entry.link !== 'string') throw new Error('Invalid backup link'); continue; }
        if (entry.type !== 'file' || !/^\d{8}$/.test(entry.object) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Invalid backup object');
        if (objects.has(entry.object)) throw new Error('Duplicated backup object'); objects.add(entry.object);
        const actual = hashFileSafe(path.join(directory, 'files', entry.object)); total += actual.bytes;
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || total > 50 * 1024 ** 3) throw new Error('Backup object checksum or budget mismatch');
    }
    if (!installation || typeof installation !== 'object' || !installation.package || !installation.lock) throw new Error('Invalid installation backup');
    const files = manifest.entries.filter(e => e.type === 'file').length;
    const symlinks = manifest.entries.length - files;
    if (manifest.files !== files || manifest.bytes !== total || manifest.symlinks !== symlinks
        || complete.files !== files || complete.bytes !== total || complete.symlinks !== symlinks) throw new Error('Backup counts mismatch');
    return { directory, manifest, installation, files: seen.size, bytes: total };
}
module.exports = { inspectBackupContents };
