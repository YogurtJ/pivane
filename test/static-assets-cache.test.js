const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const zlib = require('node:zlib');

function get(port, file, encoding) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: file, headers: { 'Accept-Encoding': `${encoding}, identity;q=0` } }, res => {
            const chunks = []; res.on('data', bytes => chunks.push(bytes));
            res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'], bytes: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}
async function setup(t, wrap) {
    const modulePath = require.resolve('../server/static-assets'), originalGzip = zlib.gzip, originalBrotli = zlib.brotliCompress;
    let createStaticAssets;
    try {
        zlib.gzip = wrap(originalGzip); zlib.brotliCompress = wrap(originalBrotli);
        delete require.cache[modulePath]; ({ createStaticAssets } = require('../server/static-assets'));
    } finally { zlib.gzip = originalGzip; zlib.brotliCompress = originalBrotli; delete require.cache[modulePath]; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-static-cache-'));
    const app = express(); app.use(createStaticAssets([['/', root]])); app.use(express.static(root));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, port: server.address().port };
}

test('a complete workbench working set keeps both negotiated representations warm', async t => {
    let compressions = 0;
    const { root, port } = await setup(t, original => (...args) => { compressions++; original(...args); });
    for (let i = 0; i < 140; i++) fs.writeFileSync(path.join(root, `module-${i}.js`), `// Module ${i}\n` + 'const fixture = 1;\n'.repeat(10));
    for (let pass = 0; pass < 2; pass++) for (const encoding of ['br', 'gzip']) for (let i = 0; i < 140; i++) {
        const result = await get(port, `/module-${i}.js`, encoding);
        assert.equal(result.status, 200); assert.equal(result.encoding, encoding);
    }
    assert.equal(compressions, 280, 'a second page visit never recompresses unchanged modules');
    fs.appendFileSync(path.join(root, 'module-1.js'), '// new revision\n');
    await get(port, '/module-1.js', 'br'); await get(port, '/module-1.js', 'gzip');
    assert.equal(compressions, 282, 'a changed source invalidates both old representations');
});

test('overlapping requests share compression without exhausting unique compression slots', async t => {
    let compressions = 0, first;
    const started = new Promise(resolve => { first = resolve; });
    const releases = [];
    const { root, port } = await setup(t, original => (...args) => {
        compressions++; releases.push(() => original(...args)); first();
    });
    const bytes = Buffer.from('fixture '.repeat(10000)); fs.writeFileSync(path.join(root, 'shared.js'), bytes);
    const pending = Array.from({ length: 8 }, () => get(port, '/shared.js', 'gzip'));
    await started;
    // Keep the first representation pending while the parallel HTTP requests arrive.
    await new Promise(resolve => setTimeout(resolve, 30));
    const calls = compressions;
    for (const release of releases) release();
    const replies = await Promise.all(pending);
    assert.equal(calls, 1); assert.equal(compressions, 1);
    for (const reply of replies) {
        assert.equal(reply.status, 200); assert.equal(reply.encoding, 'gzip');
        assert.deepEqual(zlib.gunzipSync(reply.bytes), bytes);
    }
});
