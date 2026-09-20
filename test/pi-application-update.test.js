const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { gzipSync } = require('node:zlib');
const { hash } = require('../server/pi-maintenance-files');
const { unpack, stageApplication, download } = require('../server/pi-application-installer');
function tar(entries) {
    const blocks = [];
    for (const [name, body, type = '0'] of entries) {
        const bytes = Buffer.from(body), header = Buffer.alloc(512);
        header.write(name); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
        header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156);
        header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-update-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return path.join(root, 'release'); }
function archive(extra = {}) {
    const files = { 'package.json': JSON.stringify({ name: 'pivane', version: '1.2.3', dependencies: { '@earendil-works/pi-coding-agent': '0.86.0' } }), 'package-lock.json': JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }), ...extra };
    const manifest = { product: 'Pivane', appVersion: '1.2.3', piVersion: '0.86.0', files: Object.entries(files).map(([name, value]) => ({ path: name, bytes: Buffer.byteLength(value), sha256: hash(Buffer.from(value)) })) };
    return tar([...Object.entries(files), ['TRIAL_MANIFEST.json', JSON.stringify(manifest)]].map(([name, bytes]) => ['pivane-1.2.3/' + name, bytes]));
}
test('application archive rejects traversal, links, duplicates, missing manifest and private files', t => {
    for (const entries of [[['pivane-1.2.3/../escape', 'bad']], [['pivane-1.2.3/link', '', '2']], [['pivane-1.2.3/a', 'a'], ['pivane-1.2.3/a', 'b']]]) assert.throws(() => unpack(tar(entries), '1.2.3', fixture(t)));
    assert.throws(() => unpack(archive({ '.env': 'synthetic' }), '1.2.3', fixture(t)), /private/);
    const dir = fixture(t); assert.equal(unpack(archive(), '1.2.3', dir).files.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version, '1.2.3');
});
test('application installer fails before npm on checksum mismatch and isolates installation credentials', async t => {
    const bytes = archive(), release = { version: '1.2.3', sha256: hash(bytes) };
    await assert.rejects(stageApplication({ directory: fixture(t), release: { ...release, sha256: '0'.repeat(64) }, get: async () => bytes, run: () => assert.fail('must not install') }), /SHA256/);
    const dir = fixture(t), calls = [];
    await stageApplication({ directory: dir, release, get: async () => bytes, env: { PATH: process.env.PATH, HOME: os.homedir(), OPENAI_API_KEY: 'synthetic' }, run: async (args, opts) => {
        calls.push(args); assert.equal(opts.env.OPENAI_API_KEY, undefined);
        if (calls.length === 1) { assert.ok(args.includes('ci')); assert.ok(args.includes('--ignore-scripts')); fs.mkdirSync(path.join(dir, 'node_modules/@earendil-works/pi-coding-agent'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules/@earendil-works/pi-coding-agent/package.json'), '{"version":"0.86.0"}'); }
        else assert.equal(opts.env.PI_OFFLINE, '1');
    } });
    assert.equal(calls.length, 2); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PI_INSTALL_COMPLETE.json'))).archiveSha256, release.sha256);
});
test('release download rejects off-origin redirects before requesting them', async () => {
    let calls = 0;
    await assert.rejects(download('https://github.com/YogurtJ/pivane/releases/download/v1.2.3/a', { env: {}, request: async () => { calls++; return { status: 302, headers: { get: () => 'https://evil.example/payload' } }; } }), /Untrusted/);
    assert.equal(calls, 1);
});
