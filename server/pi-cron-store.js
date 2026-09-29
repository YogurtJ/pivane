const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { privateDir } = require('./pi-maintenance-files');
const privateFiles = require('./pi-private-files');
const ACTIVE = new Set(['waiting', 'dispatching', 'running', 'uncertain']);
const DEFAULT_LIMITS = { maxRunsPerDay: 40, maxTokensPerDay: 400000, maxCostPerDay: null };
class CronStore {
    constructor(filename) {
        const directory = privateDir(path.dirname(filename));
        filename = path.join(directory, path.basename(filename));
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { if (!fs.lstatSync(filename + suffix).isFile()) throw new Error('Unsafe scheduler database'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!fs.existsSync(filename)) fs.closeSync(privateFiles.openPrivateFileSync(filename));
        privateFiles.privateFileMode(filename);
        this.filename = filename;
        this.db = new DatabaseSync(filename);
        this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, jobId TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS runs_job ON runs(jobId,at);
            CREATE TABLE IF NOT EXISTS homes (profileId TEXT PRIMARY KEY, data TEXT NOT NULL);`);
        this.owner = `${process.pid}:${randomUUID()}`;
        try {
            this.transaction(() => {
                const version = this.meta('version');
                if (version && version !== 1) throw new Error('Unsupported scheduler database');
                const owner = this.meta('owner');
                if (owner) {
                    let alive = true;
                    try { process.kill(Number(owner.split(':')[0]), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
                    if (alive) throw new Error('This identity already has a scheduler owner');
                }
                this.setMeta('version', 1); this.setMeta('owner', this.owner);
                for (const run of this.activeRuns()) if (['dispatching', 'running'].includes(run.status)) {
                    this.saveRun({ ...run, status: 'uncertain', reason: 'restart' });
                }
            });
        } catch (error) { this.db.close(); throw error; }
    }
    transaction(callback) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = callback(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    meta(key) { const row = this.db.prepare('SELECT data FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.data) : null; }
    setMeta(key, data) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(data)); }
    jobs() { return this.db.prepare('SELECT data FROM jobs').all().map(row => JSON.parse(row.data)); }
    job(id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
    saveJob(job) { this.db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)').run(job.id, JSON.stringify(job)); }
    runs(jobId) { return (jobId ? this.db.prepare('SELECT data FROM runs WHERE jobId=? ORDER BY at DESC LIMIT 100').all(jobId)
        : this.db.prepare('SELECT data FROM runs ORDER BY at DESC LIMIT 100').all()).map(row => JSON.parse(row.data)); }
    activeRuns(jobId) {
        const sql = "SELECT data FROM runs WHERE json_extract(data,'$.status') IN ('waiting','dispatching','running','uncertain')";
        return (jobId ? this.db.prepare(sql + ' AND jobId=? ORDER BY at').all(jobId) : this.db.prepare(sql + ' ORDER BY at').all()).map(row => JSON.parse(row.data));
    }
    runCount() { return this.db.prepare('SELECT count(*) AS n FROM runs').get().n; }
    run(id) { const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
    saveRun(run) {
        if (!ACTIVE.has(run.status)) { run = { ...run, jobRevision: run.job?.revision ?? run.jobRevision }; delete run.job; }
        this.db.prepare('INSERT OR REPLACE INTO runs VALUES (?,?,?,?)').run(run.id, run.jobId, run.scheduledAt, JSON.stringify(run));
    }
    home(id) { const row = this.db.prepare('SELECT data FROM homes WHERE profileId=?').get(id); return row ? JSON.parse(row.data) : null; }
    homes() { return this.db.prepare('SELECT profileId,data FROM homes').all().map(row => ({ profileId: row.profileId, ...JSON.parse(row.data) })); }
    saveHome(id, data) { this.db.prepare('INSERT OR REPLACE INTO homes VALUES (?,?)').run(id, JSON.stringify(data)); }
    limits() { return this.meta('limits') || DEFAULT_LIMITS; }
    usage(day, jobId) {
        const sql = "SELECT json_extract(data,'$.usage') AS usage, json_extract(data,'$.reservedTokens') AS reservedTokens, json_extract(data,'$.reservedCost') AS reservedCost FROM runs WHERE json_extract(data,'$.budgetDay')=? AND json_extract(data,'$.reservedTokens')>0";
        const runs = (jobId ? this.db.prepare(sql + ' AND jobId=?').all(day, jobId) : this.db.prepare(sql).all(day)).map(row => ({ ...row, usage: row.usage ? JSON.parse(row.usage) : null }));
        return { runs: runs.length, tokens: runs.reduce((sum, run) => sum + (run.usage?.tokens ?? run.reservedTokens), 0),
            cost: runs.reduce((sum, run) => sum + (run.usage?.cost ?? run.reservedCost ?? 0), 0),
            unknownCost: runs.some(run => run.usage?.cost == null && run.reservedCost == null) };
    }
    close() {
        if (!this.db) return;
        const db = this.db;
        try {
            if (fs.existsSync(this.filename) && this.meta('owner') === this.owner) db.prepare("DELETE FROM meta WHERE key='owner'").run();
        } finally { db.close(); this.db = null; }
    }
}
module.exports = { CronStore, ACTIVE, DEFAULT_LIMITS };
