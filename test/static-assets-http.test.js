const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { createStaticAssets } = require('../server/static-assets');

const source = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(port, pathname, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject); req.end();
    });
}
function decoded(reply) {
    return reply.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(reply.body)
        : reply.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(reply.body) : reply.body;
}

test('bounded static middleware preserves Express routing, validator and source revisions', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-static-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const publicDir = path.join(root, 'public'); fs.mkdirSync(publicDir);
    const file = path.join(publicDir, 'fixture.js');
    const bytes = Buffer.from('const synthetic = "' + 'fixture text '.repeat(1000) + '";\n');
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(root, 'secret.js'), 'outside root');
    fs.symlinkSync(path.join(root, 'secret.js'), path.join(publicDir, 'link.js'));
    const app = express();
    app.use(createStaticAssets([['/', publicDir]]));
    app.use(express.static(publicDir));
    app.get('/api/private.js', (_req, res) => res.json({ secret: 'synthetic' }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const port = server.address().port;
    const identity = await request(port, '/fixture.js', { 'Accept-Encoding': 'identity' });
    assert.equal(identity.status, 200); assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(identity.body, bytes);
    const gzip = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip;q=0.7, br;q=0.1, identity;q=0' });
    assert.equal(gzip.status, 200); assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(decoded(gzip), bytes); assert.match(gzip.headers.vary, /Accept-Encoding/);
    assert.notEqual(gzip.headers.etag, identity.headers.etag);
    assert.equal(gzip.headers['last-modified'], identity.headers['last-modified']);
    assert.equal(gzip.headers['cache-control'], identity.headers['cache-control']);
    const br = await request(port, '/fixture.js', { 'Accept-Encoding': 'br, gzip;q=0.1, identity;q=0' });
    assert.equal(br.headers['content-encoding'], 'br'); assert.deepEqual(decoded(br), bytes);
    assert.ok(br.body.length < bytes.length && gzip.body.length < bytes.length);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'br;q=0, gzip;q=0, identity;q=0' })).status, 406);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': '*;q=0' })).status, 406);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip;q=0, br;q=0' })).headers['content-encoding'], undefined);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'unsupported;q=1, identity;q=0' })).status, 406);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'unsupported' })).headers['content-encoding'], undefined);
    const fresh = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip, identity;q=0', 'If-None-Match': gzip.headers.etag });
    assert.equal(fresh.status, 304); assert.equal(fresh.body.length, 0);
    assert.equal(fresh.headers.etag, gzip.headers.etag); assert.match(fresh.headers.vary, /Accept-Encoding/);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': 'W/' + gzip.headers.etag })).status, 304);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', 'If-Modified-Since': gzip.headers['last-modified'] })).status, 304);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'br', 'If-None-Match': gzip.headers.etag })).status, 200);
    const head = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip, identity;q=0' }, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], String(gzip.body.length));
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag }, 'HEAD')).status, 304);
    const range = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', Range: 'bytes=0-4' });
    assert.equal(range.status, 206); assert.deepEqual(range.body, bytes.subarray(0, 5)); assert.equal(range.headers['content-encoding'], undefined);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip, identity;q=0', Range: 'bytes=0-4' })).status, 406);
    const staleRange = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', Range: 'bytes=0-4', 'If-Range': '"invalid"' });
    assert.equal(staleRange.status, 200); assert.deepEqual(staleRange.body, bytes);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', Range: 'bytes=999999-' })).status, 416);
    assert.equal((await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', 'If-Match': '"no"' })).status, 412);
    assert.equal((await request(port, '/link.js', { 'Accept-Encoding': 'br' })).headers['content-encoding'], undefined, 'symlink uses native static behavior');
    assert.notEqual((await request(port, '/%2e%2e/secret.js', { 'Accept-Encoding': 'br' })).headers['content-encoding'], 'br');
    assert.notEqual((await request(port, '/missing.js', { 'Accept-Encoding': 'br' })).headers['content-encoding'], 'br');
    assert.equal((await request(port, '/api/private.js', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined);
    const revised = Buffer.from('let changed = "' + 'replacement '.repeat(1400) + '";\n');
    fs.writeFileSync(file, revised);
    const updated = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag });
    assert.equal(updated.status, 200); assert.deepEqual(decoded(updated), revised); assert.notEqual(updated.headers.etag, gzip.headers.etag);
    const timestamp = fs.statSync(file).mtime;
    fs.writeFileSync(file, Buffer.from('a'.repeat(revised.length)));
    fs.utimesSync(file, timestamp, timestamp);
    const sameSize = await request(port, '/fixture.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': updated.headers.etag });
    assert.equal(sameSize.status, 200); assert.deepEqual(decoded(sameSize), Buffer.from('a'.repeat(revised.length)));
    assert.notEqual(sameSize.headers.etag, updated.headers.etag);
    console.log(`Synthetic fixture: identity ${bytes.length}B, gzip ${gzip.body.length}B, br ${br.body.length}B`);
});

