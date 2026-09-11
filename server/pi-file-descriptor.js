const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
let native;
function backend() {
    if (process.platform === 'linux') return 'linux-proc';
    if (process.platform === 'win32') { native = require('./pi-win32-native').getWindowsNative(); return 'win32-handle'; }
    if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
        throw Object.assign(new Error('This platform has no verified descriptor-path backend'), { code: 'FD_PLATFORM' });
    }
    if (!native) {
        const directory = path.join(__dirname, '../native');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'darwin-fd-manifest.json'), 'utf8'));
        const filename = path.join(directory, 'pi-darwin-fd.node');
        const digest = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
        if (manifest.napi !== 8 || digest(filename) !== manifest.binarySha256 ||
            digest(path.join(directory, 'pi-darwin-fd.c')) !== manifest.sourceSha256) {
            throw Object.assign(new Error('Descriptor-path backend does not match its build manifest'), { code: 'FD_BACKEND' });
        }
        const candidate = require(filename);
        if (typeof candidate.descriptorPath !== 'function') throw new Error('Invalid descriptor-path backend');
        native = candidate;
    }
    return 'darwin-fcntl';
}
function rawPath(fd) {
    if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) throw new TypeError('Invalid file descriptor');
    return backend() === 'linux-proc' ? `/proc/self/fd/${fd}` : native.descriptorPath(fd);
}
// Canonicalize the kernel-reported name; callers retain all root/private-path,
// identity, type, size, and before/after checks. Never fall back to the requested path.
function descriptorPathSync(fd) { return fs.realpathSync.native(rawPath(fd)); }
async function descriptorPath(fd) { return fsp.realpath(rawPath(fd)); }
function descriptorBackendAvailable() { try { backend(); return true; } catch { return false; } }
module.exports = { descriptorPathSync, descriptorPath, descriptorBackendAvailable, assertDescriptorBackend: backend };
