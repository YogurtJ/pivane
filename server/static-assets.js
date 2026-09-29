const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const io = require('./pi-file-io');
const { descriptorPath } = require('./pi-file-descriptor');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 24;
const revision = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

function encodingQuality(header, name) {
    const values = new Map();
    for (const part of header.split(',')) {
        const match = /^\s*([a-z*][a-z0-9_-]*)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*)?$/i.exec(part);
        if (match) values.set(match[1].toLowerCase(), match[2] === undefined ? 1 : Number(match[2]));
    }
    if (values.has(name)) return values.get(name);
    if (name === 'identity') return values.get('*') === 0 ? 0 : 1;
    return values.get('*') || 0;
}

function createStaticAssets(roots) {
    const routes = roots.map(([prefix, directory]) => {
        let realRoot;
        try { realRoot = fs.realpathSync.native(directory); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return { prefix, directory: path.resolve(directory), realRoot };
    });
    const cache = new Map();
    let cacheBytes = 0, activeCompressions = 0;
    function evict(key) {
        const item = cache.get(key);
        if (item) { cache.delete(key); cacheBytes -= item.bytes.length; }
    }
    return async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let pathname;
        try { pathname = decodeURIComponent(req.path); } catch { return next(); }
        const route = routes.find(({ prefix }) => pathname.startsWith(prefix));
        if (!route || !route.realRoot) return next();
        const relative = pathname.slice(route.prefix.length);
        // Keep send's default dotfile exclusion and the public access allowlist.
        if (!relative || !/\.(?:js|css)$/i.test(relative) || /\.bak(?:[-.]|$)|\.tmp$|~$/i.test(pathname)
            || relative.split('/').some(part => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))
            || (route.prefix === '/' && (pathname.startsWith('/api/')
                || (relative.includes('/') && relative !== 'vendor/mermaid-11.17.2.min.js')))) return next();
        const accept = req.headers['accept-encoding'];
        res.vary('Accept-Encoding');
        if (typeof accept !== 'string') return next();
        const choices = ['br', 'gzip', 'identity'].map(name => [name, encodingQuality(accept, name)]);
        choices.sort((a, b) => b[1] - a[1]);
        const [encoding, quality] = choices[0];
        if (quality === 0) return res.sendStatus(406);
        const fallback = () => encodingQuality(accept, 'identity') > 0 ? next() : res.sendStatus(406);
        // Native static serving owns ranges and preconditions of the identity representation.
        if (req.headers.range || req.headers['if-range'] || req.headers['if-match'] || req.headers['if-unmodified-since']) return fallback();
        if (encoding === 'identity') return next();
        const filename = path.join(route.directory, relative);
        const canonical = path.join(route.realRoot, relative);
        let handle, reserved = false;
        try {
            if (await fs.promises.realpath(filename) !== canonical) return fallback();
            const named = await fs.promises.lstat(canonical, { bigint: true });
            if (!named.isFile() || named.size > BigInt(MAX_SOURCE_BYTES)) return fallback();
            handle = await io.openRead(canonical);
            const identity = io.identity(handle.fd), before = await handle.stat({ bigint: true });
            const sourceRevision = revision(before);
            const verify = async () => {
                const actual = await descriptorPath(handle.fd);
                if (!before.isFile() || actual !== canonical || !actual.startsWith(route.realRoot + path.sep)
                    || await fs.promises.realpath(filename) !== canonical
                    || revision(named) !== sourceRevision
                    || revision(await handle.stat({ bigint: true })) !== sourceRevision
                    || revision(await fs.promises.lstat(canonical, { bigint: true })) !== sourceRevision
                    || !io.sameIdentityAtPath(canonical, identity)) throw new Error('Static source changed');
            };
            await verify();
            const key = canonical + '\0' + encoding;
            let item = cache.get(key);
            if (item && (item.revision !== sourceRevision || item.identity !== identity)) { evict(key); item = null; }
            if (item) { cache.delete(key); cache.set(key, item); }
            else {
                if (activeCompressions >= 4) return fallback();
                activeCompressions++; reserved = true;
                // Bound the read even if a writer grows the file after the stat.
                const bytes = Buffer.alloc(Number(before.size) + 1);
                let total = 0;
                while (total < bytes.length) {
                    const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
                    if (!bytesRead) break;
                    total += bytesRead;
                }
                if (total !== Number(before.size)) throw new Error('Static source changed');
                await verify();
                const compressed = encoding === 'br'
                    ? await brotli(bytes.subarray(0, total), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
                    : await gzip(bytes.subarray(0, total));
                item = { revision: sourceRevision, identity, bytes: compressed,
                    etag: '"' + crypto.createHash('sha256').update(compressed).digest('hex') + '"' };
                await verify();
                // Another cold request may have populated the same representation.
                evict(key);
                while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + item.bytes.length > MAX_CACHE_BYTES) evict(cache.keys().next().value);
                cache.set(key, item); cacheBytes += item.bytes.length;
            }
            await verify();
            res.set({ 'Content-Encoding': encoding, 'ETag': item.etag,
                'Last-Modified': new Date(Number(before.mtimeMs)).toUTCString(),
                'Cache-Control': 'public, max-age=0', 'Accept-Ranges': 'none' });
            res.type(path.extname(filename));
            res.send(item.bytes); // Express applies conditional GET and HEAD to this representation.
        } catch (error) {
            if (error.message === 'Static source changed') return res.sendStatus(409);
            return fallback();
        } finally {
            if (reserved) activeCompressions--;
            await handle?.close();
        }
    };
}
module.exports = { createStaticAssets };
