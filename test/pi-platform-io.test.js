const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { assertPrivateFile } = require('./private-file-helper.cjs');
const fileIo = require('../server/pi-file-io');
const { descriptorPathSync } = require('../server/pi-file-descriptor');

test('private-file verification rejects public access using the actual platform permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-private-permissions-'));
    const filename = path.join(root, 'fixture.txt');
    try {
        require('../server/pi-private-files').writePrivateFileSync(filename, 'synthetic only');
        assertPrivateFile(filename);
        if (process.platform === 'win32') execFileSync('icacls.exe', [filename, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore' });
        else fs.chmodSync(filename, 0o644);
        assert.throws(() => assertPrivateFile(filename));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('platform file opening refuses final link swaps and preserves byte offsets and full Windows identity', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-platform-io-')));
    const filename = path.join(root, '数据.txt'), link = path.join(root, 'link.txt');
    let fd;
    try {
        fs.writeFileSync(filename, '0123456789');
        fd = fileIo.openReadSync(filename);
        assert.equal(descriptorPathSync(fd), filename);
        const identity = fileIo.identity(fd);
        if (process.platform === 'win32') assert.match(identity, /^[a-f0-9]{48}$/);
        assert.equal(fileIo.sameIdentityAtPath(filename, identity), true);
        const buffer = Buffer.alloc(3);
        assert.equal(fs.readSync(fd, buffer, 0, 3, 4), 3);
        assert.equal(buffer.toString(), '456');
        fs.symlinkSync(filename, link);
        assert.throws(() => fileIo.openReadSync(link), { code: 'ELOOP' });
        const replacement = path.join(root, 'replacement.txt'); fs.writeFileSync(replacement, 'replacement');
        if (process.platform === 'win32') {
            assert.equal(fileIo.sameIdentityAtPath(replacement, identity), false);
            assert.throws(() => require('../server/pi-win32-native').replaceFileSync(replacement, filename), { code: 'FILE_REPLACE' });
            assert.equal(fs.readFileSync(filename, 'utf8'), '0123456789', 'refused replacement leaves the existing file intact');
            fs.closeSync(fd); fd = undefined;
        }
        require('../server/pi-win32-native').replaceFileSync(replacement, filename);
        if (process.platform === 'win32') assert.equal(fileIo.sameIdentityAtPath(filename, identity), false);
        assert.equal(fs.readFileSync(filename, 'utf8'), 'replacement');
        // Invalid-fd probes run in a separate process, so a CRT failure cannot
        // be mistaken for an ordinary assertion failure or kill this test runner.
        if (process.platform === 'win32') {
            const binary = path.resolve(__dirname, '../native/pi-win32-x64-fd.node');
            const probe = spawnSync(process.execPath, ['-e', "const n=require(process.argv[1]),a=require('assert');for(const fd of [999999,2147483647])a.throws(()=>n.descriptorPath(fd),{code:'EBADF'});for(const x of [-1,NaN,Infinity,1.5,null,'3'])a.throws(()=>n.descriptorPath(x),TypeError)", binary], { encoding: 'utf8' });
            assert.equal(probe.status, 0, probe.stderr);
        }
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); }
});
