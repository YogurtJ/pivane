const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { privateDir, copySafe, hashFileSafe } = require('./pi-maintenance-files');
const { prove, verifyAll, changed, incomplete } = require('./pi-document-storage-references');

// Include disabled/deleted job records and the immutable job snapshots retained
// by waiting/uncertain runs. Stream rows; never materialize the scheduler history.
function collect(db) {
    const ids = new Set(), digest = createHash('sha256');
    let bytes = 0, rows = 0;
    if (JSON.parse(db.prepare("SELECT data FROM meta WHERE key='version'").get()?.data) !== 1) throw incomplete();
    for (const [kind, sql, limit] of [
        ['jobs', 'SELECT id,data FROM jobs ORDER BY id', 100],
        ['runs', "SELECT id,data FROM runs WHERE json_extract(data,'$.status') IN ('waiting','dispatching','running','uncertain') ORDER BY id", 10000]
    ]) {
        let count = 0;
        for (const row of db.prepare(sql).iterate()) {
            bytes += Buffer.byteLength(row.data);
            if (++count > limit || ++rows > 10100 || bytes > 64 * 1024 ** 2) throw incomplete();
            const value = JSON.parse(row.data), job = kind === 'jobs' ? value : value.job;
            if (!job || typeof job.prompt !== 'string' || job.prompt.length > 40000) throw incomplete();
            digest.update(JSON.stringify([kind, row.id, row.data]));
            const stack = [value]; let nodes = 0;
            while (stack.length) {
                const item = stack.pop();
                if (++nodes > 100000) throw incomplete();
                if (typeof item === 'string') {
                    for (const match of item.matchAll(/[a-f0-9]{64}/g)) ids.add(match[0]);
                } else if (item && typeof item === 'object') stack.push(...Object.values(item));
                if (ids.size > 10000 || stack.length > 100000) throw incomplete();
            }
        }
    }
    return { ids: [...ids], revision: digest.digest('hex') };
}
function clock(db) {
    return JSON.stringify([db.prepare('SELECT total_changes() AS n').get().n, db.prepare('PRAGMA data_version').get().data_version]);
}
function cronDocumentReferences(cron) {
    if (!cron?.db?.db || cron.error || cron.stopping || cron.busy) throw incomplete();
    const store = cron.db, live = store.db, filename = store.filename;
    const proofs = [prove(path.dirname(filename), true), prove(filename)];
    // CronStore uses DELETE journals. A journal/WAL or an inconsistent image
    // cannot be interpreted as an idle committed snapshot.
    for (const suffix of ['-journal', '-wal', '-shm']) {
        try { fs.lstatSync(filename + suffix); throw incomplete(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        proofs.push({ missing: filename + suffix });
    }
    const revision = clock(live);
    let directory, snapshot;
    try {
        directory = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-document-cron-')));
        const file = path.join(directory, 'snapshot.sqlite');
        const copied = copySafe(filename, file, { bytes: 0, files: 0, maxBytes: 512 * 1024 ** 2, maxFiles: 1 });
        snapshot = new DatabaseSync(file, { readOnly: true, allowExtension: false });
        const integrity = snapshot.prepare('PRAGMA quick_check(1)').get();
        if (integrity?.quick_check !== 'ok') throw incomplete();
        const saved = collect(snapshot), current = collect(live);
        if (hashFileSafe(file, 512 * 1024 ** 2).sha256 !== copied.sha256) throw changed();
        const check = () => {
            verifyAll(proofs);
            if (cron.db !== store || store.db !== live || cron.error || cron.stopping || cron.busy || clock(live) !== revision) throw changed();
        };
        check();
        return { complete: true, ids: [...new Set([...saved.ids, ...current.ids])], proofs, check,
            revision: createHash('sha256').update(JSON.stringify([copied.sha256, current.revision, revision])).digest('hex') };
    } finally {
        try { snapshot?.close(); }
        finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
    }
}
module.exports = { cronDocumentReferences };
