const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PiQueueStore } = require('../server/pi-queue-store');
const { atomicJson } = require('../server/pi-maintenance-files');
const refs = require('../public/pi-document-references');
const document = { id: 'a'.repeat(64), revision: 'b'.repeat(64), name: 'fixture.pdf', format: 'pdf', size: 12 };
const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
function fixture(t, options) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-queue-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const worker = { cwd: root, sessionPath: path.join(root, 'session.jsonl'), sessionId: 'fixture', controls: { runtimeId: randomUUID() } };
    return { root, worker, store: new PiQueueStore(path.join(root, 'queue'), options) };
}

test('full intentions persist privately, snapshots omit base64 and reconstruction never replays', t => {
    const { worker, store } = fixture(t);
    const original = { message: 'original ' + refs.marker(document), images: [image] };
    const id = store.reserve(worker, 'steering', original);
    assert.equal(store.protectedDocuments().complete, false, 'input processing is unproven until actual payload is saved');
    store.update(worker, id, 'queued', { ...original, message: 'expanded ' + refs.marker(document) });
    assert.equal(JSON.stringify(store.summaries(worker)).includes(image.data), false);
    assert.throws(() => store.payload(worker, id), /原生队列/);
    const reconstructed = new PiQueueStore(store.root);
    const next = { ...worker, controls: { runtimeId: randomUUID() } };
    assert.equal(reconstructed.summaries(next)[0].state, 'unknown');
    assert.deepEqual(reconstructed.payload(next, id).payload.images, [image]);
    assert.equal(reconstructed.payload(next, id).original.message, original.message);
    assert.deepEqual(reconstructed.protectedDocuments().ids, [document.id]);
    assert.equal(reconstructed.protectedDocuments().complete, true);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
        assert.equal(fs.statSync(store.root).mode & 0o777, 0o700);
    }
});

test('duplicate text retains independent images; clear evidence uses IDs, ack failure preserves record and revision', t => {
    let fail = false;
    const { worker, store } = fixture(t, { save: (file, value) => { if (fail) throw new Error('controlled fsync failure'); atomicJson(file, value); } });
    const a = store.reserve(worker, 'steering', { message: 'same', images: [image] });
    const b = store.reserve(worker, 'followUp', { message: 'same', images: [{ ...image, data: 'd29ybGQ=' }] });
    for (const id of [a, b]) store.update(worker, id, 'queued', { message: 'same', images: id === a ? [image] : [{ ...image, data: 'd29ybGQ=' }] });
    store.reconcileClear(worker, [], [b], { steering: [], followUp: [] });
    store.update(worker, a, 'started');
    const before = store.protectedDocuments().revision;
    fail = true;
    assert.throws(() => store.acknowledge(worker, b), /fsync failure/);
    assert.equal(store.protectedDocuments().revision, before);
    assert.equal(store.summaries(worker).length, 2);
    fail = false;
    store.acknowledge(worker, b);
    assert.equal(store.summaries(worker)[0].id, a);
    assert.equal(store.summaries(worker)[0].state, 'started');
});

test('quota failure happens before publication, leases exclude mutations and incomplete scans reject corruption or symlinks', t => {
    const { worker, store, root } = fixture(t, { limits: { sessionBytes: 1000, bytes: 5000 } });
    assert.throws(() => store.reserve(worker, 'steering', { message: 'x'.repeat(2000), images: [] }), /额度/);
    assert.equal(fs.existsSync(store.file), false);
    const done = store.beginOperation();
    assert.throws(() => store.acquireReferenceLease(), /正在进行/); done();
    const release = store.acquireReferenceLease();
    assert.throws(() => store.reserve(worker, 'steering', { message: 'small', images: [] }), /正在核验/);
    assert.equal(store.protectedDocuments().complete, true);
    release();
    store.reserve(worker, 'steering', { message: 'small', images: [] });
    fs.writeFileSync(store.file, '{}');
    assert.throws(() => store.protectedDocuments(), /无效/);
    fs.unlinkSync(store.file);
    fs.writeFileSync(path.join(root, 'other'), '{}'); fs.symlinkSync(path.join(root, 'other'), store.file);
    assert.throws(() => store.protectedDocuments());
});

