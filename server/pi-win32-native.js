const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
let native;
function getWindowsNative() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw Object.assign(new Error('No verified Windows native backend for this architecture'), { code: 'FD_PLATFORM' });
    if (!native) {
        const directory = path.join(__dirname, '../native');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'win32-x64-manifest.json'), 'utf8'));
        const filename = path.join(directory, 'pi-win32-x64-fd.node');
        const digest = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
        if (manifest.napi !== 8 || manifest.arch !== 'x64' || manifest.platform !== 'win32' || digest(filename) !== manifest.binarySha256 || digest(path.join(directory, 'pi-win32-fd.c')) !== manifest.sourceSha256) {
            throw Object.assign(new Error('Windows native backend does not match its build manifest'), { code: 'FD_BACKEND' });
        }
        const candidate = require(filename);
        if (['descriptorPath', 'descriptorIdentity', 'openRead', 'openPrivate', 'securePrivate', 'replaceFile'].some(name => typeof candidate[name] !== 'function')) throw new Error('Invalid Windows native backend');
        native = candidate;
    }
    return native;
}
function replaceFileSync(source, target) {
    if (process.platform === 'win32') getWindowsNative().replaceFile(path.toNamespacedPath(source), path.toNamespacedPath(target));
    else fs.renameSync(source, target);
}
module.exports = { getWindowsNative, replaceFileSync };
