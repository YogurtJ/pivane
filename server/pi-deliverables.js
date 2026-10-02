const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { fileScope, fileError, fail } = require('./pi-file-scope');
const { readVerifiedFile } = require('./pi-file-bytes');
const { MAX_FILE_BYTES, representation } = require('./pi-file-types');
const { privateDir, atomicJson } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');
const { withinCanonical, windowsPath } = require('./pi-platform-path');
const { activeBranch } = require('./pi-message-payload');
const ENTRY = 'pivane-deliverable';
const idPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = () => fail('交付参数无效', 400, 'DELIVERY_INPUT');
function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(k => !['requestId', 'title', 'files', 'sourceRoot'].includes(k))
        || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.requestId)
        || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160
        || !Array.isArray(input.files) || !input.files.length || input.files.length > 20
        || input.files.some(file => typeof file !== 'string' || !file.trim() || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file))
        || new Set(input.files).size !== input.files.length
        || input.sourceRoot !== undefined && (typeof input.sourceRoot !== 'string' || !path.isAbsolute(input.sourceRoot) || input.sourceRoot.length > 4096)) throw invalid();
    return { requestId: input.requestId, title: input.title.trim(), files: input.files, sourceRoot: input.sourceRoot };
}
function references(branch) {
    const found = new Map();
    for (const entry of branch) {
        const data = entry.type === 'custom' && entry.customType === ENTRY && entry.data;
        if (data?.version === 1 && idPattern.test(data.id) && idPattern.test(data.manifestRevision)) found.set(data.id, data);
    }
    if (found.size > 500) throw fail('交付记录超过读取预算', 413, 'DELIVERY_LIMIT');
    return [...found.values()].reverse();
}
class DeliverableStore {
    constructor(store) { this.store = store; this.jobs = new Set(); }
    async root(create = false) {
        const { getAgentDir } = await getSdk();
        const root = path.join(fs.realpathSync.native(getAgentDir()), 'pivane-deliverables');
        if (create) return privateDir(root);
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) throw fail('交付存储位置无效', 409, 'DELIVERY_CHANGED');
        return root;
    }
    async readObject(root, file, limit) {
        return readVerifiedFile(file, { maxBytes: limit, check: actual => {
            if (!withinCanonical(root, actual)) throw fail('交付文件位置已变化', 409, 'DELIVERY_CHANGED');
        } });
    }
    async manifest(id, expected) {
        if (!idPattern.test(id)) throw invalid();
        const root = await this.root();
        const file = await this.readObject(root, path.join(root, id, 'manifest.json'), 128 * 1024);
        if (expected && file.revision !== expected) throw fail('交付清单已变化', 409, 'DELIVERY_CHANGED');
        const manifest = JSON.parse(file.bytes.toString('utf8'));
        if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20
            || manifest.files.some((f, i) => f.index !== i || !idPattern.test(f.revision) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES
                || typeof f.name !== 'string' || typeof f.sourcePath !== 'string')) throw fail('交付清单无效', 409, 'DELIVERY_CHANGED');
        return { manifest, revision: file.revision };
    }
    async publish(context, raw, signal) {
        const input = validate(raw);
        const cwd = this.store.resolveProject(context.cwd);
        if (typeof context.sessionId !== 'string' || !context.sessionId) throw invalid();
        const id = digest(JSON.stringify([cwd, context.sessionId, input.requestId]));
        if (this.jobs.has(id)) throw fail('此交付正在登记，请稍后核对同一 requestId', 409, 'DELIVERY_BUSY');
        if (this.jobs.size >= 2) throw fail('交付登记额度已满，请稍后再试', 429, 'DELIVERY_BUSY');
        this.jobs.add(id);
        try {
            signal?.throwIfAborted();
            const requestHash = digest(JSON.stringify(input));
            try {
                const existing = await this.manifest(id);
                if (existing.manifest.requestHash !== requestHash) throw fail('requestId 已用于不同交付，请核对原记录', 409, 'DELIVERY_CONFLICT');
                // Idempotence never silently republishes damaged/missing objects.
                for (const file of existing.manifest.files) await this.content({ id, manifestRevision: existing.revision }, file.index);
                return this.receipt(existing);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const scope = await fileScope(this.store, input.sourceRoot || cwd);
            // An external root must be explicitly supplied, never inferred from a link.
            const files = []; let total = 0;
            for (const source of input.files) {
                signal?.throwIfAborted();
                if (process.platform !== 'win32' && source.includes('\\')) throw invalid();
                let native; try { native = windowsPath(source); } catch { throw invalid(); }
                const requested = path.resolve(scope.cwd, native);
                const file = await readVerifiedFile(requested, { check: scope.check, maxBytes: MAX_FILE_BYTES });
                total += file.size;
                if (total > 64 * 1024 * 1024) throw fail('一组交付超过 64 MiB 限制', 413, 'DELIVERY_LIMIT');
                files.push({ ...file, requested });
            }
            signal?.throwIfAborted();
            const root = await this.root(true), directory = path.join(root, id);
            // An unfinished directory is retained as evidence, never overwritten or
            // automatically replayed after an uncertain publication.
            try { fs.mkdirSync(directory, { mode: 0o700 }); }
            catch (error) { if (error.code === 'EEXIST') throw fail('交付登记未完成，请检查原 requestId；未重放', 409, 'DELIVERY_INCOMPLETE'); throw error; }
            privateDir(directory);
            const manifest = { version: 1, id, requestHash, title: input.title, cwd, sessionId: context.sessionId,
                createdAt: new Date().toISOString(), files: files.map((file, index) => ({ index, name: path.basename(file.absolutePath),
                    sourcePath: file.absolutePath, requestedPath: file.requested, size: file.size, revision: file.revision, modifiedAt: file.modifiedAt })) };
            files.forEach((file, i) => writePrivateFileSync(path.join(directory, `${i}.bin`), file.bytes, true));
            atomicJson(path.join(directory, 'manifest.json'), manifest);
            return this.receipt(await this.manifest(id));
        } catch (error) { throw error.status ? error : fileError(error); }
        finally { this.jobs.delete(id); }
    }
    receipt({ manifest, revision }) {
        return { reference: { version: 1, id: manifest.id, manifestRevision: revision }, title: manifest.title,
            files: manifest.files.map(file => ({ name: file.name, size: file.size, revision: file.revision,
                href: `#pi-delivery=${manifest.id}/${file.index}` })) };
    }
    async content(reference, index) {
        const { manifest } = await this.manifest(reference.id, reference.manifestRevision);
        const item = manifest.files[index];
        if (!item || item.index !== index) throw fail('交付文件不存在', 404, 'DELIVERY_MISSING');
        const root = await this.root();
        const file = await this.readObject(root, path.join(root, reference.id, `${index}.bin`), MAX_FILE_BYTES);
        if (file.revision !== item.revision || file.size !== item.size) throw fail('交付文件已变化，拒绝展示', 409, 'DELIVERY_CHANGED');
        return { ...representation(file, item.name), absolutePath: item.sourcePath, path: item.name, name: item.name,
            deliveryId: manifest.id, index, createdAt: manifest.createdAt, title: manifest.title, source: 'delivery' };
    }
}
class DeliverableService {
    constructor({ store, supervisor }) { this.store = store; this.supervisor = supervisor; this.objects = new DeliverableStore(store); this.reading = 0; }
    async branch(input) {
        if (typeof input.cwd !== 'string' || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 160) throw invalid();
        const session = await this.store.getSession(input.cwd, input.sessionId);
        const worker = this.supervisor.getActiveWorker(session.path);
        if (worker) {
            if (worker.disposed || worker.restarting || worker.sessionId !== session.id || worker.cwd !== session.cwd) throw fail('会话运行身份已变化', 409, 'DELIVERY_CONTEXT');
            const snapshot = await worker.request('get_entries');
            if (worker !== this.supervisor.getActiveWorker(session.path) || worker.disposed) throw fail('会话连接已变化', 409, 'DELIVERY_CONTEXT');
            return { session, refs: references(activeBranch(snapshot)) };
        }
        if (fs.statSync(session.path).size > 128 * 1024 * 1024) throw fail('会话超过交付索引读取预算', 413, 'DELIVERY_LIMIT');
        const { SessionManager } = await getSdk();
        const manager = this.store.profileManager(session, SessionManager);
        return { session, refs: references(manager.getBranch()) };
    }
    async request(input) {
        if (!input || Object.keys(input).some(k => !['cwd', 'sessionId', 'id', 'index', 'path'].includes(k))
            || (input.id === undefined) !== (input.index === undefined) || input.id !== undefined && input.path !== undefined) throw invalid();
        if (this.reading >= 4) throw fail('交付读取正在进行，请稍后再试', 429, 'FILE_BUSY');
        this.reading++;
        try {
            const initial = await this.branch(input);
            if (input.id !== undefined) {
                const index = Number(input.index);
                if (!idPattern.test(input.id) || !/^\d{1,2}$/.test(String(input.index)) || index >= 20) throw invalid();
                const ref = initial.refs.find(r => r.id === input.id);
                if (!ref) throw fail('此交付不在当前会话分支内', 403, 'DELIVERY_SCOPE');
                const saved = await this.objects.manifest(ref.id, ref.manifestRevision);
                const proof = this.store.sessionMoves ? await this.store.sessionMoves.deliveryProof(initial.session) : new Map([[initial.session.cwd, null]]);
                const allowed = proof.get(saved.manifest.cwd);
                if (allowed !== null && !allowed?.has(ref.id + ':' + ref.manifestRevision)) throw fail('交付不属于当前项目', 403, 'DELIVERY_SCOPE');
                const result = await this.objects.content(ref, index);
                const current = await this.branch(input);
                if (current.session.path !== initial.session.path || !current.refs.some(r => r.id === ref.id && r.manifestRevision === ref.manifestRevision)) throw fail('会话分支已变化', 409, 'DELIVERY_CONTEXT');
                return result;
            }
            const items = [];
            if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length > 4096 || /[\x00-\x1f\x7f]/.test(input.path))) throw invalid();
            const target = input.path === undefined ? null : path.resolve(initial.session.cwd, input.path);
            const proof = this.store.sessionMoves ? await this.store.sessionMoves.deliveryProof(initial.session) : new Map([[initial.session.cwd, null]]);
            for (const ref of initial.refs) {
                try {
                    const { manifest } = await this.objects.manifest(ref.id, ref.manifestRevision);
                    const allowed = proof.get(manifest.cwd);
                    if (allowed !== null && !allowed?.has(ref.id + ':' + ref.manifestRevision)) throw fail('交付不属于当前项目', 403, 'DELIVERY_SCOPE');
                    for (const file of manifest.files) {
                        if (target && file.sourcePath !== target && file.requestedPath !== target) continue;
                        items.push({ id: ref.id, index: file.index, name: file.name, title: manifest.title, size: file.size,
                            createdAt: manifest.createdAt, sourcePath: file.sourcePath, revision: file.revision });
                        if (target || items.length >= 200) break;
                    }
                } catch (error) { if (target) continue; items.push({ id: ref.id, unavailable: true, name: '交付文件暂不可用' }); }
                if (target && items.length || items.length >= 200) break;
            }
            const current = await this.branch(input), allowed = new Set(current.refs.map(r => `${r.id}:${r.manifestRevision}`));
            if (current.session.path !== initial.session.path || initial.refs.some(r => !allowed.has(`${r.id}:${r.manifestRevision}`))) throw fail('会话分支已变化', 409, 'DELIVERY_CONTEXT');
            return { items, partial: items.length >= 200 };
        } catch (error) { throw error.status ? error : fileError(error); }
        finally { this.reading--; }
    }
}
module.exports = { ENTRY, validate, references, DeliverableStore, DeliverableService };
