const fs = require('node:fs');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');

const children = {
    '': ['type', 'customType', 'parentSession', 'data', 'details'],
    data: ['source', 'to', 'from'], details: ['source', 'to', 'from'],
    'data.source': ['cwd', 'sessionId'], 'data.to': ['cwd', 'sessionId'], 'data.from': ['cwd', 'sessionId'],
    'details.source': ['cwd', 'sessionId'], 'details.to': ['cwd', 'sessionId'], 'details.from': ['cwd', 'sessionId']
};
const error = (message, code = 'SESSION_MOVE_SCAN_INVALID') => Object.assign(new Error(message), { status: 409, code });
const invalid = () => error('无法完整核对其他会话的原生引用，请先检查会话文件');
const signature = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const whitespace = c => c === ' ' || c === '\t' || c === '\r';
const boundary = c => whitespace(c) || c === '\n' || c === ',' || c === '}' || c === ']';

// Validate JSONL while projecting only the fields used by cross-thread references.
// Ignored strings are scanned in chunks, including escapes, without accumulating
// message bodies. Field order and duplicate keys retain JSON.parse semantics.
class ReferenceProjection {
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
        if (this.stack.length >= 256) throw error('会话引用元数据超过嵌套预算', 'SESSION_MOVE_SCAN_BUDGET');
        this.stack.push({ kind, path: kind === 'object' ? path : null, value, state: kind === 'object' ? 'keyOrEnd' : 'valueOrEnd', key: null });
    }
    append(token, text) {
        if (!token.capture) return;
        this.bytes += Buffer.byteLength(text);
        if (this.bytes > 1024 * 1024) throw error('会话引用元数据超过单条读取预算', 'SESSION_MOVE_SCAN_BUDGET');
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
            if (this.budget.metadata > this.budget.maxMetadata) throw error('会话引用检查超过元数据读取预算', 'SESSION_MOVE_SCAN_BUDGET');
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

async function scanSessionReferences(file, onRecord, budget = { bytes: 0, metadata: 0, maxBytes: 1024 ** 3, maxMetadata: 256 * 1024 ** 2 }) {
    const fd = io.openReadSync(file);
    try {
        const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!before.isFile() || descriptorPathSync(fd) !== file) throw error('会话引用文件身份无效，请先核对会话目录');
        if (before.size > BigInt(budget.maxBytes - budget.bytes)) throw error('会话引用检查超过原始读取预算（1 GiB）', 'SESSION_MOVE_SCAN_BUDGET');
        const decoder = new TextDecoder('utf-8', { fatal: true }), buffer = Buffer.alloc(256 * 1024);
        let records = 0, length = 0, read;
        const parser = new ReferenceProjection(record => { onRecord(record, records++); }, budget);
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null))) {
            length += read; budget.bytes += read;
            if (budget.bytes > budget.maxBytes || length > Number(before.size)) throw error('会话引用文件在检查期间变化，请重新预览', 'SESSION_MOVE_SCAN_CHANGED');
            parser.feed(decoder.decode(buffer.subarray(0, read), { stream: true }));
            await new Promise(resolve => setImmediate(resolve));
        }
        parser.feed(decoder.decode()); parser.finishLine();
        if (!records) throw invalid();
        if (length !== Number(before.size) || signature(before) !== signature(fs.fstatSync(fd, { bigint: true }))
            || signature(before) !== signature(fs.lstatSync(file, { bigint: true })) || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity))
            throw error('会话引用文件在检查期间变化，请重新预览', 'SESSION_MOVE_SCAN_CHANGED');
    } finally { fs.closeSync(fd); }
}
module.exports = { scanSessionReferences };
