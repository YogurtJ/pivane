const fileIo = require('./pi-file-io');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { descriptorPathSync, assertDescriptorBackend } = require('./pi-file-descriptor');
const { parentPort, workerData } = require('node:worker_threads');

const LIMITS = { files: 2000, bytes: 512 * 1024 * 1024, fileBytes: 64 * 1024 * 1024,
    lineBytes: 8 * 1024 * 1024, entries: 250000, records: 100000, milliseconds: 20000 };
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const within = (root, value) => value === root || value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
    records: 0, missingUsage: 0, missingCost: 0, zeroCost: 0 });
function add(target, record) {
    target.records++;
    if (!record.usage) { target.missingUsage++; return; }
    for (const field of fields) target[field] += record.usage[field];
    target.total += fields.reduce((sum, field) => sum + record.usage[field], 0);
    if (record.cost === null) target.missingCost++;
    else { target.cost += record.cost; if (record.cost === 0) target.zeroCost++; }
}
function canonical(value, depth = 0) {
    if (depth > 64) throw new Error('depth');
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
    return value;
}
function recordFromEntry(entry, dayOf, filter) {
    const assistant = entry.type === 'message' && entry.message?.role === 'assistant';
    const tool = entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.usage !== undefined;
    const summary = ['compaction', 'branch_summary'].includes(entry.type);
    if (!assistant && !tool && !summary) return null;
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) return { invalidDate: true };
    const day = dayOf.format(timestamp);
    if (day < filter.from || day > filter.to) return null;
    if (typeof entry.id !== 'string' || entry.id.length > 128) throw new Error('id');
    const raw = summary ? entry.usage : entry.message.usage;
    const usage = raw && fields.every(field => Number.isSafeInteger(raw[field]) && raw[field] >= 0 && raw[field] <= 1e9)
        ? Object.fromEntries(fields.map(field => [field, raw[field]])) : null;
    const cost = typeof raw?.cost?.total === 'number' && Number.isFinite(raw.cost.total) && raw.cost.total >= 0 && raw.cost.total <= 1e9 ? raw.cost.total : null;
    // Native forks/imports preserve entry IDs and timestamps. Include payload to avoid ID collisions;
    // parentId may change on branch export. Never recurse into compaction.retainedTail as new usage.
    const payload = assistant || tool ? entry.message : { summary: entry.summary, usage: entry.usage, type: entry.type };
    const key = createHash('sha256').update(JSON.stringify(canonical([entry.id, entry.timestamp, payload]))).digest('hex');
    const safeName = value => typeof value === 'string' ? value.slice(0, 500) : '未知';
    return { key, day, usage, cost, provider: assistant ? safeName(entry.message.provider) : '工具与摘要',
        model: assistant ? safeName(entry.message.responseModel || entry.message.model) : '工具与摘要（未归属模型）' };
}

