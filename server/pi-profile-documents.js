'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { safeFile: selectedFile } = require('./pi-native-service');
const { safeFile: readFile } = require('./profile-memory/management');
const { createMutationLock } = require('./profile-memory/mutation-lock');
const { profileMemoryCapability } = require('./profile-memory/management');
const { documentIndex, pendingDocumentIndex, documentIndexSynced } = require('./profile-memory/document-index');
const { normalizedMemory, profileRevision } = require('./pi-profile-registry');
const { descriptorPathSync } = require('./pi-file-descriptor');
const io = require('./pi-file-io');
const privateFiles = require('./pi-private-files');
const { replaceFileSync } = require('./pi-win32-native');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ID = /^[a-f0-9-]{36}$/;
const revision = (data, generation) => createHash('sha256').update(JSON.stringify([data?.revision ?? null, generation])).digest('hex');
function unavailable(id, target, status, profile) {
    return { version: 1, profileId: id, target, status, content: '', revision: null,
        profileRevision: profileRevision(profile), usage: { used: 0,
            limit: normalizedMemory(profile?.memory ?? {})[target === 'user' ? 'userCharLimit' : 'memoryCharLimit'], unit: 'characters' } };
}
function location(agentDir, id, create) {
    if (!path.isAbsolute(agentDir) || fs.realpathSync.native(agentDir) !== agentDir) throw fail('Invalid identity directory');
    const anchor = selectedFile(agentDir, ['pivane-profiles', 'data', id, '.profile-root'], create);
    const root = path.dirname(anchor);
    if (create) {
        privateFiles.privateDirectory(root);
        if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    }
    if (fs.existsSync(root) && (fs.realpathSync.native(root) !== root || !fs.lstatSync(root).isDirectory())) throw fail('Unsafe profile data directory');
    return root;
}
async function snapshot(root, target, profile, generation, installed, bundle) {
    const file = path.join(root, target === 'user' ? 'USER.md' : 'MEMORY.md');
    const data = readFile(file);
    const content = data?.text ?? '';
    const indexSynced = Boolean(installed && profile.memory?.enabled
        && await documentIndexSynced(root, target, bundle, content));
    if ((readFile(file)?.revision ?? null) !== (data?.revision ?? null)) throw fail('Document changed during read', 409);
    return { version: 1, profileId: profile.id, target, status: 'ready', content,
        revision: revision(data, generation), profileRevision: profileRevision(profile),
        indexSynced, indexStatus: !profile.memory?.enabled ? 'disabled' : !installed ? 'unsupported' : indexSynced ? 'ready' : 'pending',
        usage: { used: content ? content.trim().split('\n§\n').map(part => part.trim()).filter(Boolean).join('\n§\n').length : 0,
            limit: normalizedMemory(profile.memory)[target === 'user' ? 'userCharLimit' : 'memoryCharLimit'], unit: 'characters' } };
}
function validateContent(content, limit) {
    if (typeof content !== 'string' || content.length > limit || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024
        || content.includes('\0') || /\r/.test(content)) throw fail('Invalid or over-limit document');
    // The native adapter separates entries on this exact delimiter. Preserve its format.
    if (content && (content !== content.trim() || content.split('\n§\n').some(part => !part.trim() || part !== part.trim())))
        throw fail('Invalid memory document format');
}
function publish(root, target, content, expected) {
    const file = path.join(root, target === 'user' ? 'USER.md' : 'MEMORY.md');
    const fd = io.openReadSync(root);
    const identity = io.identity(fd), before = fs.fstatSync(fd, { bigint: true });
    const check = () => {
        const now = fs.fstatSync(fd, { bigint: true });
        if (!before.isDirectory() || before.dev !== now.dev || before.ino !== now.ino || before.mode !== now.mode
            || descriptorPathSync(fd) !== root || !io.sameIdentityAtPath(root, identity)) throw fail('Profile directory changed', 409);
    };
    const tmp = path.join(root, `.${target}.${randomUUID()}.tmp`);
    try {
        check();
        privateFiles.writePrivateFileSync(tmp, content, true);
        check();
        if (readFile(file)?.revision !== expected) throw fail('Document changed; reload before saving', 409);
        replaceFileSync(tmp, file);
        privateFiles.privateFileMode(file);
        check();
        if (readFile(file)?.text !== content) throw fail('Document changed during save', 409);
        if (process.platform !== 'win32') fs.fsyncSync(fd);
    } finally { try { fs.unlinkSync(tmp); } catch {} fs.closeSync(fd); }
}
function mountProfileDocumentRoutes(router, { profiles, getAgentDir, bundlePath } = {}) {
    if (!profiles?.getProfile || !profiles?.reserve || typeof getAgentDir !== 'function') throw new TypeError('Expected profiles and getAgentDir');
    const handler = (write) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const id = req.params.id, target = write ? req.body?.target : req.query.target;
            if (!ID.test(id) || !['user', 'memory'].includes(target)) throw fail('Invalid document target or profile');
            if (write && (typeof req.body?.expectedRevision !== 'string' || typeof req.body?.expectedProfileRevision !== 'string'))
                throw fail('Expected revisions are required');
            const work = async () => {
                const profile = await profiles.getProfile(id);
                if (!profile) {
                    if (write) throw fail('Profile not found', 404);
                    return unavailable(id, target, 'missing');
                }
                if (!profile.enabled || target === 'memory' && !profile.memory?.enabled) {
                    if (write) throw fail('Profile document is disabled', 409);
                    return unavailable(id, target, 'disabled', profile);
                }
                const bundle = await (typeof bundlePath === 'function' ? bundlePath() : bundlePath);
                const installed = profileMemoryCapability({ bundlePath: bundle }).installed;
                if (target === 'memory' && !installed) {
                    if (write) throw fail('Profile memory adapter is unavailable', 409);
                    return unavailable(id, target, 'unsupported', profile);
                }
                const agentDir = await getAgentDir();
                const root = location(agentDir, id, write);
                if (!write && !fs.existsSync(root)) return { version: 1, profileId: id, target, status: 'ready', content: '',
                    revision: revision(null, 0), profileRevision: profileRevision(profile), indexSynced: Boolean(installed && profile.memory?.enabled),
                    indexStatus: !profile.memory?.enabled ? 'disabled' : installed ? 'ready' : 'unsupported',
                    usage: { used: 0, limit: normalizedMemory(profile.memory)[target === 'user' ? 'userCharLimit' : 'memoryCharLimit'], unit: 'characters' } };
                const lock = createMutationLock(root);
                if (!write) return lock.inspect(generation => snapshot(root, target, profile, generation, installed, bundle));
                const result = await lock.run(undefined, async generation => {
                    const latest = await profiles.getProfile(id);
                    const current = await snapshot(root, target, latest, generation, installed, bundle);
                    if (current.revision !== req.body.expectedRevision || current.profileRevision !== req.body.expectedProfileRevision)
                        throw fail('Document or profile changed; reload before saving', 409);
                    validateContent(req.body.content, current.usage.limit);
                    const file = path.join(root, target === 'user' ? 'USER.md' : 'MEMORY.md');
                    const old = readFile(file);
                    if (pendingDocumentIndex(root, target) && (!latest.memory.enabled || !installed))
                        throw fail('Document search index is pending repair', 409);
                    const index = latest.memory.enabled && installed ? await documentIndex(root, target, bundle, old, req.body.content) : null;
                    let published = false, marked = false;
                    try {
                        if (index?.repairing) {
                            index.sync();
                            return { ok: true, documentSaved: true, indexSynced: true };
                        }
                        if (index) { index.mark(); marked = true; }
                        publish(root, target, req.body.content, old?.revision);
                        published = true;
                        if (index) { index.sync(); marked = false; }
                        return installed && latest.memory.enabled
                            ? { ok: true, documentSaved: true, indexSynced: true }
                            : { documentSaved: true, indexSynced: false, indexStatus: latest.memory.enabled ? 'unsupported' : 'disabled', httpStatus: 202 };
                    } catch (error) {
                        if (!index && !published) {
                            let actual;
                            try { actual = readFile(file)?.revision ?? null; } catch { actual = undefined; }
                            if (actual === createHash('sha256').update(req.body.content).digest('hex'))
                                return { documentSaved: true, indexSynced: false, indexStatus: latest.memory.enabled ? 'unsupported' : 'disabled',
                                    error: 'Document saved, but its final file checks failed', httpStatus: 503 };
                            if (actual !== old?.revision && !(actual === null && !old))
                                return { documentSaved: 'unknown', indexSynced: false,
                                    error: 'Document publication is uncertain; inspect its current revision', httpStatus: 503 };
                        }
                        if (marked && !published) {
                            // Replacement can succeed before a later descriptor/fsync check fails.
                            // Keep the search gate unless the old bytes are still verified.
                            let actual;
                            try { actual = readFile(file)?.revision ?? null; } catch { actual = undefined; }
                            if (actual === index.plan.after) published = true;
                            else if (actual === index.plan.before) { index.cancel(); marked = false; }
                            else return { documentSaved: 'unknown', indexSynced: false, indexStatus: 'pending',
                                error: 'Document publication is uncertain; inspect its current revision before repairing the index', httpStatus: 503 };
                        }
                        if (!published || !index) throw error;
                        let currentDocument;
                        try { currentDocument = await snapshot(root, target, latest, generation + 1, installed, bundle); }
                        catch { return { documentSaved: 'unknown', indexSynced: false, indexStatus: 'pending',
                            error: 'Document was published but its current revision cannot be verified', httpStatus: 503 }; }
                        return { documentSaved: true, indexSynced: false, indexStatus: 'pending',
                            error: 'Document saved, but memory search indexing needs repair', document: currentDocument, httpStatus: 503 };
                    } finally { index?.close(); }
                });
                // A write reserves a generation before publication; return its actual post-write revision.
                if (result.httpStatus === 503) return result;
                return { ...result, ...await lock.inspect(generation => snapshot(root, target, profile, generation, installed, bundle)) };
            };
            const result = write ? await profiles.reserve(work) : await work();
            const { httpStatus, ...body } = result;
            res.status(httpStatus || 200).json(body);
        } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Profile document unavailable' }); }
    };
    router.get('/profiles/:id/documents', handler(false));
    router.put('/profiles/:id/documents', handler(true));
}
module.exports = { mountProfileDocumentRoutes, location };
