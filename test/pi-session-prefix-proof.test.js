const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createPrefixProofSync, verifySessionPrefixes, MAX_PREFIX } = require('../server/pi-session-prefix-proof');
const { hash } = require('../server/pi-maintenance-files');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-prefix-proof-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const record = (id, parentId, data = {}) => ({ type: 'custom', id, parentId, customType: 'fixture', data });
function native(entries = []) {
    const session = { id: randomUUID(), cwd: root, path: path.join(root, randomUUID() + '.jsonl') };
    const header = { type: 'session', version: 3, id: session.id, cwd: root, timestamp: '2026-10-13T00:00:00.000Z' };
    fs.writeFileSync(session.path, [header, ...entries].map(entry => JSON.stringify(entry) + '\n').join(''));
    return session;
}
function appendBody(session, megabytes, id, parentId) {
    const fd = fs.openSync(session.path, 'a'), chunk = Buffer.alloc(1024 * 1024, 65);
    try {
        fs.writeSync(fd, JSON.stringify({ type: 'message', id, parentId }).slice(0, -1) + ',"message":{"role":"user","content":[{"type":"image","mimeType":"image/png","data":"');
        for (let i = 0; i < megabytes; i++) fs.writeSync(fd, chunk);
        fs.writeSync(fd, '"}],"timestamp":1}}\n');
    } finally { fs.closeSync(fd); }
}
function appendMarker(session, parentId) {
    const marker = record('marker', parentId, { revision: 'fixture' });
    fs.appendFileSync(session.path, JSON.stringify(marker) + '\n');
    return marker;
}
function meter(t, session) {
    let bytes = 0, largestBuffer = 0, calls = 0;
    const expected = fs.statSync(session.path, { bigint: true }), read = fs.readSync;
    const mock = t.mock.method(fs, 'readSync', function (fd, buffer, offset, length, position) {
        const count = read.call(fs, fd, buffer, offset, length, position);
        const actual = fs.fstatSync(fd, { bigint: true });
        // Native descriptor backends may load their own manifest/binary on the
        // first call. Meter only the fixture's descriptor, on every platform.
        if (actual.dev === expected.dev && actual.ino === expected.ino) {
            bytes += count; calls++; largestBuffer = Math.max(largestBuffer, buffer.length);
        }
        return count;
    });
    return { reset() { bytes = 0; calls = 0; largestBuffer = 0; }, result() { return { bytes, calls, largestBuffer }; }, restore() { mock.mock.restore(); } };
}

test('96MiB native prefix creation and 352MiB grown JSONL verification use bounded reads and memory, and yield to concurrent work', async t => {
    const session = native([record('first', null)]);
    appendBody(session, 96, 'image', 'first');
    const reads = meter(t, session), before = process.memoryUsage(), start = performance.now();
    const proof = createPrefixProofSync(session), creationMs = performance.now() - start;
    const creation = reads.result(), createdMemory = process.memoryUsage();
    assert.ok(proof.tailLength > 96 * 1024 ** 2);
    assert.equal(creation.largestBuffer, 256 * 1024);
    assert.ok(creation.bytes <= proof.tailLength + 8192);
    assert.ok(createdMemory.arrayBuffers - before.arrayBuffers < 16 * 1024 ** 2, 'does not retain a body-sized buffer');
    assert.ok(createdMemory.heapUsed - before.heapUsed < 48 * 1024 ** 2, 'does not retain a body-sized string');
    appendMarker(session, 'image');
    appendBody(session, 256, 'later', 'marker');
    reads.reset(); let turns = 0;
    const pulse = setInterval(() => { turns++; }, 1);
    const verificationStart = performance.now();
    await verifySessionPrefixes(session, [proof], { marker: true });
    clearInterval(pulse);
    const verification = reads.result(); reads.restore();
    assert.ok(turns > 1, 'async hashing and projection let the event loop run');
    assert.ok(verification.bytes <= proof.tailLength + 8192, 'growing suffix is never scanned');
    assert.equal(verification.largestBuffer, 256 * 1024);
    t.diagnostic(JSON.stringify({ size: fs.statSync(session.path).size, prefix: proof.tailLength, creationMs,
        verificationMs: performance.now() - verificationStart, creation, verification,
        heapDelta: createdMemory.heapUsed - before.heapUsed, bufferDelta: createdMemory.arrayBuffers - before.arrayBuffers, turns }));
});

