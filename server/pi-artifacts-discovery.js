'use strict';

// Disposable, bounded source discovery. Never indexes message text or writes
// native sessions. A candidate is only a locator; the native branch still owns
// every delivery reference at list/read time.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const io = require('./pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('./pi-file-descriptor');
const { withinCanonical: within } = require('./pi-platform-path');
const stamp = stat => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(stat[k])).join(':');
const hash = value => createHash('sha256').update(value).digest('hex');
const LIMITS = { directories: 300, files: 800, entries: 12000, bytes: 128 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, historyBytes: 16 * 1024 * 1024, milliseconds: 8000, media: 300 };
const MEDIA = { image: ['generation_history.json', 'images'], video: ['video_history.json', 'videos'], audio: ['tts_history.json', 'audio'] };
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f/\\]/.test(value) && !['.', '..'].includes(value);
function mediaLocator(kind, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const folder = MEDIA[kind][1], url = raw[`${kind === 'audio' ? 'audio' : kind}Url`];
    // Old records may use filename or a local URL. Never accept external URLs,
    // query strings, nested paths, dot aliases or caller supplied absolute paths.
    const filename = raw.filename || (typeof url === 'string' && url.startsWith(`/${folder}/`) ? url.slice(folder.length + 2) : null);
    if (!safeName(filename) || /[%?#]/.test(filename)) return null;
    const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : filename;
    if (!id || id.length > 160) return null;
    return { kind, id, filename, recordRevision: hash(JSON.stringify(raw)), title: filename,
        createdAt: typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : null,
        model: String(raw.labModelId || raw.model || '').slice(0, 120) };
}
function verifiedBytes(filename, root, maxBytes, reserve = () => {}) {
    let fd;
    try {
        const before = fs.lstatSync(filename, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error('source-size');
        fd = io.openReadSync(filename);
        const opened = fs.fstatSync(fd, { bigint: true }), actual = descriptorPathSync(fd), identity = io.identity(fd);
        if (actual !== filename || !within(root, actual) || stamp(before) !== stamp(opened)) throw new Error('source-changed');
        // Reserve before I/O, including the extra EOF/change probe. A later
        // identity failure must not refund bytes that were already read.
        reserve(Number(opened.size) + 1);
        const buffer = Buffer.alloc(Number(opened.size) + 1); let size = 0;
        while (size < buffer.length) { const n = fs.readSync(fd, buffer, size, buffer.length - size, size); if (!n) break; size += n; }
        if (size !== Number(opened.size) || stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true }))
            || stamp(opened) !== stamp(fs.lstatSync(filename, { bigint: true })) || descriptorPathSync(fd) !== actual
            || fs.realpathSync.native(filename) !== actual || !io.sameIdentityAtPath(filename, identity)) throw new Error('source-changed');
        return buffer.subarray(0, size);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function discover(input, limits = LIMITS) {
    assertDescriptorBackend();
    const coverage = { scannedSessions: 0, skippedSources: 0, limited: false }, sessions = [], media = [];
    const started = Date.now(); let entries = 0, bytes = 0, files = 0, directories = 0;
    const budget = () => { if (++entries > limits.entries || bytes >= limits.bytes || Date.now() - started >= limits.milliseconds) { coverage.limited = true; return false; } return true; };
    function* names(directory, root) {
        let dir, fd;
        try {
            const before = fs.lstatSync(directory, { bigint: true });
            if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync.native(directory) !== directory || !within(root, directory)) throw new Error('directory');
            fd = io.openReadSync(directory); const identity = io.identity(fd), opened = fs.fstatSync(fd, { bigint: true });
            if (stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== directory) throw new Error('directory');
            dir = fs.opendirSync(process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory);
            let item;
            while (budget() && (item = dir.readSync())) yield item;
            if (descriptorPathSync(fd) !== directory || fs.realpathSync.native(directory) !== directory || !io.sameIdentityAtPath(directory, identity)
                || stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true })) || stamp(opened) !== stamp(fs.lstatSync(directory, { bigint: true }))) throw new Error('directory-changed');
        } finally { try { dir?.closeSync(); } finally { if (fd !== undefined) fs.closeSync(fd); } }
    }
    try {
        const root = fs.realpathSync.native(input.sessionRoot);
        const projectDirectory = input.cwd ? path.basename(require('./pi-session-relocation').sessionDirectory(path.dirname(root), input.cwd)) : null;
        const folders = projectDirectory ? [{ name: projectDirectory, isDirectory: () => true }] : names(root, root);
        for (const folder of folders) {
            if (!folder.isDirectory()) continue;
            if (++directories > limits.directories) { coverage.limited = true; break; }
            const directory = path.join(root, folder.name), found = [];
            try {
                for (const entry of names(directory, root)) {
                    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
                    if (++files > limits.files) { coverage.limited = true; break; }
                    const filename = path.join(directory, entry.name);
                    try {
                        const stat = fs.lstatSync(filename); if (stat.size > limits.fileBytes || stat.size > limits.bytes - bytes) { coverage.skippedSources++; continue; }
                        const content = verifiedBytes(filename, root, Math.min(limits.fileBytes, limits.bytes - bytes), amount => {
                            if (amount > limits.bytes - bytes) { coverage.limited = true; throw new Error('source-budget'); }
                            bytes += amount;
                        });
                        const end = content.indexOf(10);
                        if (end < 0 || end > 16384 || content.at(-1) !== 10) throw new Error('header');
                        const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, end)));
                        if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !/^[\w-]{1,160}$/.test(header.id)
                            || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw new Error('header');
                        const cwd = fs.realpathSync.native(header.cwd);
                        if (cwd !== header.cwd || require('./pi-session-relocation').sessionDirectory(path.dirname(root), cwd) !== directory) throw new Error('session-directory');
                        if (!input.roots.some(r => within(r, cwd)) || input.hidden.includes(cwd) || input.cwd && input.cwd !== cwd) continue;
                        fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
                        if (!fs.statSync(cwd).isDirectory()) continue;
                        coverage.scannedSessions++;
                        // A hint only. Text containing the marker cannot grant a reference.
                        if (!content.includes(Buffer.from('pivane-deliverable'))) continue;
                        found.push({ cwd, id: header.id, path: filename, size: content.length, modifiedAt: new Date(stat.mtimeMs).toISOString() });
                    } catch { coverage.skippedSources++; }
                }
                sessions.push(...found);
            } catch { coverage.skippedSources++; }
            if (coverage.limited) break;
        }
    } catch (error) { if (error.code !== 'ENOENT') coverage.skippedSources++; }
    if (!input.cwd && input.mediaRoot) for (const [kind, [history]] of Object.entries(MEDIA)) {
        try {
            const root = fs.realpathSync.native(input.mediaRoot);
            if (root !== path.resolve(input.mediaRoot)) throw new Error('media-root-changed');
            const data = verifiedBytes(path.join(root, history), root, limits.historyBytes);
            const items = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
            if (!Array.isArray(items)) throw new Error('history');
            const identities = new Map();
            for (const raw of items) {
                const value = mediaLocator(kind, raw); if (!value) { coverage.skippedSources++; continue; }
                const key = value.id; identities.set(key, identities.has(key) ? null : value);
            }
            const values = [...identities.values()];
            coverage.skippedSources += values.filter(v => !v).length;
            if (values.length > limits.media) coverage.limited = true;
            media.push(...values.filter(Boolean).slice(-limits.media));
        } catch (error) { if (error.code !== 'ENOENT') coverage.skippedSources++; }
    }
    const identities = new Map();
    for (const s of sessions) { const key = JSON.stringify([s.cwd, s.id]); identities.set(key, identities.has(key) ? null : s); }
    coverage.skippedSources += [...identities.values()].filter(v => !v).length;
    return { sessions: [...identities.values()].filter(Boolean).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
        media: media.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), coverage };
}
if (parentPort) { try { parentPort.postMessage({ value: discover(workerData) }); } catch { parentPort.postMessage({ error: '成果来源暂时无法读取' }); } }
module.exports = { discover, LIMITS, MEDIA, mediaLocator, verifiedBytes };
