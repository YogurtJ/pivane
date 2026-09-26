'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const io = require('../pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('../pi-file-descriptor');

const PROFILE_ENTRY = 'pivane-agent-profile';
const MEMORY_READ_ENTRY = 'pivane-profile-memory-read';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_LOOKUP_ENTRIES = 20000;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
// Provenance writes must work on long conversations, so their streaming proof
// budget sits well above the 8 MiB historical index bound and fails explicitly.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 200000;
const MAX_SCAN_FILES = 5000;
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function directoryIdentity(dir) {
    const real = fs.realpathSync.native(dir);
    if (real !== path.resolve(dir) || !fs.statSync(real).isDirectory()) throw new Error('Non-canonical profile path');
    return real;
}

function parseContext(raw) {
    if (!raw || raw.length > 8192) return null;
    try {
        const value = JSON.parse(raw);
        if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.profileId)
            || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 200
            || !path.isAbsolute(value.cwd) || !path.isAbsolute(value.profileRoot) || !path.isAbsolute(value.sessionsRoot)
            || typeof value.memory?.enabled !== 'boolean' || typeof value.memory?.autoLearn !== 'boolean'
            || !Number.isSafeInteger(value.memory.memoryCharLimit) || value.memory.memoryCharLimit < 256 || value.memory.memoryCharLimit > 65536
            || !Number.isSafeInteger(value.memory.userCharLimit) || value.memory.userCharLimit < 256 || value.memory.userCharLimit > 32768
            || typeof value.skills?.learnedEnabled !== 'boolean') return null;
        if (value.sessionPath !== undefined && (typeof value.sessionPath !== 'string'
            || !path.isAbsolute(value.sessionPath) || path.resolve(value.sessionPath) !== value.sessionPath)) return null;
        const agentDir = path.dirname(path.dirname(path.dirname(path.resolve(value.profileRoot))));
        if (directoryIdentity(agentDir) !== agentDir
            || path.resolve(value.profileRoot) !== path.join(agentDir, 'pivane-profiles', 'data', value.profileId)
            || value.sessionsRoot !== path.join(agentDir, 'sessions')
            || directoryIdentity(value.sessionsRoot) !== value.sessionsRoot) return null;
        if (fs.existsSync(value.profileRoot)) directoryIdentity(value.profileRoot);
        for (let dir = path.dirname(value.profileRoot); dir !== agentDir; dir = path.dirname(dir)) {
            if (fs.existsSync(dir)) directoryIdentity(dir);
        }
        const cwd = fs.realpathSync.native(value.cwd);
        if (cwd !== value.cwd) return null;
        if (value.sessionPath !== undefined && (!inside(value.sessionsRoot, value.sessionPath)
            || path.extname(value.sessionPath) !== '.jsonl')) return null;
        return { ...value, sessionsRoot: path.join(agentDir, 'sessions'), cwd, agentDir };
    } catch { return null; }
}

function binding(entries, sessionId) {
    const markers = entries.filter(entry => entry?.type === 'custom' && entry.customType === PROFILE_ENTRY
        && entry.data?.sessionId === sessionId);
    if (markers.length !== 1 || markers[0].data.version !== 1) return null;
    const profileId = markers[0].data.profileId;
    return profileId === null || typeof profileId === 'string' && /^[a-f0-9-]{36}$/.test(profileId)
        ? { sessionId, profileId } : null;
}

function eligibleManager(manager, context, cwd) {
    try {
        const header = manager.getHeader();
        const file = manager.getSessionFile();
        return manager.getSessionId() === context.sessionId && header?.id === context.sessionId && header.cwd === context.cwd
            && fs.realpathSync.native(cwd) === context.cwd
            && binding(manager.getEntries(), header.id)?.profileId === context.profileId
            && file && inside(context.sessionsRoot, path.resolve(file))
            && (!context.sessionPath || file === context.sessionPath)
            && fs.realpathSync.native(file) === path.resolve(file);
    } catch { return false; }
}

