const fileIo = require('./pi-file-io');
const fs = require('node:fs');
const path = require('node:path');
const { descriptorPathSync, assertDescriptorBackend } = require('./pi-file-descriptor');
const { parentPort, workerData } = require('node:worker_threads');
const within = (root, file) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const LIMITS = { files: 1000, bytes: 256 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, lineBytes: 8 * 1024 * 1024, entries: 200000, milliseconds: 10000, results: 200 };
function searchSessions({ root, roots, q, cwd: selectedCwd, hidden = [] }, limits = LIMITS) {
    assertDescriptorBackend();
    const coverage = { scannedFiles: 0, skippedFiles: 0, limited: false }, results = [], files = [];
    const start = Date.now(), needle = q.toLowerCase(); let bytes = 0, entries = 0;
    const check = () => { if (Date.now() - start > limits.milliseconds || bytes > limits.bytes || entries > limits.entries) { coverage.limited = true; throw new Error('budget'); } };
    if (!fs.existsSync(root)) return { results, coverage };
    root = fs.realpathSync.native(root);
    for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
        if (!folder.isDirectory()) continue;
        const dir = path.join(root, folder.name);
        if (!within(root, fs.realpathSync.native(dir))) continue;
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
            if (files.length >= limits.files) { coverage.limited = true; break; }
            const filename = path.join(dir, file.name);
            try { files.push({ filename, modified: fs.statSync(filename).mtimeMs }); } catch { coverage.skippedFiles++; }
        }
        if (coverage.limited) break;
    }
    for (const { filename, modified } of files.sort((a, b) => b.modified - a.modified || a.filename.localeCompare(b.filename))) {
        let fd;
        try {
            check(); fd = fileIo.openReadSync(filename);
            const stat = fs.fstatSync(fd, { bigint: true }), actual = descriptorPathSync(fd), identity = fileIo.identity(fd);
            if (!stat.isFile() || stat.size > limits.fileBytes || !within(root, actual)) throw new Error('file');
            let header, cwd, name = '', first = '', hit = null, matches = 0, position = 0, pending = Buffer.alloc(0);
            const line = buffer => {
                if (!buffer.length) return;
                entries++; check(); if (buffer.length > limits.lineBytes) throw new Error('line');
                const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
                if (!header) {
                    if (entry?.type !== 'session' || ![2, 3].includes(entry.version) || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) || typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) throw new Error('header');
                    cwd = fs.realpathSync.native(entry.cwd);
                    if (!fs.statSync(cwd).isDirectory() || !roots.some(r => within(r, cwd)) || hidden.includes(cwd) || selectedCwd && cwd !== selectedCwd) throw new Error('excluded');
                    header = entry; return;
                }
                if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name.slice(0, 160);
                const m = entry.type === 'message' ? entry.message : null;
                if (!m || !['user', 'assistant'].includes(m.role)) return;
                const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
                if (m.role === 'user' && !first) first = text.slice(0, 100);
                const at = text.toLowerCase().indexOf(needle);
                if (at < 0) return;
                matches++;
                if (!hit && typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)) hit = { entryId: entry.id, role: m.role, matchOffset: at,
                    snippet: (at > 80 ? '…' : '') + text.slice(Math.max(0, at - 80), at + needle.length + 160) + (at + needle.length + 160 < text.length ? '…' : '') };
            };
            const size = Number(stat.size);
            while (position < size) {
                check(); const chunk = Buffer.alloc(Math.min(65536, size - position)); const n = fs.readSync(fd, chunk, 0, chunk.length, position);
                if (!n) throw new Error('changed'); position += n; bytes += n; pending = Buffer.concat([pending, chunk.subarray(0, n)]);
                let begin = 0, end;
                while ((end = pending.indexOf(10, begin)) >= 0) { line(pending.subarray(begin, end)); begin = end + 1; }
                pending = pending.subarray(begin); if (pending.length > limits.lineBytes) throw new Error('line');
            }
            if (pending.length) line(pending);
            const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(filename, { bigint: true });
            if (!fileIo.sameIdentityAtPath(filename, identity) || !header || !current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs
                || fs.realpathSync.native(header.cwd) !== cwd || fs.realpathSync.native(filename) !== actual || descriptorPathSync(fd) !== actual) throw new Error('changed');
            coverage.scannedFiles++;
            if (hit) results.push({ sessionId: header.id, cwd, name: name || first || '未命名线程', modified: new Date(modified).toISOString(), matches, ...hit });
            if (results.length >= limits.results) { coverage.limited = true; break; }
        } catch (e) { if (e.message !== 'excluded') coverage.skippedFiles++; if (e.message === 'budget') break; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return { results, coverage };
}
if (parentPort) { try { parentPort.postMessage({ value: searchSessions(workerData) }); } catch { parentPort.postMessage({ error: '会话搜索未完成，请缩小范围后重试' }); } }
module.exports = { searchSessions, LIMITS };
