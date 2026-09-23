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

// Inspect only metadata lines of the active descriptor; message bodies are never retained.
function activeBinding(file, context) {
    let fd;
    try {
        assertDescriptorBackend();
        if (!file || !inside(context.sessionsRoot, file) || path.extname(file) !== '.jsonl'
            || fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) return null;
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size < 20n) return null;
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) return null;
        const chunk = Buffer.alloc(64 * 1024);
        let prefix = Buffer.alloc(0), header = null, matches = 0, first = true;
        const consume = () => {
            const text = prefix.toString('utf8');
            if (first || /^\s*\{\s*"type"\s*:\s*"custom"/.test(text)) {
                if (prefix.length >= 64 * 1024) throw new Error('Oversize session metadata');
                const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix));
                if (first) { header = entry; first = false; }
                else if (entry.type === 'custom' && entry.customType === PROFILE_ENTRY && entry.data?.sessionId === context.sessionId) {
                    matches++;
                    if (entry.data.version !== 1 || entry.data.profileId !== context.profileId) throw new Error('Wrong binding');
                }
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
                if (prefix.length < 64 * 1024) prefix = Buffer.concat([prefix, fragment.subarray(0, 64 * 1024 - prefix.length)]);
                consume(); start = i + 1;
            }
            if (start < n && prefix.length < 64 * 1024)
                prefix = Buffer.concat([prefix, chunk.subarray(start, start + 64 * 1024 - prefix.length)]);
        }
        if (prefix.length) consume();
        if (header?.type !== 'session' || header.id !== context.sessionId || header.cwd !== context.cwd || matches !== 1) return null;
        if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened) || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(opened)
            || descriptorPathSync(fd) !== file || fs.realpathSync.native(file) !== file || !io.sameIdentityAtPath(file, identity)) return null;
        return { dev: opened.dev, ino: opened.ino, mode: opened.mode, native: identity };
    } catch { return null; }
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

module.exports = { parseContext, binding, eligibleManager, eligibleFile, snapshot, verifyNativeSession, sameActiveFile,
    listSessionFiles, listEligibleFiles, MAX_SESSION_BYTES };
