const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const io = require('./pi-file-io');
const { descriptorPath } = require('./pi-file-descriptor');
const { fail } = require('./pi-file-scope');
const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
const CHUNK_BYTES = 256 * 1024;

// Every pass retains the same opened object and the complete native identity
// proof. The final chunk is withheld until EOF, revision and path checks pass.
async function withVerifiedFile(requested, { check, maxBytes, signal }, action) {
    let handle;
    try {
        signal?.throwIfAborted();
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
        const size = Number(before.size);
        const validate = async () => {
            signal?.throwIfAborted();
            const after = await handle.stat({ bigint: true });
            await checkPath();
            const named = await fs.lstat(resolved, { bigint: true });
            if (!io.sameIdentityAtPath(resolved, identity) || fields.some(key => before[key] !== after[key] || after[key] !== named[key]))
                throw fail('文件正在变化，请稍后刷新', 409, 'FILE_CHANGED');
        };
        const metadata = { absolutePath: resolved, size, modifiedAt: new Date(Number(before.mtimeMs)).toISOString() };
        const transfer = async (consume, { expectedRevision, beforeComplete } = {}) => {
            await validate();
            const hash = createHash('sha256');
            let total = 0, pending;
            while (total < size) {
                signal?.throwIfAborted();
                const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - total));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
                if (!bytesRead) throw fail('文件正在变化，请稍后刷新', 409, 'FILE_CHANGED');
                const bytes = buffer.subarray(0, bytesRead);
                hash.update(bytes); total += bytesRead;
                if (pending) await consume(pending);
                pending = bytes;
            }
            const extra = await handle.read(Buffer.alloc(1), 0, 1, total);
            if (extra.bytesRead) throw fail('文件正在变化，请稍后刷新', 409, 'FILE_CHANGED');
            await validate();
            const result = { ...metadata, readAt: new Date().toISOString(), revision: hash.digest('hex') };
            if (expectedRevision && result.revision !== expectedRevision) throw fail('文件内容已变化，拒绝下载', 409, 'FILE_CHANGED');
            await beforeComplete?.(result);
            // Authorization checks may await native state. Revalidate afterward.
            await validate();
            if (pending) await consume(pending);
            return result;
        };
        return await action({ ...metadata, transfer, validate });
    } finally { await handle?.close(); }
}

async function readVerifiedFile(requested, options) {
    return withVerifiedFile(requested, options, async file => {
        const chunks = [];
        const metadata = await file.transfer(bytes => { chunks.push(bytes); });
        return { ...metadata, bytes: Buffer.concat(chunks, metadata.size) };
    });
}
async function scanVerifiedFile(requested, options) {
    return withVerifiedFile(requested, options, file => file.transfer(() => {}, { expectedRevision: options.expectedRevision }));
}
module.exports = { readVerifiedFile, scanVerifiedFile, withVerifiedFile };
