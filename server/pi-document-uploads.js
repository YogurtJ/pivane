const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const { getSdk } = require('./pi-session-store');
const { privateDir, atomicJson } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');
const { readVerifiedFile } = require('./pi-file-bytes');
const { withinCanonical } = require('./pi-platform-path');
const { fail } = require('./pi-file-scope');
const { activeBranch } = require('./pi-message-payload');
const refs = require('../public/pi-document-references');
const { DocumentParserPool } = require('./pi-document-pool');
const { validateRead } = require('./pi-document-parser');
const MAX_BYTES = 20 * 1024 * 1024, MAX_FILE_BYTES = 100 * 1024 * 1024, MAX_STORAGE = 2 * 1024 ** 3, MAX_SESSION_BYTES = 256 * 1024 ** 2;
const digest = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{64}$/;
const invalid = () => fail('文档附件参数无效', 400, 'DOCUMENT_INPUT');
function uploadInput(raw) {
    if (!raw || Object.keys(raw).some(key => !['cwd', 'sessionId', 'requestId', 'name', 'purpose'].includes(key))
        || typeof raw.cwd !== 'string' || raw.cwd.length > 4096 || typeof raw.sessionId !== 'string' || !raw.sessionId || raw.sessionId.length > 160
        || typeof raw.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(raw.requestId)
        || typeof raw.name !== 'string' || !raw.name || raw.name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(raw.name)) throw invalid();
    if (raw.purpose !== undefined && raw.purpose !== 'image') throw invalid();
    const extension = raw.name.split('.').at(-1).toLowerCase();
    const format = raw.purpose === 'image' ? 'image' : ['docx', 'xlsx', 'pptx', 'pdf'].includes(extension) ? extension : 'file';
    return { ...raw, format };
}
class DocumentUploads {
    constructor({ store, supervisor, isSuspended = () => false, root, pool, protectedDocuments, storageGuard, scanMaxBytes } = {}) {
        Object.assign(this, { store, supervisor, isSuspended, storageRoot: root });
        this.pool = pool || new DocumentParserPool(); this.operations = new Set(); this.writing = false; this.closed = false;
        this.storage = new (require('./pi-document-storage').DocumentStorage)(this, { protectedDocuments, storageGuard, scanMaxBytes });
    }
    get active() { return this.operations.size + this.pool.jobs.size; }
    reserve() {
        this.storage.assertAvailable();
        if (!require('./pi-file-descriptor').descriptorBackendAvailable()) throw fail('文档文件校验组件不可用', 503, 'DOCUMENT_PARSER');
        if (this.closed || this.isSuspended()) throw fail('文档服务正在维护，请稍后再试', 503, 'DOCUMENT_BUSY');
        if (this.operations.size >= 2) throw fail('文档附件正在处理，请稍后再试', 429, 'DOCUMENT_BUSY');
        let release;
        const job = { promise: new Promise(resolve => { release = resolve; }) }; this.operations.add(job);
        return () => { this.operations.delete(job); release(); };
    }
    async root(create = false) {
        const agent = fs.realpathSync.native((await getSdk()).getAgentDir());
        const root = this.storageRoot || path.join(agent, 'pivane-uploads');
        if (create) { if (privateDir(root) !== root) throw fail('文档存储位置已变化', 409, 'DOCUMENT_CHANGED'); }
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) throw fail('文档存储位置已变化', 409, 'DOCUMENT_CHANGED');
        return root;
    }
    async object(id) {
        if (!idPattern.test(id)) throw invalid();
        const root = await this.root();
        this.checkDeleted(root, id);
        const folder = path.join(root, id), stat = fs.lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(folder) !== folder) throw fail('文档存储位置已变化', 409, 'DOCUMENT_CHANGED');
        const check = actual => { if (!withinCanonical(folder, actual)) throw fail('文档文件位置已变化', 409, 'DOCUMENT_CHANGED'); };
        const metadata = await readVerifiedFile(path.join(folder, 'manifest.json'), { check, maxBytes: 8192 });
        const manifest = JSON.parse(metadata.bytes.toString('utf8'));
        if (manifest.version !== 1 || !refs.valid(manifest.reference) || manifest.reference.id !== id
            || typeof manifest.cwd !== 'string' || typeof manifest.sessionId !== 'string' || typeof manifest.requestId !== 'string') throw fail('文档清单无效', 409, 'DOCUMENT_CHANGED');
        return { folder, check, manifest };
    }
    async bytes(object) {
        const content = await readVerifiedFile(path.join(object.folder, 'original'), { check: object.check, maxBytes: MAX_FILE_BYTES });
        if (content.revision !== object.manifest.reference.revision || content.size !== object.manifest.reference.size) throw fail('文档原件已变化', 409, 'DOCUMENT_CHANGED');
        return content.bytes;
    }
    async session(input) {
        if (typeof input.cwd !== 'string' || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 160) throw invalid();
        const session = await this.store.getSession(input.cwd, input.sessionId);
        if (this.supervisor.removing.has(session.path) || this.supervisor.moving.has(session.path)) throw fail('会话正在删除或移动', 409, 'DOCUMENT_CONTEXT');
        return session;
    }
    checkDeleted(root, id) {
        const directory = path.join(root, '.storage-deleted');
        if (!fs.existsSync(directory)) return;
        require('./pi-document-storage-references').prove(directory, true);
        if (fs.existsSync(path.join(directory, id + '.json'))) throw fail('此上传已清理，请为新上传使用新的标识', 410, 'DOCUMENT_DELETED');
    }
    async upload(raw, bytes, { reserved = false } = {}) {
        const leave = reserved ? null : this.reserve();
        try { return await this.uploadChecked(raw, bytes); } finally { leave?.(); }
    }
    async uploadChecked(raw, bytes) {
        const input = uploadInput(raw);
        const maximum = ['file', 'image'].includes(input.format) ? MAX_FILE_BYTES : MAX_BYTES;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximum) throw fail(`单个附件须为非空文件且不超过 ${maximum / 1024 / 1024} MiB`, 413, 'DOCUMENT_LIMIT');
        const session = await this.session(input), id = digest(JSON.stringify([session.cwd, session.id, input.requestId]));
        const reference = { id, revision: digest(bytes), name: input.name, format: input.format, size: bytes.length };
        try {
            const existing = await this.object(id);
            if (refs.marker(existing.manifest.reference) !== refs.marker(reference)) throw fail('此 requestId 已用于不同文件，请核对原上传', 409, 'DOCUMENT_CONFLICT');
            await this.bytes(existing); return { reference, marker: refs.marker(reference), reused: true };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Office/PDF keep their parser validation; general files remain opaque originals.
        if (!['file', 'image'].includes(input.format)) await this.pool.run(bytes, input.format, {}, { validateOnly: true });
        if (input.format === 'image') require('./pi-image-context').decodeImage({ data: bytes.toString('base64') }, '新上传');
        const current = await this.session(input);
        if (session.path !== current.path || session.cwd !== current.cwd || this.closed || this.isSuspended()) throw fail('会话已变化，原上传未提交', 409, 'DOCUMENT_CONTEXT');
        if (this.writing) throw fail('文档附件正在保存，请稍后再试', 429, 'DOCUMENT_BUSY');
        this.writing = true;
        try {
            const root = await this.root(true);
            this.checkDeleted(root, id);
            // Recheck after validation: two concurrent calls with the same stable
            // requestId may finish out of order. Never overwrite published bytes.
            if (fs.existsSync(path.join(root, id))) {
                const existing = await this.object(id);
                if (refs.marker(existing.manifest.reference) !== refs.marker(reference)) throw fail('上传标识冲突', 409, 'DOCUMENT_CONFLICT');
                await this.bytes(existing); return { reference, marker: refs.marker(reference), reused: true };
            }
            let total = 0, sessionTotal = 0;
            const names = fs.readdirSync(root).filter(name => {
                if (['.storage-deleted', '.storage-receipts'].includes(name)) {
                    require('./pi-document-storage-references').prove(path.join(root, name), true); return false;
                }
                return true;
            });
            if (names.length >= 10000) throw fail('文档存储项数已达上限', 413, 'DOCUMENT_STORAGE');
            for (const name of names) {
                if (name.startsWith('.upload-')) {
                    const temporary = path.join(root, name), stat = fs.lstatSync(temporary);
                    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(temporary) !== temporary) throw fail('文档临时存储位置已变化', 409, 'DOCUMENT_CHANGED');
                    const original = path.join(temporary, 'original');
                    if (fs.existsSync(original)) total += (await readVerifiedFile(original, { maxBytes: MAX_FILE_BYTES, check: actual => {
                        if (!withinCanonical(temporary, actual)) throw fail('文档临时存储位置已变化', 409, 'DOCUMENT_CHANGED');
                    } })).size;
                    continue;
                }
                if (!idPattern.test(name)) throw fail('文档存储包含未识别项目', 409, 'DOCUMENT_CHANGED');
                const object = await this.object(name);
                total += object.manifest.reference.size;
                if (object.manifest.cwd === session.cwd && object.manifest.sessionId === session.id) sessionTotal += object.manifest.reference.size;
            }
            if (total + bytes.length > MAX_STORAGE || sessionTotal + bytes.length > MAX_SESSION_BYTES) throw fail('文档存储额度已满（每线程 256 MiB，实例 2 GiB），请通过附件管理整理', 413, 'DOCUMENT_STORAGE');
            // No await between final identity checks and private, exclusive writes.
            await this.session(input);
            if (this.closed || this.isSuspended()) throw fail('文档服务正在关闭', 503, 'DOCUMENT_BUSY');
            const temporary = path.join(root, '.upload-' + require('node:crypto').randomUUID());
            const folder = privateDir(temporary);
            try {
                writePrivateFileSync(path.join(folder, 'original'), bytes, true);
                atomicJson(path.join(folder, 'manifest.json'), { version: 1, cwd: session.cwd, sessionId: session.id, requestId: input.requestId, createdAt: new Date().toISOString(), reference });
                fs.renameSync(folder, path.join(root, id));
                if (process.platform !== 'win32') { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
            } finally {
                // Only our unpublished temporary directory may be removed.
                if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
            }
            return { reference, marker: refs.marker(reference), reused: false };
        } finally { this.writing = false; }
    }
    async branch(input) {
        const session = await this.session(input), worker = this.supervisor.getActiveWorker(session.path);
        if (worker) {
            if (worker.disposed || worker.restarting || worker.sessionId !== session.id || worker.cwd !== session.cwd) throw fail('会话运行身份已变化', 409, 'DOCUMENT_CONTEXT');
            const snapshot = await worker.request('get_entries');
            if (worker !== this.supervisor.getActiveWorker(session.path) || worker.disposed) throw fail('会话连接已变化', 409, 'DOCUMENT_CONTEXT');
            return { session, references: refs.references(activeBranch(snapshot)), worker };
        }
        if (fs.statSync(session.path).size > 128 * 1024 ** 2) throw fail('会话超过文档引用读取预算', 413, 'DOCUMENT_LIMIT');
        const { SessionManager } = await getSdk();
        return { session, references: refs.references(this.store.profileManager(session, SessionManager).getBranch()) };
    }
    async authorized(input, { draft = false } = {}) {
        const initial = await this.branch(input), object = await this.object(input.id);
        const ref = object.manifest.reference;
        const attached = initial.references.some(item => refs.marker(item) === refs.marker(ref));
        const ownUpload = draft && object.manifest.cwd === initial.session.cwd && object.manifest.sessionId === initial.session.id;
        const access = !attached && !ownUpload && draft ? await require('./pi-session-fork-access').readForkAccess(this.store, initial.session) : null;
        const inheritedDraft = access?.documents.some(item => refs.marker(item) === refs.marker(ref));
        if (!attached && !ownUpload && !inheritedDraft) throw fail('文档附件不属于当前会话分支', 403, 'DOCUMENT_SCOPE');
        const bytes = await this.bytes(object);
        return { initial, object, bytes, reference: ref, attached, draftRevision: inheritedDraft ? access.revision : null };
    }
    async checkCurrent(input, authorized) {
        if (authorized.draftRevision) {
            const access = await require('./pi-session-fork-access').readForkAccess(this.store, authorized.initial.session);
            if (access?.revision !== authorized.draftRevision || !access.documents.some(ref => refs.marker(ref) === refs.marker(authorized.reference)))
                throw fail('文档草稿来源已变化，请重新读取', 409, 'DOCUMENT_CONTEXT');
        }
        const current = await this.branch(input);
        if (current.session.path !== authorized.initial.session.path || current.worker !== authorized.initial.worker
            || authorized.attached && !current.references.some(ref => refs.marker(ref) === refs.marker(authorized.reference))) throw fail('会话分支已变化，请重新读取', 409, 'DOCUMENT_CONTEXT');
    }
    async read(worker, raw, signal, { reserved = false } = {}) {
        if (!worker || worker.disposed || worker.restarting || worker.noSession) throw fail('需要活跃的持久线程', 403, 'DOCUMENT_CONTEXT');
        const leave = reserved ? null : this.reserve();
        worker.documentReads = (worker.documentReads || 0) + 1;
        try { return await this.readChecked(worker, raw, signal); }
        finally { worker.documentReads--; leave?.(); }
    }
    async readChecked(worker, raw, signal) {
        if (!raw || Object.keys(raw).some(key => !['id', 'action', 'start', 'count', 'sheet', 'column', 'columns'].includes(key)) || !idPattern.test(raw.id)) throw invalid();
        const { id, ...args } = raw;
        if (args.action !== 'materialize') validateRead(args);
        else if (Object.keys(args).some(key => key !== 'action')) throw invalid();
        const input = { cwd: worker.cwd, sessionId: worker.sessionId, id }, authorized = await this.authorized(input);
        if (authorized.initial.worker !== worker) throw fail('会话运行身份已变化', 409, 'DOCUMENT_CONTEXT');
        if (args.action === 'materialize') return require('./pi-attachment-materialize').materialize(this, worker, input, authorized, signal);
        if (['file', 'image'].includes(authorized.reference.format)) throw fail('此附件请用 get_attachment 取得原件，再使用相应工具处理', 415, 'DOCUMENT_FORMAT');
        const result = await this.pool.run(authorized.bytes, authorized.reference.format, args, { signal });
        await this.checkCurrent(input, authorized);
        if (worker.disposed || worker.restarting) throw fail('会话运行身份已变化', 409, 'DOCUMENT_CONTEXT');
        return { reference: authorized.reference, ...result };
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.operations].map(job => job.promise)); await this.pool.dispose(); }
}
function mountDocumentUploads(router, service) {
    require('./pi-document-storage').mountDocumentStorage(router, service.storage);
    const respond = action => async (req, res) => {
        let leave;
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        try { leave = service.reserve(); await action(req, res); }
        catch (error) {
            const missing = ['ENOENT', 'ENOTDIR'].includes(error.code), denied = ['EACCES', 'EPERM', 'ELOOP'].includes(error.code);
            if (!res.headersSent) res.status(error.status || (missing ? 404 : denied ? 403 : 400)).json({
                error: missing ? '文档附件不存在或尚未保存' : denied ? '文档附件不可访问' : error.message,
                code: missing ? 'DOCUMENT_MISSING' : denied ? 'DOCUMENT_SCOPE' : error.code });
        }
        finally { leave?.(); }
    };
    // Admission occurs BEFORE buffering the raw body, with the existing access,
    // Origin/CSRF and maintenance middleware already applied.
    router.post('/uploads', respond(async (req, res) => {
        const input = uploadInput(req.query);
        if (req.is('application/octet-stream') !== 'application/octet-stream') throw fail('上传须使用 application/octet-stream', 415, 'DOCUMENT_INPUT');
        await new Promise((resolve, reject) => express.raw({ type: 'application/octet-stream', limit: ['file', 'image'].includes(input.format) ? MAX_FILE_BYTES : MAX_BYTES, inflate: false })(req, res, error => error ? reject(error) : resolve()));
        res.json(await service.upload(req.query, req.body, { reserved: true }));
    }));
    router.post('/uploads/read', respond(async (req, res) => {
        const worker = req.workspaceIdentity?.kind === 'agent-thread' && req.workspaceIdentity.worker;
        const controller = new AbortController();
        const cancel = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', cancel);
        try { res.json(await service.read(worker, req.body, controller.signal, { reserved: true })); }
        finally { res.removeListener('close', cancel); }
    }));
    router.get('/uploads/status', respond(async (req, res) => {
        if (Object.keys(req.query).some(key => !['cwd', 'sessionId', 'requestId'].includes(key))
            || typeof req.query.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(req.query.requestId)) throw invalid();
        const session = await service.session(req.query), id = digest(JSON.stringify([session.cwd, session.id, req.query.requestId]));
        const object = await service.object(id);
        if (object.manifest.cwd !== session.cwd || object.manifest.sessionId !== session.id || object.manifest.requestId !== req.query.requestId) throw fail('上传标识冲突', 409, 'DOCUMENT_CONFLICT');
        await service.bytes(object);
        res.json({ reference: object.manifest.reference, marker: refs.marker(object.manifest.reference) });
    }));
    router.get('/uploads', respond(async (req, res) => {
        if (Object.keys(req.query).some(key => !['cwd', 'sessionId', 'id'].includes(key))) throw invalid();
        if (!req.query.id) return res.json({ items: (await service.branch(req.query)).references });
        const authorized = await service.authorized(req.query, { draft: true });
        await service.checkCurrent(req.query, authorized);
        res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="document.${authorized.reference.format}"; filename*=UTF-8''${encodeURIComponent(authorized.reference.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
            'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
        res.send(authorized.bytes);
    }));
}
module.exports = { DocumentUploads, mountDocumentUploads, uploadInput, MAX_BYTES, MAX_FILE_BYTES };
