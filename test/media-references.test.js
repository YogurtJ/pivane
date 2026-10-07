const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MediaReferences } = require('../server/media-references');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-references-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';

test('stored references deduplicate, survive restart, verify bytes and reject wrong types', async () => {
    const directory = path.join(root, 'store');
    const store = new MediaReferences({ directory });
    const { ref } = store.put(png);
    assert.match(ref, /^mediaref:[a-f0-9]{64}$/);
    assert.equal(store.put(png).ref, ref);
    assert.equal(store.usage().files, 1);
    assert.equal(await new MediaReferences({ directory }).resolve(ref, 'image'), png);
    await assert.rejects(store.resolve(ref, 'video'), /not a video/);
    await assert.rejects(store.read('mediaref:../private'), /Unknown/);
    assert.throws(() => store.put('data:image/png;base64,SGVsbG8='), /Invalid image/);
    fs.writeFileSync(store.locate(ref.slice(9)).file, Buffer.from('changed'));
    await assert.rejects(store.read(ref), /changed on disk/);
});

test('references have a storage budget and reject symlinks; gallery copies stay immutable', async () => {
    const store = new MediaReferences({ directory: path.join(root, 'budget'), maxBytes: 1 });
    assert.throws(() => store.put(png), /storage is full/);
    const gallery = path.join(root, 'gallery'); fs.mkdirSync(gallery);
    fs.writeFileSync(path.join(gallery, 'one.png'), Buffer.from(png.split(',')[1], 'base64'));
    const refs = new MediaReferences({ directory: path.join(root, 'safe') });
    const ref = await refs.gallery('/images/one.png', gallery);
    fs.writeFileSync(path.join(gallery, 'one.png'), 'changed');
    assert.equal(await refs.resolve(ref, 'image'), png);
    await assert.rejects(refs.gallery('/images/%2e%2e%2fprivate.png', gallery), /Invalid gallery/);
    const file = refs.locate(ref.slice(9)).file;
    fs.unlinkSync(file); fs.symlinkSync(path.join(gallery, 'one.png'), file);
    await assert.rejects(refs.read(ref), /invalid/);
});