// The opened descriptor supplies both the identity check and the bytes parsed/indexed.
function snapshot(file, context) {
    let fd;
    try {
        assertDescriptorBackend();
        file = path.resolve(file);
        if (!inside(context.sessionsRoot, file) || path.extname(file) !== '.jsonl'
            || fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) return null;
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size < 20n || before.size > BigInt(MAX_SESSION_BYTES)) return null;
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) return null;
        const bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
            const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!n) return null;
            offset += n;
        }
        const after = fs.lstatSync(file, { bigint: true });
        if (stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true })) || stamp(after) !== stamp(opened)
            || descriptorPathSync(fd) !== file || fs.realpathSync.native(file) !== file
            || !io.sameIdentityAtPath(file, identity)) return null;
        const entries = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(Boolean).map(line => JSON.parse(line));
        const header = entries[0];
        if (header?.type !== 'session' || !header.id || !header.timestamp || !path.isAbsolute(header.cwd)
            || fs.realpathSync.native(header.cwd) !== header.cwd
            || binding(entries, header.id)?.profileId !== context.profileId) return null;
        return { file, header, entries, fingerprint: createHash('sha256').update(bytes).digest('hex'), stamp: stamp(opened), bytes: bytes.length };
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function eligibleFile(file, context) { return Boolean(snapshot(file, context)); }

function listSessionFiles(context, startAfter = '', cap = MAX_SCAN_FILES) {
    const files = [];
    let limited = false;
    for (const directory of fs.readdirSync(context.sessionsRoot, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
        const dir = path.join(context.sessionsRoot, directory.name);
        if (fs.realpathSync.native(dir) !== dir) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const file = path.join(dir, entry.name);
            if (file <= startAfter) continue;
            if (files.length >= cap) { limited = true; break; }
            files.push(file);
        }
        if (limited) break;
    }
    return { files, limited };
}

// Inspect only metadata lines (the header and custom entries) of one opened
// descriptor; message bodies are never retained. `maxBytes` makes an oversize
// session fail explicitly instead of returning a partial answer.
function streamSessionMetadata(file, sessionsRoot, visit, maxBytes) {
    let fd;
    try {
        assertDescriptorBackend();
        if (!file || !inside(sessionsRoot, file) || path.extname(file) !== '.jsonl'
            || fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) return null;
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size < 20n) return null;
        if (maxBytes !== undefined && before.size > BigInt(maxBytes))
            throw Object.assign(new Error('Native session exceeds source proof limits'), { code: 'SOURCE_PROOF_LIMIT' });
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) return null;
        const chunk = Buffer.alloc(64 * 1024);
        let prefix = Buffer.alloc(0), header = null, first = true;
        const consume = () => {
            const text = prefix.toString('utf8');
            if (first || /^\s*\{\s*"type"\s*:\s*"custom"/.test(text)) {
                if (prefix.length >= MAX_METADATA_BYTES) throw new Error('Oversize session metadata');
                const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix));
                if (first) { header = entry; first = false; }
                else if (entry.type === 'custom') visit(entry);
            }
            prefix = Buffer.alloc(0);
        };
        let offset = 0;
        while (offset < Number(opened.size)) {
            const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, Number(opened.size) - offset), offset);
            if (!n) return null;
            offset += n;
            let start = 0;
            for (let i = 0; i < n; i++) if (chunk[i] === 10) {
                const fragment = chunk.subarray(start, i);
                if (prefix.length < MAX_METADATA_BYTES) prefix = Buffer.concat([prefix, fragment.subarray(0, MAX_METADATA_BYTES - prefix.length)]);
                consume(); start = i + 1;
            }
            if (start < n && prefix.length < MAX_METADATA_BYTES)
                prefix = Buffer.concat([prefix, chunk.subarray(start, start + MAX_METADATA_BYTES - prefix.length)]);
        }
        if (prefix.length) consume();
        if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(opened)
            || descriptorPathSync(fd) !== file || fs.realpathSync.native(file) !== file || !io.sameIdentityAtPath(file, identity)) return null;
        return { header, identity: { dev: opened.dev, ino: opened.ino, mode: opened.mode, native: identity } };
    } catch (error) {
        if (error?.code === 'SOURCE_PROOF_LIMIT') throw error;
        return null;
    }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function activeBinding(file, context) {
    let matches = 0;
    const scanned = streamSessionMetadata(file, context.sessionsRoot, entry => {
        if (entry.customType === PROFILE_ENTRY && entry.data?.sessionId === context.sessionId) {
            matches++;
            if (entry.data.version !== 1 || entry.data.profileId !== context.profileId) throw new Error('Wrong binding');
        }
    });
    const header = scanned?.header;
    if (header?.type !== 'session' || header.id !== context.sessionId || header.cwd !== context.cwd || matches !== 1) return null;
    return scanned.identity;
}

