const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CronStore } = require('../server/pi-cron-store');
const { cronDocumentReferences } = require('../server/pi-document-cron-references');
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-cron-references-'));
    const db = new CronStore(path.join(root, 'cron.sqlite'));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, db, cron: { db, busy: false, stopping: false, error: null } };
}
test('scheduler protection includes disabled/deleted jobs and uncertain immutable run prompts, with mutation checks', t => {
    const f = fixture(t);
    f.db.saveJob({ id: 'job', prompt: a, enabled: false, deleted: true });
    f.db.saveRun({ id: 'run', jobId: 'job', scheduledAt: 1, status: 'uncertain', job: { prompt: b } });
    f.db.saveRun({ id: 'finished', jobId: 'job', scheduledAt: 2, status: 'completed', job: { prompt: c } });
    const result = cronDocumentReferences(f.cron);
    assert.deepEqual(result.ids.sort(), [a, b]); assert.equal(result.complete, true); result.check();
    f.db.saveJob({ id: 'job', prompt: c });
    assert.throws(result.check, { code: 'DOCUMENT_STORAGE_CHANGED' });
});
test('physical scheduler replacement cannot hide references behind the existing SQLite connection', t => {
    const f = fixture(t), other = fixture(t);
    f.db.saveJob({ id: 'old', prompt: a }); other.db.saveJob({ id: 'new', prompt: b }); other.db.close();
    const previous = f.db.filename + '.before';
    try { fs.renameSync(f.db.filename, previous); }
    catch (error) {
        // SQLite's Windows VFS may deny deleting/renaming an open database.
        // That kernel refusal already prevents the stale-handle replacement.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        assert.deepEqual(cronDocumentReferences(f.cron).ids, [a]); return;
    }
    fs.copyFileSync(other.db.filename, f.db.filename);
    try { assert.deepEqual(cronDocumentReferences(f.cron).ids.sort(), [a, b]); }
    finally { fs.unlinkSync(f.db.filename); fs.renameSync(previous, f.db.filename); }
});
test('scheduler journal, invalid retained records and unknown active snapshots fail closed', t => {
    const f = fixture(t), journal = f.db.filename + '-journal';
    fs.writeFileSync(journal, 'unconfirmed');
    assert.throws(() => cronDocumentReferences(f.cron), { code: 'DOCUMENT_SCAN_INCOMPLETE' }); fs.unlinkSync(journal);
    f.db.saveJob({ id: 'invalid', prompt: 'x'.repeat(40001) });
    assert.throws(() => cronDocumentReferences(f.cron), { code: 'DOCUMENT_SCAN_INCOMPLETE' });
    f.db.saveJob({ id: 'invalid', prompt: 'valid' });
    f.db.saveRun({ id: 'unknown', jobId: 'invalid', scheduledAt: 1, status: 'uncertain' });
    assert.throws(() => cronDocumentReferences(f.cron), { code: 'DOCUMENT_SCAN_INCOMPLETE' });
});