test('runtime attribution, fork isolation, move refusal, deletion hook and legacy text recovery stay explicit', t => {
    const { worker, store } = fixture(t);
    const id = store.reserve(worker, 'steering', { message: 'full', images: [image] });
    const next = { ...worker, controls: { runtimeId: randomUUID() } };
    assert.equal(store.update(next, id, 'queued', { message: 'wrong', images: [] }), false);
    assert.equal(store.retire(next, id), false);
    assert.deepEqual(store.summaries({ ...next, sessionPath: worker.sessionPath + '-fork', sessionId: 'fork' }), []);
    assert.throws(() => store.assertMovable(worker.sessionPath), /先处理/);
    store.acknowledge(next, id);
    store.assertMovable(worker.sessionPath);
    store.saveLegacy(worker, { steering: ['legacy text'], followUp: [] }, 'recovered');
    assert.equal(store.summaries(next)[0].hasPayload, false);
    assert.equal(store.summaries(next)[0].imageCount, 0);
    store.forgetDeletedSession(worker.sessionPath);
    assert.deepEqual(store.summaries(next), []);
});

test('post-publication fsync failure and missing manifests fail closed for reference cleanup', t => {
    let failAfterPublish = false;
    const { worker, store } = fixture(t, { save: (file, value) => {
        atomicJson(file, value);
        if (failAfterPublish) throw new Error('controlled directory fsync failure');
    } });
    const id = store.reserve(worker, 'steering', { message: 'must keep draft on failed acknowledgement', images: [image] });
    store.update(worker, id, 'started', { message: 'must keep draft on failed acknowledgement', images: [image] });
    failAfterPublish = true;
    assert.throws(() => store.acknowledge(worker, id), /directory fsync failure/);
    assert.equal(store.fault, true, 'an ambiguous disk outcome cannot masquerade as durable acknowledgement');
    assert.throws(() => store.protectedDocuments(), /不完整/);
    assert.throws(() => store.acquireReferenceLease(), /持久化失败/);
    fs.unlinkSync(store.file);
    assert.throws(() => new PiQueueStore(store.root).protectedDocuments(), /清单缺失/);
});

test('concurrent saved originals survive evidence capacity refusal and validation limits without faulting acknowledgement', t => {
    const { worker, store } = fixture(t, { limits: { sessionBytes: 2500, bytes: 6000 } });
    const original = { message: 'bounded original ' + refs.marker(document), images: [image] };
    const ids = [store.reserve(worker, 'steering', original), store.reserve(worker, 'followUp', original)];
    const saved = store.read();
    assert.equal(saved.entries.length, 2);
    for (const id of ids) store.update(worker, id, 'queued', { message: 'expanded ' + 'E'.repeat(2400), images: [image, image] });
    assert.equal(store.fault, null);
    assert.equal(store.protectedDocuments().complete, false);
    assert.deepEqual(store.protectedDocuments().ids, [document.id]);
    for (const id of ids) {
        const recovered = store.payload(worker, id);
        assert.deepEqual(recovered.payload, original); assert.deepEqual(recovered.original, original);
        assert.equal(recovered.originalOnly, true); assert.equal(recovered.effectiveComplete, false);
        assert.equal(recovered.imageCount, 1); assert.equal(recovered.transformed, false);
        store.acknowledge(worker, id);
    }
    assert.deepEqual(store.read().entries, []);
    assert.equal(store.protectedDocuments().complete, true);
    for (const effective of [{ message: 'E'.repeat(400001), images: [] }, { message: 'seven transformed images', images: Array(7).fill(image) },
        { message: 'native extension image', images: [{ ...image, mimeType: 'image/bmp' }] },
        { message: 'native extension encoding', images: [{ ...image, data: image.data + '\n' }] }]) {
        const id = store.reserve(worker, 'steering', original);
        store.update(worker, id, 'queued', effective);
        assert.equal(store.fault, null);
        assert.equal(store.summaries(worker)[0].originalOnly, true);
        store.acknowledge(worker, id);
    }
});

test('operation admission candidates constrain old clear proof even if it mentions a newer identity', t => {
    const { worker, store } = fixture(t);
    const first = store.reserve(worker, 'steering', { message: 'same operation text', images: [image] });
    store.update(worker, first, 'queued', { message: 'same operation text', images: [image] });
    const fallbackIds = store.saveLegacy(worker, { steering: ['same operation text'], followUp: [] });
    const newer = store.reserve(worker, 'steering', { message: 'same operation text', images: [{ ...image, data: 'd29ybGQ=' }] });
    store.update(worker, newer, 'queued', { message: 'same operation text', images: [{ ...image, data: 'd29ybGQ=' }] });
    store.reconcileClear(worker, fallbackIds, [first, newer], { steering: [], followUp: [] }, [first]);
    assert.equal(store.summaries(worker).find(entry => entry.id === first).state, 'recovered');
    assert.equal(store.summaries(worker).find(entry => entry.id === newer).state, 'queued');
    assert.equal(store.read().entries.some(entry => fallbackIds.includes(entry.id)), false);
});
