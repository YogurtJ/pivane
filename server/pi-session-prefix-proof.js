const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const MAX_PREFIX = 1024 ** 3;
const MAX_HEADER = 1024 ** 2, MAX_MARKER = 1024 ** 2, CHUNK = 256 * 1024;
const invalid = () => Object.assign(new Error('原生会话前缀证明无效或读取期间变化'), { status: 409, code: 'SESSION_PREFIX_CHANGED' });
const signature = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const children = { '': ['type', 'id', 'parentId', 'customType', 'data'], data: ['id', 'manifestRevision'] };
const whitespace = c => c === ' ' || c === '\t' || c === '\r';
const boundary = c => whitespace(c) || c === '\n' || c === ',' || c === '}' || c === ']';

// Validate the initial native prefix while retaining only identity/tree and delivery fields.
// Ignored strings are scanned in chunks, including escapes, without accumulating
// message bodies. Field order and duplicate keys retain JSON.parse semantics.
class PrefixProjection {
    constructor(onRecord, budget) { this.onRecord = onRecord; this.budget = budget; this.reset(); }
    reset() { this.stack = []; this.root = null; this.done = false; this.token = null; this.bytes = 0; }
    path() {
        const frame = this.stack.at(-1);
        if (!frame || frame.path === null || frame.kind !== 'object' || !children[frame.path]?.includes(frame.key)) return null;
        return frame.path ? frame.path + '.' + frame.key : frame.key;
    }
    value(value) {
        const frame = this.stack.at(-1);
        if (!frame) throw invalid();
        if (frame.kind === 'object') {
            if (frame.state !== 'value') throw invalid();
            if (this.path() !== null) frame.value[frame.key] = value;
        } else if (!['value', 'valueOrEnd'].includes(frame.state)) throw invalid();
        frame.state = 'commaOrEnd';
    }
    startContainer(kind) {
        const path = this.stack.length ? this.path() : '';
        const value = path !== null ? (kind === 'object' ? {} : []) : undefined;
        if (!this.stack.length) {
            if (this.done || kind !== 'object') throw invalid();
            this.root = value;
        } else this.value(value);
        if (this.stack.length >= 256) throw invalid();
        this.stack.push({ kind, path: kind === 'object' ? path : null, value, state: kind === 'object' ? 'keyOrEnd' : 'valueOrEnd', key: null });
    }
    append(token, text) {
        if (!token.capture) return;
        this.bytes += Buffer.byteLength(text);
        if (this.bytes > 1024 * 1024) throw invalid();
        token.parts.push(text);
    }
    endToken() {
        const token = this.token, frame = this.stack.at(-1);
        if (token.kind === 'string' && frame.kind === 'object' && ['key', 'keyOrEnd'].includes(frame.state)) {
            frame.key = token.capture ? JSON.parse(token.parts.join('')) : null;
            frame.state = 'colon';
        } else {
            let value;
            if (token.capture) value = JSON.parse(token.parts.join(''));
            else if (token.kind === 'string' && this.path() !== null) value = token.nonempty;
            this.value(value);
        }
        this.token = null;
    }
    finishLine() {
        if (this.token?.kind === 'number' && ['zero', 'integer', 'fraction', 'exponentDigits'].includes(this.token.state)) this.endToken();
        else if (this.token?.kind === 'literal' && this.token.position === this.token.literal.length) this.endToken();
        if (this.token || this.stack.length || this.root && !this.done) throw invalid();
        if (this.done) {
            this.budget.metadata += this.bytes;
            if (this.budget.metadata > this.budget.maxMetadata) throw invalid();
            this.onRecord(this.root);
        }
        this.reset();
    }
    feed(text) {
        for (let i = 0; i < text.length;) {
            const c = text[i], token = this.token;
            if (token?.kind === 'string') {
                if (token.unicode) {
                    if (!/[0-9a-fA-F]/.test(c)) throw invalid();
                    this.append(token, c); token.unicode--; i++; continue;
                }
                if (token.escape) {
                    if (!'"\\/bfnrtu'.includes(c)) throw invalid();
                    this.append(token, c); token.escape = false; if (c === 'u') token.unicode = 4; i++; continue;
                }
                const markers = /["\\\u0000-\u001f]/g; markers.lastIndex = i;
                const match = markers.exec(text), end = match ? match.index : text.length;
                if (end > i) token.nonempty = true;
                this.append(token, text.slice(i, end)); i = end;
                if (!match) continue;
                if (text[i] === '"') { this.append(token, '"'); this.endToken(); i++; }
                else if (text[i] === '\\') { this.append(token, '\\'); token.nonempty = true; token.escape = true; i++; }
                else throw invalid();
                continue;
            }
            if (token?.kind === 'literal') {
                if (token.position < token.literal.length) {
                    if (c !== token.literal[token.position++]) throw invalid();
                    this.append(token, c); i++; continue;
                }
                if (!boundary(c)) throw invalid();
                this.endToken(); continue;
            }
            if (token?.kind === 'number') {
                let next;
                if (token.state === 'minus') next = c === '0' ? 'zero' : /[1-9]/.test(c) ? 'integer' : null;
                else if (['zero', 'integer'].includes(token.state)) next = token.state === 'integer' && /[0-9]/.test(c) ? 'integer' : c === '.' ? 'dot' : /[eE]/.test(c) ? 'exponent' : null;
                else if (['dot', 'fraction'].includes(token.state)) next = /[0-9]/.test(c) ? 'fraction' : token.state === 'fraction' && /[eE]/.test(c) ? 'exponent' : null;
                else if (token.state === 'exponent') next = /[+-]/.test(c) ? 'exponentSign' : /[0-9]/.test(c) ? 'exponentDigits' : null;
                else if (['exponentSign', 'exponentDigits'].includes(token.state)) next = /[0-9]/.test(c) ? 'exponentDigits' : null;
                if (next) { token.state = next; this.append(token, c); i++; continue; }
                if (!boundary(c) || !['zero', 'integer', 'fraction', 'exponentDigits'].includes(token.state)) throw invalid();
                this.endToken(); continue;
            }
            if (c === '\n') { this.finishLine(); i++; continue; }
            if (whitespace(c)) { i++; continue; }
            if (this.done) throw invalid();
            const frame = this.stack.at(-1);
            if (c === '{' || c === '[') { this.startContainer(c === '{' ? 'object' : 'array'); i++; continue; }
            if (!frame) throw invalid();
            if (c === '}' || c === ']') {
                if (frame.kind !== (c === '}' ? 'object' : 'array') || !['keyOrEnd', 'valueOrEnd', 'commaOrEnd'].includes(frame.state)) throw invalid();
                this.stack.pop(); if (!this.stack.length) this.done = true; i++; continue;
            }
            if (c === ':' && frame.kind === 'object' && frame.state === 'colon') { frame.state = 'value'; i++; continue; }
            if (c === ',' && frame.state === 'commaOrEnd') { frame.state = frame.kind === 'object' ? 'key' : 'value'; i++; continue; }
            if (!['key', 'keyOrEnd', 'value', 'valueOrEnd'].includes(frame.state)) throw invalid();
            const key = frame.kind === 'object' && ['key', 'keyOrEnd'].includes(frame.state);
            if (key && c !== '"') throw invalid();
            const path = this.path(), capture = key ? frame.path !== null : path !== null && !children[path];
            if (c === '"') this.token = { kind: 'string', capture, parts: [], escape: false, unicode: 0, nonempty: false };
            else if (['t', 'f', 'n'].includes(c)) this.token = { kind: 'literal', capture: path !== null, parts: [], literal: c === 't' ? 'true' : c === 'f' ? 'false' : 'null', position: 1 };
            else if (c === '-' || /[0-9]/.test(c)) this.token = { kind: 'number', capture: path !== null, parts: [], state: c === '-' ? 'minus' : c === '0' ? 'zero' : 'integer' };
            else throw invalid();
            this.append(this.token, c); i++;
        }
    }
}

function openSession(session) {
    if (typeof session?.id !== 'string' || !session.id || typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd)
        || typeof session.path !== 'string' || !path.isAbsolute(session.path)) throw invalid();
    const fd = io.openReadSync(session.path);
    try {
        const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)
            || descriptorPathSync(fd) !== path.resolve(session.path)) throw invalid();
        return { fd, before, identity, session };
    } catch (error) { fs.closeSync(fd); throw error; }
}
function unchanged(input) {
    const { fd, before, identity, session } = input;
    if (signature(before) !== signature(fs.fstatSync(fd, { bigint: true }))
        || signature(before) !== signature(fs.lstatSync(session.path, { bigint: true }))
        || descriptorPathSync(fd) !== path.resolve(session.path) || !io.sameIdentityAtPath(session.path, identity)) throw invalid();
}
function readAt(input, buffer, position, length) {
    let total = 0;
    while (total < length) {
        const read = fs.readSync(input.fd, buffer, total, length - total, position + total);
        if (!read) throw invalid();
        total += read;
    }
    return buffer.subarray(0, total);
}
function header(input) {
    const parts = [], buffer = Buffer.alloc(4096); let position = 0;
    while (position < Number(input.before.size) && position <= MAX_HEADER) {
        const bytes = readAt(input, buffer, position, Math.min(buffer.length, Number(input.before.size) - position, MAX_HEADER + 1 - position));
        const end = bytes.indexOf(10);
        parts.push(Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)));
        if (end >= 0) {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
            if (value?.type !== 'session' || value.version !== 3 || value.id !== input.session.id
                || value.cwd !== input.session.cwd || typeof value.timestamp !== 'string') throw invalid();
            return { value, length: position + end + 1 };
        }
        position += bytes.length;
    }
    throw invalid();
}
function projection(onRecord) {
    return new PrefixProjection(onRecord, { metadata: 0, maxMetadata: 64 * 1024 ** 2 });
}
// Feed at raw LF boundaries so projected delivery cutoffs remain byte offsets,
// including multibyte UTF-8 and lines which span several chunks.
function projectedFeed(parser, decoder, bytes, offset, onEnd) {
    for (let start = 0; start < bytes.length;) {
        const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline + 1;
        onEnd(offset + end);
        parser.feed(decoder.decode(bytes.subarray(start, end), { stream: true }));
        start = end;
    }
}
// Publication is deliberately synchronous: the caller must append the native
// marker before a worker can open the newly published fork. Memory is bounded
// by a chunk, projected metadata, and at most one million native entry IDs.
function createPrefixProofSync(session) {
    const input = openSession(session);
    try {
        const parsed = header(input), length = Number(input.before.size) - parsed.length;
        if (length > MAX_PREFIX) throw invalid();
        const digest = createHash('sha256'), buffer = Buffer.alloc(CHUNK), seen = new Set();
        const parser = projection(entry => {
            if (!entry || entry.type === 'session' || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
                || entry.parentId !== null && !seen.has(entry.parentId) || seen.size >= 1000000) throw invalid();
            seen.add(entry.id);
        });
        const decoder = new TextDecoder('utf-8', { fatal: true }); let last;
        for (let offset = 0; offset < length;) {
            const bytes = readAt(input, buffer, parsed.length + offset, Math.min(CHUNK, length - offset));
            digest.update(bytes); parser.feed(decoder.decode(bytes, { stream: true }));
            last = bytes.at(-1); offset += bytes.length;
        }
        parser.feed(decoder.decode()); parser.finishLine();
        // The marker must be a separate native JSONL record at this boundary.
        if (length && last !== 10) throw invalid();
        unchanged(input);
        return { header: parsed.value, tailLength: length, tailSha256: digest.digest('hex') };
    } finally { fs.closeSync(input.fd); }
}
function markerAt(input, position) {
    const parts = [], buffer = Buffer.alloc(4096); let length = 0;
    while (position + length < Number(input.before.size) && length < MAX_MARKER) {
        const bytes = readAt(input, buffer, position + length, Math.min(buffer.length, MAX_MARKER - length, Number(input.before.size) - position - length));
        const end = bytes.indexOf(10);
        parts.push(Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)));
        if (end >= 0) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
        length += bytes.length;
    }
    throw invalid();
}
// Proofs bind immutable tail prefixes, never the growing suffix. Capture a full
// descriptor snapshot before reading, then reject even a concurrent legal append.
// A later retry on a stable append remains valid. No cross-read identity cache:
// exact backup restoration at the original logical/native identity is supported.
async function verifySessionPrefixes(session, proofs, { onRecord, marker } = {}) {
    if (!Array.isArray(proofs) || !proofs.length || proofs.length > 1000
        || proofs.some(proof => !Number.isSafeInteger(proof.tailLength) || proof.tailLength < 0 || proof.tailLength > MAX_PREFIX
            || typeof proof.tailSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.tailSha256))
        || proofs.reduce((sum, proof) => sum + proof.tailLength, 0) > MAX_PREFIX) throw invalid();
    const input = openSession(session);
    try {
        const parsed = header(input), limit = Math.max(...proofs.map(proof => proof.tailLength));
        if (parsed.length + limit > Number(input.before.size)) throw invalid();
        const lengths = [...new Set(proofs.map(proof => proof.tailLength))].sort((a, b) => a - b);
        const hashes = new Map(), digest = createHash('sha256'), buffer = Buffer.alloc(CHUNK);
        let recordEnd = 0;
        const seen = marker ? new Set() : null;
        const parser = onRecord || marker ? projection(entry => {
            if (seen) {
                if (entry.type === 'session' || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
                    || entry.parentId !== null && !seen.has(entry.parentId) || seen.size >= 1000000) throw invalid();
                seen.add(entry.id);
            }
            onRecord?.(entry, recordEnd);
        }) : null;
        const decoder = parser && new TextDecoder('utf-8', { fatal: true });
        let offset = 0;
        for (const length of lengths) {
            while (offset < length) {
                const bytes = readAt(input, buffer, parsed.length + offset, Math.min(CHUNK, length - offset));
                digest.update(bytes);
                if (parser) projectedFeed(parser, decoder, bytes, offset, end => { recordEnd = end; });
                offset += bytes.length;
                await new Promise(resolve => setImmediate(resolve));
            }
            hashes.set(length, digest.copy().digest('hex'));
        }
        if (parser) { parser.feed(decoder.decode()); parser.finishLine(); }
        if (proofs.some(proof => hashes.get(proof.tailLength) !== proof.tailSha256)) throw invalid();
        const entry = marker ? markerAt(input, parsed.length + limit) : null;
        if (marker && (typeof entry?.id !== 'string' || !entry.id || seen.has(entry.id)
            || entry.parentId !== null && !seen.has(entry.parentId))) throw invalid();
        unchanged(input);
        return { header: parsed.value, marker: entry };
    } finally { fs.closeSync(input.fd); }
}
module.exports = { MAX_PREFIX, createPrefixProofSync, verifySessionPrefixes };
