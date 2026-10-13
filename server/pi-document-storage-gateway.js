const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { readSafe } = require('./pi-maintenance-files');
const { NativeDocumentScope } = require('./pi-document-native-scope');
const { cronDocumentReferences } = require('./pi-document-cron-references');
const { prove, verifyAll, changed } = require('./pi-document-storage-references');

function fileProof(file, directory = false) {
    file = path.resolve(file);
    try { return prove(file, directory); }
    catch (error) { if (error.code === 'ENOENT') return { missing: file }; throw error; }
}

// Settings are read only through authorized canonical projects. Unknown custom
// native roots disable cleanup; their paths are never followed as scan authority.
function settingsScope(agent, nativeScope, store) {
    const scope = new NativeDocumentScope(agent), proofs = [];
    if (!nativeScope || nativeScope.root !== scope.root || nativeScope.complete !== true
        || !Array.isArray(nativeScope.projects) || nativeScope.projects.length > 1000) return { complete: false, proofs };
    const files = new Set([path.join(agent, 'settings.json')]);
    for (const input of nativeScope.projects) {
        let cwd;
        try { cwd = store.resolveProject(input); }
        catch { scope.complete = false; continue; }
        proofs.push(fileProof(cwd, true));
        files.add(path.join(cwd, '.pi', 'settings.json'));
    }
    for (const file of files) {
        proofs.push(fileProof(path.dirname(file), true), fileProof(file));
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readSafe(file, 4 * 1024 ** 2))); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.subagents !== undefined && (!value.subagents || typeof value.subagents !== 'object' || Array.isArray(value.subagents))) {
            scope.complete = false; continue;
        }
        if (Object.hasOwn(value.subagents || {}, 'defaultSessionDir')) scope.reference(value.subagents.defaultSessionDir);
    }
    verifyAll(proofs);
    return { complete: scope.complete, proofs };
}

// Bind document cleanup to the existing request/lifecycle admission and both
// persistent send-intention stores. This holds no conversation or attachment data.
function documentStorageIntegration({ maintenance, supervisor, deferred, cron, store, idle }) {
    let current = null;
    const storageGuard = {
        acquire() {
            const admission = maintenance.acquireReferenceLease(idle);
            const context = { admission, checks: [], queueRelease: null };
            current = context;
            return {
                async ready() {
                    admission.check();
                    // A prompt preflight acknowledgement can precede the native
                    // start event. Read an existing worker after admission closes;
                    // this never starts/reuses a worker or sends a model request.
                    for (const worker of supervisor.workers.values()) {
                        const state = await worker.request('get_state', {}, 5000);
                        if (current !== context || supervisor.workers.get(worker.sessionPath) !== worker
                            || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0 || state.webOperation) throw changed();
                        admission.check();
                    }
                    // An idle RPC snapshot cannot fence future extension timers
                    // in another process. Require actual worker exit; the host
                    // never terminates someone's runtime as a cleanup side effect.
                    if (supervisor.workers.size || supervisor.ephemeralWorkers.size || supervisor.retiring.size) {
                        throw Object.assign(new Error('请先退出工作台中已打开的运行实例，再清理附件；用量仍可查看'), { status: 409, code: 'DOCUMENT_STORAGE_BUSY' });
                    }
                },
                check() {
                    if (current !== context) throw changed();
                    admission.check();
                    for (const check of context.checks) check();
                },
                release() {
                    try { context.queueRelease?.(); }
                    finally {
                        if (current === context) current = null;
                        admission.release();
                    }
                }
            };
        }
    };
    async function protectedDocuments({ nativeScope } = {}) {
        const context = current;
        const scheduler = cron();
        await scheduler.ready;
        const queue = await supervisor.getQueueStore();
        const agent = fs.realpathSync.native((await getSdk()).getAgentDir());
        if (context) {
            if (current !== context) throw changed();
            context.admission.check();
            if (!context.queueRelease) context.queueRelease = queue.acquireReferenceLease();
        }
        const scope = settingsScope(agent, nativeScope, store);
        const proofs = [...scope.proofs, fileProof(path.dirname(deferred.filePath), true), fileProof(deferred.filePath),
            fileProof(path.dirname(queue.root), true), fileProof(queue.root, true), fileProof(queue.file)];
        const deferredRevision = deferred.revision;
        const scheduled = deferred.protectedDocuments(), queued = queue.protectedDocuments(), recurring = cronDocumentReferences(scheduler);
        proofs.push(...recurring.proofs);
        const check = () => {
            verifyAll(proofs);
            recurring.check();
            if (deferred.revision !== deferredRevision || deferred.error || queue.fault || queue.operations) throw changed();
        };
        check();
        if (context) context.checks.push(check);
        return { complete: scope.complete && scheduled.complete === true && queued.complete === true && recurring.complete === true,
            ids: [...new Set([...scheduled.ids, ...queued.ids, ...recurring.ids])].sort(),
            revision: createHash('sha256').update(JSON.stringify([scheduled.revision, queued.revision, recurring.revision, proofs])).digest('hex') };
    }
    return { storageGuard, protectedDocuments };
}

module.exports = { documentStorageIntegration, settingsScope };
