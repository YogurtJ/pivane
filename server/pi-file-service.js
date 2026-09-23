const fs = require('node:fs/promises');
const fileIo = require('./pi-file-io');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileScope, fileError, fail } = require('./pi-file-scope');
const { descriptorPath } = require('./pi-file-descriptor');
const { windowsPath } = require('./pi-platform-path');
const policy = require('../public/pi-file-policy');

class PiFileService {
    constructor(store) { this.store = store; this.reading = 0; }
    async content(input) {
        if (!input || typeof input.cwd !== 'string' || typeof input.path !== 'string' || !input.path.trim()
            || input.cwd.length > 4096 || input.path.length > 4096 || /[\x00-\x1f\x7f]/.test(input.path) || (process.platform !== 'win32' && input.path.includes('\\'))
            || Object.keys(input).some(key => !['cwd', 'path'].includes(key))) throw fail('文件路径无效', 400, 'FILE_PATH');
        let inputPath;
        try { inputPath = windowsPath(input.path); } catch { throw fail('文件路径无效', 400, 'FILE_PATH'); }
        if (this.reading >= 4) throw fail('文件读取正在进行，请稍后再试', 429, 'FILE_BUSY');
        this.reading++;
        let handle;
        try {
            const { cwd, check } = await fileScope(this.store, input.cwd);
            const requested = path.resolve(cwd, inputPath);
            check(requested, true);
            const resolved = await fs.realpath(requested); check(resolved);
            // Reject a final symlink/reparse point instead of following a swap.
            handle = await fileIo.openRead(resolved);
            const identity = fileIo.identity(handle.fd);
            const checkDescriptorPath = async () => {
                const actual = await descriptorPath(handle.fd); check(actual);
                if (actual !== resolved || await fs.realpath(requested) !== resolved) throw fail('文件位置已变化，请重新打开', 409, 'FILE_CHANGED');
            };
            await checkDescriptorPath();
            const before = await handle.stat({ bigint: true });
            if (!before.isFile()) throw fail('只支持普通文本文件', 415, 'FILE_TYPE');
            if (before.size > BigInt(policy.maxBytes)) throw fail('文件超过 2 MiB，暂不支持网页全文查看', 413, 'FILE_SIZE');
            const bytes = Buffer.alloc(Number(before.size) + 1);
            let total = 0;
            while (total < bytes.length) {
                const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
                if (!bytesRead) break;
                total += bytesRead;
            }
            const after = await handle.stat({ bigint: true });
            await checkDescriptorPath();
            if (!fileIo.sameIdentityAtPath(resolved, identity) || total !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
                throw fail('文件正在变化，请稍后刷新', 409, 'FILE_CHANGED');
            }
            let content;
            try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total)); }
            catch { throw fail('只支持 UTF-8 文本文件', 415, 'FILE_ENCODING'); }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw fail('二进制文件暂不支持全文查看', 415, 'FILE_BINARY');
            return { cwd, path: path.relative(cwd, resolved).split(path.sep).join('/'), absolutePath: resolved, content, size: total,
                modifiedAt: new Date(Number(after.mtimeMs)).toISOString(), readAt: new Date().toISOString(),
                revision: createHash('sha256').update(bytes.subarray(0, total)).digest('hex') };
        } catch (error) {
            throw fileError(error);
        } finally { try { await handle?.close(); } finally { this.reading--; } }
    }
}
module.exports = { PiFileService };
