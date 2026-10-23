// Immutable authorization evidence for Web-created forks. Native JSONL remains
// the only history; receipts contain file references and a native-prefix proof.
const fs = require('node:fs');
const path = require('node:path');
const { getSdk } = require('./pi-session-store');
const { privateDir, readSafe, hash } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');
const { MAX_PREFIX, createPrefixProofSync, verifySessionPrefixes } = require('./pi-session-prefix-proof');
const documents = require('../public/pi-document-references');
const ENTRY = 'pivane-fork-access';
const MAX_RECEIPT = 512 * 1024, MAX_SESSION = 64 * 1024 * 1024;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => Object.assign(new Error('分叉文件来源证明无效或已变化'), { status: 409, code: 'FORK_ACCESS_CHANGED' });
const referenceKey = ref => `${ref.id}:${ref.manifestRevision}`;

async function directory(create = false) {
    const agent = fs.realpathSync.native((await getSdk()).getAgentDir());
    let current = agent;
    for (const part of ['pivane-session-moves', 'forks']) {
        current = path.join(current, part);
        if (create && privateDir(current) !== current) throw fail();
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(current) !== current) throw fail();
    }
    return current;
}
const filename = (root, id) => path.join(root, hash(id) + '.json');
function validate(receipt, session) {
    if (![1, 2].includes(receipt?.version) || receipt.target?.id !== session.id
        || typeof receipt.target.cwd !== 'string' || !path.isAbsolute(receipt.target.cwd)
        || typeof receipt.target.path !== 'string' || !path.isAbsolute(receipt.target.path)
        || typeof receipt.created !== 'string' || !hex(receipt.tailSha256)
        || !Number.isSafeInteger(receipt.tailLength) || receipt.tailLength < 0 || receipt.tailLength > (receipt.version === 1 ? MAX_SESSION : MAX_PREFIX)
        || !Array.isArray(receipt.deliveries) || receipt.deliveries.length > 500
        || receipt.deliveries.some(ref => !hex(ref.id) || !hex(ref.manifestRevision) || typeof ref.cwd !== 'string' || !path.isAbsolute(ref.cwd))
        || !Array.isArray(receipt.documents) || receipt.documents.length > 8 || receipt.documents.some(ref => !documents.valid(ref))) throw fail();
}
async function readForkAccess(store, session) {
    let bytes;
    try { bytes = readSafe(filename(await directory(), session.id), MAX_RECEIPT); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const receipt = JSON.parse(bytes); validate(receipt, session);
    const revision = hash(bytes);
    let parsed;
    try { parsed = await verifySessionPrefixes(session, [receipt], { marker: true }); }
    catch { throw fail(); }
    const entry = parsed.marker;
    if (receipt.created !== parsed.header.timestamp || entry?.type !== 'custom' || entry.customType !== ENTRY
        || typeof entry.id !== 'string' || !entry.id || !(entry.parentId === null || typeof entry.parentId === 'string')
        || entry.data?.version !== receipt.version || entry.data.sessionId !== session.id || entry.data.revision !== revision) throw fail();
    // Moving a grantee preserves its ID and native prefix, but a hand-edited
    // header/path is not a relocation. Require the existing committed move chain.
    if (receipt.target.cwd !== session.cwd || receipt.target.path !== session.path) {
        if (!store.sessionMoves) throw fail();
        const resolved = await store.sessionMoves.resolve(receipt.target.cwd, session.id);
        if (resolved.session.path !== session.path || resolved.session.cwd !== session.cwd) throw fail();
    }
    return { ...receipt, revision };
}
async function deliveryProof(store, session) {
    const proof = store.sessionMoves ? await store.sessionMoves.deliveryProof(session) : new Map([[session.cwd, null]]);
    const access = await readForkAccess(store, session);
    for (const ref of access?.deliveries || []) {
        if (proof.get(ref.cwd) === null) continue;
        if (!proof.has(ref.cwd)) proof.set(ref.cwd, new Set());
        proof.get(ref.cwd).add(referenceKey(ref));
    }
    proof.forkRevision = access?.revision || null;
    return proof;
}
async function checkForkAccess(store, session, revision) {
    if (((await readForkAccess(store, session))?.revision || null) !== revision) throw fail();
}

// Called under the source worker's existing exclusive slot, before publishing
// a new session. Only the selected native path and the selected question qualify.
async function prepareForkAccess(store, session, branch, draftEntry) {
    const refs = require('./pi-deliverables').references(branch);
    const drafts = draftEntry ? documents.references([draftEntry]) : [];
    if (drafts.length > 5) throw new Error('一次最多添加 5 个文档附件');
    const deliveries = [];
    if (refs.length) {
        const proof = await deliveryProof(store, session);
        const objects = new (require('./pi-deliverables').DeliverableStore)(store);
        for (const ref of refs) {
            const key = referenceKey(ref);
            if (![...proof].some(([cwd, allowed]) => cwd !== session.cwd && allowed?.has(key))) continue;
            let manifest;
            try { ({ manifest } = await objects.manifest(ref.id, ref.manifestRevision)); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            // Move chains may qualify the same reference in several projects.
            // Only its verified immutable manifest identifies the actual origin.
            const cwd = manifest.cwd;
            if (cwd !== session.cwd && proof.get(cwd)?.has(key)) deliveries.push({ cwd, id: ref.id, manifestRevision: ref.manifestRevision });
        }
    }
    if (!deliveries.length && !drafts.length) return () => {};
    if (deliveries.length > 500) throw new Error('分叉文件引用超过预算');
    const root = await directory(true);
    // No await here: native publication, receipt persistence and its native
    // marker finish before another request can open the new worker.
    return manager => {
        const target = { id: manager.getSessionId(), cwd: manager.getCwd(), path: fs.realpathSync.native(manager.getSessionFile()) };
        require('./pi-private-files').privateFileMode(target.path);
        const parsed = createPrefixProofSync(target);
        const receipt = { version: 2, target, created: parsed.header.timestamp,
            source: { id: session.id, cwd: session.cwd }, tailLength: parsed.tailLength, tailSha256: parsed.tailSha256, deliveries, documents: drafts };
        validate(receipt, target);
        const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
        if (bytes.length > MAX_RECEIPT) throw new Error('分叉文件来源证明超过预算');
        writePrivateFileSync(filename(root, target.id), bytes, true);
        if (process.platform !== 'win32') { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        manager.appendCustomEntry(ENTRY, { version: 2, sessionId: target.id, revision: hash(bytes) });
    };
}
module.exports = { ENTRY, readForkAccess, deliveryProof, checkForkAccess, prepareForkAccess };
