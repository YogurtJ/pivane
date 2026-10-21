const fs = require('node:fs');
const { promisify } = require('node:util');
const { withVerifiedFile } = require('./pi-file-bytes');
const { openPrivateFileSync } = require('./pi-private-files');
const { descriptorPath } = require('./pi-file-descriptor');
const io = require('./pi-file-io');
const { fail } = require('./pi-file-scope');
const write = promisify(fs.write), sync = promisify(fs.fsync), close = promisify(fs.close);

async function copyVerifiedFile(source, destination, options) {
    return withVerifiedFile(source, options, async file => {
        const fd = openPrivateFileSync(destination), identity = io.identity(fd);
        const validate = async () => {
            if (await descriptorPath(fd) !== destination || await fs.promises.realpath(destination) !== destination
                || !io.sameIdentityAtPath(destination, identity) || !(await promisify(fs.fstat)(fd, { bigint: true })).isFile())
                throw fail('交付存储位置已变化', 409, 'DELIVERY_CHANGED');
        };
        try {
            await validate();
            const result = await file.transfer(async bytes => {
                let offset = 0;
                while (offset < bytes.length) {
                    options.signal?.throwIfAborted();
                    const { bytesWritten } = await write(fd, bytes, offset, bytes.length - offset, null);
                    if (!bytesWritten) throw fail('交付文件写入未完成', 500, 'DELIVERY_INCOMPLETE');
                    offset += bytesWritten;
                }
            }, { expectedRevision: options.expectedRevision });
            await sync(fd); await validate();
            if ((await promisify(fs.fstat)(fd)).size !== result.size) throw fail('交付文件写入未完成', 409, 'DELIVERY_CHANGED');
            return result;
        } finally { await close(fd); }
    });
}

async function sendVerifiedFile(res, source, options) {
    return withVerifiedFile(source, options, async file => {
        // Complete the first proof before committing headers; the second pass
        // streams from that same descriptor with bounded memory and backpressure.
        const metadata = await file.transfer(() => {}, { expectedRevision: options.expectedRevision });
        if (options.expectedSize !== undefined && metadata.size !== options.expectedSize) throw fail('交付文件已变化', 409, 'DELIVERY_CHANGED');
        await options.authorize?.();
        await file.validate();
        const name = String(options.name || 'download').replace(/[\x00-\x1f\x7f/\\]/g, '_');
        const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
        res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(metadata.size),
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encoded}`,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
        if (options.head) { res.end(); return; }
        await file.transfer(bytes => new Promise((resolve, reject) => {
            res.write(bytes, error => error ? reject(error) : resolve());
        }), { expectedRevision: metadata.revision, beforeComplete: options.authorize });
        options.signal?.throwIfAborted();
        res.end();
    });
}
module.exports = { copyVerifiedFile, sendVerifiedFile };
