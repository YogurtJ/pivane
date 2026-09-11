const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { getWindowsNative } = require('./pi-win32-native');
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function openReadSync(filename) {
    return process.platform === 'win32' ? getWindowsNative().openRead(path.toNamespacedPath(filename)) : fs.openSync(filename, flags);
}
async function openRead(filename) {
    if (process.platform !== 'win32') return fs.promises.open(filename, flags);
    const fd = openReadSync(filename); let closed = false;
    return { fd,
        stat: options => promisify(fs.fstat)(fd, options),
        read: (buffer, offset, length, position) => new Promise((resolve, reject) => fs.read(fd, buffer, offset, length, position, (error, bytesRead) => error ? reject(error) : resolve({ bytesRead, buffer }))),
        close: async () => { if (!closed) { closed = true; await promisify(fs.close)(fd); } }
    };
}
function identity(fd) { return process.platform === 'win32' ? getWindowsNative().descriptorIdentity(fd) : null; }
function sameIdentityAtPath(filename, expected) {
    if (expected === null) return true; // Other platforms retain their native BigInt stat comparisons.
    let fd;
    try { fd = openReadSync(filename); return identity(fd) === expected; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { openReadSync, openRead, identity, sameIdentityAtPath };
