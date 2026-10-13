const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PiDeferredMessages } = require('../server/pi-deferred-messages');
const refs = require('../public/pi-document-references');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-deferred-protection-')));
    const service = new PiDeferredMessages({ store: {}, supervisor: {}, filePath: path.join(root, 'deferred.json'), intervalMs: 1000000 });
    t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const document = digit => ({ id: digit.repeat(64), revision: 'f'.repeat(64), name: 'fixture.pdf', format: 'pdf', size: 16 });
    const add = digit => service.create({ cwd: root, id: 'fixture-session' }, { id: randomUUID(), dueAt: Date.now() + 3600000, message: refs.marker(document(digit)) });
    return { root, service, document, add };
}

test('document protection includes paused and uncertain deferred payloads without changing them', t => {
    const { service, add } = fixture(t);
    assert.deepEqual(service.protectedDocuments().ids, []);
    const a = add('a'), b = add('b');
    service.change(() => { service.jobs.find(j => j.id === a.id).status = 'paused'; service.jobs.find(j => j.id === b.id).status = 'uncertain'; });
    const before = fs.readFileSync(service.filePath);
    const snapshot = service.protectedDocuments();
    assert.equal(snapshot.complete, true); assert.deepEqual(snapshot.ids, ['a'.repeat(64), 'b'.repeat(64)]);
    assert.deepEqual(fs.readFileSync(service.filePath), before);
    assert.equal(service.protectedDocuments().revision, snapshot.revision);
});

test('protection covers both saved external changes and the still-live schedule', t => {
    const { service, add, document } = fixture(t); add('a');
    const old = service.protectedDocuments();
    const disk = JSON.parse(fs.readFileSync(service.filePath, 'utf8'));
    disk.jobs[0].payload.message = refs.marker(document('b'));
    fs.writeFileSync(service.filePath, JSON.stringify(disk));
    const next = service.protectedDocuments();
    assert.deepEqual(next.ids, ['a'.repeat(64), 'b'.repeat(64)]); assert.notEqual(next.revision, old.revision);
    assert.equal(service.jobs[0].payload.message, refs.marker(document('a')));
});

test('missing, malformed or unreadable saved intentions never appear complete', t => {
    const { service, add } = fixture(t); add('a');
    fs.unlinkSync(service.filePath); assert.throws(() => service.protectedDocuments());
    fs.writeFileSync(service.filePath, JSON.stringify({ version: 1, jobs: [{ status: 'paused' }] }));
    assert.throws(() => service.protectedDocuments(), /无法完整核对/);
    fs.writeFileSync(service.filePath, '{"version":1,"jobs":[');
    assert.throws(() => service.protectedDocuments());
    service.error = 'synthetic unavailable store'; assert.throws(() => service.protectedDocuments(), /synthetic/);
});