// The session ID lives in the header line, not in the file name (Pi names files
// `<timestamp>_<fileId>.jsonl` with an unrelated ID). Only the first line of each
// file is read; callers must still prove the header and binding of the single match.
const HEADER_BYTES = 64 * 1024;
const lookupCache = new Map();
function headerSessionId(file) {
    let fd;
    try {
        fd = io.openReadSync(file);
        const buffer = Buffer.alloc(HEADER_BYTES);
        const length = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
        const end = buffer.subarray(0, length).indexOf(0x0a);
        if (end < 0) return null;
        const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
        return header?.type === 'session' && typeof header.id === 'string' ? header.id : null;
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sessionFilesById(sessionsRoot, sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
    const cached = lookupCache.get(`${sessionsRoot}\0${sessionId}`);
    if (cached && inside(sessionsRoot, cached) && headerSessionId(cached) === sessionId) return [cached];
    const files = [];
    let scanned = 0;
    for (const directory of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
        const dir = path.join(sessionsRoot, directory.name);
        if (fs.realpathSync.native(dir) !== dir) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            if (++scanned > MAX_LOOKUP_ENTRIES)
                throw Object.assign(new Error('Session lookup exceeds scan limit'), { code: 'SOURCE_PROOF_LIMIT' });
            const file = path.join(dir, entry.name);
            if (headerSessionId(file) === sessionId) files.push(file);
        }
    }
    if (files.length === 1) {
        if (lookupCache.size >= 256) lookupCache.delete(lookupCache.keys().next().value);
        lookupCache.set(`${sessionsRoot}\0${sessionId}`, files[0]);
    }
    return files;
}

// Server-side proof that a native session file is bound to one profile, taking
// the canonical cwd from its own header (never from a client). It also returns
// the data of the latest memory-read entry recorded for that profile.
function profileSession(file, { sessionsRoot, profileId, sessionId }) {
    let matches = 0, lastRead = null;
    const scanned = streamSessionMetadata(file, sessionsRoot, entry => {
        if (entry.customType === PROFILE_ENTRY && entry.data?.sessionId === sessionId) {
            matches++;
            if (entry.data.version !== 1 || entry.data.profileId !== profileId) throw new Error('Wrong binding');
        } else if (entry.customType === MEMORY_READ_ENTRY && entry.data?.profileId === profileId) lastRead = entry.data;
    }, MAX_SOURCE_BYTES);
    const header = scanned?.header;
    try {
        if (header?.type !== 'session' || header.id !== sessionId || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)
            || fs.realpathSync.native(header.cwd) !== header.cwd || matches !== 1) return null;
    } catch { return null; }
    return { file, cwd: header.cwd, identity: scanned.identity, lastRead };
}

