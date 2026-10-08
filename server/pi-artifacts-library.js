'use strict';
// Instance-owned immutable bytes + mutable organization. No session authority is
// used after an explicit save; origin is only a revocable navigation pointer.
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { privateDir, atomicJson, readSafe, hashFileSafe } = require('./pi-maintenance-files');
const { writePrivateFileSync, openPrivateFileSync } = require('./pi-private-files');
const { descriptorPathSync } = require('./pi-file-descriptor');
const io = require('./pi-file-io');
const { readVerifiedFile } = require('./pi-file-bytes');
const { representation } = require('./pi-file-types');
const ID = /^[a-f0-9]{64}$/, hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 400, code = 'ARTIFACT_INPUT') => Object.assign(new Error(message), { status, code });
const MAX_ENTRIES = 10000, MAX_BYTES = 4 * 1024 ** 3;
function name(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\x00-\x1f\x7f/\\]/.test(value) || /[. ]$/.test(value) || /[:*?"<>|]/.test(value)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value === '.' || value === '..') throw fail('名称无效，请使用不含路径的文件名称');
    return value.trim();
}
function text(value, max = 160) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail('名称无效');
    return value.trim();
}
class ArtifactLibrary {
    constructor(options = {}) { this.directory = options.directory; this.mutating = false; }
    async root(create = false) {
        if (!this.directory) { const { getAgentDir } = await getSdk(); this.directory = path.join(fs.realpathSync.native(getAgentDir()), 'pivane-artifacts'); }
        const root = path.resolve(this.directory);
        if (create) privateDir(root);
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) throw fail('成果存储位置已变化', 409, 'ARTIFACT_STORAGE');
        return root;
    }
    async catalog(create = false) {
        let root;
        try { root = await this.root(create); }
        catch (error) { if (!create && error.code === 'ENOENT') return { version: 1, revision: 0, entries: [], collections: [], operations: [] }; throw error; }
        let data;
        try { data = JSON.parse(readSafe(path.join(root, 'catalog.json'), 16 * 1024 ** 2)); }
        catch (error) { if (error.code === 'ENOENT') return { version: 1, revision: 0, entries: [], collections: [], operations: [] }; throw error; }
        if (data.version !== 1 || !Number.isSafeInteger(data.revision) || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES
            || !Array.isArray(data.collections) || data.collections.length > 100 || !Array.isArray(data.operations) || data.operations.length > 200
            || data.collections.some(c => !c || !ID.test(c.id) || text(c.name) !== c.name) || new Set(data.collections.map(c => c.id)).size !== data.collections.length
            || new Set(data.entries.map(e => e.id)).size !== data.entries.length || data.entries.some(e => !ID.test(e.id) || !ID.test(e.sourceKey) || !ID.test(e.sha256)
                || !Number.isSafeInteger(e.revision) || e.revision < 1 || !Number.isSafeInteger(e.size) || e.size < 0 || e.size > 64 * 1024 ** 2
                || typeof e.name !== 'string' || name(e.name) !== e.name || typeof e.originalName !== 'string' || name(e.originalName) !== e.originalName
                || !['document', 'image', 'video', 'audio', 'web', 'other'].includes(e.kind) || !Number.isFinite(Date.parse(e.savedAt))
                || e.project && (typeof e.project.cwd !== 'string' || !path.isAbsolute(e.project.cwd) || typeof e.project.name !== 'string')
                || e.origin && (typeof e.origin.cwd !== 'string' || !path.isAbsolute(e.origin.cwd) || typeof e.origin.sessionId !== 'string' || !ID.test(e.origin.deliveryId) || !ID.test(e.origin.revision) || !Number.isInteger(e.origin.index))
                || !Array.isArray(e.collections) || e.collections.length > 100 || e.collections.some(c => !data.collections.some(item => item.id === c)) || typeof e.favorite !== 'boolean')) throw fail('成果目录无效，请保留原文件并联系管理员', 409, 'ARTIFACT_STORAGE');
        data.deletedSources ||= []; data.deletedVersions ||= {};
        if (!data.deletedVersions || typeof data.deletedVersions !== 'object' || Array.isArray(data.deletedVersions) || Object.keys(data.deletedVersions).length > MAX_ENTRIES
            || Object.entries(data.deletedVersions).some(([key, id]) => !ID.test(key) || !ID.test(id))) throw fail('成果删除版本记录无效', 409, 'ARTIFACT_STORAGE');
        if (!Array.isArray(data.deletedSources) || data.deletedSources.length > MAX_ENTRIES || data.deletedSources.some(k => !ID.test(k))
            || data.entries.some(e => e.deletingAt && (!e.trashedAt || !Number.isFinite(Date.parse(e.deletingAt))))) throw fail('成果删除记录无效', 409, 'ARTIFACT_STORAGE');
        return data;
    }
    async operationPath(requestId, create = false) {
        if (typeof requestId !== 'string' || !/^[\w.-]{8,160}$/.test(requestId)) throw fail('请求标识无效');
        const root = await this.root(create), directory = path.join(root, 'operations');
        if (create) privateDir(directory);
        if (fs.realpathSync.native(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw fail('操作记录位置已变化', 409, 'ARTIFACT_STORAGE');
        return path.join(directory, requestId + '.json');
    }
    async operation(requestId) {
        try { return JSON.parse(readSafe(await this.operationPath(requestId), 1024 * 1024)); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    async reserveOperation(operation) {
        const file = await this.operationPath(operation.id, true);
        if (fs.readdirSync(path.dirname(file)).length >= 10000) throw fail('成果操作记录额度已满，请由管理员整理', 413, 'ARTIFACT_LIMIT');
        try { writePrivateFileSync(file, JSON.stringify(operation), true); }
        catch (error) { if (error.code === 'EEXIST') throw fail('该操作已有记录，请核对原请求；未重放', 409, 'ARTIFACT_INCOMPLETE'); throw error; }
    }
    async finishOperation(operation) { atomicJson(await this.operationPath(operation.id), operation); }
    async commit(catalog) {
        const root = await this.root(true); catalog.revision++;
        const bytes = Buffer.byteLength(JSON.stringify(catalog)); if (bytes > 16 * 1024 ** 2) throw fail('成果目录容量已满', 413, 'ARTIFACT_LIMIT');
        atomicJson(path.join(root, 'catalog.json'), catalog);
    }
    async mutation(action) {
        if (this.mutating) throw fail('成果正在保存或整理，请稍后核对', 409, 'ARTIFACT_BUSY');
        this.mutating = true;
        try { return await action(await this.catalog(true)); } finally { this.mutating = false; }
    }
    async save(catalog, sourceKey, bytes, metadata) {
        if (!ID.test(sourceKey) || !Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 ** 2) throw fail('成果保存参数无效');
        // Preserve deterministic exclusive-create protection for uncertain saves;
        // a confirmed deletion advances the generation instead of reviving old IDs.
        const id = hash('saved:' + sourceKey + (catalog.deletedVersions?.[sourceKey] ? ':' + catalog.deletedVersions[sourceKey] : '')), old = catalog.entries.find(e => e.sourceKey === sourceKey);
        if (old) { if (old.sha256 !== hash(bytes)) throw fail('原成果版本已变化', 409, 'ARTIFACT_SOURCE'); return old; }
        if (catalog.entries.length >= MAX_ENTRIES || catalog.entries.reduce((n, e) => n + e.size, 0) + bytes.length > MAX_BYTES) throw fail('成果库已达保存额度（4 GiB／10000 文件）', 413, 'ARTIFACT_LIMIT');
        const root = await this.root(true), file = path.join(root, id + '.bin');
        // Exclusive creation preserves uncertain writes as evidence, never overwrites.
        try {
            const fd = openPrivateFileSync(file);
            try {
                const identity = io.identity(fd), before = fs.fstatSync(fd, { bigint: true });
                if (descriptorPathSync(fd) !== file || !before.isFile() || fs.realpathSync.native(root) !== root) throw fail('成果保存位置已变化', 409, 'ARTIFACT_STORAGE');
                fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
                const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
                if (descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity) || before.dev !== after.dev || before.ino !== after.ino || !after.isFile()
                    || after.size !== BigInt(bytes.length) || ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(k => after[k] !== named[k])) throw fail('成果保存字节或身份已变化', 409, 'ARTIFACT_STORAGE');
                if (hashFileSafe(file, 64 * 1024 ** 2).sha256 !== hash(bytes) || !io.sameIdentityAtPath(file, identity)) throw fail('成果保存字节校验失败', 409, 'ARTIFACT_STORAGE');
            } finally { fs.closeSync(fd); }
        }
        catch (error) { if (error.code === 'EEXIST') throw fail('此成果曾有未确认的保存，请核对原请求；未重放', 409, 'ARTIFACT_INCOMPLETE'); throw error; }
        const entry = { ...metadata, id, sourceKey, name: name(metadata.name), originalName: name(metadata.name), sha256: hash(bytes), size: bytes.length,
            revision: 1, savedAt: new Date().toISOString(), favorite: false, collections: [], trashedAt: null, hiddenAt: null };
        catalog.deletedSources = (catalog.deletedSources || []).filter(k => k !== sourceKey);
        catalog.entries.push(entry); await this.commit(catalog); return entry;
    }
    async purge(catalog, entry) {
        if (!entry.trashedAt) throw fail('请先移入回收站，再永久删除', 409, 'ARTIFACT_CONFIRM');
        const deleted = catalog.deletedSources || (catalog.deletedSources = []), versions = catalog.deletedVersions || (catalog.deletedVersions = {});
        if ((!deleted.includes(entry.sourceKey) && deleted.length >= MAX_ENTRIES) || (!versions[entry.sourceKey] && Object.keys(versions).length >= MAX_ENTRIES)) throw fail('删除记录额度已满，请联系管理员', 413, 'ARTIFACT_LIMIT');
        const root = await this.root(), file = path.join(root, entry.id + '.bin'), parentFd = io.openReadSync(root);
        let fd;
        try {
            const parentIdentity = io.identity(parentFd), parent = fs.fstatSync(parentFd, { bigint: true });
            const checkParent = () => {
                const named = fs.lstatSync(root, { bigint: true });
                if (descriptorPathSync(parentFd) !== root || fs.realpathSync.native(root) !== root || !named.isDirectory()
                    || !io.sameIdentityAtPath(root, parentIdentity) || ['dev', 'ino', 'mode'].some(k => parent[k] !== named[k])) throw fail('成果目录身份已变化', 409, 'ARTIFACT_STORAGE');
            };
            checkParent();
            try { fd = io.openReadSync(file); }
            catch (error) { if (error.code !== 'ENOENT' || !entry.deletingAt) throw error; }
            let checkFile;
            if (fd !== undefined) {
                const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
                checkFile = () => {
                    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
                    if (!before.isFile() || !named.isFile() || before.size !== BigInt(entry.size) || descriptorPathSync(fd) !== file
                        || !io.sameIdentityAtPath(file, identity) || ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(k => before[k] !== after[k] || after[k] !== named[k])) throw fail('成果文件身份或字节已变化，未删除', 409, 'ARTIFACT_STORAGE');
                };
                checkFile();
                if (hashFileSafe(file, 64 * 1024 ** 2).sha256 !== entry.sha256) throw fail('成果字节已变化，未删除', 409, 'ARTIFACT_STORAGE');
                checkFile();
            }
            // Durable intent denies restoration after a crash between unlink and
            // catalog commit. Only a new explicit confirmed request may reconcile.
            entry.deletingAt ||= new Date().toISOString(); await this.commit(catalog);
            checkParent();
            if (fd !== undefined) { checkFile(); fs.unlinkSync(file); }
            else { try { fs.lstatSync(file); throw fail('成果文件重新出现，请核对后再删除', 409, 'ARTIFACT_STORAGE'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
            checkParent(); if (process.platform !== 'win32') fs.fsyncSync(parentFd);
            const entries = catalog.entries, previousDeleted = [...deleted], previousVersions = { ...versions };
            catalog.entries = entries.filter(e => e.id !== entry.id);
            if (!deleted.includes(entry.sourceKey)) deleted.push(entry.sourceKey);
            versions[entry.sourceKey] = entry.id;
            try { await this.commit(catalog); }
            catch (error) { catalog.entries = entries; catalog.deletedSources = previousDeleted; catalog.deletedVersions = previousVersions; throw error; }
        } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(parentFd); }
    }
    async content(entry, cover = false) {
        const root = await this.root(), file = path.join(root, entry.id + '.bin');
        const data = await readVerifiedFile(file, { maxBytes: cover ? 2 * 1024 ** 2 : 64 * 1024 ** 2, check: actual => {
            if (actual !== file) throw fail('成果文件位置已变化', 409, 'ARTIFACT_STORAGE');
        } });
        if (data.revision !== entry.sha256 || data.size !== entry.size) throw fail('已保存成果字节已变化，拒绝读取', 409, 'ARTIFACT_STORAGE');
        const result = representation(data, entry.originalName);
        if (data.bytes.length >= 12 && data.bytes.toString('ascii', 4, 8) === 'ftyp') Object.assign(result, { kind: 'video', mime: 'video/mp4', encoding: 'base64', base64: data.bytes.toString('base64') });
        return { data: result, bytes: data.bytes, storagePath: file };
    }
    item(entry, visibleProject = true) {
        return { key: entry.id, source: 'library', sourceKey: entry.sourceKey, title: entry.name, createdAt: entry.createdAt, savedAt: entry.savedAt,
            project: visibleProject && entry.project ? { key: hash(entry.project.cwd), name: entry.project.name } : null,
            origin: entry.origin?.sessionId ? { sessionId: entry.origin.sessionId } : null, saved: true, independent: true,
            favorite: entry.favorite, collections: entry.collections, trashedAt: entry.trashedAt, hiddenAt: entry.hiddenAt, deletionPending: Boolean(entry.deletingAt), revision: entry.revision,
            ...(entry.model ? { model: entry.model } : {}), types: [entry.kind], files: [{ key: entry.id, name: entry.name, originalName: entry.originalName, kind: entry.kind, size: entry.size }] };
    }
    async list(input = {}, eligibleProject = () => true) {
        if (Object.keys(input).some(k => !['offset', 'revision'].includes(k))) throw fail('成果分页参数无效');
        const offset = input.offset === undefined ? 0 : Number(input.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_ENTRIES) throw fail('成果分页参数无效');
        const catalog = await this.catalog();
        if (input.revision !== undefined && String(catalog.revision) !== input.revision) throw fail('成果目录已变化，请刷新', 409, 'ARTIFACT_CONFLICT');
        const entries = [...catalog.entries].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        return { items: entries.slice(offset, offset + 200).map(e => this.item(e, !e.project || eligibleProject(e.project.cwd))), collections: catalog.collections,
            projects: [...new Map(catalog.entries.filter(e => e.project && eligibleProject(e.project.cwd)).map(e => [e.project.cwd, { key: hash(e.project.cwd), ...e.project }])).values()],
            savedSources: [...new Set([...catalog.entries.map(e => e.sourceKey), ...(catalog.deletedSources || [])])], revision: catalog.revision, nextOffset: offset + 200 < entries.length ? offset + 200 : null, total: entries.length,
            bytes: entries.reduce((n, e) => n + e.size, 0), trashBytes: entries.filter(e => e.trashedAt).reduce((n, e) => n + e.size, 0), limitBytes: MAX_BYTES };
    }
}
module.exports = { ArtifactLibrary, artifactName: name, artifactText: text, artifactFail: fail, artifactHash: hash };
