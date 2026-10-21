const path = require('node:path');
const { readVerifiedFile } = require('./pi-file-bytes');
const { MAX_FILE_BYTES, utf8, representation } = require('./pi-file-types');
const { fileLimits } = require('./pi-file-limits');
const { sendVerifiedFile } = require('./pi-file-download');
const { fileScope, fileError, fail } = require('./pi-file-scope');
const { windowsPath } = require('./pi-platform-path');
const policy = require('../public/pi-file-policy');

class PiFileService {
    constructor(store) { this.store = store; this.reading = 0; this.limits = fileLimits(); }
    async content(input) { return this.read(input, false); }
    async preview(input) { return this.read(input, true); }
    async download(input, options) { return this.read(input, false, options); }
    async read(input, preview, download) {
        if (!input || typeof input.cwd !== 'string' || typeof input.path !== 'string' || !input.path.trim()
            || input.cwd.length > 4096 || input.path.length > 4096 || /[\x00-\x1f\x7f]/.test(input.path) || (process.platform !== 'win32' && input.path.includes('\\'))
            || Object.keys(input).some(key => !['cwd', 'path'].includes(key))) throw fail('文件路径无效', 400, 'FILE_PATH');
        let inputPath;
        try { inputPath = windowsPath(input.path); } catch { throw fail('文件路径无效', 400, 'FILE_PATH'); }
        if (this.reading >= 4) throw fail('文件读取正在进行，请稍后再试', 429, 'FILE_BUSY');
        this.reading++;
        try {
            const { cwd, check } = await fileScope(this.store, input.cwd);
            const requested = path.resolve(cwd, inputPath);
            if (download) return await sendVerifiedFile(download.res, requested, {
                ...download, check, maxBytes: this.limits.downloadBytes, name: path.basename(requested),
                authorize: async () => {
                    await download.authorize?.();
                    const current = await fileScope(this.store, input.cwd);
                    if (current.cwd !== cwd) throw fail('项目目录已变化', 409, 'FILE_CHANGED');
                    current.check(requested, true);
                }
            });
            const file = await readVerifiedFile(requested, { check, maxBytes: preview ? MAX_FILE_BYTES : policy.maxBytes });
            const { bytes, ...metadata } = file;
            return { cwd, path: path.relative(cwd, file.absolutePath).split(path.sep).join('/'),
                ...(preview ? representation(file, file.absolutePath) : { ...metadata, content: utf8(bytes) }) };
        } catch (error) {
            throw fileError(error);
        } finally { this.reading--; }
    }
}
module.exports = { PiFileService };
