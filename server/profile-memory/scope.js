'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROFILE_ENTRY = 'pivane-agent-profile';
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_FILES = 5000;

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function directoryIdentity(dir) {
    const real = fs.realpathSync(dir);
    if (real !== path.resolve(dir) || !fs.statSync(real).isDirectory()) throw new Error('Non-canonical profile path');
    return real;
}

function parseContext(raw) {
    if (!raw || raw.length > 8192) return null;
    try {
        const value = JSON.parse(raw);
        if (value.version !== 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(value.profileId)
            || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 200
            || !path.isAbsolute(value.cwd) || !path.isAbsolute(value.profileRoot) || !path.isAbsolute(value.sessionsRoot)
            || typeof value.memory?.enabled !== 'boolean' || typeof value.memory?.autoLearn !== 'boolean'
            || typeof value.skills?.learnedEnabled !== 'boolean') return null;
        const sessionsRoot = directoryIdentity(value.sessionsRoot);
        const agentDir = path.dirname(path.dirname(path.dirname(path.resolve(value.profileRoot))));
        if (directoryIdentity(agentDir) !== agentDir
            || path.resolve(value.profileRoot) !== path.join(agentDir, 'pivane-profiles', 'data', value.profileId)) return null;
        if (fs.existsSync(value.profileRoot)) directoryIdentity(value.profileRoot);
        for (let dir = path.dirname(value.profileRoot); dir !== agentDir; dir = path.dirname(dir)) {
            if (fs.existsSync(dir)) directoryIdentity(dir);
        }
        const cwd = fs.realpathSync(value.cwd);
        if (cwd !== value.cwd) return null;
        return { ...value, sessionsRoot, cwd, agentDir };
    } catch { return null; }
}

function binding(entries, sessionId) {
    const markers = entries.filter(entry => entry?.type === 'custom' && entry.customType === PROFILE_ENTRY);
    // A second marker is not a profile change: it makes the binding ambiguous.
    if (markers.length !== 1) return null;
    const marker = markers[0].data;
    return marker?.version === 1 && marker.sessionId === sessionId && typeof marker.profileId === 'string'
        ? marker.profileId : null;
}

function eligibleManager(manager, context, cwd) {
    try {
        const header = manager.getHeader();
        const file = manager.getSessionFile();
        return header?.id === context.sessionId && header.cwd === context.cwd
            && fs.realpathSync(cwd) === context.cwd
            && binding(manager.getEntries(), header.id) === context.profileId
            && file && inside(context.sessionsRoot, path.resolve(file))
            && fs.realpathSync(file) === path.resolve(file);
    } catch { return false; }
}

function eligibleFile(file, context) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_SESSION_BYTES || stat.size < 20
            || !inside(context.sessionsRoot, path.resolve(file)) || fs.realpathSync(file) !== path.resolve(file)) return false;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const header = JSON.parse(lines[0]);
        if (header.type !== 'session' || typeof header.cwd !== 'string' || !header.id) return false;
        const markers = [];
        for (const line of lines.slice(1)) {
            if (!line.includes(PROFILE_ENTRY)) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'custom' && entry.customType === PROFILE_ENTRY) markers.push(entry);
            } catch { return false; }
        }
        return binding(markers, header.id) === context.profileId;
    } catch { return false; }
}

function verifyNativeSession(context) {
    let inspected = 0;
    for (const directory of fs.readdirSync(context.sessionsRoot, { withFileTypes: true })) {
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
        const dir = path.join(context.sessionsRoot, directory.name);
        if (fs.realpathSync(dir) !== dir) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (++inspected > MAX_SCAN_FILES) return false;
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const file = path.join(dir, entry.name);
            try {
                const fd = fs.openSync(file, 'r');
                let header;
                try {
                    const first = Buffer.alloc(8192);
                    const length = fs.readSync(fd, first, 0, first.length, 0);
                    const newline = first.subarray(0, length).indexOf(10);
                    if (newline < 0) continue;
                    header = JSON.parse(first.subarray(0, newline).toString('utf8'));
                } finally { fs.closeSync(fd); }
                if (header.id === context.sessionId && header.cwd === context.cwd && eligibleFile(file, context)) return true;
            } catch { /* invalid session */ }
        }
    }
    return false;
}

function listEligibleFiles(context, cap = 20) {
    const files = [];
    let inspected = 0;
    for (const directory of fs.readdirSync(context.sessionsRoot, { withFileTypes: true })) {
        if (directory.isSymbolicLink() || !directory.isDirectory()) continue;
        const dir = path.join(context.sessionsRoot, directory.name);
        if (fs.realpathSync(dir) !== dir) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (++inspected > MAX_SCAN_FILES || files.length >= cap) return files;
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const file = path.join(dir, entry.name);
            if (eligibleFile(file, context)) files.push(file);
        }
    }
    return files;
}

module.exports = { parseContext, binding, eligibleManager, eligibleFile, verifyNativeSession, listEligibleFiles, MAX_SESSION_BYTES };