function scanUsage({ root, roots, filter }, limits = LIMITS) {
    assertDescriptorBackend();
    const started = Date.now();
    const coverage = { scannedFiles: 0, skippedFiles: 0, excludedProjects: 0, duplicates: 0, invalidDates: 0, limited: false };
    const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: filter.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    let bytes = 0, entries = 0, records = 0;
    const files = [], sessions = [];
    if (!fs.existsSync(root)) return aggregate([], filter, coverage);
    root = fs.realpathSync.native(root);
    const check = () => {
        if (Date.now() - started > limits.milliseconds || bytes > limits.bytes || entries > limits.entries || records > limits.records) {
            coverage.limited = true; throw new Error('budget');
        }
    };
    // Match the native sessions/<project>/*.jsonl layout. Never follow directory or file symlinks.
    for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
        check();
        if (!directory.isDirectory()) { if (directory.isSymbolicLink()) coverage.skippedFiles++; continue; }
        const folder = path.join(root, directory.name);
        if (!within(root, fs.realpathSync.native(folder))) { coverage.skippedFiles++; continue; }
        for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
            if (!file.name.endsWith('.jsonl')) continue;
            if (!file.isFile()) { coverage.skippedFiles++; continue; }
            if (files.length >= limits.files) { coverage.limited = true; break; }
            files.push(path.join(folder, file.name));
        }
        if (coverage.limited) break;
    }
    for (const filename of files.sort()) {
        let fd;
        try {
            check();
            fd = fileIo.openReadSync(filename);
            const stat = fs.fstatSync(fd, { bigint: true });
            const identity = fileIo.identity(fd);
            const actual = descriptorPathSync(fd);
            if (!stat.isFile() || !within(root, actual) || stat.size > limits.fileBytes) throw new Error('file');
            const size = Number(stat.size); // Conversion only after the bounded file-size check.
            const data = { path: filename, rows: [], name: '' };
            let pending = Buffer.alloc(0), header = null, position = 0;
            const processLine = line => {
                entries++; check();
                if (line.length > limits.lineBytes) throw new Error('line');
                if (!line.toString('utf8').trim()) return;
                const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
                if (!header) {
                    if (entry?.type !== 'session' || ![2, 3].includes(entry.version) || typeof entry.id !== 'string'
                        || typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) throw new Error('header');
                    const cwd = fs.realpathSync.native(entry.cwd);
                    if (!fs.statSync(cwd).isDirectory() || !roots.some(base => within(base, cwd))) {
                        coverage.excludedProjects++; throw new Error('excluded');
                    }
                    header = entry;
                    Object.assign(data, { cwd, id: entry.id.slice(0, 128), created: Date.parse(entry.timestamp) || 0 });
                    return;
                }
                if (!entry || typeof entry !== 'object' || entry.type === 'session') throw new Error('entry');
                if (entry.type === 'session_info' && typeof entry.name === 'string') data.name = entry.name.slice(0, 120);
                const row = recordFromEntry(entry, dayOf, filter);
                if (row?.invalidDate) coverage.invalidDates++;
                else if (row) { data.rows.push(row); records++; check(); }
            };
            while (position < size) {
                check();
                const chunk = Buffer.alloc(Math.min(65536, size - position));
                const read = fs.readSync(fd, chunk, 0, chunk.length, position);
                if (!read) throw new Error('changed');
                position += read; bytes += read;
                pending = Buffer.concat([pending, chunk.subarray(0, read)]);
                let start = 0, end;
                while ((end = pending.indexOf(10, start)) !== -1) { processLine(pending.subarray(start, end)); start = end + 1; }
                pending = pending.subarray(start);
                if (pending.length > limits.lineBytes) throw new Error('line');
            }
            if (pending.length) processLine(pending);
            const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(filename, { bigint: true });
            if (!fileIo.sameIdentityAtPath(filename, identity) || !header || !current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev
                || fs.realpathSync.native(header.cwd) !== data.cwd
                || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs
                || fs.realpathSync.native(filename) !== actual || descriptorPathSync(fd) !== actual) throw new Error('changed');
            sessions.push(data); coverage.scannedFiles++;
        } catch (error) {
            if (error.message !== 'excluded') coverage.skippedFiles++;
            if (error.message === 'budget') break;
        } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    // Oldest surviving session owns shared records. Removing an original leaves its surviving copy countable.
    sessions.sort((a, b) => a.created - b.created || a.path.localeCompare(b.path));
    return aggregate(sessions, filter, coverage);
}
function aggregate(sessions, filter, coverage) {
    const seen = new Set(), total = empty(), daily = new Map(), models = new Map(), providers = new Map(), projects = new Map(), sessionRows = [];
    for (let day = Date.parse(filter.from); day <= Date.parse(filter.to); day += 86400000) {
        const key = new Date(day).toISOString().slice(0, 10); daily.set(key, { date: key, ...empty() });
    }
    const bucket = (map, key, extra) => { if (!map.has(key)) map.set(key, { ...extra, ...empty() }); return map.get(key); };
    for (const session of sessions) {
        const item = { id: session.id, cwd: session.cwd, name: session.name || session.id, ...empty() };
        for (const row of session.rows) {
            if (seen.has(row.key)) { coverage.duplicates++; continue; }
            seen.add(row.key);
            for (const target of [total, item, daily.get(row.day),
                bucket(models, JSON.stringify([row.provider, row.model]), { provider: row.provider, model: row.model }),
                bucket(providers, row.provider, { provider: row.provider }),
                bucket(projects, session.cwd, { cwd: session.cwd, name: path.basename(session.cwd) || session.cwd })]) add(target, row);
        }
        if (item.records) sessionRows.push(item);
    }
    const sorted = values => [...values].sort((a, b) => b.total - a.total || b.records - a.records);
    return { ...filter, generatedAt: new Date().toISOString(), scope: 'persistent-sessions',
        total, daily: [...daily.values()], models: sorted(models.values()), providers: sorted(providers.values()),
        projects: sorted(projects.values()), sessions: sorted(sessionRows), coverage,
        partial: coverage.skippedFiles > 0 || coverage.invalidDates > 0 || coverage.limited || total.missingUsage > 0 };
}
if (parentPort) {
    try { parentPort.postMessage({ value: scanUsage(workerData) }); }
    catch { parentPort.postMessage({ error: '用量扫描未完成，请稍后刷新' }); }
}
module.exports = { scanUsage, recordFromEntry, LIMITS };
