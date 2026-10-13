const fs = require('node:fs');
const path = require('node:path');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { fail } = require('./pi-file-scope');
const { NativeDocumentScope, sessionPathFields } = require('./pi-document-native-scope');
const stamp = stat => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(stat[k])).join(':');
const changed = () => fail('附件或保存引用已变化，请重新预览', 409, 'DOCUMENT_STORAGE_CHANGED');
const incomplete = () => fail('无法完整核对保存引用，暂不能清理附件', 409, 'DOCUMENT_SCAN_INCOMPLETE');

// Validate every JSON token, retaining only a sliding string window. Protecting
// IDs in any string deliberately overcounts references (including old branches
// and orphan fork receipts), without buffering large native image messages.
class IdScanner {
    constructor(ids, found, jsonl, scope) { Object.assign(this, { ids, found, jsonl, scope }); this.stack = []; this.done = false; this.records = 0; this.token = null; }
    string(text) {
        if (this.token.capture) {
            const room = this.token.limit - this.token.value.length;
            this.token.value += text.slice(0, Math.max(0, room));
            this.token.overflow ||= text.length > room;
        }
        const window = this.tail + text;
        for (const match of window.matchAll(/[a-f0-9]{64}/g)) if (this.ids.has(match[0])) this.found.add(match[0]);
        this.tail = window.slice(-63);
    }
    value() {
        const f = this.stack.at(-1);
        if (!f || !(f.kind === '{' ? f.state === 'value' : ['value', 'first'].includes(f.state))) throw incomplete();
        f.state = 'comma';
    }
    endToken() {
        const f = this.stack.at(-1), token = this.token;
        if (token.kind === 'string' && f.kind === '{' && ['key', 'first'].includes(f.state)) {
            f.key = token.overflow ? null : token.value; f.state = 'colon';
        } else {
            if (sessionPathFields.has(f.key)) this.scope.reference(token.kind === 'string' ? token.value
                : token.kind === 'literal' && token.literal === 'null' ? null : token.kind === 'literal' && token.literal === 'false' ? false : undefined, token.overflow);
            this.value();
        }
        this.token = null;
    }
    newline() {
        if (this.token?.kind === 'number' && ['zero', 'integer', 'fraction', 'exponentDigits'].includes(this.token.state)
            || this.token?.kind === 'literal' && this.token.position === this.token.literal.length) this.endToken();
        if (this.token || this.stack.length) throw incomplete();
        if (this.done) { this.records++; this.done = false; }
    }
    feed(text) {
        for (let i = 0; i < text.length;) {
            const c = text[i], t = this.token;
            if (t?.kind === 'string') {
                if (t.unicode) {
                    if (!/[a-fA-F0-9]/.test(c)) throw incomplete();
                    t.hex += c; i++; if (--t.unicode === 0) this.string(String.fromCharCode(parseInt(t.hex, 16))); continue;
                }
                if (t.escape) {
                    if (!'"\\/bfnrtu'.includes(c)) throw incomplete();
                    t.escape = false; i++;
                    if (c === 'u') { t.unicode = 4; t.hex = ''; }
                    else this.string(({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] || c);
                    continue;
                }
                const marker = /["\\\u0000-\u001f]/g; marker.lastIndex = i;
                const match = marker.exec(text), end = match ? match.index : text.length;
                this.string(text.slice(i, end)); i = end;
                if (!match) continue;
                if (text[i] === '"') { this.endToken(); i++; }
                else if (text[i] === '\\') { t.escape = true; i++; }
                else throw incomplete();
                continue;
            }
            if (t?.kind === 'literal') {
                if (t.position < t.literal.length) { if (c !== t.literal[t.position++]) throw incomplete(); i++; continue; }
                if (!/[\s,}\]]/.test(c)) throw incomplete(); this.endToken(); continue;
            }
            if (t?.kind === 'number') {
                let next;
                if (t.state === 'minus') next = c === '0' ? 'zero' : /[1-9]/.test(c) ? 'integer' : null;
                else if (['zero', 'integer'].includes(t.state)) next = t.state === 'integer' && /[0-9]/.test(c) ? 'integer' : c === '.' ? 'dot' : /[eE]/.test(c) ? 'exponent' : null;
                else if (['dot', 'fraction'].includes(t.state)) next = /[0-9]/.test(c) ? 'fraction' : t.state === 'fraction' && /[eE]/.test(c) ? 'exponent' : null;
                else if (t.state === 'exponent') next = /[+-]/.test(c) ? 'exponentSign' : /[0-9]/.test(c) ? 'exponentDigits' : null;
                else if (['exponentSign', 'exponentDigits'].includes(t.state)) next = /[0-9]/.test(c) ? 'exponentDigits' : null;
                if (next) { t.state = next; i++; continue; }
                if (!/[\s,}\]]/.test(c) || !['zero', 'integer', 'fraction', 'exponentDigits'].includes(t.state)) throw incomplete();
                this.endToken(); continue;
            }
            if (c === '\n') { if (this.jsonl) this.newline(); i++; continue; }
            if (' \t\r'.includes(c)) { i++; continue; }
            if (this.done) throw incomplete();
            const f = this.stack.at(-1);
            if (c === '{' || c === '[') {
                if (!f) { if (c !== '{') throw incomplete(); } else {
                    if (sessionPathFields.has(f.key)) this.scope.reference(undefined);
                    this.value();
                }
                if (this.stack.length >= 256) throw incomplete();
                this.stack.push({ kind: c, state: 'first' }); i++; continue;
            }
            if (!f) throw incomplete();
            if (c === '}' || c === ']') {
                if (f.kind !== (c === '}' ? '{' : '[') || !['first', 'comma'].includes(f.state)) throw incomplete();
                this.stack.pop(); if (!this.stack.length) this.done = true; i++; continue;
            }
            if (c === ':' && f.kind === '{' && f.state === 'colon') { f.state = 'value'; i++; continue; }
            if (c === ',' && f.state === 'comma') { f.state = f.kind === '{' ? 'key' : 'value'; i++; continue; }
            const key = f.kind === '{' && ['first', 'key'].includes(f.state);
            if (!(key || f.state === 'value' || f.kind === '[' && f.state === 'first') || key && c !== '"') throw incomplete();
            if (c === '"') { this.tail = ''; this.token = { kind: 'string', capture: key || sessionPathFields.has(f.key), value: '', limit: key ? 64 : 4096, overflow: false }; }
            else if ('tfn'.includes(c)) this.token = { kind: 'literal', literal: c === 't' ? 'true' : c === 'f' ? 'false' : 'null', position: 1 };
            else if (c === '-' || /[0-9]/.test(c)) this.token = { kind: 'number', state: c === '-' ? 'minus' : c === '0' ? 'zero' : 'integer' };
            else throw incomplete();
            i++;
        }
    }
    finish() { this.newline(); if (!this.records || !this.jsonl && this.records !== 1) throw incomplete(); }
}

