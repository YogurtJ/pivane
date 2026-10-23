const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fileIo = require('./pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('./pi-file-descriptor');
const { customTypeIs } = require('./pivane-compat');
const { getSdk } = require('./pi-session-store');
const { MESSAGE_OUT, MESSAGE_IN, outboundMessage } = require('./pi-agent-message-format');
const LIMITS = { replyLocationBytes: 1024 * 1024, outboxPerSession: 2000, projects: 8, batchBytes: 8 * 1024 * 1024, milliseconds: 100, refreshMilliseconds: 2000, lineBytes: 32 * 1024 * 1024, files: 50000, metadataBytes: 32 * 1024 * 1024 };
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const failure = (code, message) => Object.assign(new Error(message), { code });

// Disposable metadata only. Never opens a writable SessionManager, copies chat
// history, or treats a partial/failed inventory as evidence that a task is absent.
class TaskCatalog {
    constructor({ store, directory, limits = {}, suspended = () => false }) {
        Object.assign(this, { store, directory, suspended });
        this.limits = { ...LIMITS, ...limits };
        this.projects = new Map(); this.reads = new Set(); this.stopping = false; this.bytesRead = 0;
        this.replyLocations = new Map(); this.replyLocationBytes = 0;
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
            // A caller's native history grows with each tool call. Finish multiple
            // bounded batches here so histories larger than batchBytes do not get
            // invalidated again before the caller ever observes a complete index.
            // Retain one shared flight and yield between batches; never relax scan's
            // full inventory, descriptor identity or before/after change checks.
            const flight = Promise.resolve().then(async () => {
                const deadline = Date.now() + this.limits.refreshMilliseconds;
                do {
                    if (this.stopping || this.suspended()) throw failure('TASK_SUSPENDED', 'Task directory is paused for maintenance');
                    try { await this.scan(project); }
                    catch (error) {
                        // A managed worker may append a receipt between batches.
                        // scan/readBatch have discarded the changed record; retry
                        // from disk within this same budget, never reuse its state.
                        if (error.code !== 'TASK_CHANGED' || Date.now() >= deadline) throw error;
                    }
                    if (project.complete || Date.now() >= deadline) break;
                    await new Promise(resolve => setImmediate(resolve));
                } while (Date.now() < deadline);
            });
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
    // Persistent threads in one project, for Agent-to-Agent addressing. Metadata only.
    threads(project) {
        return [...project.files.values()].filter(f => f.complete && f.header?.cwd === project.cwd).map(f => ({
            id: f.header.id, cwd: project.cwd, path: f.path, name: f.name || '', preview: f.preview || '', special: f.special,
            modified: new Date(Number(f.stat.mtimeNs / 1000000n)).toISOString(),
            task: f.task && f.task.sessionId === f.header.id && this.originMatches(f.task, project.cwd) ? { sourceSessionId: f.task.source.sessionId, requestId: f.task.requestId } : null,
            outbox: [...f.outbox.values()], inbox: f.inbox }));
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
                    record = { path: filename, stat, position: 0, linePosition: 0, parts: [], pendingBytes: 0, complete: false,
                        header: null, task: null, state: null, name: '', results: new Map(), receipts: new Set(), read: new Set(),
                        preview: '', special: null, outbox: new Map(), outboxLocations: new Map(), inbox: new Set() };
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
            // Delivered message bodies stay in their native files; keep only routing identity in memory.
            const delivered = new Set([...project.files.values()].flatMap(record => [...record.inbox]));
            for (const record of project.files.values()) for (const [id, message] of record.outbox)
                if (delivered.has(id) && message.text !== undefined) record.outbox.set(id, { ...message, text: undefined });
            // Include all sessions, even non-task parents, for receipt recovery.
            const ids = new Set(); let metadataBytes = 0;
            for (const record of project.files.values()) {
                if (record.header?.cwd === project.cwd) {
                    if (ids.has(record.header.id)) throw failure('TASK_DUPLICATE_ID', 'Duplicate native session identity; reconcile the session files');
                    ids.add(record.header.id);
                }
                metadataBytes += Buffer.byteLength(JSON.stringify([record.header, record.task, record.state, record.name,
                    [...record.results.values()], [...record.receipts], [...record.read], record.preview, [...record.outbox.values()], [...record.outboxLocations], [...record.inbox]]));
            }
            if (metadataBytes > this.limits.metadataBytes) throw failure('TASK_METADATA_LIMIT', 'Task metadata exceeds the cache budget');
            project.metadataBytes = metadataBytes;
            const indexed = [...project.files.values()].every(record => record.complete);
            let bodiesComplete = false;
            if (indexed) {
                for (const record of project.files.values()) {
                    if ([...record.outboxLocations.keys()].filter(id => !delivered.has(id)).length > this.limits.outboxPerSession)
                        throw failure('TASK_OUTBOX_LIMIT', 'Pending outbound messages exceed the recovery index budget; the catalog is incomplete');
                }
                // Discover all inboxes before retaining any outbound body. Large
                // delivered histories consume routing metadata, not body memory.
                bodiesComplete = this.readOutboundBodies(project, delivered, remaining, started);
            }
            let stable = true;
            if (directoryBefore) {
                // Directory timestamps can remain identical for multiple writes
                // within one filesystem clock tick. Recheck actual membership
                // before claiming a complete inventory for task deduplication.
                const currentNames = (await fs.promises.readdir(project.directory, { withFileTypes: true })).filter(entry => entry.name.endsWith('.jsonl'));
                const membersMatch = currentNames.length === names.length
                    && currentNames.every(entry => entry.isFile() && present.has(path.join(project.directory, entry.name)));
                const after = fs.lstatSync(project.directory, { bigint: true });
                stable = membersMatch && after.isDirectory() && fingerprint(after) === fingerprint(directoryBefore)
                    && fs.realpathSync.native(project.directory) === project.directory;
            } else stable = !fs.existsSync(project.directory);
            for (const [filename, record] of project.files) {
                try {
                    const now = fs.lstatSync(filename, { bigint: true });
                    if (!now.isFile() || fingerprint(now) !== fingerprint(record.stat)
                        || !fileIo.sameIdentityAtPath(filename, record.identity ?? null)) { project.files.delete(filename); stable = false; }
                } catch { project.files.delete(filename); stable = false; }
            }
            project.complete = stable && indexed && bodiesComplete;
        } catch (error) {
            project.outboundRead = null;
            if (error.code === 'TASK_METADATA_LIMIT') {
                // A failed cache must not survive to accumulate another batch on
                // each refresh. Native files remain the recovery source.
                project.files.clear(); project.metadataBytes = 0;
                clearTimeout(project.timer); project.timer = null;
            }
            project.error = error.code?.startsWith('TASK_') ? error : failure('TASK_SCAN_FAILED', 'Task directory could not be verified; retry after the session files settle');
            throw project.error;
        }
    }
    readOutboundBodies(project, delivered, allowance, started) {
        for (const source of project.files.values()) for (const [id, location] of source.outboxLocations) {
            const expected = source.outbox.get(id);
            if (delivered.has(id) || expected.text !== undefined) continue;
            if (allowance <= 0 || Date.now() - started >= this.limits.milliseconds) return false;
            if (project.metadataBytes + location.bytes > this.limits.metadataBytes)
                throw failure('TASK_METADATA_LIMIT', 'Pending message bodies exceed the cache budget');
            let pending = project.outboundRead;
            if (!pending || pending.source !== source || pending.id !== id) {
                pending = project.outboundRead = { source, id, phase: 'header', reader: {
                    path: source.path, stat: source.stat, identity: source.identity, position: 0, linePosition: 0, parts: [], pendingBytes: 0,
                    endPosition: source.headerEndPosition, header: null, complete: false, selectOutboundId: id
                } };
            }
            const reader = pending.reader;
            while (allowance > 0 && Date.now() - started < this.limits.milliseconds) {
                const bytes = this.readBatch(project, reader, allowance, started); allowance -= bytes;
                if (reader.complete) {
                    if (pending.phase === 'header') {
                        if (reader.header.id !== source.header.id || reader.header.cwd !== project.cwd)
                            throw failure('TASK_CHANGED', 'Outbound message source changed during recovery');
                        pending.phase = 'body'; reader.position = reader.linePosition = location.position;
                        reader.endPosition = location.position + location.length; reader.complete = false;
                    } else {
                        const message = reader.selectedOutbound;
                        if (!message || typeof message.text !== 'string'
                            || createHash('sha256').update(message.text).digest('hex') !== expected.textHash
                            || JSON.stringify({ ...message, text: undefined }) !== JSON.stringify(outboundMessage(expected)))
                            throw failure('TASK_CHANGED', 'Outbound message changed during recovery');
                        source.outbox.set(id, { ...expected, text: message.text });
                        project.metadataBytes += location.bytes;
                        project.outboundRead = null;
                        break;
                    }
                } else if (!bytes) break;
            }
            if (project.outboundRead) return false;
        }
        project.outboundRead = null;
        return true;
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
            const endPosition = record.endPosition ?? Number(stat.size);
            while (record.position < endPosition && bytes < allowance && Date.now() - started < this.limits.milliseconds) {
                const buffer = Buffer.alloc(Math.min(65536, allowance - bytes, endPosition - record.position));
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
                    record.linePosition = record.position - count + end + 1;
                    record.parts = []; record.pendingBytes = 0; from = end + 1;
                }
                append(buffer.subarray(from, count));
            }
            const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(record.path, { bigint: true });
            if (!current.isFile() || fingerprint(after) !== fingerprint(stat) || fingerprint(current) !== fingerprint(stat)
                || !fileIo.sameIdentityAtPath(record.path, identity) || descriptorPathSync(fd) !== actual
                || fs.realpathSync.native(record.path) !== actual) throw failure('TASK_CHANGED', 'Session changed during task discovery; retry');
            if (record.position === endPosition) {
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
            record.header = { id: entry.id, cwd, rawCwd: entry.cwd };
            record.headerEndPosition = record.linePosition + buffer.length + 1; return;
        }
        if (entry.type === 'message' && entry.id === record.selectEntryId && entry.message?.role === 'assistant') {
            record.selectedLocation = { position: record.linePosition, length: buffer.length + 1 };
            const content = entry.message.content;
            record.selectedText = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
                .filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
        }
        // Located readers retain only the selected payload, never rebuild an
        // unbounded metadata cache while walking unrelated native history.
        if (record.selectOutboundId) {
            if (entry.type === 'custom' && entry.customType === MESSAGE_OUT && entry.data?.messageId === record.selectOutboundId)
                record.selectedOutbound = outboundMessage(entry.data, record.header);
            return;
        }
        if (record.selectEntryId) return;
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
        if (!record.preview && (entry.type === 'message' && entry.message?.role === 'user'
            || entry.type === 'custom_message' && customTypeIs(entry, 'pivane-agent-task-message'))) {
            const content = entry.type === 'message' ? entry.message.content : entry.content;
            const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
                .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ');
            record.preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        if (entry.type === 'custom' && customTypeIs(entry, 'pivane-extension-assistant')) record.special = 'pivane-extension-assistant';
        if (entry.type === 'custom' && customTypeIs(entry, 'pivane-profile-authoring')) record.special = 'pivane-profile-authoring';
        if (entry.type === 'custom' && entry.customType === MESSAGE_OUT) {
            const message = outboundMessage(entry.data, record.header);
            if (message) {
                const textHash = typeof message.text === 'string' ? createHash('sha256').update(message.text).digest('hex') : undefined;
                const metadata = { ...message, text: undefined, textHash };
                record.outbox.set(message.messageId, metadata); record.outboxLocations.delete(message.messageId);
                if (typeof message.text === 'string') record.outboxLocations.set(message.messageId, {
                    position: record.linePosition, length: buffer.length + 1,
                    bytes: Buffer.byteLength(JSON.stringify({ ...metadata, text: message.text })) - Buffer.byteLength(JSON.stringify(metadata))
                });
            }
        }
        if (entry.type === 'custom_message' && entry.customType === MESSAGE_IN && typeof entry.details?.messageId === 'string'
            && /^[a-f0-9]{64}$/.test(entry.details.messageId)) record.inbox.add(entry.details.messageId);
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
        const location = this.replyLocations.get(JSON.stringify([source.path, entryId]));
        const located = location && location.revision === fingerprint(source.stat) && location.identity === source.identity;
        const record = { path: source.path, stat: source.stat, identity: source.identity, position: 0, linePosition: 0, parts: [], pendingBytes: 0,
            endPosition: located ? source.headerEndPosition : undefined,
            header: null, task: null, state: null, results: new Map(), receipts: new Set(), read: new Set(), selectEntryId: entryId,
            preview: '', special: null, outbox: new Map(), inbox: new Set() };
        const started = Date.now();
        while (record.selectedText === undefined && !record.complete) {
            if (this.stopping || this.suspended() || Date.now() - started > 20000) throw failure('TASK_RESULT_LIMIT', 'Result reading stopped; retry with the same task and result identifiers');
            this.readBatch(project, record, this.limits.batchBytes, Date.now());
            // Re-read the native header even with a location hint. Only the long
            // intervening history is skipped, never the requested session proof.
            if (located && record.complete && record.position === source.headerEndPosition) {
                if (record.header.id !== sessionId || record.header.cwd !== project.cwd) throw failure('TASK_RESULT_MISSING', 'Original task reply is no longer available');
                record.position = record.linePosition = location.position;
                record.endPosition = location.position + location.length; record.complete = false;
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        // The event-loop yield above may allow a writer or maintenance to run.
        if (this.stopping || this.suspended() || Date.now() - started > 20000) throw failure('TASK_RESULT_LIMIT', 'Result reading stopped; retry with the same task and result identifiers');
        this.readBatch(project, record, 0, Date.now());
        if (record.header?.id !== sessionId || record.header.cwd !== project.cwd || record.selectedText === undefined) throw failure('TASK_RESULT_MISSING', 'Original task reply is no longer available');
        // Preserve readReply's batch selection, including the last matching ID
        // within that batch. Discovery and reads of other entries never choose it.
        const key = JSON.stringify([source.path, entryId]);
        const selected = { ...record.selectedLocation, revision: fingerprint(record.stat), identity: record.identity };
        const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(selected)) + 64;
        const previous = this.replyLocations.get(key);
        if (previous) { this.replyLocationBytes -= previous.bytes; this.replyLocations.delete(key); }
        // Commit only after final proof. Eviction falls back to native scanning;
        // this bounded cache contains no reply body or independent conversation.
        if (bytes <= this.limits.replyLocationBytes) {
            while (this.replyLocationBytes + bytes > this.limits.replyLocationBytes) {
                const oldest = this.replyLocations.keys().next().value;
                this.replyLocationBytes -= this.replyLocations.get(oldest).bytes; this.replyLocations.delete(oldest);
            }
            this.replyLocations.set(key, { ...selected, bytes }); this.replyLocationBytes += bytes;
        }
        const text = record.selectedText.slice(offset, offset + 8000);
        return { entryId, text, offset, nextOffset: offset + text.length < record.selectedText.length ? offset + text.length : null, totalCharacters: record.selectedText.length };
    }
    async dispose() {
        this.stopping = true;
        for (const project of this.projects.values()) clearTimeout(project.timer);
        await Promise.allSettled([...this.reads, ...[...this.projects.values()].flatMap(p => [p.flight, p.ready]).filter(Boolean)]);
        this.projects.clear(); this.replyLocations.clear(); this.replyLocationBytes = 0;
    }
}
module.exports = { TaskCatalog, LIMITS };
