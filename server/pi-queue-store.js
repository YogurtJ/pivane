const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { privateDir, atomicJson, readSafe } = require('./pi-maintenance-files');
const { validateMessage } = require('./pi-message-payload');
const refs = require('../public/pi-document-references');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const states = new Set(['saved', 'queued', 'started', 'unknown', 'recovered']);
const DEFAULT_LIMITS = { entries: 1024, sessionEntries: 32, bytes: 256 * 1024 ** 2, sessionBytes: 64 * 1024 ** 2 };
const storageLimit = message => Object.assign(new Error(message), { code: 'QUEUE_STORAGE_LIMIT' });
function effectivePayload(value) {
    if (typeof value?.message === 'string' && (value.message.length > 400000 || refs.split(value.message).filter(part => part.reference).length > 5)
        || Array.isArray(value?.images) && (value.images.length > 6 || value.images.reduce((sum, image) => sum + (typeof image?.data === 'string' ? image.data.length : 0), 0) > 24 * 1024 ** 2)) {
        throw Object.assign(new Error('原生变换后的内容超过恢复载荷预算'), { code: 'QUEUE_EVIDENCE_LIMIT' });
    }
    try { return validateMessage(value); }
    catch {
        // Extension-generated native content may use a shape or image encoding
        // outside this service's restore contract. That is incomplete evidence,
        // not a failed journal write; preserve and acknowledge the original.
        throw Object.assign(new Error('原生变换后的内容无法完整保存为恢复载荷'), { code: 'QUEUE_EVIDENCE_LIMIT' });
    }
}

