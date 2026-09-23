'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const MAX_FILE = 2 * 1024 * 1024;
function safeFile(file) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE || fs.realpathSync(file) !== file) return null;
        return { text: fs.readFileSync(file, 'utf8'), revision: `${stat.size}:${Math.trunc(stat.mtimeMs)}` };
    } catch { return null; }
}
function projectRoots(root) {
    const dirs = [];
    const projects = path.join(root, 'projects');
    try {
        if (fs.realpathSync(projects) === projects) {
            for (const entry of fs.readdirSync(projects, { withFileTypes: true }).slice(0, 1000)) {
                if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) dirs.push(path.join(projects, entry.name));
            }
        }
    } catch { /* no project records */ }
    return dirs;
}
function listMemories(root) {
    const items = [];
    const versions = [];
    const scopes = [[root, 'memory', 'MEMORY.md'], [root, 'user', 'USER.md'], [root, 'failure', 'failures.md'],
        ...projectRoots(root).map(dir => [dir, 'project', 'MEMORY.md'])];
    for (const [dir, target, name] of scopes) {
        if (dir !== root && fs.realpathSync(dir) !== dir) continue;
        const file = path.join(dir, name);
        const data = safeFile(file);
        if (!data) continue;
        versions.push(`${file}:${data.revision}`);
        for (const content of data.text.split('\n§\n').map(part => part.trim()).filter(Boolean)) {
            items.push({ id: createHash('sha256').update(`${file}\0${target}\0${content}`).digest('hex'), kind: 'memory', target, content });
        }
    }
    return { items, versions };
}
function listSkills(root) {
    const items = [];
    const versions = [];
    const dirs = [path.join(root, 'skills'), ...projectRoots(root).map(dir => path.join(dir, 'skills'))];
    for (const dir of dirs) {
        try {
            if (fs.realpathSync(dir) !== dir) continue;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 1000)) {
                if (!entry.isDirectory()) continue;
                const file = path.join(dir, entry.name, 'SKILL.md');
                const data = safeFile(file);
                if (!data) continue;
                const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(data.text)?.[1] || '';
                const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.replace(/^['"]|['"]$/g, '') || '';
                const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.replace(/^['"]|['"]$/g, '') || entry.name;
                items.push({ id: createHash('sha256').update(file).digest('hex'), kind: 'skill', name, description,
                    updatedAt: new Date(fs.statSync(file).mtimeMs).toISOString() });
                versions.push(`${file}:${data.revision}`);
            }
        } catch { /* missing directory */ }
    }
    return { items, versions };
}

function listExtendedMemories(root, bundlePath) {
    const dbPath = path.join(root, 'sessions.db');
    if (!fs.existsSync(dbPath)) return { items: [], versions: [] };
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || fs.realpathSync(dbPath) !== dbPath) throw new Error('Unsafe memory database');
    if (!bundlePath || !path.isAbsolute(bundlePath) || !fs.existsSync(bundlePath)) return null;
    const Database = createRequire(bundlePath)('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const count = db.prepare('SELECT COUNT(*) AS total FROM memories').get().total;
        if (count > 10000) throw new Error('Memory browsing limit exceeded');
        const rows = db.prepare('SELECT id, project, target, content, created, last_referenced FROM memories ORDER BY id').all();
        return { versions: [`sessions.db:${stat.size}:${Math.trunc(stat.mtimeMs)}`],
            items: rows.map(row => ({
                id: createHash('sha256').update(`${row.target}\0${row.project || ''}\0${row.content}`).digest('hex'),
                kind: 'memory', target: row.project && row.target === 'memory' ? 'project' : row.target,
                content: row.content, createdAt: row.created, updatedAt: row.last_referenced,
            })) };
    } finally { db.close(); }
}

// profiles.getProfile(id) returns a saved record or null; agentDir is the server's Pi identity directory.
function mountProfileMemoryRoutes(router, { profiles, agentDir, bundlePath = null }) {
    if (!profiles || typeof profiles.getProfile !== 'function' || !path.isAbsolute(agentDir)) {
        throw new TypeError('Expected {profiles.getProfile(id), agentDir}');
    }
    router.get('/profiles/:id/memory', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const profileId = req.params.id;
        const kind = req.query.kind;
        if (kind !== 'memories' && kind !== 'skills') return res.status(400).json({ error: 'Invalid memory kind' });
        const base = { version: 1, profileId, revision: null, items: [], hasMore: false };
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(profileId)) return res.status(400).json({ error: 'Invalid profile id' });
        const profile = profiles.getProfile(profileId);
        if (!profile) return res.json({ ...base, status: 'missing' });
        if (!profile.enabled || (kind === 'memories' && !profile.memory?.enabled)
            || (kind === 'skills' && !profile.skills?.learnedEnabled)) return res.json({ ...base, status: 'disabled' });
        try {
            const root = path.join(agentDir, 'pivane-profiles', 'data', profile.id);
            if (profile.id !== profileId || !/^[A-Za-z0-9_-]{1,80}$/.test(profileId)
                || !fs.existsSync(root)) return res.json({ ...base, status: 'ready' });
            if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw new Error('Unsafe profile root');
            const listing = kind === 'memories' ? listMemories(root) : listSkills(root);
            if (kind === 'memories') {
                const extended = listExtendedMemories(root, bundlePath);
                if (!extended) return res.json({ ...base, status: 'unsupported', reason: 'Extended memory reader is not configured' });
                const known = new Set(listing.items.map(item => `${item.target}\0${item.content}`));
                listing.items.push(...extended.items.filter(item => !known.has(`${item.target}\0${item.content}`)));
                listing.versions.push(...extended.versions);
            }
            const { items, versions } = listing;
            const rawOffset = Number(req.query.offset ?? 0);
            if (!Number.isSafeInteger(rawOffset) || rawOffset < 0 || rawOffset > 100000) return res.status(400).json({ error: 'Invalid offset' });
            const query = typeof req.query.query === 'string' ? req.query.query.slice(0, 200).toLocaleLowerCase() : '';
            const matches = query ? items.filter(item => `${item.name || ''} ${item.description || ''} ${item.content || ''}`.toLocaleLowerCase().includes(query)) : items;
            const revision = createHash('sha256').update(versions.sort().join('\n')).digest('hex');
            return res.json({ ...base, status: 'ready', revision, items: matches.slice(rawOffset, rawOffset + 50), hasMore: matches.length > rawOffset + 50 });
        } catch {
            return res.json({ ...base, status: 'error', reason: 'Profile data cannot be read' });
        }
    });
}
module.exports = { mountProfileMemoryRoutes };
