'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { getSdk } = require('./pi-session-store');
const { DeliverableService, references } = require('./pi-deliverables');
const { activeBranch } = require('./pi-message-payload');
const { readVerifiedFile } = require('./pi-file-bytes');
const { representation } = require('./pi-file-types');
const { withinCanonical: within } = require('./pi-platform-path');
const { MEDIA, mediaLocator, LIMITS, verifiedBytes } = require('./pi-artifacts-discovery');
const { decodeSession } = require('./pi-session-relocation');
const fail = (message, status = 400, code = 'ARTIFACT_INPUT') => Object.assign(new Error(message), { status, code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kinds = new Set(['all', 'document', 'image', 'video', 'audio', 'web', 'other']);
const typeOf = name => /\.(png|jpe?g|webp|gif|svg)$/i.test(name) ? 'image' : /\.(mp4|webm|mov)$/i.test(name) ? 'video'
    : /\.(wav|mp3|ogg|flac|m4a)$/i.test(name) ? 'audio' : /\.html?$/i.test(name) ? 'web'
        : /\.(md|markdown|txt|pdf|csv|tsv|docx?|xlsx?|pptx?)$/i.test(name) ? 'document' : 'other';
const safeText = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';

class ArtifactsService {
    constructor({ store, supervisor, preferences, mediaRoot, libraryRoot, isSuspended = () => false, discovery }) {
        Object.assign(this, { store, supervisor, preferences, mediaRoot, isSuspended, discovery });
        this.library = new (require('./pi-artifacts-library').ArtifactLibrary)({ directory: libraryRoot });
        this.management = new (require('./pi-artifacts-management').ArtifactManagement)(this);
        this.snapshots = new Map(); this.locators = new Map(); this.jobs = new Set(); this.stopping = false;
        if (mediaRoot) this.mediaRoot = path.resolve(mediaRoot);
    }
    get busy() { return this.jobs.size > 0; }
    check() { if (this.stopping || this.isSuspended()) throw fail('成果目录暂不可用，请稍后刷新', 503, 'ARTIFACT_SUSPENDED'); }
    async job(action, signal) {
        this.check();
        if (this.jobs.size >= 2) throw fail('成果读取正在进行，请稍后重试', 429, 'ARTIFACT_BUSY');
        let finish; const job = { done: new Promise(resolve => { finish = resolve; }) }; this.jobs.add(job);
        try { signal?.throwIfAborted(); return await action(job); }
        finally { this.jobs.delete(job); finish(); }
    }
    hidden(cwd) { return (this.preferences?.getHiddenProjects?.() || []).includes(cwd); }
    prune() {
        for (const [id, item] of this.snapshots) if (Date.now() - item.at > 120000) this.snapshots.delete(id);
        for (const [id, item] of this.locators) if (Date.now() - item.at > 15 * 60000) this.locators.delete(id);
        while (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value);
        while (this.locators.size > 3000) this.locators.delete(this.locators.keys().next().value);
    }
    async discover(cwd, job, signal) {
        const { getAgentDir } = await getSdk();
        const input = { sessionRoot: path.join(getAgentDir(), 'sessions'), roots: this.store.roots, hidden: this.preferences?.getHiddenProjects?.() || [], cwd, mediaRoot: this.mediaRoot };
        if (this.discovery) return this.discovery(input);
        return new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, 'pi-artifacts-discovery.js'), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 192 } });
            let done = false;
            const finish = (error, value) => {
                if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
                // A timeout is not an idle worker: retain the job until termination.
                void worker.terminate().then(() => error ? reject(error) : resolve(value), () => reject(fail('成果发现进程未正常结束', 503)));
            };
            const cancel = () => finish(fail('成果读取已取消', 499, 'ARTIFACT_ABORTED')); job.cancel = cancel;
            const timer = setTimeout(() => finish(fail('成果发现超时，请缩小项目范围', 503, 'ARTIFACT_TIMEOUT')), 12000);
            signal?.addEventListener('abort', cancel, { once: true });
            worker.once('message', m => finish(m.error ? fail(m.error, 503) : null, m.value));
            worker.once('error', () => finish(fail('成果发现暂时不可用', 503)));
            worker.once('exit', () => finish(fail('成果发现未完成', 503)));
            if (signal?.aborted) cancel();
        });
    }
    qualify(candidate) {
        this.check();
        try { if (this.hidden(candidate.cwd) || this.store.resolveProject(candidate.cwd) !== candidate.cwd) throw new Error('scope'); }
        catch { throw fail('来源项目不可用', 403, 'ARTIFACT_SCOPE'); }
    }
    async session(candidate, budget) {
        this.qualify(candidate);
        await this.store.sessionMoves?.assertAvailable(candidate.cwd, candidate.id);
        const stat = fs.lstatSync(candidate.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes) throw fail('来源会话超出读取预算或已变化', 409, 'ARTIFACT_SOURCE');
        const { SessionManager, getAgentDir } = await getSdk();
        const root = fs.realpathSync.native(path.join(getAgentDir(), 'sessions'));
        if (path.dirname(candidate.path) !== require('./pi-session-relocation').sessionDirectory(path.dirname(root), candidate.cwd)) throw fail('来源会话目录已变化', 409, 'ARTIFACT_SOURCE');
        if (!within(root, candidate.path) || fs.realpathSync.native(candidate.path) !== candidate.path) throw fail('来源会话位置已变化', 409, 'ARTIFACT_SOURCE');
        // Use Pi's in-memory reader over verified immutable bytes. Opening an empty
        // file with SessionManager.open would initialize it; a gallery never writes.
        const remaining = Math.min(LIMITS.fileBytes, budget?.remaining ?? LIMITS.fileBytes);
        const bytes = verifiedBytes(candidate.path, root, remaining, amount => {
            if (!budget) return;
            if (amount > budget.remaining) throw fail('来源读取超过本批预算', 413, 'ARTIFACT_BUDGET');
            budget.remaining -= amount;
        });
        const document = decodeSession(bytes);
        if (document.header.id !== candidate.id || document.header.cwd !== candidate.cwd) throw fail('来源会话身份已变化', 409, 'ARTIFACT_SOURCE');
        const manager = SessionManager.inMemory(candidate.cwd, undefined, document.records);
        await this.store.sessionMoves?.assertAvailable(candidate.cwd, candidate.id);
        this.qualify(candidate);
        return { manager, session: { id: candidate.id, cwd: candidate.cwd, path: candidate.path, name: manager.getSessionName?.() || '' } };
    }
    deliveryService(candidate, maxRefs = 500, budget) {
        // Preserve DeliverableService's before/after native branch, manifest and
        // relocation proofs, but use a bounded exact locator instead of listing
        // every session in the project again for every card.
        const service = new DeliverableService({ store: this.store, supervisor: this.supervisor });
        service.branch = async () => {
            const { manager, session } = await this.session(candidate, budget);
            const worker = this.supervisor.getActiveWorker(session.path);
            const project = branch => { const all = references(branch); service.truncated ||= all.length > maxRefs; return all.slice(0, maxRefs); };
            if (!worker) return { session, refs: project(manager.getBranch()) };
            if (worker.disposed || worker.restarting || worker.cwd !== session.cwd || worker.sessionId !== session.id) throw fail('来源会话正在变化', 409, 'DELIVERY_CONTEXT');
            const entries = await worker.request('get_entries');
            if (worker !== this.supervisor.getActiveWorker(session.path) || worker.disposed || worker.restarting) throw fail('来源会话正在变化', 409, 'DELIVERY_CONTEXT');
            this.qualify(candidate);
            return { session, refs: project(activeBranch(entries)) };
        };
        return service;
    }
    addLocator(value) {
        const key = digest(value.source === 'delivery' ? [value.source, value.candidate.cwd, value.candidate.id, value.deliveryId, value.index, value.revision]
            : [value.source, value.media.kind, value.media.id, value.media.recordRevision]);
        this.locators.delete(key); this.locators.set(key, { ...value, at: Date.now() });
        return key;
    }
    async deliveries(candidate, budget) {
        const service = this.deliveryService(candidate, 40, budget);
        const result = await service.request({ cwd: candidate.cwd, sessionId: candidate.id });
        const groups = new Map(); let unavailable = false;
        for (const file of result.items) {
            if (file.unavailable) { unavailable = true; continue; }
            const key = `${file.id}:${candidate.cwd}:${candidate.id}`;
            if (!groups.has(key)) groups.set(key, { key: '', source: 'delivery', title: safeText(file.title, 160), createdAt: file.createdAt,
                project: { key: digest(candidate.cwd), name: path.basename(candidate.cwd) || candidate.cwd },
                origin: { sessionId: candidate.id }, files: [], types: [], saved: true });
            const item = groups.get(key), kind = typeOf(file.name);
            const locator = { source: 'delivery', candidate, deliveryId: file.id, index: file.index, revision: file.revision };
            const fileKey = this.addLocator(locator);
            item.files.push({ key: fileKey, name: safeText(file.name, 240), kind, size: file.size });
            if (!item.types.includes(kind)) item.types.push(kind);
            item.key ||= fileKey;
        }
        return { items: [...groups.values()], partial: result.partial || unavailable || service.truncated };
    }
    validate(input) {
        if (!input || Object.keys(input).some(k => !['cwd', 'sessionId', 'snapshot', 'offset'].includes(k))) throw fail('成果目录参数无效');
        if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 4096)) throw fail('项目参数无效');
        if (input.sessionId !== undefined && (!input.cwd || typeof input.sessionId !== 'string' || !/^[\w-]{1,160}$/.test(input.sessionId))) throw fail('会话参数无效');
        const cwd = input.cwd ? this.store.resolveProject(input.cwd) : null;
        if (cwd && this.hidden(cwd)) throw fail('项目不可用', 403, 'ARTIFACT_SCOPE');
        const offset = input.offset === undefined ? 0 : Number(input.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > 800) throw fail('成果分页无效');
        if (input.snapshot !== undefined && (typeof input.snapshot !== 'string' || !/^[\w-]{36}$/.test(input.snapshot))) throw fail('成果分页无效');
        if (offset && !input.snapshot) throw fail('请刷新成果目录', 409, 'ARTIFACT_EXPIRED');
        return { cwd, sessionId: input.sessionId || null, offset };
    }
    async list(input, signal) {
        const { cwd, sessionId, offset } = this.validate(input); this.prune();
        return this.job(async job => {
            let snapshot;
            if (input.snapshot) {
                snapshot = this.snapshots.get(input.snapshot);
                if (!snapshot || snapshot.cwd !== cwd || snapshot.sessionId !== sessionId || Date.now() - snapshot.at > 120000) throw fail('成果目录已过期，请刷新', 409, 'ARTIFACT_EXPIRED');
            } else {
                const data = await this.discover(cwd, job, signal);
                snapshot = { id: randomUUID(), at: Date.now(), cwd, sessionId, ...data };
                if (sessionId) snapshot.sessions = snapshot.sessions.filter(s => s.id === sessionId);
                this.snapshots.set(snapshot.id, snapshot); this.prune();
            }
            const items = [], coverage = { ...snapshot.coverage }, budget = { remaining: 96 * 1024 * 1024 }; let end = offset;
            const started = Date.now();
            while (end < snapshot.sessions.length && end < offset + 8) {
                this.check(); signal?.throwIfAborted(); const candidate = snapshot.sessions[end];
                if (budget.remaining <= 0 || Date.now() - started > 3000) break;
                end++;
                try { const result = await this.deliveries(candidate, budget); items.push(...result.items); if (result.partial) coverage.limited = true; }
                catch { coverage.skippedSources++; }
            }
            if (!offset && !cwd) for (const media of snapshot.media) {
                const key = this.addLocator({ source: 'media', media });
                items.push({ key, source: 'media', title: safeText(media.title, 180), createdAt: media.createdAt, project: null, origin: null, saved: false,
                    model: safeText(media.model, 120), types: [media.kind], files: [{ key, name: media.filename, kind: media.kind, size: null }] });
            }
            const projects = [];
            for (const projectCwd of new Set(snapshot.sessions.map(s => s.cwd))) {
                try { this.qualify({ cwd: projectCwd }); projects.push({ key: digest(projectCwd), name: path.basename(projectCwd) || projectCwd, cwd: projectCwd }); }
                catch { coverage.skippedSources++; }
            }
            const eligible = new Set(projects.map(p => p.key));
            this.check(); signal?.throwIfAborted(); this.prune();
            return { items: items.filter(i => !i.project || eligible.has(i.project.key)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), projects,
                snapshot: snapshot.id, nextOffset: end < snapshot.sessions.length ? end : null,
                partial: coverage.limited || coverage.skippedSources > 0, coverage };
        }, signal);
    }
    locator(key) {
        this.prune();
        if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw fail('成果标识无效');
        const locator = this.locators.get(key);
        if (!locator) throw fail('成果链接已过期，请刷新目录后重试', 409, 'ARTIFACT_EXPIRED');
        return locator;
    }
    async mediaBytes(media, maxBytes = 64 * 1024 * 1024) {
        if (!this.mediaRoot) throw fail('媒体库不可用', 404);
        const root = await fs.promises.realpath(this.mediaRoot), history = path.join(root, MEDIA[media.kind][0]);
        if (root !== this.mediaRoot) throw fail('媒体库位置已变化', 409, 'ARTIFACT_SOURCE');
        const check = actual => { if (actual !== history) throw fail('媒体位置已变化', 409, 'ARTIFACT_SOURCE'); };
        const saved = await readVerifiedFile(history, { check, maxBytes: LIMITS.historyBytes });
        const items = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes));
        if (!Array.isArray(items)) throw fail('媒体记录不可用', 409);
        const matches = items.map(raw => mediaLocator(media.kind, raw)).filter(m => m?.id === media.id);
        if (matches.length !== 1 || matches[0].recordRevision !== media.recordRevision || matches[0].filename !== media.filename) throw fail('媒体记录已变化，请刷新目录', 409, 'ARTIFACT_SOURCE');
        const directory = path.join(root, 'public', MEDIA[media.kind][1]);
        if (await fs.promises.realpath(directory) !== directory) throw fail('媒体位置已变化', 409, 'ARTIFACT_SOURCE');
        const file = await readVerifiedFile(path.join(directory, media.filename), { maxBytes,
            check: actual => { if (actual !== path.join(directory, media.filename)) throw fail('媒体位置已变化', 409, 'ARTIFACT_SOURCE'); } });
        const after = await readVerifiedFile(history, { check, maxBytes: LIMITS.historyBytes });
        if (after.revision !== saved.revision || await fs.promises.realpath(this.mediaRoot) !== root) throw fail('媒体记录已变化，请刷新目录', 409, 'ARTIFACT_SOURCE');
        const data = representation(file, media.filename);
        if (media.kind === 'video' && file.bytes.length >= 12 && file.bytes.toString('ascii', 4, 8) === 'ftyp') Object.assign(data, { kind: 'video', mime: 'video/mp4', encoding: 'base64', base64: file.bytes.toString('base64') });
        return data;
    }
    async preview(key, signal, cover = false) {
        return this.job(async () => {
            let data;
            const saved = (await this.library.catalog()).entries.find(e => e.id === key);
            if (saved) {
                if (saved.trashedAt) throw fail('成果已在回收站，请先恢复', 409, 'ARTIFACT_TRASHED');
                data = (await this.library.content(saved, cover)).data;
                const current = (await this.library.catalog()).entries.find(e => e.id === key);
                if (!current || current.trashedAt || current.sha256 !== saved.sha256) throw fail('成果状态已变化，请刷新', 409, 'ARTIFACT_CONFLICT');
                this.check(); signal?.throwIfAborted();
                if (cover && data.kind !== 'image') throw fail('此成果使用格式封面', 415, 'ARTIFACT_COVER');
                return Object.fromEntries(['kind', 'mime', 'encoding', 'content', 'base64', 'width', 'height', 'delimiter', 'size', 'revision', 'readAt', 'modifiedAt', 'previewReason'].filter(k => data[k] !== undefined).map(k => [k, data[k]]));
            }
            const locator = this.locator(key);
            if (locator.source === 'media') data = await this.mediaBytes(locator.media, cover ? 2 * 1024 * 1024 : 64 * 1024 * 1024);
            else {
                const s = locator.candidate;
                data = await this.deliveryService(s).request({ cwd: s.cwd, sessionId: s.id, id: locator.deliveryId, index: String(locator.index) });
                if (data.revision !== locator.revision) throw fail('成果版本已变化，请刷新目录', 409, 'ARTIFACT_SOURCE');
            }
            this.check(); signal?.throwIfAborted();
            if (locator.source === 'delivery') this.qualify(locator.candidate);
            if (data.kind === 'binary' && data.encoding === 'base64' && data.base64) {
                const prefix = Buffer.from(data.base64.slice(0, 16), 'base64');
                if (prefix.length >= 12 && prefix.toString('ascii', 4, 8) === 'ftyp') Object.assign(data, { kind: 'video', mime: 'video/mp4' });
            }
            if (cover && (data.kind !== 'image' || data.size > 2 * 1024 * 1024)) throw fail('此成果使用格式封面', 415, 'ARTIFACT_COVER');
            // Do not expose internal storage/source paths, manifests or parameters.
            const fields = ['kind', 'mime', 'encoding', 'content', 'base64', 'width', 'height', 'delimiter', 'size', 'revision', 'readAt', 'modifiedAt', 'previewReason'];
            return Object.fromEntries(fields.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
        }, signal);
    }
    async origin(key, signal) {
        return this.job(async () => {
            const saved = (await this.library.catalog()).entries.find(e => e.id === key);
            let locator;
            if (saved) {
                if (!saved.origin?.sessionId) throw fail('此成果没有可验证的来源会话', 404, 'ARTIFACT_ORIGIN');
                const o = saved.origin;
                try {
                    const session = await this.store.getSession(o.cwd, o.sessionId);
                    locator = { source: 'delivery', candidate: { cwd: session.cwd, id: session.id, path: session.path }, deliveryId: o.deliveryId, index: o.index, revision: o.revision };
                } catch { throw fail('来源会话已不存在；已保存成果仍可使用', 404, 'ARTIFACT_ORIGIN'); }
            } else locator = this.locator(key);
            if (locator.source !== 'delivery') throw fail('此历史媒体未关联会话', 404, 'ARTIFACT_ORIGIN');
            const s = locator.candidate;
            // Verify the exact reference again, not just session existence. Restrict
            // the list to this ID so old results do not scan 500 manifests.
            const delivery = this.deliveryService(s), branch = delivery.branch;
            delivery.branch = async () => { const state = await branch(); return { ...state, refs: state.refs.filter(r => r.id === locator.deliveryId) }; };
            const result = await delivery.request({ cwd: s.cwd, sessionId: s.id });
            if (!result.items.some(f => f.id === locator.deliveryId && f.index === locator.index && f.revision === locator.revision)) throw fail('来源分支不再包含此成果', 403, 'ARTIFACT_SCOPE');
            this.qualify(s); signal?.throwIfAborted();
            return { cwd: s.cwd, sessionId: s.id };
        }, signal);
    }
    async dispose() {
        this.stopping = true;
        for (const job of this.jobs) job.cancel?.();
        // Keep native reads owned until actual completion, not just cancellation.
        await Promise.all([...this.jobs].map(job => job.done));
        this.snapshots.clear(); this.locators.clear();
    }
}
module.exports = { ArtifactsService, typeOf, artifactKind: typeOf, kinds };
