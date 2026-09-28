const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const io = require('./pi-file-io');
const { descriptorPath } = require('./pi-file-descriptor');
const { fail } = require('./pi-file-scope');
const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];

// The caller owns scope policy. Both ordinary project reads and immutable
// deliverables retain the same kernel-path, identity and complete-read proof.
async function readVerifiedFile(requested, { check, maxBytes }) {
    let handle;
    try {
        check(requested, true);
        const resolved = await fs.realpath(requested); check(resolved);
        handle = await io.openRead(resolved);
        const identity = io.identity(handle.fd);
        const checkPath = async () => {
            const actual = await descriptorPath(handle.fd); check(actual);
            if (actual !== resolved || await fs.realpath(requested) !== resolved) throw fail('文件位置已变化，请重新打开', 409, 'FILE_CHANGED');
        };
        await checkPath();
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) throw fail('只支持普通文件', 415, 'FILE_TYPE');
        if (before.size > BigInt(maxBytes)) throw fail(`文件超过 ${maxBytes / 1024 / 1024} MiB 限制`, 413, 'FILE_SIZE');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (!bytesRead) break;
            total += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        await checkPath();
        const named = await fs.lstat(resolved, { bigint: true });
        if (!io.sameIdentityAtPath(resolved, identity) || total !== Number(before.size)
            || fields.some(key => before[key] !== after[key] || after[key] !== named[key])) {
            throw fail('文件正在变化，请稍后刷新', 409, 'FILE_CHANGED');
        }
        const bytes = buffer.subarray(0, total);
        return { bytes, absolutePath: resolved, size: total, modifiedAt: new Date(Number(after.mtimeMs)).toISOString(),
            readAt: new Date().toISOString(), revision: createHash('sha256').update(bytes).digest('hex') };
    } finally { await handle?.close(); }
}
module.exports = { readVerifiedFile };
