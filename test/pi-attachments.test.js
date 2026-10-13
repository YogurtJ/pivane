const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const attachments = require('../public/pi-attachments');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64');

test('attachment IDs work without crypto and are unique within the page', () => {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/pi-attachments'), 'utf8'), context);
    const ids = Array.from({ length: 1000 }, () => context.window.PiAttachments.id());
    assert.equal(new Set(ids).size, 1000);
});

test('attachments classify empty MIME code/images and reject unsupported formats', async () => {
    for (const name of ['hello.ts', 'Dockerfile', '.gitignore', 'data.jsonl']) {
        const file = await attachments.read(new File(['hello'], name));
        assert.equal(file.kind, 'text'); assert.equal(file.text, 'hello');
    }
    const image = await attachments.read(new File([png], 'image.png'));
    assert.equal(image.mimeType, 'image/png'); assert.equal(image.data, png.toString('base64'));
    for (const [name, type] of [['x.pdf', 'application/pdf'], ['x.docx', ''], ['x.zip', ''], ['x.heic', 'image/heic'], ['x.svg', 'image/svg+xml'], ['x.bin', '']]) {
        await assert.rejects(attachments.read(new File(['test'], name, { type })));
    }
    await assert.rejects(attachments.read(new File(['not an image'], 'fake.png')), /图片内容/);
    await assert.rejects(attachments.read(new File([new Uint8Array([0, 1])], 'binary.txt')), /二进制/);
    await assert.rejects(attachments.read(new File([new Uint8Array([255, 254, 128])], 'bad.txt')), /UTF-8/);
    await assert.rejects(attachments.read(new File([], 'empty.txt')), /为空/);
});

test('per-file limits are checked before reading file data', async () => {
    const oversized = (name, size) => ({ name, size, type: '', arrayBuffer() { throw new Error('must not read'); } });
    await assert.rejects(attachments.read(oversized('x.png', attachments.limits.imageBytes + 1)), /6MB/);
    await assert.rejects(attachments.read(oversized('x.txt', attachments.limits.textBytes + 1)), /1MB/);
});

test('payload escaping and total limits match the gateway boundaries', () => {
    const file = { kind: 'text', name: 'a"<&.txt', text: 'content' };
    assert.match(attachments.payload('prompt', [file]).message, /name="a&quot;&lt;&amp;.txt"/);
    assert.doesNotThrow(() => attachments.validatePayload({ message: 'a'.repeat(400000) }));
    assert.throws(() => attachments.validateDraft('a'.repeat(400000), [file]), /400000/);
    assert.throws(() => attachments.validateDraft('', Array(9).fill(file)), /8 个/);
    const image = { mimeType: 'image/png', data: 'x' };
    assert.throws(() => attachments.validatePayload({ message: '', images: Array(7).fill(image) }), /6 张/);
    assert.doesNotThrow(() => attachments.validatePayload({ message: '', images: [{ ...image, data: 'x'.repeat(attachments.limits.encodedBytes) }] }));
    assert.throws(() => attachments.validatePayload({ message: '', images: [{ ...image, data: 'x'.repeat(attachments.limits.encodedBytes + 1) }] }), /24MB/);
});

test('native document drafts restore removable cards and images without duplicating markers or re-uploading', () => {
    const docs = require('../public/pi-document-references');
    const reference = { id: 'a'.repeat(64), revision: 'b'.repeat(64), name: '合同 & 样本.docx', format: 'docx', size: 1234 };
    const marker = docs.marker(reference), image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
    const draft = attachments.fromPayload({ message: 'Summarize\n\n' + marker, images: [image] });
    assert.equal(draft.text, 'Summarize');
    assert.deepEqual(draft.files.map(file => file.kind), ['document', 'image']);
    assert.deepEqual(draft.files[0].reference, reference);
    assert.equal(draft.files[0].name, reference.name);
    assert.deepEqual(attachments.payload(draft.text, draft.files), { message: 'Summarize\n\n' + marker, images: [image] });
    assert.equal(attachments.payload(draft.text, draft.files.slice(1)).message, 'Summarize', 'removing the card removes the reference');
    assert.throws(() => attachments.fromPayload({ message: Array(6).fill(marker).join('\n') }), /5 个/);
    assert.throws(() => attachments.fromPayload({ message: 'Imported image', images: [{ ...image, data: 'x" onerror="alert(1)' }] }), /图片内容/);
    const invalid = marker.replace('bytes="1234"', 'bytes="0"');
    assert.equal(attachments.fromPayload({ message: invalid }).text, invalid, 'unrecognized text is never silently discarded');
});

test('clipboard files are not duplicated and directories are refused', () => {
    const file = new File(['hello'], 'hello.txt');
    const item = { kind: 'file', getAsFile: () => file };
    assert.deepEqual(attachments.transferFiles({ items: [item], files: [file] }).files, [file]);
    assert.equal(attachments.hasFiles({ types: ['text/plain'], files: [] }), false);
    assert.equal(attachments.hasFiles({ types: ['Files'], items: [] }), true);
    assert.match(attachments.transferFiles({ types: ['Files'], items: [] }).errors[0], /未提供文件内容/);
    assert.match(attachments.transferFiles({ items: [{ ...item, webkitGetAsEntry: () => ({ isDirectory: true }) }] }).errors[0], /文件夹/);
});