test('hash boundaries and projected delivery byte offsets preserve UTF-8, duplicate-key semantics and skipped JSON bodies', async () => {
    const session = native();
    const first = '{"id":"discarded","type":"custom","parentId":null,"id":"one","customType":"pivane-deliverable","data":{"id":"old","id":"a","manifestRevision":"b"},"ignored":{"nested":[false,null,1.25e-2,"中文\\n\\u4e2d"]}}\n';
    const second = JSON.stringify(record('two', 'one', { ignored: '🧪'.repeat(140000) })) + '\n';
    fs.appendFileSync(session.path, first + second);
    const prefix = createPrefixProofSync(session), records = [];
    await verifySessionPrefixes(session, [{ tailLength: Buffer.byteLength(first), tailSha256: hash(Buffer.from(first)) }, prefix], {
        onRecord: (entry, offset) => records.push({ entry, offset })
    });
    assert.equal(records[0].entry.id, 'one'); assert.equal(records[0].entry.data.id, 'a');
    assert.equal(records[0].offset, Buffer.byteLength(first));
    assert.equal(records[1].offset, prefix.tailLength);
    assert.equal(records[1].entry.data.ignored, undefined);
});

test('bad prefix, incomplete marker, native tree changes and invalid UTF-8 fail closed', async () => {
    const session = native([record('one', null)]), proof = createPrefixProofSync(session);
    appendMarker(session, 'one');
    const original = fs.readFileSync(session.path), tailStart = original.indexOf(10) + 1;
    fs.writeFileSync(session.path, original.toString().replace('fixture', 'altered'));
    await assert.rejects(verifySessionPrefixes(session, [proof], { marker: true }), { code: 'SESSION_PREFIX_CHANGED' });
    fs.writeFileSync(session.path, original.subarray(0, tailStart + proof.tailLength + 3));
    await assert.rejects(verifySessionPrefixes(session, [proof], { marker: true }));
    fs.writeFileSync(session.path, original.subarray(0, tailStart + proof.tailLength - 1));
    await assert.rejects(verifySessionPrefixes(session, [proof]));
    for (const entries of [[record('one', 'missing')], [record('one', null), record('one', 'one')]]) {
        assert.throws(() => createPrefixProofSync(native(entries)), { code: 'SESSION_PREFIX_CHANGED' });
    }
    const utf8 = native(); fs.appendFileSync(utf8.path, Buffer.from([0xff, 10]));
    assert.throws(() => createPrefixProofSync(utf8));
    fs.writeFileSync(session.path, original.toString().replace('"parentId":"one"', '"parentId":"missing"'));
    await assert.rejects(verifySessionPrefixes(session, [proof], { marker: true }));
});

