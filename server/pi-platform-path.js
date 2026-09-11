const path = require('node:path');
function windowsPath(value) {
    if (process.platform !== 'win32') return value;
    let result = value.replace(/\//g, '\\');
    if (/^\\\\\?\\UNC\\/i.test(result)) result = '\\\\' + result.slice(8);
    else if (/^\\\\\?\\[a-z]:\\/i.test(result)) result = result.slice(4);
    if (/^\\\\[.?]\\/.test(result) || /^[a-z]:($|[^\\])/i.test(result)) throw new Error('Unsupported Windows path namespace');
    const tail = result.replace(/^[a-z]:\\/i, '');
    if (/[\x00-\x1f<>:"|?*]/.test(tail)) throw new Error('Windows alternate streams and device paths are not supported');
    for (const part of tail.split('\\')) {
        if (!part || part === '.' || part === '..') continue;
        if (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error('Windows device names and ambiguous filename suffixes are not supported');
    }
    return result;
}
// Inputs at security boundaries are canonical names returned by native realpath.
// win32.relative folds case and would confuse distinct case-sensitive directories.
function withinCanonical(root, value) {
    return value === root || value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
module.exports = { windowsPath, withinCanonical };
