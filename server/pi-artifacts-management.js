'use strict';
const fs = require('node:fs'), path = require('node:path');
const { artifactFail: fail, artifactName: name, artifactText: text, artifactHash: hash } = require('./pi-artifacts-library');
const { fileScope } = require('./pi-file-scope');
const { openPrivateFileSync } = require('./pi-private-files');
const { descriptorPathSync } = require('./pi-file-descriptor');
const io = require('./pi-file-io');
const ID = /^[a-f0-9]{64}$/;
class ArtifactManagement {
    constructor(service) { this.service = service; this.library = service.library; }
    async source(key) {
        const s = this.service, locator = s.locator(key); let data, metadata;
        if (locator.source === 'media') {
            const m = locator.media; data = await s.mediaBytes(m);
            metadata = { name: m.filename, kind: m.kind, createdAt: m.createdAt, model: m.model || '', project: null, origin: null,
                sourcePath: path.join(s.mediaRoot, 'public', require('./pi-artifacts-discovery').MEDIA[m.kind][1], m.filename) };
        } else {
            const c = locator.candidate;
            data = await s.deliveryService(c).request({ cwd: c.cwd, sessionId: c.id, id: locator.deliveryId, index: String(locator.index) });
            if (data.revision !== locator.revision) throw fail('成果版本已变化，请刷新', 409, 'ARTIFACT_SOURCE');
            s.qualify(c);
            metadata = { name: data.name, kind: require('./pi-artifacts').artifactKind(data.name), createdAt: data.createdAt, title: data.title,
                project: { cwd: c.cwd, name: path.basename(c.cwd) || c.cwd },
                origin: { cwd: c.cwd, sessionId: c.id, deliveryId: locator.deliveryId, index: locator.index, revision: locator.revision }, sourcePath: data.absolutePath };
        }
        s.check();
        const bytes = data.encoding === 'utf8' ? Buffer.from(data.content, 'utf8') : Buffer.from(data.base64, 'base64');
        if (bytes.length !== data.size || hash(bytes) !== data.revision) throw fail('成果字节校验失败', 409, 'ARTIFACT_SOURCE');
        return { bytes, metadata };
    }
    async location(key, signal) {
        return this.service.job(async () => {
            const catalog = await this.library.catalog(), entry = catalog.entries.find(e => e.id === key);
            if (entry) {
                const root = await this.library.root();
                return { storagePath: path.join(root, entry.id + '.bin'), originalName: entry.originalName, sourcePath: entry.sourcePath || null,
                    origin: entry.origin ? { cwd: entry.origin.cwd, sessionId: entry.origin.sessionId } : null,
                    project: entry.project, independent: true, savedAt: entry.savedAt };
            }
            const source = await this.source(key); signal?.throwIfAborted();
            return { sourcePath: source.metadata.sourcePath || null, project: source.metadata.project, origin: source.metadata.origin ? { cwd: source.metadata.origin.cwd, sessionId: source.metadata.origin.sessionId } : null,
                independent: false, originalName: source.metadata.name };
        }, signal);
    }
    validate(input) {
        const allowed = ['requestId', 'action', 'files', 'name', 'favorite', 'collectionId', 'cwd', 'directory', 'confirmed'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))
            || typeof input.requestId !== 'string' || !/^[\w.-]{8,160}$/.test(input.requestId)
            || !['save', 'favorite', 'rename', 'collection-add', 'collection-remove', 'project', 'trash', 'restore', 'purge', 'hide', 'unhide', 'export', 'collection-create', 'collection-rename', 'collection-delete'].includes(input.action)) throw fail('成果操作参数无效');
        const collectionAction = input.action.startsWith('collection-') && !['collection-add', 'collection-remove'].includes(input.action);
        if (!collectionAction && (!Array.isArray(input.files) || !input.files.length || input.files.length > 50 || new Set(input.files.map(f => f?.key)).size !== input.files.length
            || input.files.some(f => !f || !ID.test(f.key) || Object.keys(f).some(k => !['key', 'revision'].includes(k)) || f.revision !== undefined && (!Number.isSafeInteger(f.revision) || f.revision < 1)))) throw fail('一次请选择 1–50 个文件');
        if (['trash', 'purge', 'export', 'collection-delete'].includes(input.action) && input.confirmed !== true) throw fail('请确认此批操作', 409, 'ARTIFACT_CONFIRM');
        if (input.action === 'purge' && input.files.some(f => !Number.isSafeInteger(f.revision))) throw fail('永久删除需要当前文件修订，请刷新', 409, 'ARTIFACT_CONFLICT');
        if (input.action === 'favorite' && typeof input.favorite !== 'boolean') throw fail('星标参数无效');
        if (input.action === 'rename' && input.files.length !== 1) throw fail('重命名请一次选择一个文件');
        if (['rename', 'collection-create', 'collection-rename'].includes(input.action)) { const cleaned = input.action === 'rename' ? name(input.name) : text(input.name); if (cleaned !== input.name) throw fail('名称首尾不能有空格'); }
        if (['collection-add', 'collection-remove', 'collection-rename', 'collection-delete'].includes(input.action) && !ID.test(input.collectionId)) throw fail('合集标识无效');
        if (input.action === 'project' && input.cwd !== null && (typeof input.cwd !== 'string' || input.cwd.length > 4096)) throw fail('项目参数无效');
        if (input.action === 'export' && (typeof input.cwd !== 'string' || typeof input.directory !== 'string' || input.directory.length > 4096)) throw fail('保存目录参数无效');
        return { ...input };
    }
    async batch(raw, signal) {
        const input = this.validate(raw);
        return this.service.job(() => this.library.mutation(async catalog => {
            const requestHash = hash(JSON.stringify(input)), prior = await this.library.operation(input.requestId);
            if (prior) {
                if (prior.hash !== requestHash) throw fail('请求标识已用于不同操作', 409, 'ARTIFACT_CONFLICT');
                if (!prior.result) throw fail('上次操作结果未确认，请刷新核对；未重放', 409, 'ARTIFACT_INCOMPLETE');
                return prior.result;
            }
            if (catalog.operations.length >= 200) catalog.operations.splice(0, catalog.operations.length - 199);
            const operation = { id: input.requestId, hash: requestHash, at: new Date().toISOString(), result: null };
            await this.library.reserveOperation(operation);
            catalog.operations.push(operation); await this.library.commit(catalog);
            // Client abort never cancels an already reserved mutation. Track until
            // the real write ends; an uncertain response is queried by requestId.
            let result;
            try {
                if (input.action === 'project' && input.cwd !== null) {
                    const cwd = this.service.store.resolveProject(input.cwd); this.service.qualify({ cwd }); input.cwd = cwd;
                }
                if (['collection-add', 'collection-remove'].includes(input.action) && !catalog.collections.some(c => c.id === input.collectionId)) throw fail('合集不存在', 404, 'ARTIFACT_MISSING');
                if (input.action.startsWith('collection-') && !['collection-add', 'collection-remove'].includes(input.action)) result = await this.collection(catalog, input);
                else {
                    const results = []; let bytes = 0;
                    for (const file of input.files) {
                        try {
                            this.service.check();
                            let entry = catalog.entries.find(e => e.id === file.key || e.sourceKey === file.key);
                            if (input.action === 'purge') {
                                if (!entry || file.key !== entry.id) throw fail('只能永久删除成果库回收站中的文件', 404, 'ARTIFACT_MISSING');
                                if (entry.revision !== file.revision) throw fail('成果已变化，请刷新后核对', 409, 'ARTIFACT_CONFLICT');
                                bytes += entry.size;
                                if (bytes > 128 * 1024 ** 2) throw fail('本批删除校验超过 128 MiB，请分批操作', 413, 'ARTIFACT_LIMIT');
                                await this.library.purge(catalog, entry);
                                results.push({ key: file.key, ok: true, deleted: true }); continue;
                            }
                            if (entry?.deletingAt) throw fail('此成果删除结果待核对，请在回收站重新确认永久删除', 409, 'ARTIFACT_INCOMPLETE');
                            if (entry && file.revision !== undefined && entry.revision !== file.revision) throw fail('成果已变化，请刷新后重试', 409, 'ARTIFACT_CONFLICT');
                            if (entry && file.key !== entry.id) {
                                // A source locator never gains saved-copy authority.
                                // Revalidate its branch/history even when the bytes
                                // have independently been saved under a library ID.
                                const source = await this.source(file.key); bytes += source.bytes.length;
                                if (bytes > 128 * 1024 ** 2) throw fail('本批读取超过 128 MiB，请分批操作', 413, 'ARTIFACT_LIMIT');
                            }
                            if (!entry) {
                                if (['restore', 'unhide', 'collection-remove'].includes(input.action)) throw fail('成果尚未保存', 404, 'ARTIFACT_MISSING');
                                const source = await this.source(file.key); bytes += source.bytes.length;
                                if (bytes > 128 * 1024 ** 2) throw fail('本批保存超过 128 MiB，请分批操作', 413, 'ARTIFACT_LIMIT');
                                entry = await this.library.save(catalog, file.key, source.bytes, source.metadata);
                            }
                            if (entry.trashedAt && !['restore', 'trash'].includes(input.action)) throw fail('成果已在回收站，请先恢复', 409, 'ARTIFACT_TRASHED');
                            if (input.action === 'project' && input.cwd) this.service.qualify({ cwd: input.cwd });
                            let exported;
                            switch (input.action) {
                            case 'favorite': entry.favorite = input.favorite; break;
                            case 'rename': entry.name = input.name; break;
                            case 'collection-add':
                                if (!catalog.collections.some(c => c.id === input.collectionId)) throw fail('合集不存在', 404, 'ARTIFACT_MISSING');
                                if (!entry.collections.includes(input.collectionId)) entry.collections.push(input.collectionId); break;
                            case 'collection-remove': entry.collections = entry.collections.filter(id => id !== input.collectionId); break;
                            case 'project': entry.project = input.cwd ? { cwd: input.cwd, name: path.basename(input.cwd) || input.cwd } : null; break;
                            case 'trash': entry.trashedAt ||= new Date().toISOString(); break;
                            case 'restore': entry.trashedAt = null; entry.hiddenAt = null; break;
                            case 'hide': entry.hiddenAt ||= new Date().toISOString(); break;
                            case 'unhide': entry.hiddenAt = null; break;
                            case 'export':
                                bytes += entry.size;
                                if (bytes > 128 * 1024 ** 2) throw fail('本批读写超过 128 MiB，请分批操作', 413, 'ARTIFACT_LIMIT');
                                exported = await this.export(entry, input); break;
                            }
                            entry.revision++; await this.library.commit(catalog);
                            results.push({ key: file.key, ok: true, item: this.library.item(entry), ...(exported ? { exported } : {}) });
                        } catch (error) { results.push({ key: file.key, ok: false, code: error.code || 'ARTIFACT_WRITE', error: error.status ? error.message : '成果操作未完成，请核对该项；未重放' }); }
                    }
                    result = { requestId: input.requestId, results };
                }
            } catch (error) { result = { requestId: input.requestId, results: [], error: error.status ? error.message : '成果操作未完成，请刷新核对' }; }
            operation.result = result; await this.library.commit(catalog); await this.library.finishOperation(operation); return result;
        }), signal);
    }
    async collection(catalog, input) {
        if (input.action === 'collection-create') {
            if (catalog.collections.length >= 100) throw fail('最多创建 100 个合集', 413, 'ARTIFACT_LIMIT');
            catalog.collections.push({ id: hash('collection:' + input.requestId), name: input.name });
        } else {
            const collection = catalog.collections.find(c => c.id === input.collectionId);
            if (!collection) throw fail('合集不存在', 404, 'ARTIFACT_MISSING');
            if (input.action === 'collection-rename') collection.name = input.name;
            else {
                catalog.collections = catalog.collections.filter(c => c !== collection);
                for (const entry of catalog.entries) if (entry.collections.includes(collection.id)) { entry.collections = entry.collections.filter(id => id !== collection.id); entry.revision++; }
            }
        }
        await this.library.commit(catalog); return { requestId: input.requestId, results: [], collections: catalog.collections };
    }
    async result(requestId) {
        if (typeof requestId !== 'string' || !/^[\w.-]{8,160}$/.test(requestId)) throw fail('请求标识无效');
        return this.service.job(async () => {
            const operation = await this.library.operation(requestId);
            if (!operation) throw fail('未找到该操作记录，请刷新核对，不要自动重试', 404, 'ARTIFACT_MISSING');
            return operation.result || { requestId, pending: true, noReplay: true };
        });
    }
    async export(entry, input) {
        const scope = await fileScope(this.service.store, input.cwd);
        if (this.service.hidden(scope.cwd)) throw fail('目标项目不可用', 403, 'ARTIFACT_SCOPE');
        const parent = path.resolve(scope.cwd, input.directory); scope.check(parent, true);
        if (fs.realpathSync.native(parent) !== parent) throw fail('请选择真实目录，不支持目录链接', 409, 'ARTIFACT_SCOPE');
        const before = fs.lstatSync(parent, { bigint: true }); if (!before.isDirectory()) throw fail('目标不是目录');
        const target = path.join(parent, name(entry.name)); scope.check(target, true);
        const { bytes } = await this.library.content(entry);
        // Recheck after asynchronous source read. Exclusive open never overwrites
        // user files; inspect the actual opened kernel path before the first byte.
        if (fs.realpathSync.native(parent) !== parent || !sameDirectory(before, fs.lstatSync(parent, { bigint: true }))) throw fail('目标目录已变化', 409, 'ARTIFACT_CONFLICT');
        let fd, parentFd;
        try {
            parentFd = io.openReadSync(parent);
            const parentIdentity = io.identity(parentFd), openedParent = fs.fstatSync(parentFd, { bigint: true });
            if (descriptorPathSync(parentFd) !== parent || !sameDirectory(before, openedParent) || !io.sameIdentityAtPath(parent, parentIdentity)) throw fail('目标目录身份已变化', 409, 'ARTIFACT_CONFLICT');
            fd = openPrivateFileSync(target); const identity = io.identity(fd), opened = fs.fstatSync(fd, { bigint: true }), actual = descriptorPathSync(fd); scope.check(actual);
            if (actual !== target || !fs.fstatSync(fd).isFile()) throw fail('目标文件位置已变化', 409, 'ARTIFACT_CONFLICT');
            fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
            if (descriptorPathSync(fd) !== target || !io.sameIdentityAtPath(target, identity) || fs.realpathSync.native(parent) !== parent
                || !sameDirectory(before, fs.lstatSync(parent, { bigint: true })) || !sameFile(opened, fs.fstatSync(fd, { bigint: true }), fs.lstatSync(target, { bigint: true }), bytes.length)) throw fail('保存位置已变化，请核对目标；未重放', 409, 'ARTIFACT_CONFLICT');
            if (descriptorPathSync(parentFd) !== parent || !io.sameIdentityAtPath(parent, parentIdentity) || !sameDirectory(openedParent, fs.fstatSync(parentFd, { bigint: true }))) throw fail('目录身份已变化，请核对目标；未重放', 409, 'ARTIFACT_CONFLICT');
            if (require('./pi-maintenance-files').hashFileSafe(target, 64 * 1024 ** 2).sha256 !== entry.sha256 || !io.sameIdentityAtPath(target, identity)) throw fail('导出字节校验失败，请核对目标；未重放', 409, 'ARTIFACT_CONFLICT');
            this.service.qualify({ cwd: scope.cwd });
            return { path: target, originalPreserved: true };
        } catch (error) { if (error.code === 'EEXIST') throw fail('目标文件已存在，没有覆盖；请修改成果名称或选择其他目录', 409, 'ARTIFACT_CONFLICT'); throw error; }
        finally { if (fd !== undefined) fs.closeSync(fd); if (parentFd !== undefined) fs.closeSync(parentFd); }
    }
}
function sameFile(opened, after, named, size) {
    return after.isFile() && named.isFile() && opened.dev === after.dev && opened.ino === after.ino && after.size === BigInt(size)
        && ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(k => after[k] === named[k]);
}
function sameDirectory(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && b.isDirectory(); }
module.exports = { ArtifactManagement };
