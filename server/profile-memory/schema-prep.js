'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// pi-hermes-memory 0.9.10 adds these columns in DatabaseManager's open path from
// a column snapshot taken outside any transaction. Two first opens of one profile
// database (RPC worker, index worker thread, server document index) can then both
// ALTER and one fails with "duplicate column name"; the index worker would stay
// failed for its session. Apply the same additive columns once under BEGIN
// IMMEDIATE before a Pivane-owned DatabaseManager opens the file, so upstream finds
// them present. Keep this list equal to upstream's memories schema on upgrades.
const MEMORY_COLUMNS = Object.freeze([
    ['hit_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_hit_at', 'DATE'],
]);
const BUSY_TIMEOUT_MS = 5000;

function missingColumns(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get()) return [];
    const names = new Set(db.prepare('PRAGMA table_info(memories)').all().map(column => column.name));
    return MEMORY_COLUMNS.filter(([name]) => !names.has(name));
}

// Same classification as upstream DatabaseManager.isCorruptionError.
function corrupt(error) {
    if (['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(error?.code)) return true;
    const message = String(error?.message || '').toLowerCase();
    return ['database disk image is malformed', 'file is not a database', 'database schema is corrupt',
        'malformed database schema'].some(text => message.includes(text));
}

// Returns the added column names. A missing, empty or non-regular (including
// symlinked) database is left to the existing open paths, which create it or
// reject it; a corrupt one is left to upstream recovery. Every other failure,
// notably a writer holding the lock past the busy timeout, is thrown: falling
// through would let concurrent upstream opens race on the same ALTER.
function prepareProfileDatabase(root, bundlePath, { busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
    const file = path.join(root, 'sessions.db');
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isFile() || stat.size === 0 || fs.realpathSync.native(file) !== file) return [];
    let db;
    try {
        db = new (createRequire(bundlePath)('better-sqlite3'))(file, { fileMustExist: true });
        db.pragma(`busy_timeout = ${busyTimeoutMs}`);
        // Already migrated databases only take a WAL read snapshot, never a write lock.
        if (!missingColumns(db).length) return [];
        db.exec('BEGIN IMMEDIATE');
        try {
            const added = [];
            for (const [name, type] of missingColumns(db)) {
                db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
                added.push(name);
            }
            db.exec('COMMIT');
            return added;
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* the failed statement may have ended the transaction */ }
            throw error;
        }
    } catch (error) {
        if (corrupt(error)) return [];
        throw error;
    } finally {
        try { db?.close(); } catch { /* a close failure does not change the committed schema */ }
    }
}

module.exports = { prepareProfileDatabase, MEMORY_COLUMNS };
