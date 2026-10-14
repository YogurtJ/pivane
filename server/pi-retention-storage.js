const fs = require('node:fs');
const path = require('node:path');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { readSafe, hash } = require('./pi-maintenance-files');

// Destruction is supported only in the exclusively managed Linux namespace.
// All cooperating writers must hold the launcher lock and maintenance admission.
// An arbitrary same-UID writer deliberately violating that protocol is outside
// this boundary. No pathname-only or lower precision platform fallback exists.
const MAX_ENTRIES = 100000;
const identity = stat => Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mode', 'uid', 'gid'].map(k => [k, String(stat[k])]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = stat => ({ ...identity(stat), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
function supported() {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') throw new Error('Retention deletion requires Linux directory descriptors');
}
function pin(directory, expected, privateMode = true) {
    supported();
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || (stat.mode & (privateMode ? 0o077n : 0o022n)) !== 0n
            || descriptorPathSync(fd) !== directory || !equal(identity(stat), identity(fs.lstatSync(directory, { bigint: true })))
            || expected && !equal(identity(stat), expected)) throw new Error('Retention directory identity or private permissions changed');
        return { fd, directory, identity: identity(stat), at: name => `/proc/self/fd/${fd}/${name}`, close: () => fs.closeSync(fd) };
    } catch (error) { fs.closeSync(fd); throw error; }
}
function check(handle) {
    if (descriptorPathSync(handle.fd) !== handle.directory || !equal(identity(fs.fstatSync(handle.fd, { bigint: true })), handle.identity)
        || !equal(identity(fs.lstatSync(handle.directory, { bigint: true })), handle.identity)) throw new Error('Retention directory changed');
}
function stateProof(directory) { return hash(readSafe(path.join(directory, 'state.json'))); }
function directoryIdentity(directory, privateMode = true) { const handle = pin(directory, undefined, privateMode); try { return handle.identity; } finally { handle.close(); } }
function snapshotTree(handle) {
    const rows = []; let entries = 0;
    function visit(parent, relative = '') {
        check(parent);
        for (const name of fs.readdirSync(parent.at('.')).sort()) {
            const relativePath = relative ? `${relative}/${name}` : name;
            const stat = fs.lstatSync(parent.at(name), { bigint: true });
            if (++entries > MAX_ENTRIES || relativePath.split('/').length > 128) throw new Error('Retention tree budget exceeded');
            if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unknown retention object type');
            rows.push({ path: relativePath, stamp: stamp(stat), type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'symlink' });
            if (stat.isDirectory()) {
                const child = pin(path.join(handle.directory, relativePath), undefined, false);
                try { visit(child, relativePath); } finally { child.close(); }
            }
        }
        check(parent);
    }
    visit(handle); return rows;
}
// Snapshot before any deletion. Work yields only between verified individual
// removals; every continuation rechecks runtime/state and descriptor ownership.
async function removeTree(handle, guard, signal, expectedTree) {
    const rows = snapshotTree(handle);
    if (!equal(rows, expectedTree)) throw new Error('Retention quarantine contents changed');
    const directories = new Map([['', handle]]);
    try {
        for (const row of rows.filter(r => r.type === 'directory')) {
            const dir = pin(path.join(handle.directory, row.path), identityFromStamp(row.stamp), false); directories.set(row.path, dir);
        }
        let count = 0;
        for (const row of [...rows].reverse()) {
            if (signal?.aborted) throw new Error('Retention cancelled');
            guard();
            const parent = directories.get(path.posix.dirname(row.path) === '.' ? '' : path.posix.dirname(row.path));
            check(parent);
            const target = parent.at(path.posix.basename(row.path)), actual = fs.lstatSync(target, { bigint: true });
            // Directory times change as this traversal removes their children.
            if (!equal(row.type === 'directory' ? identity(actual) : stamp(actual), row.type === 'directory' ? identityFromStamp(row.stamp) : row.stamp)) throw new Error('Retention object changed');
            if (row.type === 'directory') { const own = directories.get(row.path); check(own); own.close(); directories.delete(row.path); fs.rmdirSync(target); }
            else fs.unlinkSync(target);
            if (++count % 64 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        guard(); check(handle);
    } finally { for (const [name, dir] of directories) if (name) dir.close(); }
}
function identityFromStamp(value) { return Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mode', 'uid', 'gid'].map(k => [k, value[k]])); }
module.exports = { supported, pin, check, identity, stamp, equal, stateProof, directoryIdentity, snapshotTree, removeTree, MAX_ENTRIES };