test('real server serves public scripts and vendor assets compressed without touching API, media or HTML', { timeout: 60000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-static-server-'));
    const agent = path.join(root, 'agent'); fs.mkdirSync(agent);
    const child = spawn(process.execPath, ['server.js', '--direct'], { cwd: source, env: {
        PATH: process.env.PATH, HOME: root, HOST: '127.0.0.1', PORT: '0', PI_MEDIA_PROFILE: 'clean', PI_OFFLINE: '1', PI_TELEMETRY: '0',
        PI_CODING_AGENT_DIR: agent, PI_MEDIA_DATA_DIR: path.join(root, 'media'), PI_PROJECT_ROOTS: root,
        PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json')
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    t.after(async () => {
        if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]); }
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(root, { recursive: true, force: true });
    });
    let port;
    for (let i = 0; i < 400; i++) {
        const match = /Pivane backend running at http:\/\/localhost:(\d+)/.exec(output);
        if (match) { port = Number(match[1]); break; }
        if (child.exitCode !== null) break;
        await delay(50);
    }
    assert.ok(port, `isolated service must start: ${output.slice(-1000)}`);
    for (const route of ['/pi-chat.js', '/workspace.css', '/vendor/marked/marked.umd.js', '/vendor/dompurify/purify.min.js', '/vendor/highlight/highlight.min.js', '/vendor/katex-0.18.7/katex.min.js', '/vendor/katex-0.18.7/katex.min.css', '/vendor/mermaid-11.17.2.min.js']) {
        const external = /^\/vendor\/(?:marked|dompurify|highlight)\//.test(route);
        const original = fs.readFileSync(external ?
            path.join(source, 'node_modules', route.replace(/^\/vendor\//, '').replace(/^marked\//, 'marked/lib/').replace(/^dompurify\//, 'dompurify/dist/').replace(/^highlight\//, '@highlightjs/cdn-assets/')) : path.join(source, 'public', route));
        const reply = await request(port, route, { 'Accept-Encoding': 'br, gzip;q=0.5, identity;q=0' });
        assert.equal(reply.status, 200, route); assert.equal(reply.headers['content-encoding'], 'br', route);
        assert.deepEqual(decoded(reply), original, route);
        assert.equal((await request(port, route, { 'Accept-Encoding': 'gzip, br;q=0, identity;q=0' })).headers['content-encoding'], 'gzip');
        console.log(`${route}: identity ${original.length}B, br ${reply.body.length}B`);
    }
    for (const route of ['/', '/api/access/status', '/api/pi/status', '/brand/logo-64.png', '/images/unknown.js']) {
        const reply = await request(port, route, { 'Accept-Encoding': 'gzip, br' });
        assert.equal(reply.headers['content-encoding'], undefined, route);
    }
    assert.equal((await request(port, '/pi-chat.js', { 'Accept-Encoding': 'gzip', Range: 'bytes=0-9' })).status, 206);
    const settings = await request(port, '/api/access/settings');
    const revision = JSON.parse(settings.body).revision;
    const access = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ enabled: true, token: 'synthetic-static-token-123456', confirmed: true, expectedRevision: revision });
        const req = http.request({ hostname: '127.0.0.1', port, path: '/api/access/settings', method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Pi-Access': '1' } }, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
        }); req.on('error', reject); req.end(payload);
    });
    assert.equal(access, 200);
    assert.equal((await request(port, '/api/pi/status', { 'Accept-Encoding': 'br' })).status, 401);
    const publicAsset = await request(port, '/pi-chat.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(publicAsset.status, 200); assert.equal(publicAsset.headers['content-encoding'], 'gzip');
});
