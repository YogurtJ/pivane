'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const io = require('../pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('../pi-file-descriptor');
const { reviewModelConfig } = require('./auto-learn');
const MAX_FILE = 2 * 1024 * 1024;
const BUNDLE_SHA256 = '0b2d8dae469077d615f46cb7d96d408663dc66980748718441d137293f9f9faa';
const hash = data => createHash('sha256').update(data).digest('hex');
const stamp = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
function safeFile(file) {
    let fd;
    try {
        assertDescriptorBackend();
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FILE)) throw new Error('Unsafe profile file');
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(opened) !== stamp(before) || descriptorPathSync(fd) !== file) throw new Error('Changed profile file');
        const bytes = Buffer.alloc(Number(opened.size));
        let pos = 0;
        while (pos < bytes.length) {
            const n = fs.readSync(fd, bytes, pos, bytes.length - pos, pos);
            if (!n) throw new Error('Changed profile file');
            pos += n;
        }
        if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened)
            || stamp(fs.lstatSync(file, { bigint: true })) !== stamp(opened)
            || descriptorPathSync(fd) !== file || fs.realpathSync.native(file) !== file
            || !io.sameIdentityAtPath(file, identity)) throw new Error('Changed profile file');
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: hash(bytes), updatedAt: new Date(Number(opened.mtimeMs)).toISOString() };
    } catch (error) { if (error.code === 'ENOENT' && fd === undefined) return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function safeDir(dir) {
    if (!fs.existsSync(dir)) return false;
    if (fs.realpathSync.native(dir) !== dir || !fs.lstatSync(dir).isDirectory()) throw new Error('Unsafe profile directory');
    return true;
}
function projectRoots(root) {
    const dirs = [], projects = path.join(root, 'projects');
    if (!safeDir(projects)) return dirs;
    const entries = fs.readdirSync(projects, { withFileTypes: true });
    if (entries.length > 1000) throw new Error('Profile project listing exceeds limit');
    for (const entry of entries) {
        if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
            const dir = path.join(projects, entry.name);
            if (safeDir(dir)) dirs.push(dir);
        }
    }
    return dirs;
}
function listMemories(root, projects) {
    const items = [], versions = [];
    const scopes = [[root, 'memory', 'MEMORY.md'], [root, 'user', 'USER.md'], [root, 'failure', 'failures.md'],
        ...projects.map(dir => [dir, 'project', 'MEMORY.md'])];
    for (const [dir, target, name] of scopes) {
        if (!safeDir(dir)) continue;
        const file = path.join(dir, name), data = safeFile(file);
        if (!data) continue;
        versions.push(`${file}:${data.revision}`);
        let ordinal = 0;
        for (const content of data.text.split('\n§\n').map(part => part.trim()).filter(Boolean)) {
            items.push({ id: hash(`${file}\0${ordinal++}\0${content}`), kind: 'memory', target, content, updatedAt: data.updatedAt });
        }
    }
    return { items, versions };
}
function listSkills(root, projects) {
    const items = [], versions = [];
    for (const dir of [path.join(root, 'skills'), ...projects.map(p => path.join(p, 'skills'))]) {
        if (!safeDir(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        if (entries.length > 1000) throw new Error('Profile skill listing exceeds limit');
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = path.join(dir, entry.name);
            if (!safeDir(skillDir)) continue;
            const file = path.join(skillDir, 'SKILL.md'), data = safeFile(file);
            if (!data) continue;
            const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(data.text)?.[1] || '';
            const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.replace(/^['"]|['"]$/g, '') || '';
            const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.replace(/^['"]|['"]$/g, '') || entry.name;
            items.push({ id: hash(file), kind: 'skill', name, description, updatedAt: data.updatedAt });
            versions.push(`${file}:${data.revision}`);
        }
    }
    return { items, versions };
}
function listExtendedMemories(root, bundle) {
    const dbPath = path.join(root, 'sessions.db');
    if (!fs.existsSync(dbPath)) return { items: [], versions: [] };
    if (!bundle || !path.isAbsolute(bundle) || !safeFile(bundle)) return null;
    const Database = createRequire(bundle)('better-sqlite3');
    // SQLite reads its own WAL; hash logical rows, not the database file mtime.
    if (fs.realpathSync.native(dbPath) !== dbPath || !fs.lstatSync(dbPath).isFile()) throw new Error('Unsafe database');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const count = db.prepare('SELECT COUNT(*) AS total FROM memories').get().total;
        if (count > 10000) throw new Error('Memory browsing limit exceeded');
        const rows = db.prepare('SELECT id, project, target, content, created, last_referenced FROM memories ORDER BY id').all();
        if (rows.some(row => typeof row.content !== 'string' || Buffer.byteLength(row.content) > MAX_FILE)
            || rows.reduce((sum, row) => sum + Buffer.byteLength(row.content), 0) > 8 * MAX_FILE) throw new Error('Memory response budget exceeded');
        const versions = rows.map(row => JSON.stringify(row));
        return { versions, items: rows.map(row => ({ id: hash(`${dbPath}\0${row.id}`), kind: 'memory',
            target: row.project && row.target === 'memory' ? 'project' : row.target,
            content: row.content, createdAt: row.created, updatedAt: row.last_referenced })) };
    } finally { db.close(); }
}
function resolveBundle(bundlePath) { return typeof bundlePath === 'function' ? bundlePath() : bundlePath; }
function profileMemoryCapability({ bundlePath, reviewModel } = {}) {
    const bundle = resolveBundle(bundlePath);
    let installed = false;
    try {
        if (bundle && path.isAbsolute(bundle) && hash(safeFile(bundle)?.text || '') === BUNDLE_SHA256) {
            const Database = createRequire(bundle)('better-sqlite3');
            const check = new Database(':memory:');
            try { check.exec('CREATE VIRTUAL TABLE verify_fts USING fts5(content, tokenize=trigram)'); installed = true; }
            finally { check.close(); }
        }
    } catch { /* missing or incompatible native installation */ }
    return { installed, autoLearn: installed && Boolean(reviewModelConfig(reviewModel)) };
}
// Saved profile lookup and agent dir are asynchronous server-owned callbacks.
function mountProfileMemoryRoutes(router, { profiles, getAgentDir, bundlePath = null }) {
    if (!profiles || typeof profiles.getProfile !== 'function' || typeof getAgentDir !== 'function') {
        throw new TypeError('Expected {profiles.getProfile: async(id), getAgentDir: async()}');
    }
    router.get('/profiles/:id/memory', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const profileId = req.params.id, kind = req.query.kind;
        if (kind !== 'memories' && kind !== 'skills') return res.status(400).json({ error: 'Invalid memory kind' });
        if (!/^[a-f0-9-]{36}$/.test(profileId)) return res.status(400).json({ error: 'Invalid profile id' });
        const base = { version: 1, profileId, revision: null, items: [], hasMore: false };
        try {
            const profile = await profiles.getProfile(profileId);
            if (!profile) return res.json({ ...base, status: 'missing' });
            if (!profile.enabled || (kind === 'memories' && !profile.memory?.enabled)
                || (kind === 'skills' && !profile.skills?.learnedEnabled)) return res.json({ ...base, status: 'disabled' });
            const bundle = await resolveBundle(bundlePath);
            if (!profileMemoryCapability({ bundlePath: bundle }).installed) return res.json({ ...base, status: 'unsupported', reason: 'Profile memory adapter is not installed' });
            const agentDir = await getAgentDir();
            if (!path.isAbsolute(agentDir) || fs.realpathSync.native(agentDir) !== agentDir || profile.id !== profileId)
                throw new Error('Invalid profile identity');
            const root = path.join(agentDir, 'pivane-profiles', 'data', profileId);
            if (!safeDir(root)) return res.json({ ...base, status: 'missing', reason: 'Profile data is not initialized' });
            const projects = projectRoots(root);
            const listing = kind === 'memories' ? listMemories(root, projects) : listSkills(root, projects);
            if (kind === 'memories') {
                const extended = listExtendedMemories(root, bundle);
                if (!extended) return res.json({ ...base, status: 'unsupported', reason: 'Extended memory reader is unavailable' });
                listing.items.push(...extended.items);
                listing.versions.push(...extended.versions);
            }
            const rawOffset = Number(req.query.offset ?? 0);
            if (!Number.isSafeInteger(rawOffset) || rawOffset < 0 || rawOffset > 100000) return res.status(400).json({ error: 'Invalid offset' });
            if (typeof req.query.query !== 'undefined' && (typeof req.query.query !== 'string' || req.query.query.length > 200))
                return res.status(400).json({ error: 'Invalid query' });
            const query = (req.query.query || '').toLocaleLowerCase();
            const matches = query ? listing.items.filter(item => `${item.name || ''} ${item.description || ''} ${item.content || ''}`.toLocaleLowerCase().includes(query)) : listing.items;
            const revision = hash(listing.versions.sort().join('\n'));
            return res.json({ ...base, status: 'ready', revision, items: matches.slice(rawOffset, rawOffset + 50), hasMore: matches.length > rawOffset + 50 });
        } catch { return res.json({ ...base, status: 'error', reason: 'Profile data cannot be read' }); }
    });
}
module.exports = { mountProfileMemoryRoutes, profileMemoryCapability, safeFile };
