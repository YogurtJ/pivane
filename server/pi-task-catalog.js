const fs = require('node:fs');
const path = require('node:path');
const fileIo = require('./pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('./pi-file-descriptor');
const { customTypeIs } = require('./pivane-compat');
const { getSdk } = require('./pi-session-store');
const LIMITS = { projects: 8, batchBytes: 8 * 1024 * 1024, milliseconds: 100, lineBytes: 32 * 1024 * 1024, files: 50000, metadataBytes: 32 * 1024 * 1024 };
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const failure = (code, message) => Object.assign(new Error(message), { code });

// Disposable metadata only. Never opens a writable SessionManager, copies chat
// history, or treats a partial/failed inventory as evidence that a task is absent.
class TaskCatalog {
    constructor({ store, directory, limits = {}, suspended = () => false }) {
        Object.assign(this, { store, directory, suspended });
        this.limits = { ...LIMITS, ...limits };
        this.projects = new Map(); this.reads = new Set(); this.stopping = false; this.bytesRead = 0;
    }
    async project(cwd) {
        cwd = this.store.resolveProject(cwd);
        if (!this.projects.has(cwd)) {
            if (this.projects.size >= this.limits.projects) {
                const oldest = [...this.projects.values()].filter(p => !p.flight && !p.loading).sort((a, b) => a.used - b.used)[0];
                if (!oldest || this.reads.size) throw failure('TASK_PROJECT_LIMIT', 'Task directory cache is busy; retry after current reads finish');
                clearTimeout(oldest.timer); this.projects.delete(oldest.cwd);
            }
            this.projects.set(cwd, { cwd, files: new Map(), timer: null, flight: null, error: null });
        }
        const project = this.projects.get(cwd); project.used = Date.now();
        if (!project.ready) {
            project.loading = true;
            project.ready = Promise.resolve().then(async () => {
                const { getAgentDir } = await getSdk();
                project.directory = this.directory ? this.directory(cwd) : path.join(getAgentDir(), 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
            }).catch(error => { project.ready = null; throw error; }).finally(() => { project.loading = false; });
        }
        await project.ready;
        return project;
    }
    get busy() { return this.reads.size > 0 || [...this.projects.values()].some(p => p.flight || p.loading); }
    originMatches(task, cwd) {
        try { return typeof task?.source?.sessionId === 'string' && fs.realpathSync.native(task.source.cwd) === cwd; }
        catch { return false; }
    }
    async refresh(cwd) {
        const project = await this.project(cwd);
        if (this.stopping || this.suspended()) throw failure('TASK_SUSPENDED', 'Task directory is paused for maintenance');
        if (!project.flight) {
            const flight = Promise.resolve().then(() => this.scan(project));
            project.flight = flight;
            try { await flight; } finally { project.flight = null; }
        } else await project.flight;
        if (!project.complete && !project.timer && !project.error) {
            project.timer = setTimeout(() => {
                project.timer = null;
                if (!this.stopping && !this.suspended()) void this.refresh(cwd).catch(() => {});
            }, 25);
            project.timer.unref?.();
        }
        if (project.error) throw project.error;
        return this.snapshot(project);
    }
    snapshot(project) {
        const files = [...project.files.values()];
        return { complete: Boolean(project.complete), coverage: { files: files.length, checked: files.filter(f => f.complete).length,
            bytesRead: files.reduce((n, f) => n + f.position, 0), totalBytes: files.reduce((n, f) => n + Number(f.stat.size), 0) },
            records: files.filter(f => f.complete && f.header?.cwd === project.cwd && f.task?.sessionId === f.header.id)
                .map(f => ({ session: { id: f.header.id, cwd: project.cwd, path: f.path, name: f.name || '' }, task: f.task,
                    state: f.state, sourceMatches: this.originMatches(f.task, project.cwd), results: [...f.results.values()], receipts: [...f.receipts], read: [...f.read] })) };
    }
    async scan(project) {
        assertDescriptorBackend(); project.complete = false; project.error = null;
        try {
            let names = [], directoryBefore = null;
            try {
                directoryBefore = fs.lstatSync(project.directory, { bigint: true });
                if (!directoryBefore.isDirectory() || fs.realpathSync.native(project.directory) !== project.directory) throw failure('TASK_DIRECTORY', 'Linked task discovery directories are not supported');
                names = (await fs.promises.readdir(project.directory, { withFileTypes: true })).filter(f => f.name.endsWith('.jsonl'));
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (names.length > this.limits.files) throw failure('TASK_DIRECTORY_LIMIT', 'Task directory exceeds the metadata inventory limit');
            const present = new Set();
            for (const name of names) {
                if (!name.isFile()) throw failure('TASK_FILE', 'Task discovery requires regular session files');
                const filename = path.join(project.directory, name.name); present.add(filename);
                const stat = fs.lstatSync(filename, { bigint: true });
                if (!stat.isFile()) throw failure('TASK_FILE', 'Session file changed during discovery');
                let record = project.files.get(filename);
                if (!record || fingerprint(record.stat) !== fingerprint(stat)) {
                    record = { path: filename, stat, position: 0, parts: [], pendingBytes: 0, complete: false,
                        header: null, task: null, state: null, name: '', results: new Map(), receipts: new Set(), read: new Set() };
                    project.files.set(filename, record);
                } else if (record.complete) this.readBatch(project, record, 0, Date.now());
            }
            for (const filename of project.files.keys()) if (!present.has(filename)) project.files.delete(filename);
            const started = Date.now(); let remaining = this.limits.batchBytes;
            for (const record of project.files.values()) {
                if (record.complete) continue;
                if (remaining <= 0 || Date.now() - started >= this.limits.milliseconds) break;
                remaining -= this.readBatch(project, record, remaining, started);
                await new Promise(resolve => setImmediate(resolve));
            }
            // Include all sessions, even non-task parents, for receipt recovery.
            const ids = new Set(); let metadataBytes = 0;
            for (const record of project.files.values()) {
                if (record.header?.cwd === project.cwd) {
                    if (ids.has(record.header.id)) throw failure('TASK_DUPLICATE_ID', 'Duplicate native session identity; reconcile the session files');
                    ids.add(record.header.id);
                }
                metadataBytes += Buffer.byteLength(JSON.stringify([record.header, record.task, record.state, record.name,
                    [...record.results.values()], [...record.receipts], [...record.read]]));
            }
            if (metadataBytes > this.limits.metadataBytes) throw failure('TASK_METADATA_LIMIT', 'Task metadata exceeds the cache budget');
            let stable = true;
            if (directoryBefore) {
                const after = fs.lstatSync(project.directory, { bigint: true });
                stable = after.isDirectory() && fingerprint(after) === fingerprint(directoryBefore)
                    && fs.realpathSync.native(project.directory) === project.directory;
            } else stable = !fs.existsSync(project.directory);
            for (const [filename, record] of project.files) {
                try {
                    const now = fs.lstatSync(filename, { bigint: true });
                    if (!now.isFile() || fingerprint(now) !== fingerprint(record.stat)
                        || !fileIo.sameIdentityAtPath(filename, record.identity ?? null)) { project.files.delete(filename); stable = false; }
                } catch { project.files.delete(filename); stable = false; }
            }
            project.complete = stable && [...project.files.values()].every(f => f.complete);
        } catch (error) {
            project.error = error.code?.startsWith('TASK_') ? error : failure('TASK_SCAN_FAILED', 'Task directory could not be verified; retry after the session files settle');
            throw project.error;
        }
    }
    readBatch(project, record, allowance, started) {
        let fd; let bytes = 0;
        try {
            fd = fileIo.openReadSync(record.path);
            const stat = fs.fstatSync(fd, { bigint: true }), identity = fileIo.identity(fd), actual = descriptorPathSync(fd);
            if (!stat.isFile() || actual !== record.path || fingerprint(stat) !== fingerprint(record.stat)
                || record.identity !== undefined && record.identity !== identity) throw failure('TASK_CHANGED', 'Session changed during task discovery; retry');
            record.identity = identity;
            if (record.header) {
                let currentCwd; try { currentCwd = fs.realpathSync.native(record.header.rawCwd); } catch { currentCwd = record.header.rawCwd; }
                if (currentCwd !== record.header.cwd) throw failure('TASK_CHANGED', 'Project alias changed during task discovery; retry');
            }
            while (record.position < Number(stat.size) && bytes < allowance && Date.now() - started < this.limits.milliseconds) {
                const buffer = Buffer.alloc(Math.min(65536, allowance - bytes, Number(stat.size) - record.position));
                const count = fs.readSync(fd, buffer, 0, buffer.length, record.position);
                if (!count) throw failure('TASK_CHANGED', 'Session changed during task discovery; retry');
                record.position += count; bytes += count; this.bytesRead += count;
                let from = 0, end;
                const append = part => {
                    if (!part.length) return;
                    record.parts.push(part); record.pendingBytes += part.length;
                    if (record.pendingBytes > this.limits.lineBytes) throw failure('TASK_LINE_LIMIT', 'A session record exceeds the task parser line budget');
                };
                while ((end = buffer.indexOf(10, from)) >= 0 && end < count) {
                    append(buffer.subarray(from, end));
                    this.line(project, record, Buffer.concat(record.parts, record.pendingBytes));
                    record.parts = []; record.pendingBytes = 0; from = end + 1;
                }
                append(buffer.subarray(from, count));
            }
            const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(record.path, { bigint: true });
            if (!current.isFile() || fingerprint(after) !== fingerprint(stat) || fingerprint(current) !== fingerprint(stat)
                || !fileIo.sameIdentityAtPath(record.path, identity) || descriptorPathSync(fd) !== actual
                || fs.realpathSync.native(record.path) !== actual) throw failure('TASK_CHANGED', 'Session changed during task discovery; retry');
            if (record.position === Number(stat.size)) {
                // An unfinished LF frame is not negative evidence for creation.
                if (record.pendingBytes || !record.header) throw failure('TASK_INCOMPLETE', 'Session has an unfinished record; task discovery will retry');
                record.complete = true;
            }
            return bytes;
        } catch (error) { project.files.delete(record.path); throw error; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    line(project, record, buffer) {
        if (!buffer.length) return;
        if (buffer.length > this.limits.lineBytes) throw failure('TASK_LINE_LIMIT', 'A session record exceeds the task parser line budget');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (!text.trim()) return;
        const entry = JSON.parse(text);
        if (!record.header) {
            if (entry.type !== 'session' || ![2, 3].includes(entry.version) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 160
                || typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) throw failure('TASK_HEADER', 'Unsupported native session header');
            let cwd; try { cwd = fs.realpathSync.native(entry.cwd); } catch { cwd = entry.cwd; }
            record.header = { id: entry.id, cwd, rawCwd: entry.cwd }; return;
        }
        if (entry.type === 'message' && entry.id === record.selectEntryId && entry.message?.role === 'assistant') {
            const content = entry.message.content;
            record.selectedText = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
                .filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
        }
        if (record.header.cwd !== project.cwd) return;
        if (entry.type === 'session_info') record.name = typeof entry.name === 'string' ? entry.name.slice(0, 160) : '';
        if (entry.type === 'custom' && customTypeIs(entry, 'pivane-agent-task') && !record.task
            && entry.data?.version === 1 && entry.data.sessionId === record.header.id) record.task = entry.data;
        if (entry.type === 'custom' && customTypeIs(entry, 'pivane-agent-task-state') && entry.data?.sessionId === record.header.id) {
            record.state = entry.data;
            if (entry.data.version === 2 && entry.data.status === 'settled' && typeof entry.data.resultId === 'string')
                record.results.set(entry.data.resultId, entry.data);
        }
        if (entry.type === 'custom_message' && entry.customType === 'pivane-agent-task-result' && typeof entry.details?.deliveryId === 'string') record.receipts.add(entry.details.deliveryId);
        if (entry.type === 'custom' && entry.customType === 'pivane-agent-task-read' && typeof entry.data?.deliveryId === 'string') record.read.add(entry.data.deliveryId);
    }
    async source(cwd, sessionId) {
        const project = await this.project(cwd);
        const matches = [...project.files.values()].filter(f => f.complete && f.header?.cwd === project.cwd && f.header.id === sessionId);
        if (matches.length !== 1) throw failure('TASK_SOURCE', 'Source session is missing or ambiguous');
        return matches[0];
    }
    reply(cwd, sessionId, entryId, offset = 0) {
        if (this.stopping || this.reads.size >= 2) return Promise.reject(new Error('Task result reader is busy'));
        const work = Promise.resolve().then(() => this.readReply(cwd, sessionId, entryId, offset));
        this.reads.add(work);
        return work.finally(() => this.reads.delete(work));
    }
    async readReply(cwd, sessionId, entryId, offset = 0) {
        if (!Number.isInteger(offset) || offset < 0 || offset > this.limits.lineBytes) throw new Error('Invalid result offset');
        const project = await this.project(cwd), source = await this.source(cwd, sessionId);
        const record = { path: source.path, stat: fs.lstatSync(source.path, { bigint: true }), position: 0, parts: [], pendingBytes: 0,
            header: null, task: null, state: null, results: new Map(), receipts: new Set(), read: new Set(), selectEntryId: entryId };
        const started = Date.now();
        while (record.selectedText === undefined && !record.complete) {
            if (this.stopping || this.suspended() || Date.now() - started > 20000) throw failure('TASK_RESULT_LIMIT', 'Result reading stopped; retry with the same task and result identifiers');
            this.readBatch(project, record, this.limits.batchBytes, Date.now());
            await new Promise(resolve => setImmediate(resolve));
        }
        if (record.header?.id !== sessionId || record.header.cwd !== project.cwd || record.selectedText === undefined) throw failure('TASK_RESULT_MISSING', 'Original task reply is no longer available');
        const text = record.selectedText.slice(offset, offset + 8000);
        return { entryId, text, offset, nextOffset: offset + text.length < record.selectedText.length ? offset + text.length : null, totalCharacters: record.selectedText.length };
    }
    async dispose() {
        this.stopping = true;
        for (const project of this.projects.values()) clearTimeout(project.timer);
        await Promise.allSettled([...this.reads, ...[...this.projects.values()].flatMap(p => [p.flight, p.ready]).filter(Boolean)]);
        this.projects.clear();
    }
}
module.exports = { TaskCatalog, LIMITS };
