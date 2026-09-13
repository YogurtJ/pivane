const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const privateFiles = require('./pi-private-files');
const { replaceFileSync } = require('./pi-win32-native');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function privateDir(dir) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Maintenance directory must not be a symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    privateFiles.privateDirectory(dir);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Maintenance directory must be a real directory');
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    return fs.realpathSync.native(dir);
}
function atomicJson(file, value) {
    const temp = file + '.' + randomUUID() + '.tmp';
    privateFiles.writePrivateFileSync(temp, JSON.stringify(value, null, 2) + '\n', true);
    try {
        replaceFileSync(temp, file);
        if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function readSafe(file, limit = 4 * 1024 * 1024) {
    const fd = io.openReadSync(file);
    try {
        const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!before.isFile() || before.size > BigInt(limit) || descriptorPathSync(fd) !== path.resolve(file)) throw new Error('Unsafe maintenance file');
        const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0, read;
        while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += read;
        const bytes = buffer.subarray(0, length);
        if (length > Number(before.size) || !same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true })) || !io.sameIdentityAtPath(file, identity)) throw new Error('Maintenance file changed while reading');
        return bytes;
    } finally { fs.closeSync(fd); }
}
// Copies through verified open descriptors, never follows a leaf or ancestor symlink.
// Files are streamed so media backups do not require a full file in memory.
function copySafe(source, destination, budget) {
    const input = io.openReadSync(source); let output;
    try {
        const before = fs.fstatSync(input, { bigint: true }), identity = io.identity(input);
        if (!before.isFile() || descriptorPathSync(input) !== path.resolve(source)) throw new Error('Unsafe backup source');
        budget.bytes += Number(before.size); budget.files++;
        if (budget.bytes > budget.maxBytes || budget.files > budget.maxFiles) throw new Error('Backup budget exceeded');
        output = privateFiles.openPrivateFileSync(destination);
        const digest = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let total = 0, read;
        while ((read = fs.readSync(input, buffer, 0, buffer.length, null))) {
            total += read;
            if (total > Number(before.size)) throw new Error('Backup source grew');
            digest.update(buffer.subarray(0, read));
            let written = 0;
            while (written < read) written += fs.writeSync(output, buffer, written, read - written);
        }
        fs.fsyncSync(output);
        if (total !== Number(before.size) || !same(before, fs.fstatSync(input, { bigint: true })) || !same(before, fs.lstatSync(source, { bigint: true })) || !io.sameIdentityAtPath(source, identity)) throw new Error('Backup source changed');
        budget.verified?.({ source, stat: before, identity });
        return { bytes: total, sha256: digest.digest('hex'), mode: Number(before.mode & 0o777n) };
    } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
}
function hashFileSafe(file, limit = 50 * 1024 ** 3) {
    const fd = io.openReadSync(file);
    try {
        const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!before.isFile() || before.size > BigInt(limit) || descriptorPathSync(fd) !== path.resolve(file)) throw new Error('Unsafe backup object');
        const digest = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let length = 0, read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null))) {
            length += read; if (length > Number(before.size)) throw new Error('Backup object changed'); digest.update(buffer.subarray(0, read));
        }
        if (!same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true })) || !io.sameIdentityAtPath(file, identity)) throw new Error('Backup object changed');
        return { bytes: length, sha256: digest.digest('hex') };
    } finally { fs.closeSync(fd); }
}
function backupRoots(inputs, directory, { maxBytes = 50 * 1024 ** 3, maxFiles = 100000 } = {}) {
    const target = privateDir(directory), objects = privateDir(path.join(target, 'files'));
    const verified = [];
    const budget = { bytes: 0, files: 0, maxBytes, maxFiles, verified: entry => verified.push(entry) }, entries = [], directories = [];
    const roots = [];
    for (const input of inputs) {
        if (!fs.existsSync(input)) continue;
        const root = fs.realpathSync.native(input);
        if (inside(root, target) || inside(target, root)) throw new Error('Backup source overlaps maintenance storage');
        if (!roots.some(parent => inside(parent, root))) {
            for (let i = roots.length - 1; i >= 0; i--) if (inside(root, roots[i])) roots.splice(i, 1);
            roots.push(root);
        }
    }
    function visit(file) {
        if (entries.length + directories.length >= maxFiles) throw new Error('Backup entry budget exceeded');
        const before = fs.lstatSync(file, { bigint: true });
        if (before.isSymbolicLink()) {
            const link = fs.readlinkSync(file);
            if (!same(before, fs.lstatSync(file, { bigint: true }))) throw new Error('Backup link changed');
            entries.push({ path: file, type: 'symlink', link }); return;
        }
        if (before.isDirectory()) {
            if (fs.realpathSync.native(file) !== file) throw new Error('Backup directory changed');
            const children = fs.readdirSync(file).sort();
            directories.push({ path: file, children, stat: before });
            for (const name of children) visit(path.join(file, name));
        } else {
            const object = String(entries.length).padStart(8, '0');
            const result = copySafe(file, path.join(objects, object), budget);
            entries.push({ path: file, type: 'file', object, ...result });
        }
    }
    for (const root of roots) visit(root);
    for (const file of verified) if (!same(file.stat, fs.lstatSync(file.source, { bigint: true })) || !io.sameIdentityAtPath(file.source, file.identity)) throw new Error('Backup source changed before completion');
    for (const dir of directories) {
        if (!same(dir.stat, fs.lstatSync(dir.path, { bigint: true })) || JSON.stringify(dir.children) !== JSON.stringify(fs.readdirSync(dir.path).sort())) throw new Error('Backup directory changed');
    }
    const manifest = { version: 1, createdAt: new Date().toISOString(), roots, directories: directories.map(d => d.path), entries, bytes: budget.bytes, files: budget.files,
        symlinks: entries.filter(e => e.type === 'symlink').length };
    atomicJson(path.join(target, 'manifest.json'), manifest);
    // A complete marker is written last. Interrupted copies are never advertised as backups.
    atomicJson(path.join(target, 'complete.json'), { sha256: hash(readSafe(path.join(target, 'manifest.json'), 128 * 1024 * 1024)), files: manifest.files, bytes: manifest.bytes, symlinks: manifest.symlinks });
    return { directory: target, files: manifest.files, bytes: manifest.bytes, symlinks: manifest.symlinks };
}
function recordInstallation(directory, installation) {
    const file = path.join(directory, 'installation.json');
    atomicJson(file, installation);
    const completePath = path.join(directory, 'complete.json');
    const complete = JSON.parse(readSafe(completePath));
    complete.installationSha256 = hash(readSafe(file, 32 * 1024 * 1024));
    atomicJson(completePath, complete);
}
module.exports = { privateDir, atomicJson, readSafe, copySafe, backupRoots, hashFileSafe, recordInstallation, hash, inside };
