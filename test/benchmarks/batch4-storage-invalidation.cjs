#!/usr/bin/env node
// Correctness witness, not a speed benchmark. Demonstrates why directory-only
// cache invalidation cannot preserve usage() observation of modified file sizes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const h = require('../helpers/batch4-storage-fixtures.cjs');
const stamp = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    return Object.fromEntries(['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
};
async function witness(base) {
    const attempts = h.prohibitNetworkAndProcesses();
    const { MediaReferences } = require('../../server/media-references');
    const directory = path.join(base, 'media', 'references'), store = new MediaReferences({ directory });
    const original = h.png('before-in-place-mutation');
    const item = store.put('data:image/png;base64,' + original.toString('base64'));
    const file = path.join(directory, item.ref.slice(9) + '.png');
    const before = { directory: stamp(directory), file: stamp(file), usage: store.usage() };
    // A valid PNG image now has different content at an existing content-addressed
    // name. This is deliberate corruption, used only to test invalidation safety.
    const grown = h.png('changed-content-' + 'x'.repeat(1024));
    fs.writeFileSync(file, grown);
    const after = { directory: stamp(directory), file: stamp(file), usage: store.usage() };
    assert.deepEqual(after.directory, before.directory);
    assert.equal(after.file.ino, before.file.ino);
    assert.notEqual(after.file.size, before.file.size);
    assert.equal(after.usage.files, before.usage.files);
    assert.equal(after.usage.bytes - before.usage.bytes, grown.length - original.length);
    await assert.rejects(store.read(item.ref), /changed on disk/);
    const second = h.png('valid-external-new-entry');
    fs.writeFileSync(path.join(directory, h.sha(second) + '.png'), second, { mode: 0o600 });
    const addition = { directory: stamp(directory), usage: store.usage() };
    assert.notDeepEqual(addition.directory, after.directory);
    assert.equal(addition.usage.files, after.usage.files + 1);
    assert.deepEqual(attempts, { network: 0, subprocess: 0 });
    console.log(JSON.stringify({ node: process.version, before, afterInPlaceMutation: after, afterExternalAddition: addition, attempts,
        assertions: ['Directory BigInt identity/size/mtimeNs/ctimeNs unchanged during file size growth',
            'Existing production usage() observes the changed byte total', 'Production read() rejects the content-address mismatch',
            'External addition changes directory stamp and file count'],
        scope: 'Safety witness only. Corrupt input is excluded from all timing and benefit measurements.' }, null, 2));
}
function main(args) {
    assert.equal(args[0], '--out'); assert.ok(args[1] && path.isAbsolute(args[1]));
    const output = args[1], base = path.join(path.dirname(output), 'invalidation-fixture');
    assert.ok(!fs.existsSync(base)); h.directories(base);
    try {
        const result = spawnSync(process.execPath, [__filename, '--child', base], { env: h.environment(base), encoding: 'utf8' });
        fs.writeFileSync(output, result.stdout, { mode: 0o600 });
        fs.writeFileSync(output + '.stderr.log', result.stderr, { mode: 0o600 });
        assert.equal(result.status, 0, result.stderr);
        console.log(JSON.stringify({ exitCode: result.status, output, assertions: JSON.parse(result.stdout).assertions }));
    } finally { fs.rmSync(base, { recursive: true, force: true }); assert.ok(!fs.existsSync(base)); }
}
if (process.argv[2] === '--child') witness(process.argv[3]).catch(error => { console.error(error.stack); process.exitCode = 1; });
else main(process.argv.slice(2));