// A journal of authorized send intentions, never a transcript or replay engine.
// All disk mutations and the reference lease are synchronous in the host process.
class PiQueueStore {
    constructor(root, { limits = {}, save = atomicJson } = {}) {
        this.root = path.resolve(root);
        this.file = path.join(this.root, 'intentions.json');
        this.limits = { ...DEFAULT_LIMITS, ...limits };
        this.save = save;
        this.operations = 0;
        this.leased = false;
        this.fault = null;
    }
    checkRoot(create = false) {
        if (create) {
            if (privateDir(this.root) !== this.root) throw new Error('队列存储位置已变化');
        } else if (!fs.existsSync(this.root)) return false;
        const stat = fs.lstatSync(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(this.root) !== this.root) throw new Error('队列存储位置已变化');
        return true;
    }
    read() {
        if (!this.checkRoot()) return { version: 1, revision: 0, entries: [] };
        if (!fs.existsSync(this.file)) throw new Error('队列恢复清单缺失，无法完整核验');
        const bytes = readSafe(this.file, this.limits.bytes);
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries)
            || value.entries.length > this.limits.entries * 2) throw new Error('队列恢复记录无效');
        const ids = new Set();
        for (const entry of value.entries) {
            if (!uuid.test(entry.id) || ids.has(entry.id) || typeof entry.sessionPath !== 'string' || !path.isAbsolute(entry.sessionPath)
                || typeof entry.sessionId !== 'string' || typeof entry.cwd !== 'string' || !uuid.test(entry.runtimeId)
                || !states.has(entry.state) || !['steering', 'followUp'].includes(entry.kind) || typeof entry.createdAt !== 'string') throw new Error('队列恢复记录无效');
            validateMessage(entry.original);
            if (entry.effective) validateMessage(entry.effective);
            ids.add(entry.id);
        }
        return value;
    }
    assertWritable() {
        if (this.leased) throw new Error('附件引用正在核验，请稍后发送或处理队列');
        if (this.fault) throw new Error('队列持久化失败，请重新打开运行实例并核对恢复记录');
    }
    beginOperation() {
        this.assertWritable(); this.operations++;
        let done = false;
        return () => { if (!done) { done = true; this.operations--; } };
    }
    acquireReferenceLease() {
        this.assertWritable();
        if (this.operations) throw new Error('队列操作正在进行，请稍后核验附件');
        this.leased = true;
        let done = false;
        return () => { if (!done) { done = true; this.leased = false; } };
    }
    mutate(change) {
        this.assertWritable();
        const value = this.read(), before = structuredClone(value);
        const result = change(value.entries);
        if (result === false) return false;
        value.revision++;
        // Reserve metadata headroom at admission so an original-only transition
        // always fits even when concurrent reservations consume the payload budget.
        const budgetEntries = value.entries.map(entry => ({ ...entry, state: 'recovered', effectiveComplete: false }));
        const bytes = Buffer.byteLength(JSON.stringify({ ...value, revision: Number.MAX_SAFE_INTEGER, entries: budgetEntries }, null, 2) + '\n');
        if (value.entries.filter(entry => !entry.fallback).length > this.limits.entries || value.entries.length > this.limits.entries * 2 || bytes > this.limits.bytes) throw storageLimit('队列恢复存储额度已满，请先处理恢复内容');
        const sessions = new Map();
        for (const entry of budgetEntries) {
            const budget = sessions.get(entry.sessionPath) || { entries: 0, bytes: 0 };
            if (!entry.fallback) budget.entries++;
            budget.bytes += Buffer.byteLength(JSON.stringify(entry, null, 2));
            if (budget.entries > this.limits.sessionEntries || budget.bytes > this.limits.sessionBytes) throw storageLimit('此线程队列恢复额度已满，请先处理恢复内容');
            sessions.set(entry.sessionPath, budget);
        }
        const created = !fs.existsSync(this.root);
        this.checkRoot(true);
        try {
            this.save(this.file, value);
            if (created && process.platform !== 'win32') {
                const fd = fs.openSync(path.dirname(this.root), 'r');
                try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            }
        }
        catch (error) {
            // A post-rename/fsync failure can have published different bytes.
            // Refuse further mutation/cleanup unless we can prove the old state.
            try { if (JSON.stringify(this.read()) !== JSON.stringify(before)) this.fault = true; }
            catch { this.fault = true; }
            throw error;
        }
        return result;
    }
    reserve(worker, kind, payload) {
        const original = validateMessage(payload);
        const entry = { id: randomUUID(), sessionPath: worker.sessionPath, sessionId: worker.sessionId, cwd: worker.cwd,
            runtimeId: worker.controls.runtimeId, kind, state: 'saved', createdAt: new Date().toISOString(), effectiveComplete: false, original };
        this.mutate(entries => { entries.push(entry); return entry.id; });
        return entry.id;
    }
    update(worker, id, state, effective) {
        const owned = entries => entries.find(entry => entry.id === id && entry.runtimeId === worker.controls.runtimeId
            && entry.sessionPath === worker.sessionPath && entry.sessionId === worker.sessionId);
        try {
            return this.mutate(entries => {
                const entry = owned(entries);
                if (!entry) return false;
                if (!states.has(state)) throw new Error('队列状态无效');
                // A late queued reply cannot regress a delivered or recovered identity.
                if (state === 'queued' && entry.state !== 'saved') {
                    if (entry.state === 'unknown' && effective) { entry.effective = effectivePayload(effective); entry.effectiveComplete = true; return true; }
                    return false;
                }
                if (state === 'started' && entry.state === 'recovered') return false;
                entry.state = state;
                if (effective) { entry.effective = effectivePayload(effective); entry.effectiveComplete = true; }
                return true;
            });
        } catch (error) {
            if (!['QUEUE_STORAGE_LIMIT', 'QUEUE_EVIDENCE_LIMIT'].includes(error.code)) throw error;
            return this.mutate(entries => {
                const entry = owned(entries);
                if (!entry || state === 'queued' && !['saved', 'unknown'].includes(entry.state) || state === 'started' && entry.state === 'recovered') return false;
                // Native input may already be queued. Keep the full admitted
                // original; incomplete effective references must block cleanup.
                entry.state = 'unknown';
                delete entry.effective;
                entry.effectiveComplete = false;
                return true;
            });
        }
    }
    retire(worker, id) {
        return this.mutate(entries => {
            const index = entries.findIndex(item => item.id === id && item.runtimeId === worker.controls.runtimeId
                && item.sessionPath === worker.sessionPath && item.sessionId === worker.sessionId);
            if (index < 0) return false;
            entries.splice(index, 1); return true;
        });
    }
    summaries(worker) {
        return this.read().entries.filter(entry => entry.sessionPath === worker.sessionPath && entry.sessionId === worker.sessionId && entry.cwd === worker.cwd)
            .map(entry => {
                const status = entry.state === 'recovered' ? 'recovered' : 'uncertain';
                const payload = entry.effective || entry.original;
                return { id: entry.id, status, state: entry.runtimeId === worker.controls.runtimeId ? entry.state : status === 'recovered' ? 'recovered' : 'unknown',
                    durable: true, hasPayload: !entry.legacy, legacy: Boolean(entry.legacy), imageCount: payload.images.length, originalImageCount: entry.original.images.length,
                    transformed: entry.effectiveComplete === true && Boolean(entry.effective), effectiveComplete: entry.effectiveComplete === true,
                    originalOnly: !entry.legacy && entry.effectiveComplete !== true, createdAt: entry.createdAt,
                    steering: entry.kind === 'steering' ? [payload.message] : [], followUp: entry.kind === 'followUp' ? [payload.message] : [] };
            });
    }
    payload(worker, id) {
        const entry = this.read().entries.find(item => item.id === id && item.sessionPath === worker.sessionPath && item.sessionId === worker.sessionId && item.cwd === worker.cwd);
        if (!entry) throw new Error('取回内容不存在');
        const summary = this.summaries(worker).find(item => item.id === id);
        if (entry.runtimeId === worker.controls.runtimeId && ['saved', 'queued'].includes(entry.state)) throw new Error('内容仍可能在原生队列中，请先取回或等待状态确认');
        return { ...summary, payload: structuredClone(entry.effective || entry.original), original: structuredClone(entry.original) };
    }
    acknowledge(worker, id) {
        return this.mutate(entries => {
            const index = entries.findIndex(item => item.id === id && item.sessionPath === worker.sessionPath && item.sessionId === worker.sessionId && item.cwd === worker.cwd);
            if (index < 0) throw new Error('取回内容不存在');
            const entry = entries[index];
            if (entry.runtimeId === worker.controls.runtimeId && ['saved', 'queued'].includes(entry.state)) throw new Error('内容仍可能在原生队列中，请先取回');
            entries.splice(index, 1); return true;
        });
    }
    saveLegacy(worker, queue, state = 'unknown') {
        const ids = [];
        this.mutate(entries => {
            for (const kind of ['steering', 'followUp']) for (const message of queue[kind] || []) {
                if (!message) continue;
                const id = randomUUID(); ids.push(id);
                entries.push({ id, sessionPath: worker.sessionPath, sessionId: worker.sessionId, cwd: worker.cwd,
                    runtimeId: worker.controls.runtimeId, kind, state, legacy: true, fallback: state === 'unknown', effectiveComplete: true,
                    createdAt: new Date().toISOString(), original: validateMessage({ message, images: [] }) });
            }
            return ids.length ? ids : false;
        });
        return ids;
    }
    reconcileClear(worker, fallbackIds, capturedIds, legacy, candidateIds = null) {
        this.mutate(entries => {
            for (const entry of entries) {
                if (entry.runtimeId !== worker.controls.runtimeId || entry.sessionPath !== worker.sessionPath || entry.legacy) continue;
                if (capturedIds.includes(entry.id) && (!candidateIds || candidateIds.includes(entry.id))) entry.state = 'recovered';
                else if (candidateIds?.includes(entry.id) && ['saved', 'queued'].includes(entry.state)) entry.state = 'unknown';
            }
            const keep = entries.filter(item => !fallbackIds.includes(item.id));
            entries.splice(0, entries.length, ...keep);
            for (const kind of ['steering', 'followUp']) for (const message of legacy[kind] || []) {
                if (message) entries.push({ id: randomUUID(), sessionPath: worker.sessionPath, sessionId: worker.sessionId, cwd: worker.cwd,
                    runtimeId: worker.controls.runtimeId, kind, state: 'recovered', legacy: true, effectiveComplete: true,
                    createdAt: new Date().toISOString(), original: validateMessage({ message, images: [] }) });
            }
            return true;
        });
    }
    assertMovable(sessionPath) {
        if (this.read().entries.some(entry => entry.sessionPath === sessionPath)) throw Object.assign(new Error('请先处理此线程的队列恢复内容，再移动线程'), { code: 'SESSION_QUEUE_RECOVERY' });
    }
    forgetDeletedSession(sessionPath) {
        return this.mutate(entries => {
            const kept = entries.filter(entry => entry.sessionPath !== sessionPath);
            if (kept.length === entries.length) return false;
            entries.splice(0, entries.length, ...kept); return true;
        });
    }
    protectedDocuments() {
        if (this.fault) throw new Error('队列持久化状态不完整，不能回收附件');
        const value = this.read(), ids = new Set();
        for (const entry of value.entries) for (const payload of [entry.original, entry.effective].filter(Boolean)) {
            for (const part of refs.split(payload.message)) if (part.reference) ids.add(part.reference.id);
        }
        return { complete: value.entries.every(entry => entry.effectiveComplete === true || entry.legacy === true), revision: hash(JSON.stringify(value)), ids: [...ids].sort() };
    }
}
module.exports = { PiQueueStore, DEFAULT_LIMITS };
