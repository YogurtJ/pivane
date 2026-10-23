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

test('generic files and original image references round-trip with explicit upload metadata', async () => {
    const docs = require('../public/pi-document-references');
    const reference = { id: 'c'.repeat(64), revision: 'd'.repeat(64), name: 'recording.mp3', format: 'file', size: 4 };
    const file = await attachments.read(new File(['data'], reference.name), { upload: async () => ({ reference }) });
    assert.equal(file.kind, 'document'); assert.equal(file.format, 'file'); assert.equal(file.data, undefined);
    const message = attachments.payload('Transcribe', [file]); assert.match(message.message, /pivane_attachment/);
    assert.equal(attachments.fromPayload(message).files[0].reference.id, reference.id);
    const original = { ...reference, name: 'original.png', format: 'image', size: png.length };
    const image = await attachments.read(new File([png], original.name), { preserveImages: true, upload: async (_file, options) => {
        assert.equal(options.purpose, 'image'); return { reference: original };
    } });
    const draft = attachments.fromPayload(attachments.payload('Look', [image]));
    assert.equal(draft.files.length, 1); assert.equal(draft.files[0].kind, 'image'); assert.deepEqual(draft.files[0].reference, original);
    assert.deepEqual(attachments.payload(draft.text, draft.files), attachments.payload('Look', [image]));
    assert.doesNotThrow(() => attachments.validateDraft('', Array(8).fill(file)));
    assert.throws(() => attachments.validateDraft('', [{ kind: 'pending-upload', name: 'unknown.mp3' }]), /待确认/);
    await assert.rejects(attachments.read({ name: 'big.mp4', type: 'video/mp4', size: attachments.limits.fileBytes + 1 }), /100 MiB/);
    assert.equal(docs.valid({ ...reference, size: 100 * 1024 * 1024 }), true);
    assert.equal(docs.valid({ ...reference, size: 100 * 1024 * 1024 + 1 }), false);
});

test('document attachment uploads reject stale selections before any POST, including reads that return to the source thread', async t => {
    for (const change of ['session', 'project', 'connection', 'disconnect', 'attachment epoch', 'editor', 'A-B-A']) {
        await t.test(change, async () => {
            const fixture = documentUploadFixture();
            let current = true;
            const prepared = fixture.client.prepareUpload(() => current);
            const file = new File([png], 'slow.png');
            let release;
            file.arrayBuffer = () => new Promise(resolve => { release = () => resolve(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)); });
            const pending = attachments.read(file, { ...prepared, preserveImages: true });
            if (change === 'session') fixture.context.session.id = 'b';
            else if (change === 'project') fixture.context.cwd = '/project-b';
            else if (change === 'connection') fixture.context.generation++;
            else if (change === 'disconnect') fixture.context.connected = false;
            else if (change === 'A-B-A') { fixture.context.generation += 2; }
            else current = false;
            release();
            await assert.rejects(pending, error => error.status === 409);
            assert.equal(fixture.requests.length, 0, 'stale bytes never reach the upload API');
            await assert.rejects(async () => prepared.upload(new File(['raw'], 'raw.zip')), error => error.status === 409);
            assert.equal(fixture.requests.length, 0, 'direct original uploads also check selection ownership');
        });
    }
});

test('document attachment images already POSTed retain their source owner and reject late draft insertion', async t => {
    for (const change of ['session', 'attachment epoch']) {
        await t.test(change, async () => {
            let finish, posted;
            const started = new Promise(resolve => { posted = resolve; });
            const fixture = documentUploadFixture(async (_url, _options, result) => {
                posted(); return new Promise(resolve => { finish = () => resolve(result); });
            });
            let current = true;
            const pending = attachments.read(new File([png], 'late.png'), { ...fixture.client.prepareUpload(() => current), preserveImages: true });
            await started;
            if (change === 'session') fixture.context.session.id = 'b'; else current = false;
            finish();
            await assert.rejects(pending, error => error.status === 409);
            assert.equal(fixture.requests.length, 1);
            assert.equal(fixture.requests[0].url.searchParams.get('sessionId'), 'a');
            assert.equal(fixture.requests[0].options.method, 'POST');
        });
    }
});

test('document attachment image response loss queries the original request and never POSTs again', async () => {
    const fixture = documentUploadFixture(async (_url, options, result) => {
        if (options?.method === 'POST') throw new Error('controlled response loss');
        return result;
    });
    const image = await attachments.read(new File([png], 'reconciled.png'), { ...fixture.client.prepareUpload(), preserveImages: true });
    assert.equal(image.reference.format, 'image');
    assert.deepEqual(fixture.requests.map(({ options }) => options?.method || 'GET'), ['POST', 'GET']);
    const [post, status] = fixture.requests.map(request => request.url);
    assert.equal(status.pathname, '/api/pi/uploads/status');
    assert.equal(status.searchParams.get('requestId'), post.searchParams.get('requestId'));
    assert.equal(status.searchParams.get('sessionId'), 'a');
});

function documentUploadFixture(respond = async (_url, _options, result) => result) {
    const context = { cwd: '/project-a', session: { id: 'a' }, generation: 1, connected: true };
    const requests = [];
    let saved;
    const sandbox = { PiDocumentReferences: require('../public/pi-document-references'), PiAttachments: attachments, URLSearchParams,
        crypto: require('node:crypto').webcrypto };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/pi-document-attachments'), 'utf8'), sandbox);
    const client = new sandbox.PiDocumentAttachments({ context: () => context, api: async (path, options) => {
        const url = new URL(path, 'http://fixture.invalid'); requests.push({ url, options });
        if (options?.method === 'POST') saved = { reference: { id: 'a'.repeat(64), revision: 'b'.repeat(64),
            name: options.body.name, size: options.body.size, format: url.searchParams.get('purpose') === 'image' ? 'image' : 'file' } };
        return respond(url, options, saved);
    } });
    client.enabled = true; client.generic = true;
    return { client, context, requests };
}

test('transfer recovery preserves independent prose, isolates failed files and reads FileList when items are unavailable', () => {
    const good = new File(['ok'], 'good.txt'), bad = new File(['bad'], 'broken.txt');
    const metadata = { text: 'Please inspect these files', files: [good, bad] };
    assert.equal(attachments.recoveryText(metadata, [bad], [good]), 'Please inspect these files\n[文件名（未上传）：broken.txt]');
    assert.equal(attachments.recoveryText({ text: '/local/good.txt\n/local/broken.txt', files: [good, bad] }, [bad], [good]), '[路径（未上传）：/local/broken.txt]');
    assert.equal(attachments.recoveryText({ text: 'good.txt', files: [good] }, [], [good]), '');
    assert.match(attachments.recoveryText({ text: '/local/recording.mp3' }, [], []), /文件未上传.*recording.mp3/);
    assert.equal(attachments.recoveryText({}, [bad]), '[文件名（未上传）：broken.txt]');
    assert.deepEqual(attachments.transferFiles({ items: [{ kind: 'file', getAsFile: () => null }], files: [good] }).files, [good]);
    assert.deepEqual(attachments.transferFiles({ items: [{ kind: 'file', getAsFile: () => { throw new Error('unavailable'); } }], files: [good] }).files, [good]);
    assert.equal(attachments.transferText({ getData: type => type === 'text/uri-list' ? '# comment\nfile:///local/file.mp3' : '' }), 'file:///local/file.mp3');
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