// Streams one session line by line like activeBinding, retaining only entry
// id/parentId edges. Pi SessionManager keeps the leaf at the last appended entry
// (session-manager.js _buildIndex) and walks parentId to the root (getBranch),
// so the claimed entry must sit on that path: entries on abandoned branches fail.
// Over-budget sessions throw instead of proving a truncated tree.
function sourceProof(file, context, entryId) {
    let fd;
    const overBudget = () => { throw Object.assign(new Error('Native session exceeds source proof limits'), { code: 'SOURCE_PROOF_LIMIT' }); };
    try {
        assertDescriptorBackend();
        if (typeof entryId !== 'string' || !entryId || entryId.length > 200) return null;
        file = path.resolve(file);
        if (!inside(context.sessionsRoot, file) || path.extname(file) !== '.jsonl'
            || fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) return null;
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size < 20n) return null;
        if (before.size > BigInt(MAX_SOURCE_BYTES)) overBudget();
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) return null;
        if (opened.size > BigInt(MAX_SOURCE_BYTES)) overBudget();
        const chunk = Buffer.alloc(64 * 1024);
        const parents = new Map();
        let fragments = [], header = null, first = true, matches = 0, leafId = null, entries = 0;
        const consume = () => {
            const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
            fragments = [];
            if (!line.length) return;
            const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
            if (first) { header = entry; first = false; return; }
            if (entry?.type === 'custom' && entry.customType === PROFILE_ENTRY && entry.data?.sessionId === context.sessionId) {
                matches++;
                if (entry.data.version !== 1 || entry.data.profileId !== context.profileId) throw new Error('Wrong binding');
            }
            if (entry?.type === 'session') return;
            if (typeof entry?.id !== 'string' || !entry.id || entry.id.length > 200
                || entry.parentId != null && typeof entry.parentId !== 'string') throw new Error('Malformed entry');
            if (++entries > MAX_SOURCE_ENTRIES) overBudget();
            parents.set(entry.id, entry.parentId || null);
            leafId = entry.id;
        };
        let offset = 0;
        while (offset < Number(opened.size)) {
            const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, Number(opened.size) - offset), offset);
            if (!n) return null;
            offset += n;
            let start = 0;
            for (let i = 0; i < n; i++) if (chunk[i] === 10) {
                fragments.push(Buffer.from(chunk.subarray(start, i)));
                consume(); start = i + 1;
            }
            if (start < n) fragments.push(Buffer.from(chunk.subarray(start, n)));
        }
        if (fragments.length) consume();
        if (header?.type !== 'session' || header.id !== context.sessionId || header.cwd !== context.cwd
            || !path.isAbsolute(header.cwd) || fs.realpathSync.native(header.cwd) !== header.cwd
            || matches !== 1) return null;
        const chain = new Set();
        let current = leafId;
        while (current) {
            if (chain.has(current)) return null;
            chain.add(current);
            const parent = parents.get(current);
            current = parent && parents.has(parent) ? parent : null;
        }
        if (!chain.has(entryId)) return null;
        if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(opened)
            || descriptorPathSync(fd) !== file || fs.realpathSync.native(file) !== file || !io.sameIdentityAtPath(file, identity)) return null;
        return { dev: opened.dev, ino: opened.ino, mode: opened.mode, native: identity };
    } catch (error) {
        if (error?.code === 'SOURCE_PROOF_LIMIT') throw error;
        return null;
    }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function verifyNativeSession(context, manager) {
    try {
        if (manager && !eligibleManager(manager, context, context.cwd)) return null;
        const file = manager?.getSessionFile() || context.sessionPath;
        if (!file || context.sessionPath && file !== context.sessionPath) return null;
        return activeBinding(file, context);
    } catch { return null; }
}

function sameActiveFile(file, proof) {
    let fd;
    try {
        if (!proof || fs.realpathSync.native(file) !== file) return false;
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true });
        return opened.isFile() && opened.dev === proof.dev && opened.ino === proof.ino && opened.mode === proof.mode
            && descriptorPathSync(fd) === file && io.sameIdentityAtPath(file, proof.native);
    } catch { return false; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function listEligibleFiles(context, cap = 20) {
    return listSessionFiles(context).files.filter(file => eligibleFile(file, context)).slice(0, cap);
}

module.exports = { parseContext, binding, eligibleManager, eligibleFile, snapshot, sourceProof, verifyNativeSession, sameActiveFile,
    listSessionFiles, listEligibleFiles, sessionFilesById, profileSession, MAX_SESSION_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_ENTRIES };
