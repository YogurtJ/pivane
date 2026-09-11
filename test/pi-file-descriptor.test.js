const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { descriptorPath, descriptorPathSync, assertDescriptorBackend } = require('../server/pi-file-descriptor');

test('descriptor paths retain the open object across attempted parent movement, never a replacement pathname', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fd-path-')));
    let fd;
    try {
        assert.equal(assertDescriptorBackend(), process.platform === 'darwin' ? 'darwin-fcntl' : process.platform === 'win32' ? 'win32-handle' : 'linux-proc');
        const original = path.join(root, 'allowed'), moved = path.join(root, 'outside');
        fs.mkdirSync(original);
        const name = '中文 文件.txt';
        fs.writeFileSync(path.join(original, name), 'open object');
        fd = fs.openSync(path.join(original, name), fs.constants.O_RDONLY);
        assert.equal(descriptorPathSync(fd), path.join(original, name));
        assert.equal(await descriptorPath(fd), path.join(original, name));
        try { fs.renameSync(original, moved); }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
            assert.equal(descriptorPathSync(fd), path.join(original, name));
            assert.equal(await descriptorPath(fd), path.join(original, name));
            assert.equal(fs.readFileSync(fd, 'utf8'), 'open object');
            t.diagnostic('Windows refused moving the directory with an open descendant; kernel path and held bytes remain unchanged');
            return;
        }
        fs.mkdirSync(original);
        fs.writeFileSync(path.join(original, name), 'different replacement');
        assert.equal(descriptorPathSync(fd), path.join(moved, name));
        assert.equal(await descriptorPath(fd), path.join(moved, name));
        fs.unlinkSync(path.join(moved, name));
        assert.throws(() => descriptorPathSync(fd));
        await assert.rejects(descriptorPath(fd));
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); }
});
test('invalid descriptor arguments are rejected before filesystem access', async () => {
    for (const fd of [-1, 1.5, NaN, Infinity, '3', null, 0x80000000]) {
        assert.throws(() => descriptorPathSync(fd), TypeError);
        await assert.rejects(descriptorPath(fd), TypeError);
    }
});
