'use strict';

const scope = require('./scope');
const fs = require('node:fs');
const MAX_RECHECK_BYTES = 64 * 1024 * 1024;
const MAX_RECHECK_ROWS = 5000;
const BATCH = 20;

function createIndex(dbManager, upstream, context) {
    const db = dbManager.getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS pivane_sources (
        session_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, stamp TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS pivane_progress (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pivane_cursor (key TEXT PRIMARY KEY, path TEXT NOT NULL)`);
    const erase = db.transaction(id => {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM session_files WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        db.prepare('DELETE FROM pivane_sources WHERE session_id = ?').run(id);
    });
    const markIncomplete = () => {
        db.prepare("INSERT INTO pivane_progress (key, value) VALUES ('currentIncomplete', 1) ON CONFLICT(key) DO UPDATE SET value = 1").run();
        db.prepare("INSERT INTO pivane_progress (key, value) VALUES ('incomplete', 1) ON CONFLICT(key) DO UPDATE SET value = 1").run();
    };
    const overBudget = file => {
        try { return fs.statSync(file, { bigint: true }).size > BigInt(scope.MAX_SESSION_BYTES); }
        catch { return false; }
    };
    const coverage = () => ({
        limited: Boolean(db.prepare("SELECT value FROM pivane_progress WHERE key = 'incomplete'").get()?.value),
        initialSweepComplete: Boolean(db.prepare("SELECT value FROM pivane_progress WHERE key = 'sweep'").get()?.value),
    });
    // Older derived rows have no verified source mapping; never expose them.
    for (const row of db.prepare('SELECT id FROM sessions WHERE id NOT IN (SELECT session_id FROM pivane_sources)').all()) erase(row.id);
    // Replace rows and their verified source in a single SQLite transaction across connections.
    const replace = db.transaction((file, candidate, parsed) => {
        const current = scope.snapshot(file, context);
        if (!current || current.fingerprint !== candidate.fingerprint || current.stamp !== candidate.stamp) return false;
        const previous = db.prepare('SELECT session_id, fingerprint FROM pivane_sources WHERE path = ?').get(file);
        if (previous?.session_id === parsed.id && previous.fingerprint === candidate.fingerprint) return true;
        const conflicting = db.prepare('SELECT path FROM pivane_sources WHERE session_id = ?').get(parsed.id);
        if (conflicting && conflicting.path !== file) return false;
        if (previous) erase(previous.session_id);
        if (conflicting && parsed.id !== previous?.session_id) erase(parsed.id);
        upstream.indexSession(dbManager, parsed);
        upstream.upsertSessionFileMetadata(dbManager, file, parsed.id);
        db.prepare('INSERT INTO pivane_sources (session_id, path, fingerprint, stamp) VALUES (?, ?, ?, ?)')
            .run(parsed.id, file, candidate.fingerprint, candidate.stamp);
        return true;
    });
    function index(file, candidate = scope.snapshot(file, context)) {
        if (!candidate) return false;
        const parsed = upstream.parseSessionManagerSnapshot({ getHeader: () => candidate.header, getEntries: () => candidate.entries });
        if (!parsed || parsed.id !== candidate.header.id || parsed.cwd !== candidate.header.cwd) return false;
        parsed.project = parsed.cwd;
        return replace(file, candidate, parsed);
    }
    function reconcile() {
        let changed = false;
        const rows = db.prepare('SELECT session_id, path, fingerprint FROM pivane_sources ORDER BY session_id LIMIT ?').all(MAX_RECHECK_ROWS + 1);
        if (rows.length > MAX_RECHECK_ROWS) throw new Error('Profile session index coverage exceeds verification budget');
        let bytes = 0;
        for (const row of rows) {
            const candidate = scope.snapshot(row.path, context);
            bytes += candidate?.bytes || 0;
            if (bytes > MAX_RECHECK_BYTES) throw new Error('Profile session source verification budget exceeded');
            if (!candidate || candidate.header.id !== row.session_id) {
                if (!candidate && overBudget(row.path)) markIncomplete();
                erase(row.session_id); changed = true;
            }
            else if (candidate.fingerprint !== row.fingerprint) {
                changed = true;
                if (!index(row.path, candidate)) { erase(row.session_id); throw new Error('Profile session source changed during indexing'); }
            }
        }
        if (db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE id NOT IN (SELECT session_id FROM pivane_sources)').get().total)
            throw new Error('Unverified profile session rows');
        return changed;
    }
    function advance() {
        const after = db.prepare("SELECT path FROM pivane_cursor WHERE key = 'scan'").get()?.path || '';
        const { files, limited } = scope.listSessionFiles(context, after, BATCH * 10);
        let visited = 0, indexed = 0;
        if (!after) db.prepare("INSERT INTO pivane_progress (key, value) VALUES ('currentIncomplete', 0) ON CONFLICT(key) DO UPDATE SET value = 0").run();
        for (const file of files) {
            visited++;
            const row = db.prepare('SELECT fingerprint FROM pivane_sources WHERE path = ?').get(file);
            if (row) continue;
            const candidate = scope.snapshot(file, context);
            if (!candidate) {
                // A source over the historical byte cap may be bound; other invalid files are ineligible.
                let skippedUnknown = false;
                try { skippedUnknown = fs.statSync(file, { bigint: true }).size > BigInt(scope.MAX_SESSION_BYTES); }
                catch { skippedUnknown = true; }
                if (skippedUnknown) markIncomplete();
                continue;
            }
            if (!index(file, candidate)) { markIncomplete(); continue; }
            if (++indexed >= BATCH) break;
        }
        const exhausted = !limited && visited === files.length;
        db.prepare("INSERT INTO pivane_cursor (key, path) VALUES ('scan', ?) ON CONFLICT(key) DO UPDATE SET path = excluded.path")
            .run(exhausted ? '' : files[visited - 1]);
        if (exhausted) {
            db.prepare("INSERT INTO pivane_progress (key, value) VALUES ('sweep', 1) ON CONFLICT(key) DO UPDATE SET value = 1").run();
            db.prepare("INSERT INTO pivane_progress (key, value) VALUES ('incomplete', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .run(db.prepare("SELECT value FROM pivane_progress WHERE key = 'currentIncomplete'").get()?.value || 0);
        }
        return { visited, indexed, ...coverage() };
    }
    return { index, reconcile, advance, coverage, close: () => dbManager.close() };
}
module.exports = { createIndex };
