'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { safeFile } = require('./management');
const privateFiles = require('../pi-private-files');

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const hash = text => createHash('sha256').update(text).digest('hex');
const MAX_ENTRIES = 2048;
const filename = (root, target) => path.join(root, `.pivane-memory-index-${target}.pending`);

function pendingDocumentIndex(root, target) {
    const data = safeFile(filename(root, target));
    if (!data) return null;
    let plan;
    try { plan = JSON.parse(data.text); } catch { throw fail('Invalid pending memory index state'); }
    if (plan?.version !== 1 || plan.target !== target || !/^[a-f0-9]{64}$/.test(plan.after)
        || plan.before !== null && !/^[a-f0-9]{64}$/.test(plan.before)
        || !Array.isArray(plan.old) || !Array.isArray(plan.next)
        || [plan.old, plan.next].some(items => items.length > MAX_ENTRIES || items.some(item =>
            !item || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 65536
            || typeof item.created !== 'string' || typeof item.lastReferenced !== 'string'))) throw fail('Invalid pending memory index state');
    return plan;
}

function documentEntries(store, content) {
    const parts = content ? content.split('\n§\n') : [];
    if (parts.length > MAX_ENTRIES) throw fail('Document has too many memory entries', 400);
    const items = parts.map(raw => {
        const parsed = store.decodeEntry(raw);
        if (!parsed.text || !parsed.text.trim()) throw fail('Invalid memory entry', 400);
        return { content: parsed.text, created: parsed.created, lastReferenced: parsed.lastReferenced };
    });
    if (new Set(items.map(item => item.content)).size !== items.length) throw fail('Duplicate memory entries are ambiguous', 409);
    return items;
}

function checkRows(db, plan) {
    const rows = db.prepare('SELECT id, category FROM memories WHERE target = ? AND project IS NULL AND content = ?');
    for (const content of new Set([...plan.old.map(item => item.content), ...plan.next.map(item => item.content)])) {
        const found = rows.all(plan.target, content);
        if (found.length > 1 || found.some(row => row.category !== null))
            throw fail('Memory search index has ambiguous document facts or conflicting metadata; reconcile before editing');
    }
}

function reconcile(dbManager, plan) {
    const perform = () => {
        const db = dbManager.getDb();
        const tx = db.transaction(() => {
            checkRows(db, plan);
            const old = new Set(plan.old.map(item => item.content));
            const next = new Set(plan.next.map(item => item.content));
            const remove = db.prepare('DELETE FROM memories WHERE target = ? AND project IS NULL AND category IS NULL AND content = ?');
            for (const content of old) if (!next.has(content)) {
                const removed = remove.run(plan.target, content).changes;
                if (removed > 1) throw fail('Document index changed during removal');
            }
            const count = db.prepare('SELECT COUNT(*) AS total FROM memories WHERE target = ? AND project IS NULL AND category IS NULL AND content = ?');
            const insert = db.prepare('INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (NULL, ?, NULL, ?, ?, ?)');
            for (const item of plan.next) if (count.get(plan.target, item.content).total === 0)
                insert.run(plan.target, item.content, item.created, item.lastReferenced);
            for (const item of plan.next) if (count.get(plan.target, item.content).total !== 1)
                throw fail('Document index changed during insertion');
        });
        tx.immediate();
    };
    dbManager.withCorruptionRecovery(perform);
}

async function documentIndexSynced(root, target, bundlePath, content) {
    if (pendingDocumentIndex(root, target)) return false;
    const upstream = await import(pathToFileURL(bundlePath).href);
    const store = new upstream.MemoryStore({ memoryDir: root });
    const desired = documentEntries(store, content);
    const dbPath = path.join(root, 'sessions.db');
    let stat;
    try { stat = fs.lstatSync(dbPath); }
    catch (error) { if (error.code === 'ENOENT') return desired.length === 0; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(dbPath) !== dbPath)
        throw fail('Unsafe profile memory database');
    const Database = createRequire(bundlePath)('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const rows = db.prepare('SELECT category FROM memories WHERE target = ? AND project IS NULL AND content = ?');
        return desired.every(item => {
            const matches = rows.all(target, item.content);
            return matches.length === 1 && matches[0].category === null;
        });
    } catch (error) {
        if (error.code === 'SQLITE_ERROR' || error.code === 'SQLITE_CORRUPT') return false;
        throw error;
    } finally { db.close(); }
}

async function documentIndex(root, target, bundlePath, before, after) {
    const upstream = await import(pathToFileURL(bundlePath).href);
    const store = new upstream.MemoryStore({ memoryDir: root });
    const dbManager = new upstream.DatabaseManager(root);
    const file = path.join(root, target === 'user' ? 'USER.md' : 'MEMORY.md');
    try {
        let pending = pendingDocumentIndex(root, target);
        // A stopped process may have marked an edit without publishing it. Only
        // the unchanged, descriptor-verified old document can discard that plan.
        if (pending && pending.before !== pending.after && (before?.revision ?? null) === pending.before
            && (safeFile(file)?.revision ?? null) === pending.before) {
            fs.unlinkSync(filename(root, target));
            pending = null;
        }
        const plan = pending ?? { version: 1, target, before: before?.revision ?? null,
            after: hash(after), old: documentEntries(store, before?.text ?? ''), next: documentEntries(store, after) };
        if (pending && (before?.revision !== pending.after || hash(after) !== pending.after))
            throw fail('Repair the pending document index before editing again');
        // Inspect the exact rows before publishing. No unrelated SQLite scope is reconciled.
        dbManager.withCorruptionRecovery(() => checkRows(dbManager.getDb(), plan));
        return {
            repairing: Boolean(pending),
            plan,
            mark() { privateFiles.writePrivateFileSync(filename(root, target), JSON.stringify(plan), true); },
            cancel() { fs.unlinkSync(filename(root, target)); },
            sync() {
                if (safeFile(file)?.revision !== plan.after) throw fail('Published document changed before indexing');
                reconcile(dbManager, plan);
                if (safeFile(file)?.revision !== plan.after) throw fail('Published document changed during indexing');
                fs.unlinkSync(filename(root, target));
            },
            close() { try { dbManager.close(); } catch { /* committed rows remain authoritative */ } },
        };
    } catch (error) { dbManager.close(); throw error; }
}

module.exports = { documentIndex, pendingDocumentIndex, documentIndexSynced };
