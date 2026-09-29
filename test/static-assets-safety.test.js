const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const zlib = require('node:zlib');
const io = require('../server/pi-file-io');
const { createStaticAssets } = require('../server/static-assets');
function request(port, url, encoding = 'gzip, identity;q=0') {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: url, headers: { 'Accept-Encoding': encoding } }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}
async function fixture(t, factory = createStaticAssets) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-static-safety-')));
    const publicRoot = path.join(root, 'public'); fs.mkdirSync(publicRoot);
    const app = express(); app.use(factory([['/vendor/', publicRoot], ['/', publicRoot]]));
    app.use('/vendor', express.static(publicRoot)); app.use(express.static(publicRoot));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, publicRoot, port: server.address().port };
}
test('compression preserves default dotfile exclusions', async t => {
    const { publicRoot, port } = await fixture(t);
    fs.writeFileSync(path.join(publicRoot, '.private.js'), 'private');
    fs.mkdirSync(path.join(publicRoot, '.hidden')); fs.writeFileSync(path.join(publicRoot, '.hidden', 'file.js'), 'private');
    for (const url of ['/.private.js', '/vendor/.hidden/file.js']) for (const encoding of ['identity', 'gzip', 'br']) {
        const res = await request(port, url, encoding); assert.equal(res.status, 404); assert.equal(res.headers['content-encoding'], undefined);
    }
});
test('ancestor swap cannot create an out-of-root compressed response', async t => {
    const { root, publicRoot, port } = await fixture(t);
    const nested = path.join(publicRoot, 'nested'), outside = path.join(root, 'outside'); fs.mkdirSync(nested); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(nested, 'file.js'), 'inside'); fs.writeFileSync(path.join(outside, 'file.js'), 'outside-sensitive-fixture');
    const original = fs.promises.realpath; let swapped = false;
    t.mock.method(fs.promises, 'realpath', async function(file, ...args) {
        const result = await original.call(this, file, ...args);
        if (file === path.join(nested, 'file.js') && !swapped) {
            swapped = true; fs.renameSync(nested, nested + '-old'); fs.symlinkSync(outside, nested, 'junction');
        }
        return result;
    });
    const res = await request(port, '/vendor/nested/file.js');
    assert.equal(swapped, true); assert.equal(res.status, 409); assert.equal(res.headers['content-encoding'], undefined);
    assert.ok(!res.body.includes('outside-sensitive-fixture'));
});
test('growth after open is bounded and cannot populate compression cache', async t => {
    const { publicRoot, port } = await fixture(t); const file = path.join(publicRoot, 'grow.js'); fs.writeFileSync(file, 'original');
    const original = io.openRead; let requested = 0, grew = false;
    t.mock.method(io, 'openRead', async function(...args) {
        const handle = await original(...args), read = handle.read.bind(handle);
        handle.read = async (buffer, offset, length, position) => {
            requested = Math.max(requested, buffer.length);
            if (!grew) { grew = true; fs.appendFileSync(file, 'x'.repeat(1024 * 1024)); }
            return read(buffer, offset, length, position);
        };
        return handle;
    });
    const res = await request(port, '/grow.js'); assert.equal(res.status, 409); assert.equal(requested, 9);
    assert.equal(res.headers['content-encoding'], undefined);
});
test('saturation and compression failures never send forbidden identity', async t => {
    const original = zlib.gzip; const releases = []; let ready;
    const four = new Promise(resolve => { ready = resolve; });
    zlib.gzip = function(...args) { releases.push(() => original(...args)); if (releases.length === 4) ready(); };
    const modulePath = require.resolve('../server/static-assets'); delete require.cache[modulePath];
    const delayed = require('../server/static-assets').createStaticAssets; zlib.gzip = original; delete require.cache[modulePath];
    const { publicRoot, port } = await fixture(t, delayed); fs.writeFileSync(path.join(publicRoot, 'asset.js'), 'a'.repeat(3000));
    const pending = Array.from({ length: 4 }, () => request(port, '/asset.js'));
    try { await four; const fifth = await request(port, '/asset.js'); assert.equal(fifth.status, 406); assert.equal(fifth.headers['content-encoding'], undefined); }
    finally { for (const release of releases) release(); await Promise.all(pending); }
    zlib.gzip = (...args) => args.at(-1)(new Error('synthetic compression error'));
    delete require.cache[modulePath]; const failing = require('../server/static-assets').createStaticAssets; zlib.gzip = original; delete require.cache[modulePath];
    const failure = await fixture(t, failing); fs.writeFileSync(path.join(failure.publicRoot, 'asset.js'), 'safe');
    assert.equal((await request(failure.port, '/asset.js')).status, 406);
    const allowed = await request(failure.port, '/asset.js', 'gzip'); assert.equal(allowed.status, 200); assert.equal(allowed.body.toString(), 'safe');
});
