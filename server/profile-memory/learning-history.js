'use strict';

// Native fork provenance, not a second transcript. Persist only the boundary
// entry ID; inherited message bodies and IDs continue to come from SessionManager.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readSafe } = require('../pi-maintenance-files');
const scope = require('./scope');
const inside = (root, file) => { const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const FORK_BOUNDARY = 'pivane-learning-fork-boundary';
const hash = value => createHash('sha256').update(value).digest('hex');
const sessionKey = manager => hash(`${manager.getSessionFile()}\0${manager.getSessionId()}`);
const pairKey = row => `${row.user.id}:${row.assistant.id}`;
const identity = entry => {
    // Native forks re-chain parentId when labels are removed; all other bytes
    // of inherited entries retain their native meaning.
    const { parentId, ...value } = entry;
    return hash(JSON.stringify(value));
};
function markFork(manager) {
    manager.appendCustomEntry(FORK_BOUNDARY, { version: 1, sessionId: manager.getSessionId(), boundaryId: manager.getLeafId() });
}
function inheritedIds(manager, boundary) {
    if (!boundary?.boundaryId) return new Set();
    const branch = manager.getBranch(boundary.boundaryId);
    if (!branch.length || branch.at(-1).id !== boundary.boundaryId) throw new Error('Learning fork boundary changed');
    return new Set(branch.map(entry => entry.id));
}
function inheritedPair(row, ids) { return ids.has(row.user.id) && ids.has(row.assistant.id); }
function forkBoundary(manager, context, saved) {
    const entries = manager.getEntries(), header = manager.getHeader();
    const markers = entries.filter(entry => entry.type === 'custom' && entry.customType === FORK_BOUNDARY
        && entry.data?.sessionId === header.id);
    if (markers.length) {
        if (markers.length !== 1 || markers[0].data.version !== 1 || typeof markers[0].data.boundaryId !== 'string')
            throw new Error('Invalid learning fork boundary');
        const boundary = { boundaryId: markers[0].data.boundaryId };
        inheritedIds(manager, boundary);
        return boundary;
    }
    if (saved) { inheritedIds(manager, saved); return saved; }
    if (!header.parentSession) return null;
    // Older native forks have no explicit learning marker. Prove their shared
    // prefix once from the canonical parent, including abandoned parent branches.
    // A missing/unsafe/over-budget parent fails closed rather than relearning it.
    const parent = header.parentSession;
    // Older Hermes imports used a temporary native parent that is deliberately
    // removed after import. Their explicit baseline remains the learning fence.
    const baseline = entries.findLast(entry => entry.type === 'custom' && entry.customType === 'pivane-learning-baseline');
    if (baseline && typeof parent === 'string' && path.basename(path.dirname(parent)).startsWith('.pi-import-')
        && baseline.data?.source === 'hermes-import') return { boundaryId: baseline.id };
    if (typeof parent !== 'string' || !path.isAbsolute(parent) || path.resolve(parent) !== parent
        || !inside(context.sessionsRoot, parent) || path.extname(parent) !== '.jsonl'
        || fs.realpathSync.native(parent) !== parent) throw new Error('Unverified learning fork parent');
    const bytes = readSafe(parent, scope.MAX_SOURCE_BYTES);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const parentHeader = raw.shift();
    if (parentHeader?.type !== 'session' || parentHeader.cwd !== header.cwd || parentHeader.id === header.id
        || !Number.isFinite(Date.parse(header.timestamp)) || !(Date.parse(parentHeader.timestamp) <= Date.parse(header.timestamp)))
        throw new Error('Invalid learning fork parent');
    if (raw.length > scope.MAX_SOURCE_ENTRIES) throw new Error('Learning fork parent limit reached');
    const parentEntries = new Map(raw.map(entry => [entry.id, entry]));
    let boundaryId = null;
    for (const entry of entries) {
        const original = parentEntries.get(entry.id);
        if (!original) break;
        if (identity(original) !== identity(entry)) throw new Error('Learning fork inherited entry changed');
        boundaryId = entry.id;
    }
    if (!boundaryId) throw new Error('Learning fork prefix is unproven');
    const boundary = { boundaryId, parentSessionId: parentHeader.id };
    inheritedIds(manager, boundary);
    return boundary;
}
module.exports = { FORK_BOUNDARY, sessionKey, pairKey, markFork, forkBoundary, inheritedIds, inheritedPair };
