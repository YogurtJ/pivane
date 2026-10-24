const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { WeixinComponent, SOURCES, compile } = require('../server/channels/weixin-component');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-weixin-中文 # '));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const hash = value => createHash('sha256').update(value).digest('hex');
function reviewedModules() {
    // Exercise the same module-initialization boundary as upstream, including
    // native file URL parsing and the injected package metadata reader.
    const api = new Map([
        ['package.json', JSON.stringify({ name: SOURCES[0].name, version: SOURCES[0].version })],
        ['dist/src/api/api.js', `import { fileURLToPath } from 'node:url';
            import fs from 'node:fs';
            export const moduleUrl = import.meta.url;
            export const modulePath = fileURLToPath(import.meta.url);
            export const packageVersion = JSON.parse(fs.readFileSync(modulePath)).version;
            export function getUpdates() { return fetch('https://synthetic.invalid/updates'); }`],
        ['dist/src/api/types.js', 'export const version = 1;'],
        ['dist/src/util/redact.js', 'export {};'],
        ['dist/src/messaging/markdown-filter.js', 'export {};'],
        ['dist/src/cdn/aes-ecb.js', 'export {};'],
        ['dist/src/cdn/cdn-url.js', 'export {};'],
        ['dist/src/cdn/pic-decrypt.js', 'export function downloadAndDecryptBuffer() {}'],
        ['dist/src/cdn/cdn-upload.js', 'export function uploadBufferToCdn() {}']
    ]);
    const qr = new Map(['index', 'QRMath', 'QR8bitByte', 'QRRSBlock', 'QRUtil', 'QRErrorCorrectLevel', 'QRBitBuffer', 'QRMaskPattern', 'QRPolynomial', 'QRMode'].map(name => [`vendor/QRCode/${name}.js`, name === 'index'
        ? 'module.exports = class QRCode { addData(value) { this.value = value; } make() { this.modules = [[Boolean(this.value)]]; } };' : 'module.exports = {};']));
    return { api, qr };
}

test('reviewed bundle loads with an absolute native file URL and reloads its receipt', async () => {
    const { api, qr } = reviewedModules();
    const code = await compile(api, qr);
    const loaded = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    assert.ok(path.isAbsolute(loaded.api.modulePath));
    assert.equal(loaded.api.modulePath, require.resolve('../server/channels/weixin-component'));
    assert.equal(fileURLToPath(loaded.api.moduleUrl), loaded.api.modulePath);
    assert.equal(loaded.api.packageVersion, SOURCES[0].version);
    if (process.platform === 'win32') assert.match(loaded.api.modulePath, /^[A-Za-z]:\\|^\\\\/);
    const directory = path.join(root, 'installed'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'component.json'), JSON.stringify({ version: 2, sources: SOURCES, code, codeHash: hash(code) }));
    const component = new WeixinComponent(directory, { get: () => { throw Error('Installed receipts must not download'); } });
    const transport = async url => ({ url, synthetic: true });
    const reloaded = await component.load(transport);
    assert.deepEqual(reloaded.qrMatrix('Pivane'), [[true]]);
    assert.deepEqual(await reloaded.api.getUpdates(), { url: 'https://synthetic.invalid/updates', synthetic: true });
    assert.equal((await component.install(new AbortController().signal)).installed, true);
    component.uninstall(); assert.equal(component.status().installed, false);
});

test('unreviewed imports are still rejected by the compiler', async () => {
    const { api, qr } = reviewedModules();
    api.set('dist/src/api/api.js', "import 'node:child_process';");
    await assert.rejects(compile(api, qr), /Unreviewed component import/);
});

test('installation failures identify stages without exposing diagnostic content or retrying', async () => {
    const signal = new AbortController().signal;
    let attempts = 0;
    const directory = path.join(root, 'download-failure');
    const component = new WeixinComponent(directory, { get: async () => {
        attempts++; throw Object.assign(new Error('PRIVATE_TOKEN at https://user:password@proxy.invalid/C:/private'), { code: 'ECONNRESET' });
    } });
    await assert.rejects(component.install(signal), error => {
        assert.equal(error.status, 400);
        assert.match(error.message, /下载组件（ECONNRESET）/);
        assert.doesNotMatch(error.message, /PRIVATE_TOKEN|password|proxy.invalid|C:\//);
        return true;
    });
    assert.equal(attempts, 1); assert.equal(fs.existsSync(directory), false);
    const corrupt = new WeixinComponent(path.join(root, 'verify-failure'), { get: async () => Buffer.from('untrusted') });
    await assert.rejects(corrupt.install(signal), /校验下载包/);
    assert.equal(corrupt.status().installed, false);
    const invalid = path.join(root, 'read-failure'); fs.mkdirSync(invalid);
    fs.writeFileSync(path.join(invalid, 'component.json'), 'PRIVATE_NOT_JSON');
    await assert.rejects(new WeixinComponent(invalid).install(signal), error => {
        assert.match(error.message, /读取现有组件/); assert.doesNotMatch(error.message, /PRIVATE_NOT_JSON/); return true;
    });
    assert.equal(fs.readFileSync(path.join(invalid, 'component.json'), 'utf8'), 'PRIVATE_NOT_JSON');
});

test('channel HTTP responses preserve the safe install error', async () => {
    const { mountChannels } = require('../server/channels/service');
    const component = new WeixinComponent(path.join(root, 'http-failure'), { get: async () => { throw Object.assign(new Error('PRIVATE_NETWORK_BODY'), { code: 'ENOTFOUND' }); } });
    const app = require('express')(); app.use(require('express').json());
    mountChannels(app, { track: promise => promise, action: () => component.install(new AbortController().signal) });
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/channels/weixin/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install' }) });
        assert.equal(response.status, 400);
        const body = await response.json(); assert.match(body.error, /下载组件（ENOTFOUND）/); assert.doesNotMatch(JSON.stringify(body), /PRIVATE_NETWORK_BODY/);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
