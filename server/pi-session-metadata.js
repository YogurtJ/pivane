'use strict';

const fs = require('node:fs');
const path = require('node:path');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { sessionListRevision } = require('./pi-session-list-revision');
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const { StringDecoder } = require('node:string_decoder');
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

// Keep changed-file CPU work interruptible. Exceptionally large individual JSON
// records retain native streaming discovery rather than one long synchronous parse.
async function* nativeLines(bytes) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = decoder.write(bytes.subarray(offset, offset + 65536));
        if (/[\u2028\u2029]/u.test(chunk)) throw new Error('Session metadata proof unavailable');
        pending += chunk;
        let start = 0, match;
        const lines = [], delimiters = /[\r\n]/g;
        while ((match = delimiters.exec(pending))) {
            if (match.index - start > 1024 * 1024) throw new Error('Session metadata proof unavailable');
            lines.push(pending.slice(start, match.index)); start = match.index + 1;
        }
        pending = pending.slice(start);
        if (lines.length) yield lines;
        if (pending.length > 1024 * 1024) throw new Error('Session metadata proof unavailable');
        await yieldTurn();
    }
    pending += decoder.end();
    if (pending) yield [pending];
}

// Native parseSessionEntries owns JSONL parsing. This adapter projects precisely
// the fields used by SessionManager.list, without retaining entries or search text.
// Native readline framing has runtime-specific Unicode separator behavior; those
// rare files use native list rather than broadening discovery validity.
async function projectMetadata(bytes, file, stat, parseSessionEntries) {
    try {
        let header, name, messageCount = 0, firstMessage = '', lastActivityTime;
        for await (const lines of nativeLines(bytes)) for (const line of lines) {
            const entry = parseSessionEntries(line)[0];
            if (!entry) continue;
            if (!header) {
                if (entry.type !== 'session') return null;
                header = entry; continue;
            }
            if (entry.type === 'session_info') name = entry.name?.trim() || undefined;
            if (entry.type !== 'message') continue;
            messageCount++;
            const message = entry.message;
            if (typeof message.role !== 'string' || !('content' in message)) continue;
            if (message.role !== 'user' && message.role !== 'assistant') continue;
            const time = typeof message.timestamp === 'number' ? message.timestamp : new Date(entry.timestamp).getTime();
            if (typeof message.timestamp === 'number' || !Number.isNaN(time)) lastActivityTime = Math.max(lastActivityTime ?? 0, time);
            const text = typeof message.content === 'string' ? message.content
                : message.content.filter(block => block.type === 'text').map(block => block.text).join(' ');
            if (!firstMessage && message.role === 'user' && text) firstMessage = text;
        }
        if (!header) return null;
        const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
        return { path: file, id: header.id, cwd: typeof header.cwd === 'string' ? header.cwd : '', name,
            parentSessionPath: header.parentSession, created: new Date(header.timestamp),
            modified: typeof lastActivityTime === 'number' && lastActivityTime > 0 ? new Date(lastActivityTime)
                : !Number.isNaN(headerTime) ? new Date(headerTime) : stat.mtime,
            messageCount, firstMessage: firstMessage || '(no messages)' };
    } catch (error) {
        if (error.message === 'Session metadata proof unavailable') throw error;
        return null; // Native discovery skips malformed message shapes as well.
    }
}

class SessionMetadataCache {
    constructor() { this.files = new Map(); this.bytes = 0; this.pending = new Map(); }
    put(file, record) {
        const old = this.files.get(file);
        if (old) this.bytes -= old.bytes;
        this.files.delete(file);
        record.bytes = Buffer.byteLength(JSON.stringify(record));
        // Bound both metadata count and retained text (first user messages can be huge).
        if (record.bytes > 1024 * 1024) return;
        while (this.files.size >= 5000 || this.bytes + record.bytes > 16 * 1024 * 1024) {
            const key = this.files.keys().next().value;
            this.bytes -= this.files.get(key).bytes; this.files.delete(key);
        }
        this.files.set(file, record); this.bytes += record.bytes;
    }
    async read(file, revision, parseSessionEntries) {
        const cached = this.files.get(file);
        if (cached?.revision === revision) return cached.metadata;
        let fd;
        try {
            const before = fs.lstatSync(file, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FILE_BYTES)) throw new Error('Session metadata proof unavailable');
            fd = io.openReadSync(file);
            const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
            const verify = () => {
                if (stamp(before) !== stamp(fs.fstatSync(fd, { bigint: true }))
                    || stamp(before) !== stamp(fs.lstatSync(file, { bigint: true }))
                    || descriptorPathSync(fd) !== file || fs.realpathSync.native(file) !== file
                    || !io.sameIdentityAtPath(file, identity)
                    || revision !== JSON.stringify([stamp(opened), identity])) throw new Error('Session file changed');
            };
            verify();
            const buffer = Buffer.alloc(Number(before.size) + 1);
            let total = 0;
            while (total < buffer.length) {
                const count = await new Promise((resolve, reject) => fs.read(fd, buffer, total,
                    Math.min(256 * 1024, buffer.length - total), total, (error, bytesRead) => error ? reject(error) : resolve(bytesRead)));
                if (!count) break;
                total += count;
            }
            if (total !== Number(before.size)) throw new Error('Session file changed');
            const metadata = await projectMetadata(buffer.subarray(0, total), file, fs.fstatSync(fd), parseSessionEntries);
            verify(); this.put(file, { revision, metadata });
            return metadata;
        } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    async list(directory, sdk, fallback) {
        // Existing cache instances can adopt this read-only implementation in place.
        this.pending ||= new Map();
        const proof = sessionListRevision(directory);
        let read = this.pending.get(directory);
        if (!read || read.proof !== proof || read.sdk !== sdk) {
            read = { proof, sdk };
            // Reserve before any asynchronous read; project discovery and session
            // lists share the same work, including the native fallback path.
            read.promise = Promise.resolve().then(() => this.listProven(directory, sdk, fallback, proof))
                .finally(() => { if (this.pending.get(directory) === read) this.pending.delete(directory); });
            this.pending.set(directory, read);
        }
        const rows = await read.promise;
        if (proof && proof !== sessionListRevision(directory)) throw new Error('Session file changed');
        return rows;
    }
    async listProven(directory, sdk, fallback, proof) {
        // Alias paths and unavailable proofs retain native discovery behavior.
        if (!proof) return fallback();
        const members = JSON.parse(proof)[3];
        const rows = [];
        try {
            for (const [name, stamp, identity] of members.sort((a, b) => b[0].localeCompare(a[0]))) {
                const row = await this.read(path.join(directory, name), JSON.stringify([stamp, identity]), sdk.parseSessionEntries);
                if (row) rows.push(row);
            }
        } catch (error) {
            if (error.message !== 'Session metadata proof unavailable') throw error;
            // Large files/records still use Pi's native discovery, but their
            // compact metadata must obey the same identity cache as small files.
            // Never retain allMessagesText (native search text can be enormous).
            const native = await fallback();
            if (proof !== sessionListRevision(directory)) throw new Error('Session file changed');
            const projected = new Map(native.map(({ allMessagesText, ...row }) => [row.path, row]));
            for (const [name, memberStamp, identity] of members) {
                const file = path.join(directory, name);
                this.put(file, { revision: JSON.stringify([memberStamp, identity]), metadata: projected.get(file) || null });
            }
            return native.map(row => this.files.get(row.path)?.metadata || projected.get(row.path));
        }
        if (proof !== sessionListRevision(directory)) throw new Error('Session file changed');
        return rows.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    }
}
module.exports = { SessionMetadataCache, projectMetadata };
