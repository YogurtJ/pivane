const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { privateDir, atomicJson, readSafe } = require('./pi-maintenance-files');
const { fail } = require('./pi-file-scope');
const { scanReferences, prove, verifyAll, changed, incomplete, deletionResidual } = require('./pi-document-storage-references');
const hex = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const busy = () => fail('附件正在使用或维护，请稍后再试', 409, 'DOCUMENT_BUSY');
const invalid = () => fail('附件管理参数无效', 400, 'DOCUMENT_INPUT');
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function draftIds(ids = []) {
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !hex.test(id))) throw invalid();
    return [...new Set(ids)].sort();
}
class DocumentStorage {
    constructor(uploads, { protectedDocuments, storageGuard, scanMaxBytes } = {}) {
        Object.assign(this, { uploads, protectedDocuments, storageGuard, scanMaxBytes });
        this.busy = false; this.tickets = new Map();
    }
    assertAvailable() { if (this.busy) throw busy(); }
    async operation(action, exclusive = false) {
        this.assertAvailable();
        if (exclusive && (this.uploads.active || this.uploads.writing)) throw busy();
        const leave = this.uploads.reserve();
        if (exclusive) this.busy = true;
        let lease;
        try {
            if (exclusive) {
                if (!this.protectedDocuments || !this.storageGuard?.acquire) throw incomplete();
                // Reservation must be synchronous, before any asynchronous proof.
                lease = this.storageGuard.acquire();
                if (!lease || typeof lease.check !== 'function' || typeof lease.release !== 'function') throw incomplete();
                lease.check();
                await lease.ready?.();
                lease.check();
            }
            return await action(lease);
        } finally { try { lease?.release(); } finally { this.busy = false; leave(); } }
    }
    scope(raw, keys) {
        if (!raw || Object.keys(raw).some(k => !keys.includes(k)) || typeof raw.cwd !== 'string' || raw.cwd.length > 4096) throw invalid();
        return this.uploads.store.resolveProject(raw.cwd);
    }
    async inventory(cwd) {
        let root;
        try { root = await this.uploads.root(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; root = await this.uploads.root(true); }
        const proofs = [];
        for (const name of ['.storage-receipts', '.storage-deleted']) {
            const directory = path.join(root, name);
            if (!fs.existsSync(directory) && privateDir(directory) !== directory) throw changed();
            proofs.push(prove(directory, true));
        }
        proofs.push(prove(root, true));
        const items = [], residuals = [], residualCache = {}; let totalBytes = 0, count = 0;
        const names = fs.readdirSync(root).sort();
        if (names.length > 10002) throw incomplete();
        for (const id of names) {
            if (['.storage-receipts', '.storage-deleted'].includes(id)) continue;
            if (!hex.test(id)) throw incomplete(); // Active or interrupted uploads need manual review.
            const residual = deletionResidual(root, id, residualCache);
            if (residual) {
                proofs.push(...residual.proofs); residuals.push(residual); totalBytes += residual.bytes; count++;
                continue;
            }
            const folder = path.join(root, id); proofs.push(prove(folder, true));
            if (JSON.stringify(fs.readdirSync(folder).sort()) !== JSON.stringify(['manifest.json', 'original'])) throw changed();
            proofs.push(prove(path.join(folder, 'manifest.json')), prove(path.join(folder, 'original')));
            const object = await this.uploads.object(id); await this.uploads.bytes(object);
            totalBytes += object.manifest.reference.size; count++;
            items.push({ object, visible: object.manifest.cwd === cwd });
        }
        verifyAll(proofs);
        return { root, proofs, items, residuals, totalBytes, count, cwd };
    }
    async snapshot(cwd, drafts, lease) {
        const inventory = await this.inventory(cwd); lease?.check();
        const agent = fs.realpathSync.native((await getSdk()).getAgentDir()); lease?.check();
        const native = await scanReferences(agent, new Set(inventory.items.map(i => i.object.manifest.reference.id)), this.scanMaxBytes); lease?.check();
        const external = this.protectedDocuments ? await this.protectedDocuments({ nativeScope: native.scope }) : null; lease?.check();
        if (!external || external.complete !== true || typeof external.revision !== 'string' || !external.revision || !Array.isArray(external.ids)) throw incomplete();
        const ids = draftIds(external.ids); for (const id of [...ids, ...drafts]) native.found.add(id);
        const proofs = [...inventory.proofs, ...native.proofs]; verifyAll(proofs); lease?.check();
        const revision = hash(JSON.stringify([cwd, proofs.map(p => [p.file || p.missing, p.stamp, p.identity, p.names]), external.revision, ids, drafts]));
        this.uploads.store.resolveProject(cwd);
        return { ...inventory, proofs, found: native.found, revision };
    }
    rows(snapshot) {
        return [...snapshot.items.filter(i => i.visible).map(({ object }) => ({ ...object.manifest.reference,
            sessionId: object.manifest.sessionId, createdAt: object.manifest.createdAt,
            savedReference: snapshot.found ? snapshot.found.has(object.manifest.reference.id) ? 'protected' : 'not-found' : 'unverified' })),
        ...snapshot.residuals.filter(item => item.manifest?.cwd === snapshot.cwd).map(({ manifest }) => ({ ...manifest.reference,
            sessionId: manifest.sessionId, createdAt: manifest.createdAt, savedReference: 'unverified', deletionPending: true }))];
    }
    async usage(raw) {
        const cwd = this.scope(raw, ['cwd', 'draftIds']), drafts = draftIds(raw.draftIds);
        return this.operation(async () => {
            let snapshot, warning = null, complete = false;
            try { snapshot = await this.snapshot(cwd, drafts); complete = Boolean(this.storageGuard?.acquire); }
            catch (error) {
                // Capacity remains useful when reference proof is unavailable. No
                // candidate is advertised as deletable under an incomplete scan.
                warning = error.code === 'DOCUMENT_SCAN_INCOMPLETE' ? '无法完整核对保存引用，暂不能清理附件' : '附件或引用正在变化，暂不能清理附件';
                snapshot = await this.inventory(cwd);
            }
            if (snapshot.residuals.length) warning = [warning, '附件清理残留待核对，仍保守计入用量；不会自动继续清理。'].filter(Boolean).join('；');
            this.uploads.store.resolveProject(cwd);
            return { cwd, totalBytes: snapshot.totalBytes, count: snapshot.count, limits: { bytes: 2 * 1024 ** 3, sessionBytes: 256 * 1024 ** 2, count: 10000 },
                items: this.rows(snapshot), complete, revision: complete ? snapshot.revision : null, warning: complete ? warning : warning || '暂不能清理附件' };
        });
    }
    async preview(raw) {
        const cwd = this.scope(raw, ['cwd', 'id', 'draftIds']); if (!hex.test(raw.id)) throw invalid();
        const drafts = draftIds(raw.draftIds);
        return this.operation(async lease => {
            const snapshot = await this.snapshot(cwd, drafts, lease), item = snapshot.items.find(i => i.visible && i.object.manifest.reference.id === raw.id);
            if (snapshot.residuals.some(i => i.manifest?.reference.id === raw.id)) throw fail('附件清理残留待核对，不能重复清理', 409, 'DOCUMENT_PROTECTED');
            if (!item) throw fail('附件不属于当前项目', 403, 'DOCUMENT_SCOPE');
            if (snapshot.found.has(raw.id)) throw fail('附件仍有保存引用或草稿，不能清理', 409, 'DOCUMENT_PROTECTED');
            if (this.tickets.size >= 100) this.tickets.delete(this.tickets.keys().next().value);
            const ticket = randomUUID(); this.tickets.set(ticket, { cwd, id: raw.id, drafts, revision: snapshot.revision, expires: Date.now() + 5 * 60 * 1000 });
            return { ticket, revision: snapshot.revision, item: this.rows(snapshot).find(i => i.id === raw.id), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
        }, true);
    }
    receiptPath(root, cwd, requestId) { return path.join(root, '.storage-receipts', hash(JSON.stringify([cwd, requestId])) + '.json'); }
    async status(raw) {
        const cwd = this.scope(raw, ['cwd', 'requestId']); if (typeof raw.requestId !== 'string' || !requestPattern.test(raw.requestId)) throw invalid();
        return this.operation(async () => {
            const root = await this.uploads.root(), directory = path.join(root, '.storage-receipts'); prove(directory, true);
            const receipt = JSON.parse(readSafe(this.receiptPath(root, cwd, raw.requestId), 8192));
            if (receipt.cwd !== cwd || receipt.requestId !== raw.requestId || receipt.version !== 1 || !hex.test(receipt.id)) throw changed();
            if (receipt.state === 'deleted' && fs.existsSync(path.join(root, receipt.id))) throw changed();
            return receipt;
        });
    }
    async cleanup(raw) {
        const cwd = this.scope(raw, ['cwd', 'ticket', 'revision', 'requestId', 'draftIds', 'confirmed', 'externalWritersStopped']);
        if (typeof raw.requestId !== 'string' || !requestPattern.test(raw.requestId) || typeof raw.ticket !== 'string' || typeof raw.revision !== 'string' || raw.confirmed !== true || raw.externalWritersStopped !== true) throw invalid();
        const currentDrafts = draftIds(raw.draftIds), ticket = this.tickets.get(raw.ticket);
        return this.operation(async lease => {
            const root = await this.uploads.root(); lease.check();
            const receiptDir = path.join(root, '.storage-receipts'), deletedDir = path.join(root, '.storage-deleted');
            for (const dir of [receiptDir, deletedDir]) {
                if (!fs.existsSync(dir) && privateDir(dir) !== dir) throw changed();
                prove(dir, true);
            }
            const receiptFile = this.receiptPath(root, cwd, raw.requestId);
            // Never replay a cleanup with an existing requestId, even if its
            // first attempt stopped between intent persistence and unlink.
            if (fs.existsSync(receiptFile)) {
                const receipt = JSON.parse(readSafe(receiptFile, 8192));
                if (receipt.cwd !== cwd || receipt.requestId !== raw.requestId || receipt.ticket !== raw.ticket || receipt.revision !== raw.revision) throw fail('清理标识已用于另一操作', 409, 'DOCUMENT_CONFLICT');
                if (receipt.state === 'deleted' && fs.existsSync(path.join(root, receipt.id))) throw changed();
                return receipt;
            }
            if (!ticket || ticket.cwd !== cwd || ticket.revision !== raw.revision || ticket.expires < Date.now()) throw changed();
            // Receipt directories were established before preview, so their
            // creation cannot invalidate an otherwise unchanged preview.
            const snapshot = await this.snapshot(cwd, ticket.drafts, lease);
            if (snapshot.revision !== ticket.revision) throw changed();
            const item = snapshot.items.find(i => i.visible && i.object.manifest.reference.id === ticket.id);
            if (!item || snapshot.found.has(ticket.id) || currentDrafts.includes(ticket.id)) throw fail('附件仍有保存引用或草稿，不能清理', 409, 'DOCUMENT_PROTECTED');
            lease.check(); verifyAll(snapshot.proofs); this.uploads.store.resolveProject(cwd);
            if (this.uploads.closed || this.uploads.isSuspended() || this.uploads.operations.size !== 1 || this.uploads.pool.jobs.size || this.uploads.writing) throw busy();
            lease.check();
            const folderProof = prove(item.object.folder, true);
            const deletionProof = { manifest: item.object.manifest, manifestSha256: hash(readSafe(path.join(item.object.folder, 'manifest.json'), 8192)),
                folder: { node: folderProof.node, identity: folderProof.identity },
                leaves: ['original', 'manifest.json'].map(name => { const { stamp, identity } = prove(path.join(item.object.folder, name)); return { name, stamp, identity }; }) };
            verifyAll(snapshot.proofs);
            const receipt = { version: 1, cwd, requestId: raw.requestId, ticket: raw.ticket, revision: raw.revision, id: ticket.id, state: 'uncertain', externalWritersStopped: true, createdAt: new Date().toISOString(), deletionProof };
            // Entire final window is synchronous: durable intent and tombstone
            // precede exact leaf unlinks. Failures remain uncertain, never retry.
            atomicJson(receiptFile, receipt);
            this.tickets.delete(raw.ticket);
            atomicJson(path.join(deletedDir, ticket.id + '.json'), { version: 1, id: ticket.id, requestId: raw.requestId, proof: hash(JSON.stringify(deletionProof)) });
            fs.unlinkSync(path.join(item.object.folder, 'original'));
            fs.unlinkSync(path.join(item.object.folder, 'manifest.json'));
            fs.rmdirSync(item.object.folder);
            if (process.platform !== 'win32') { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
            receipt.state = 'deleted'; atomicJson(receiptFile, receipt); this.tickets.delete(raw.ticket);
            return receipt;
        }, true);
    }
}
function mountDocumentStorage(router, storage) {
    const respond = action => async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        try { res.json(await action(req)); }
        catch (e) { res.status(e.status || (e.code === 'ENOENT' ? 404 : 409)).json({ error: e.code === 'ENOENT' ? '尚无此清理结果' : e.message, code: e.code }); }
    };
    router.post('/uploads/storage/usage', respond(req => storage.usage(req.body)));
    router.post('/uploads/storage/preview', respond(req => storage.preview(req.body)));
    router.post('/uploads/storage/cleanup', respond(req => storage.cleanup(req.body)));
    router.get('/uploads/storage/status', respond(req => storage.status(req.query)));
}
module.exports = { DocumentStorage, mountDocumentStorage };
