const fs = require('node:fs');
const path = require('node:path');
const { getWindowsNative } = require('./pi-win32-native');
function openPrivateFileSync(filename) {
    return process.platform === 'win32' ? getWindowsNative().openPrivate(path.toNamespacedPath(filename)) : fs.openSync(filename, 'wx', 0o600);
}
function writePrivateFileSync(filename, content, sync = false) {
    const fd = openPrivateFileSync(filename);
    try { fs.writeFileSync(fd, content); if (sync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function privateFileMode(filename) {
    fs.chmodSync(filename, 0o600);
    if (process.platform === 'win32') getWindowsNative().securePrivate(path.toNamespacedPath(fs.realpathSync.native(filename)));
}
function privateDirectory(directory) {
    const resolved = path.resolve(directory);
    if (process.platform === 'win32' && [path.parse(resolved).root, require('node:os').homedir()].some(p => path.resolve(p).toLowerCase() === resolved.toLowerCase())) throw new Error('Pi data must use a dedicated private directory');
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') getWindowsNative().securePrivate(path.toNamespacedPath(fs.realpathSync.native(resolved)));
    return resolved;
}
module.exports = { openPrivateFileSync, writePrivateFileSync, privateFileMode, privateDirectory };
