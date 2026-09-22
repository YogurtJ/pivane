const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { privateDir } = require('./pi-maintenance-files');
const privateFiles = require('./pi-private-files');
const { scanUsage, empty, within } = require('./pi-usage-worker');
const { officialPrices, estimateCost } = require('./pi-usage-pricing');
const metrics = [...Object.keys(empty()), 'recordedCost', 'estimatedRecords', 'unpricedRecords'];
const zero = () => ({ ...empty(), recordedCost: 0, estimatedRecords: 0, unpricedRecords: 0 });
const dayFormatter = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
function valuesFor(row) {
    const value = zero(); value.records = 1;
    if (!row.usage) { value.missingUsage = 1; return value; }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) value[field] = row.usage[field];
    value.total = value.input + value.output + value.cacheRead + value.cacheWrite;
    value.recordedCost = row.originalCost || 0;
    if (row.cost === null) value.missingCost = 1;
    else { value.cost = row.cost; value.zeroCost = Number(row.cost === 0); }
    value.estimatedRecords = Number(Boolean(row.pricing));
    value.unpricedRecords = Number(value.total > 0 && !row.pricing && (row.cost === null || row.cost === 0));
    return value;
}
function addValues(target, source) { for (const key of metrics) target[key] += source[key]; }
class UsageLedger {
    constructor(filename) {
        const directory = privateDir(path.dirname(filename));
        filename = path.join(directory, path.basename(filename));
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { if (!fs.lstatSync(filename + suffix).isFile()) throw new Error('Unsafe usage ledger'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!fs.existsSync(filename)) {
            try { fs.closeSync(privateFiles.openPrivateFileSync(filename)); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        privateFiles.privateFileMode(filename);
        this.db = new DatabaseSync(filename);
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, signature TEXT NOT NULL, cwd TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS owners (key TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, owner TEXT NOT NULL,
                provider TEXT NOT NULL, model TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS facts_time ON facts(timestamp);
            CREATE TABLE IF NOT EXISTS zones (zone TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS daily (zone TEXT NOT NULL, day TEXT NOT NULL, owner TEXT NOT NULL,
                provider TEXT NOT NULL, model TEXT NOT NULL, ${metrics.map(key => `${key} REAL NOT NULL`).join(',')},
                PRIMARY KEY(zone,day,owner,provider,model));`);
        const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
        if (version && version.value !== '1') { this.db.close(); throw new Error('Unsupported usage ledger version'); }
        this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema','1')").run();
        this.insertFact = this.db.prepare('INSERT OR IGNORE INTO facts VALUES (?,?,?,?,?,?)');
        this.upsertDay = this.db.prepare(`INSERT INTO daily VALUES (${Array(5 + metrics.length).fill('?').join(',')})
            ON CONFLICT(zone,day,owner,provider,model) DO UPDATE SET ${metrics.map(key => `${key}=${key}+excluded.${key}`).join(',')}`);
        this.zones = new Map(this.db.prepare('SELECT zone FROM zones').all().map(row => [row.zone, dayFormatter(row.zone)]));
    }
    transaction(callback) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const value = callback(); this.db.exec('COMMIT'); return value; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    saveDay(zone, formatter, owner, row) {
        const value = valuesFor(row);
        this.upsertDay.run(zone, formatter.format(row.timestamp), owner, row.provider, row.model, ...metrics.map(key => value[key]));
    }
    ensureZone(zone) {
        if (this.zones.has(zone)) return;
        const formatter = dayFormatter(zone);
        this.transaction(() => {
            if (this.db.prepare('SELECT 1 FROM zones WHERE zone=?').get(zone)) return;
            if (this.db.prepare('SELECT count(*) AS n FROM zones').get().n >= 32) throw new Error('Usage timezone limit reached');
            for (const fact of this.db.prepare('SELECT owner,data FROM facts').iterate()) this.saveDay(zone, formatter, fact.owner, JSON.parse(fact.data));
            this.db.prepare('INSERT INTO zones VALUES (?)').run(zone);
        });
        this.zones.set(zone, formatter);
    }
    sync(input, catalog) {
        let duplicates = 0;
        const source = this.db.prepare('SELECT signature,cwd FROM sources WHERE path=?');
        const result = scanUsage({ ...input, filter: { from: '0000-01-01', to: '9999-12-31', timeZone: 'UTC' },
            incremental: {
                cached: (filename, signature) => {
                    const old = source.get(filename);
                    if (!old || old.signature !== signature || !input.roots.some(root => within(root, old.cwd))) return false;
                    try { return fs.realpathSync.native(old.cwd) === old.cwd && fs.statSync(old.cwd).isDirectory(); } catch { return false; }
                },
                save: session => this.transaction(() => {
                    this.zones = new Map(this.db.prepare('SELECT zone FROM zones').all().map(row => [row.zone, dayFormatter(row.zone)]));
                    const owner = createHash('sha256').update(JSON.stringify([session.path, session.id])).digest('hex');
                    this.db.prepare('INSERT INTO owners VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name')
                        .run(owner, session.id, session.cwd, session.name || session.id);
                    for (const record of session.rows) {
                        const correction = estimateCost(record, catalog);
                        const row = { ...record, originalCost: record.cost, cost: correction.cost, pricing: correction.pricing };
                        const inserted = this.insertFact.run(row.key, row.timestamp, owner, row.provider, row.model, JSON.stringify(row));
                        if (!inserted.changes) { duplicates++; continue; }
                        for (const [zone, formatter] of this.zones) this.saveDay(zone, formatter, owner, row);
                    }
                    // Invalid dates must remain visible on subsequent scans and block deletion.
                    if (!session.invalidDates) this.db.prepare('INSERT OR REPLACE INTO sources VALUES (?,?,?)').run(session.path, session.signature, session.cwd);
                })
            } }, input.limits);
        result.coverage.duplicates += duplicates;
        const coverage = { ...result.coverage, syncedAt: new Date().toISOString() };
        if (input.onlyFile && (coverage.scannedFiles + coverage.cachedFiles !== 1 || coverage.skippedFiles || coverage.invalidDates || coverage.limited)) {
            throw new Error('会话用量尚未完整入账，暂不能删除');
        }
        if (!input.onlyFile) this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('coverage',?)").run(JSON.stringify(coverage));
        return coverage;
    }
    report(filter, roots, coverage) {
        const daily = new Map(), providers = new Map(), models = new Map(), projects = new Map(), sessions = new Map(), total = zero();
        for (let time = Date.parse(filter.from); time <= Date.parse(filter.to); time += 86400000) {
            const date = new Date(time).toISOString().slice(0, 10); daily.set(date, { date, ...zero() });
        }
        const bucket = (map, key, extra) => { if (!map.has(key)) map.set(key, { ...extra, ...zero() }); return map.get(key); };
        for (const row of this.db.prepare(`SELECT daily.*,owners.id,owners.cwd,owners.name FROM daily JOIN owners ON daily.owner=owners.key
            WHERE zone=? AND day>=? AND day<=?`).iterate(filter.timeZone, filter.from, filter.to)) {
            if (!roots.some(root => within(root, row.cwd))) continue;
            for (const target of [total, daily.get(row.day),
                bucket(providers, row.provider, { provider: row.provider }),
                bucket(models, JSON.stringify([row.provider, row.model]), { provider: row.provider, model: row.model }),
                bucket(projects, row.cwd, { cwd: row.cwd, name: path.basename(row.cwd) || row.cwd }),
                bucket(sessions, row.owner, { id: row.id, cwd: row.cwd, name: row.name })]) addValues(target, row);
        }
        const sorted = map => [...map.values()].sort((a, b) => b.total - a.total || b.records - a.records);
        const periods = type => {
            const rows = new Map();
            for (const day of daily.values()) {
                let key = day.date.slice(0, 7);
                if (type === 'week') {
                    const date = new Date(day.date); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); key = date.toISOString().slice(0, 10);
                }
                addValues(bucket(rows, key, { date: key }), day);
            }
            return [...rows.values()];
        };
        return { ...filter, generatedAt: new Date().toISOString(), scope: 'persistent-sessions', ledger: true,
            total, daily: [...daily.values()], weekly: periods('week'), monthly: periods('month'),
            providers: sorted(providers), models: sorted(models), projects: sorted(projects), sessions: sorted(sessions), coverage,
            partial: Boolean(coverage.skippedFiles || coverage.invalidDates || coverage.limited || total.missingUsage) };
    }
    close() { this.db.close(); }
}
async function runLedger(input) {
    const ledger = new UsageLedger(input.ledgerPath);
    try {
        ledger.ensureZone('UTC');
        if (input.filter) ledger.ensureZone(input.filter.timeZone);
        const coverage = ledger.sync(input, await officialPrices());
        return input.filter ? ledger.report(input.filter, input.roots, coverage) : { coverage, ledger: true };
    } finally { ledger.close(); }
}
module.exports = { UsageLedger, runLedger, valuesFor };
