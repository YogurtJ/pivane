const path = require('node:path');
const { hash, readSafe } = require('./pi-maintenance-files');
const { prove, verifyAll } = require('./pi-document-storage-references');
const { verifySessionPrefixes } = require('./pi-session-prefix-proof');
const { decodeSession } = require('./pi-session-relocation');
const { fail } = require('./pi-file-scope');
const changed = () => fail('上传线程的移动来源已变化，请重新核对', 409, 'DOCUMENT_CONTEXT');
const emptyPrefix = { tailLength: 0, tailSha256: hash(Buffer.alloc(0)) };

async function nativeSource(session) {
    const { header } = await verifySessionPrefixes(session, [emptyPrefix]);
    return { pathSha256: hash(session.path), timestamp: header.timestamp };
}

// Draft downloads inherit only the original upload thread's committed native
// move chain. No new model reference or second history is created by this proof.
async function readMoveDraftAccess(store, session, manifest) {
    if (!store.sessionMoves || manifest.sessionId !== session.id || hash(JSON.stringify([manifest.cwd, manifest.sessionId, manifest.requestId])) !== manifest.reference.id) return null;
    const journal = await store.sessionMoves.journal(), chain = [];
    let cursor = session;
    for (const record of [...journal.document.records].reverse()) {
        if (record.status !== 'committed' || record.id !== session.id || record.target.path !== cursor.path || record.target.cwd !== cursor.cwd) continue;
        chain.push(record); cursor = record.source;
        if (cursor.cwd === manifest.cwd && (!manifest.source || manifest.source.pathSha256 === hash(cursor.path))) break;
    }
    if (!chain.length || cursor.cwd !== manifest.cwd || manifest.source && manifest.source.pathSha256 !== hash(cursor.path)) return null;
    try {
        const proofs = [prove(journal.root, true), prove(journal.file)];
        if (hash(JSON.stringify(JSON.parse(readSafe(journal.file)))) !== hash(JSON.stringify(journal.document))) throw changed();
        // The old manifest format has no native-path binding. The immutable
        // source backup and target prefixes supply that binding for old uploads.
        const original = chain.at(-1), backup = path.join(journal.root, original.requestId, 'original.jsonl');
        if (original.backup !== backup) throw changed();
        proofs.push(prove(path.dirname(backup), true), prove(backup));
        const bytes = readSafe(backup, 64 * 1024 ** 2), source = decodeSession(bytes);
        if (hash(bytes) !== original.originalSha256 || source.header.id !== manifest.sessionId || source.header.cwd !== manifest.cwd
            || hash(source.tail) !== original.tailSha256 || source.tail.length !== original.tailLength
            || manifest.source && manifest.source.timestamp !== source.header.timestamp) throw changed();
        const current = await verifySessionPrefixes(session, chain);
        if (JSON.stringify(current.header) !== JSON.stringify({ ...source.header, cwd: session.cwd })) throw changed();
        verifyAll(proofs);
        return hash(JSON.stringify([chain, source.header, manifest.source || null]));
    } catch { throw changed(); }
}
module.exports = { nativeSource, readMoveDraftAccess };