test('concurrent append, rewrite and same-path replacement are rejected; stable retry and exact restoration remain valid', async t => {
    const session = native([record('one', null)]);
    appendBody(session, 2, 'body', 'one');
    const proof = createPrefixProofSync(session); appendMarker(session, 'body');
    const size = fs.statSync(session.path).size;
    const pending = verifySessionPrefixes(session, [proof], { marker: true });
    fs.appendFileSync(session.path, JSON.stringify(record('later', 'marker')) + '\n');
    await assert.rejects(pending, { code: 'SESSION_PREFIX_CHANGED' });
    await verifySessionPrefixes(session, [proof], { marker: true });
    fs.truncateSync(session.path, size);
    const copied = session.path + '.copy'; fs.copyFileSync(session.path, copied);
    const replacing = verifySessionPrefixes(session, [proof], { marker: true });
    fs.renameSync(session.path, session.path + '.original'); fs.renameSync(copied, session.path);
    await assert.rejects(replacing);
    await verifySessionPrefixes(session, [proof], { marker: true });
    const rewriting = verifySessionPrefixes(session, [proof], { marker: true });
    const fd = fs.openSync(session.path, 'r+');
    try {
        const offset = fs.readFileSync(session.path).indexOf(Buffer.from('AAAA'));
        fs.writeSync(fd, Buffer.from('B'), 0, 1, offset);
    } finally { fs.closeSync(fd); }
    await assert.rejects(rewriting, { code: 'SESSION_PREFIX_CHANGED' });
    await assert.rejects(verifySessionPrefixes(session, [proof], { marker: true }), { code: 'SESSION_PREFIX_CHANGED' });
    fs.copyFileSync(session.path + '.original', session.path);
    await verifySessionPrefixes(session, [proof], { marker: true });
    if (process.platform !== 'win32') {
        const symlink = session.path + '.link'; fs.symlinkSync(session.path, symlink);
        await assert.rejects(verifySessionPrefixes({ ...session, path: symlink }, [proof]));
        const directoryLink = path.join(root, randomUUID()); fs.symlinkSync(root, directoryLink, 'dir');
        await assert.rejects(verifySessionPrefixes({ ...session, path: path.join(directoryLink, path.basename(session.path)) }, [proof]));
    } else t.diagnostic('Symlink-specific checks require platform symlink privileges; identity replacement checks ran.');
});

test('prefix, header, marker and projected metadata budgets reject unsupported files without scanning a growing suffix', async () => {
    const session = native([record('one', null)]), proof = createPrefixProofSync(session);
    await assert.rejects(verifySessionPrefixes(session, [{ ...proof, tailLength: MAX_PREFIX + 1 }]), { code: 'SESSION_PREFIX_CHANGED' });
    await assert.rejects(verifySessionPrefixes(session, [{ ...proof, tailLength: -1 }]), { code: 'SESSION_PREFIX_CHANGED' });
    fs.truncateSync(session.path, MAX_PREFIX + 2 * 1024 ** 2);
    assert.throws(() => createPrefixProofSync(session), { code: 'SESSION_PREFIX_CHANGED' });
    const hugeHeader = native(); fs.writeFileSync(hugeHeader.path, Buffer.alloc(1024 ** 2 + 1, 32));
    assert.throws(() => createPrefixProofSync(hugeHeader), { code: 'SESSION_PREFIX_CHANGED' });
    const metadata = native([record('x'.repeat(1024 ** 2 + 1), null)]);
    assert.throws(() => createPrefixProofSync(metadata), { code: 'SESSION_PREFIX_CHANGED' });
    const nested = native(); fs.appendFileSync(nested.path, '{"id":"one","parentId":null,"ignored":' + '['.repeat(257) + '0' + ']'.repeat(257) + '}\n');
    assert.throws(() => createPrefixProofSync(nested), { code: 'SESSION_PREFIX_CHANGED' });
    const marker = native([record('one', null)]), markerProof = createPrefixProofSync(marker);
    fs.appendFileSync(marker.path, Buffer.alloc(1024 ** 2, 32));
    await assert.rejects(verifySessionPrefixes(marker, [markerProof], { marker: true }), { code: 'SESSION_PREFIX_CHANGED' });
});

test('short regular-file reads are completed through the same descriptor', async t => {
    const session = native([record('one', null)]), read = fs.readSync;
    t.mock.method(fs, 'readSync', function (fd, buffer, offset, length, position) {
        return read.call(fs, fd, buffer, offset, Math.min(length, 37), position);
    });
    const proof = createPrefixProofSync(session); appendMarker(session, 'one');
    await verifySessionPrefixes(session, [proof], { marker: true });
});