function prove(file, directory = false) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || fs.realpathSync.native(file) !== file) throw changed();
    const fd = io.openReadSync(file);
    try {
        if (descriptorPathSync(fd) !== file || stamp(stat) !== stamp(fs.fstatSync(fd, { bigint: true }))) throw changed();
        return { file, directory, stamp: stamp(stat), identity: io.identity(fd), names: directory ? fs.readdirSync(file).sort() : null };
    } finally { fs.closeSync(fd); }
}
function verify(proofs) {
    for (const p of proofs) {
        const current = prove(p.file, p.directory);
        if (p.stamp !== current.stamp || p.identity !== current.identity || JSON.stringify(p.names) !== JSON.stringify(current.names)) throw changed();
    }
}
function tree(root, proofs, optional = true) {
    try { fs.lstatSync(root); } catch (e) { if (optional && e.code === 'ENOENT') { proofs.push({ missing: root }); return []; } throw e; }
    const files = [];
    const visit = file => {
        if (proofs.length >= 30000) throw incomplete();
        const stat = fs.lstatSync(file);
        const p = prove(file, stat.isDirectory()); proofs.push(p);
        if (p.directory) for (const name of p.names) visit(path.join(file, name)); else files.push(p);
    };
    visit(root); return files;
}
function verifyAll(proofs) {
    for (const p of proofs) if (p.missing) {
        try { fs.lstatSync(p.missing); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } throw changed();
    } else verify([p]);
}
// Pi's discovery checks the first nonblank JSONL record under a 1 MiB
// header budget. Cleanup must reject candidates that best-effort listAll would
// silently omit. Positioned reads leave the full streaming scan at byte zero.
function nativeHeader(fd, required) {
    const limit = 1024 * 1024, buffer = Buffer.alloc(4096), parts = [];
    let position = 0, length = 0;
    const validate = () => {
        let header;
        try { header = JSON.parse(Buffer.concat(parts, length).toString('utf8')); } catch { throw incomplete(); }
        if (required || header?.type === 'session') {
            if (header?.type !== 'session' || typeof header.id !== 'string') throw incomplete();
        }
        return header;
    };
    while (position < limit) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - position), position);
        if (!read) { if (!length) throw incomplete(); return validate(); }
        position += read;
        for (let start = 0; start < read;) {
            const newline = buffer.indexOf(10, start), end = newline >= 0 && newline < read ? newline : read;
            const part = Buffer.from(buffer.subarray(start, end)); parts.push(part); length += part.length;
            if (end === read) break;
            if (Buffer.concat(parts, length).toString('utf8').trim()) return validate();
            parts.length = 0; length = 0; start = end + 1;
        }
    }
    if (length && fs.readSync(fd, buffer, 0, 1, position) === 0) return validate();
    throw incomplete();
}
async function scanReferences(agent, ids, maxBytes = 4 * 1024 ** 3) {
    const proofs = [], found = new Set(), scope = new NativeDocumentScope(agent); let total = 0;
    const sessionsRoot = path.join(agent, 'sessions');
    // Managed pi-subagents declares subagent-artifacts as an output tree next
    // to a parent session. Keep all identity/change proofs, but ordinary output
    // bodies are not native history. Nested run/fork JSONL stays discoverable.
    const sessions = tree(sessionsRoot, proofs).map(p => ({ ...p,
        artifact: path.relative(sessionsRoot, p.file).split(path.sep).includes('subagent-artifacts') }));
    const files = [...sessions, ...tree(path.join(agent, 'pivane-session-moves', 'forks'), proofs)];
    for (const p of files) {
        const jsonl = p.file.endsWith('.jsonl');
        if (!jsonl && !p.file.endsWith('.json')) {
            if (p.artifact) continue;
            throw incomplete();
        }
        const fd = io.openReadSync(p.file), decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            if (descriptorPathSync(fd) !== p.file || stamp(fs.fstatSync(fd, { bigint: true })) !== p.stamp || io.identity(fd) !== p.identity) throw changed();
            if (jsonl) scope.project(nativeHeader(fd, !p.artifact));
            const scanner = new IdScanner(ids, found, jsonl, scope), buffer = Buffer.alloc(256 * 1024); let read;
            while ((read = fs.readSync(fd, buffer, 0, buffer.length, null))) {
                total += read; if (total > maxBytes) throw incomplete();
                scanner.feed(decoder.decode(buffer.subarray(0, read), { stream: true }));
                await new Promise(resolve => setImmediate(resolve));
            }
            scanner.feed(decoder.decode()); scanner.finish();
            if (stamp(fs.fstatSync(fd, { bigint: true })) !== p.stamp || descriptorPathSync(fd) !== p.file) throw changed();
        } finally { fs.closeSync(fd); }
        verify([p]);
    }
    verifyAll(proofs); return { found, proofs, scope: scope.snapshot() };
}
module.exports = { scanReferences, prove, verifyAll, changed, incomplete };
