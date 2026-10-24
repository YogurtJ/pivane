const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-inventory-')));
const home = path.join(root, 'home'); fs.mkdirSync(home);
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = root; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store');
const { DocumentUploads, MAX_FILE_BYTES } = require('../server/pi-document-uploads');
const io = require('../server/pi-file-io');
let number = 0;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function fixture(t, originals = [Buffer.alloc(768 * 1024 + 17, 7)]) {
    const base = path.join(root, String(++number)), agent = path.join(base, 'agent'), cwd = path.join(base, 'project');
    fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(cwd); process.env.PI_CODING_AGENT_DIR = agent;
    const store = new PiSessionStore(), supervisor = { removing: new Set(), moving: new Set(), getActiveWorker: () => null };
    const service = new DocumentUploads({ store, supervisor });
    t.after(async () => { await service.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
    const session = await store.createSession(cwd, 'Inventory stream fixture'), files = [];
    for (const [index, bytes] of originals.entries()) {
        const { reference } = await service.upload({ cwd, sessionId: session.id, requestId: 'original-' + index, name: `original-${index}.bin` }, bytes);
        const object = await service.object(reference.id);
        files.push({ reference, original: path.join(object.folder, 'original'), manifest: path.join(object.folder, 'manifest.json') });
    }
    return { cwd, service, files };
}
function observeOriginalReads(t, afterRead = () => {}) {
    const opened = new Map(), openRead = io.openRead;
    t.mock.method(io, 'openRead', async function(filename, ...args) {
        const handle = await openRead.call(this, filename, ...args);
        if (path.basename(filename) !== 'original') return handle;
        const observation = { reads: [], closed: false }; opened.set(filename, observation);
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        t.mock.method(handle, 'read', async (...input) => {
            const result = await read(...input);
            const record = { position: input[3], bytesRead: result.bytesRead };
            observation.reads.push(record); await afterRead(filename, record); return result;
        });
        t.mock.method(handle, 'close', async (...input) => {
            try { return await close(...input); } finally { observation.closed = true; }
        });
        return handle;
    });
    return opened;
}
function changeReference(file, fields) {
    const manifest = JSON.parse(fs.readFileSync(file.manifest, 'utf8'));
    Object.assign(manifest.reference, fields); fs.writeFileSync(file.manifest, JSON.stringify(manifest));
}
function assertCompleteRead(observation, size) {
    assert.equal(observation.reads.reduce((total, read) => total + read.bytesRead, 0), size);
    assert.deepEqual(observation.reads.at(-1), { position: size, bytesRead: 0 }, 'EOF must be checked after all original bytes');
    assert.equal(observation.closed, true);
}

test('inventory hashes every original through EOF without the full download buffer or concatenation', async t => {
    const originals = [Buffer.alloc(768 * 1024 + 17, 7), Buffer.alloc(512 * 1024 + 13, 9)];
    const f = await fixture(t, originals), opened = observeOriginalReads(t), download = t.mock.method(f.service, 'bytes');
    const copies = [], concat = Buffer.concat;
    t.mock.method(Buffer, 'concat', function(chunks, size) {
        const result = concat.call(this, chunks, size);
        if (originals.some(bytes => bytes.length === result.length)) copies.push(result.length);
        return result;
    });
    const inventory = await f.service.storage.inventory(f.cwd);
    assert.equal(inventory.count, 2); assert.equal(inventory.totalBytes, originals.reduce((sum, bytes) => sum + bytes.length, 0));
    assert.deepEqual(inventory.items.map(({ object }) => object.manifest.reference).sort((a, b) => a.id.localeCompare(b.id)),
        f.files.map(file => file.reference).sort((a, b) => a.id.localeCompare(b.id)));
    for (const [index, file] of f.files.entries()) assertCompleteRead(opened.get(file.original), originals[index].length);
    t.diagnostic(JSON.stringify({ downloadBufferCalls: download.mock.callCount(), originalConcatenations: copies, originalReadBytes: inventory.totalBytes }));
    assert.equal(download.mock.callCount(), 0, 'inventory must not request complete original download buffers');
    assert.deepEqual(copies, [], 'inventory must not concatenate complete originals');
});

test('inventory rejects same-size tail tampering with DOCUMENT_CHANGED after reading the complete original', async t => {
    const f = await fixture(t), file = f.files[0], fd = fs.openSync(file.original, 'r+');
    try { fs.writeSync(fd, Buffer.from([8]), 0, 1, file.reference.size - 1); } finally { fs.closeSync(fd); }
    const opened = observeOriginalReads(t);
    await assert.rejects(f.service.storage.inventory(f.cwd), { code: 'DOCUMENT_CHANGED', status: 409, message: '文档原件已变化' });
    assertCompleteRead(opened.get(file.original), file.reference.size);
});

test('inventory preserves DOCUMENT_CHANGED when the manifest size differs despite a matching content hash', async t => {
    const f = await fixture(t), file = f.files[0]; changeReference(file, { size: file.reference.size - 1 });
    const opened = observeOriginalReads(t);
    await assert.rejects(f.service.storage.inventory(f.cwd), { code: 'DOCUMENT_CHANGED', status: 409, message: '文档原件已变化' });
    assertCompleteRead(opened.get(file.original), file.reference.size);
});

test('inventory accepts the full 100 MiB original budget and rejects the next byte before reading', async t => {
    const f = await fixture(t, [Buffer.from([0])]), file = f.files[0];
    fs.truncateSync(file.original, MAX_FILE_BYTES);
    const chunk = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
    for (let offset = 0; offset < MAX_FILE_BYTES; offset += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, MAX_FILE_BYTES - offset)));
    changeReference(file, { size: MAX_FILE_BYTES, revision: hash.digest('hex') });
    const opened = observeOriginalReads(t), inventory = await f.service.storage.inventory(f.cwd);
    assert.equal(inventory.totalBytes, 100 * 1024 ** 2); assert.equal(inventory.count, 1);
    assertCompleteRead(opened.get(file.original), MAX_FILE_BYTES);
    fs.truncateSync(file.original, MAX_FILE_BYTES + 1);
    await assert.rejects(f.service.storage.inventory(f.cwd), { code: 'FILE_SIZE', status: 413 });
    assert.deepEqual(opened.get(file.original), { reads: [], closed: true });
});

test('inventory rejects growth found by the EOF probe and closes the original descriptor', async t => {
    const f = await fixture(t), file = f.files[0];
    const opened = observeOriginalReads(t, (filename, read) => {
        if (filename === file.original && read.bytesRead && read.position + read.bytesRead === file.reference.size) fs.appendFileSync(filename, Buffer.from([1]));
    });
    await assert.rejects(f.service.storage.inventory(f.cwd), { code: 'FILE_CHANGED', status: 409 });
    const observation = opened.get(file.original);
    assert.deepEqual(observation.reads.at(-1), { position: file.reference.size, bytesRead: 1 });
    assert.equal(observation.closed, true);
});

test('inventory rejects truncation during the original scan and closes the descriptor', async t => {
    const f = await fixture(t), file = f.files[0]; let truncated = false;
    const opened = observeOriginalReads(t, (filename, read) => {
        if (!truncated && filename === file.original && read.bytesRead) {
            fs.truncateSync(filename, read.bytesRead); truncated = true;
        }
    });
    await assert.rejects(f.service.storage.inventory(f.cwd), { code: 'FILE_CHANGED', status: 409 });
    const observation = opened.get(file.original);
    assert.equal(observation.reads.at(-1).bytesRead, 0); assert.equal(observation.closed, true);
});
