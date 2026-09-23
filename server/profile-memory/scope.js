'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const io = require('../pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('../pi-file-descriptor');

const PROFILE_ENTRY = 'pivane-agent-profile';
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
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
            || typeof value.skills?.learnedEnabled !== 'boolean') return null;
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

function verifyNativeSession(context) {
    try { return listSessionFiles(context).files.some(file => {
        let fd;
        try {
            fd = io.openReadSync(file);
            const opened = fs.fstatSync(fd, { bigint: true });
            if (!opened.isFile() || opened.size > BigInt(MAX_SESSION_BYTES) || descriptorPathSync(fd) !== file) return false;
            const first = Buffer.alloc(8192), n = fs.readSync(fd, first, 0, first.length, 0);
            const newline = first.subarray(0, n).indexOf(10);
            if (newline < 0) return false;
            const header = JSON.parse(first.subarray(0, newline).toString('utf8'));
            if (header.id !== context.sessionId || header.cwd !== context.cwd) return false;
            return snapshot(file, context)?.header.id === context.sessionId;
        } catch { return false; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }); } catch { return false; }
}

function listEligibleFiles(context, cap = 20) {
    return listSessionFiles(context).files.filter(file => eligibleFile(file, context)).slice(0, cap);
}

module.exports = { parseContext, binding, eligibleManager, eligibleFile, snapshot, verifyNativeSession,
    listSessionFiles, listEligibleFiles, MAX_SESSION_BYTES };
