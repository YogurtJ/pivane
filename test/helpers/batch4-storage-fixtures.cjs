// Synthetic fixture and observation helpers for batch4-storage.cjs only.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const MiB = 1024 ** 2;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function environment(base) {
    // Construct an allowlist; never copy supplier, proxy, instance or NODE_OPTIONS values.
    return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'),
        TMPDIR: path.join(base, 'tmp'), TMP: path.join(base, 'tmp'), TEMP: path.join(base, 'tmp'),
        PI_CODING_AGENT_DIR: path.join(base, 'agent'), PI_PROJECT_ROOTS: path.join(base, 'project'),
        PI_MEDIA_DATA_DIR: path.join(base, 'media'), PI_OFFLINE: '1' };
}
function directories(base) {
    for (const name of ['home', 'tmp', 'agent', 'project', 'media', 'queue', 'gallery']) fs.mkdirSync(path.join(base, name), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(base, 'queue', 'protected-documents.json'), JSON.stringify({ complete: true, revision: 'synthetic-empty-queue-1', ids: [] }), { mode: 0o600 });
    fs.writeFileSync(path.join(base, 'queue', 'media-chat.json'), '[]', { mode: 0o600 });
}
function prohibitNetworkAndProcesses() {
    const attempts = { network: 0, subprocess: 0 };
    const network = () => { attempts.network++; throw new Error('Storage benchmark prohibits all network'); };
    require('node:net').Socket.prototype.connect = network;
    require('node:tls').connect = network;
    for (const mod of [require('node:http'), require('node:https')]) { mod.request = network; mod.get = network; }
    require('node:dgram').Socket.prototype.send = network;
    globalThis.fetch = network;
    const subprocess = () => { attempts.subprocess++; throw new Error('Measurement/setup subprocess cannot start another process'); };
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[key] = subprocess;
    return attempts;
}
function png(label) {
    const crc = input => {
        let value = 0xffffffff;
        for (const byte of input) {
            value ^= byte;
            for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
        }
        return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
        length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, checksum]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('tEXt', Buffer.from('fixture\0' + label)), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 20, 40, 60, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function prepareDocuments(base, sizes) {
    const { PiSessionStore, getSdk } = require('../../server/pi-session-store');
    const { marker } = require('../../public/pi-document-references');
    const cwd = path.join(base, 'project'), store = new PiSessionStore();
    const session = await store.createSession(cwd, 'Synthetic storage benchmark');
    const { SessionManager, getAgentDir } = await getSdk();
    if (fs.realpathSync(getAgentDir()) !== path.join(base, 'agent')) throw new Error('Unexpected SDK identity path');
    const manager = SessionManager.open(session.path), root = path.join(base, 'agent', 'pivane-uploads');
    fs.mkdirSync(root, { mode: 0o700 });
    for (const name of ['.storage-receipts', '.storage-deleted']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const references = [], chunk = Buffer.alloc(MiB, 0x6b);
    for (let index = 0; index < sizes.length; index++) {
        const requestId = 'synthetic-' + index, id = sha(JSON.stringify([cwd, session.id, requestId]));
        const folder = path.join(root, id); fs.mkdirSync(folder, { mode: 0o700 });
        const fd = fs.openSync(path.join(folder, 'original'), 'wx', 0o600), hash = crypto.createHash('sha256');
        try {
            for (let offset = 0; offset < sizes[index]; offset += chunk.length) {
                const part = chunk.subarray(0, Math.min(chunk.length, sizes[index] - offset));
                fs.writeSync(fd, part); hash.update(part);
            }
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        const reference = { id, revision: hash.digest('hex'), name: `synthetic-${index}.bin`, format: 'file', size: sizes[index] };
        const manifest = { version: 1, cwd, sessionId: session.id, requestId, createdAt: '2026-10-23T00:00:00.000Z', reference };
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        references.push(reference);
        if (index % 2 === 0) manager.appendMessage({ role: 'user', content: marker(reference), timestamp: index + 1 });
    }
    return { group: 'document', sizes, count: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0), protectedCount: Math.ceil(sizes.length / 2),
        root, cwd, session: { id: session.id, path: session.path }, references,
        manifestBytes: references.reduce((sum, ref) => sum + fs.statSync(path.join(root, ref.id, 'manifest.json')).size, 0), nativeBytes: fs.statSync(session.path).size };
}
function prepareMedia(base, count) {
    const directory = path.join(base, 'media', 'references'); fs.mkdirSync(directory, { mode: 0o700 });
    let bytes = 0;
    for (let index = 0; index < count; index++) {
        const content = png('existing-' + index); bytes += content.length;
        fs.writeFileSync(path.join(directory, sha(content) + '.png'), content, { mode: 0o600 });
    }
    return { group: 'media', directory, count, bytes, maxFiles: 5000, maxBytes: 4 * 1024 ** 3, item: 'valid 1x1 RGBA PNG with distinct tEXt and CRC' };
}

function observations() {
    let active = null;
    const descriptors = new Map(), restore = [];
    const category = filename => String(filename).endsWith('/original') ? 'original' : String(filename).endsWith('/manifest.json') ? 'manifest'
        : String(filename).endsWith('.jsonl') ? 'native' : 'other';
    const count = (name, amount = 1) => { if (active) active.counts[name] = (active.counts[name] || 0) + amount; };
    const memory = () => {
        if (!active) return;
        const value = process.memoryUsage();
        for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) active.peak[key] = Math.max(active.peak[key], value[key]);
    };
    const wrap = (object, key, callback) => {
        const original = object[key]; object[key] = callback(original);
        restore.push(() => { object[key] = original; });
    };
    for (const key of ['statSync', 'lstatSync', 'fstatSync', 'readdirSync']) wrap(fs, key, original => function(...args) { count(key); return original.apply(this, args); });
    const wrapRealpath = original => function(filename, ...args) { count('realpathSync'); if (String(filename).startsWith('/proc/self/fd/')) count('descriptorPathSync'); return original.call(this, filename, ...args); };
    // realpathSync.native is a separate callable property used by the production proofs.
    const realpath = fs.realpathSync, native = realpath.native;
    fs.realpathSync = wrapRealpath(realpath); fs.realpathSync.native = wrapRealpath(native);
    restore.push(() => { fs.realpathSync = realpath; });
    wrap(fsp, 'realpath', original => async function(filename, ...args) { count('realpathAsync'); if (String(filename).startsWith('/proc/self/fd/')) count('descriptorPathAsync'); return original.call(this, filename, ...args); });
    wrap(fs, 'openSync', original => function(filename, ...args) {
        const fd = original.call(this, filename, ...args); descriptors.set(fd, category(filename)); count('openSync'); return fd;
    });
    wrap(fs, 'closeSync', original => function(fd, ...args) { try { return original.call(this, fd, ...args); } finally { descriptors.delete(fd); count('closeSync'); } });
    wrap(fs, 'readSync', original => function(fd, ...args) {
        const bytes = original.call(this, fd, ...args), kind = descriptors.get(fd) || 'other';
        count('readSyncCalls'); count(kind + 'ReadCalls'); count(kind + 'ReadBytes', bytes); return bytes;
    });
    wrap(fsp, 'open', original => async function(filename, ...args) {
        const handle = await original.call(this, filename, ...args), kind = category(filename); count('openAsync');
        const read = handle.read.bind(handle), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
        handle.read = async (...input) => { const result = await read(...input); count('readAsyncCalls'); count(kind + 'ReadCalls'); count(kind + 'ReadBytes', result.bytesRead); return result; };
        handle.stat = async (...input) => { count('fstatAsync'); return stat(...input); };
        handle.close = async (...input) => { count('closeAsync'); return close(...input); };
        return handle;
    });
    wrap(fsp, 'lstat', original => async function(...args) { count('lstatAsync'); return original.apply(this, args); });
    wrap(Buffer, 'concat', original => function(...args) {
        const result = original.apply(this, args);
        count('concatCalls'); count('concatBytes', result.length);
        if (active) active.maxConcatBytes = Math.max(active.maxConcatBytes, result.length);
        if (result.length >= MiB) memory(); // Also observe the synchronous full-buffer allocation.
        return result;
    });
    return {
        async measure(action) {
            if (!global.gc) throw new Error('Run the measurement child with --expose-gc');
            global.gc();
            const baseline = process.memoryUsage(), resourceBefore = process.resourceUsage(), cpuBefore = process.cpuUsage();
            const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
            await new Promise(resolve => setTimeout(resolve, 8)); delay.reset();
            active = { counts: {}, peak: { ...baseline }, maxConcatBytes: 0 };
            let last = performance.now(), maxHeartbeatGapMs = 0;
            const timer = setInterval(() => { const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last); last = now; memory(); }, 1);
            const start = performance.now();
            let value, end, after;
            try {
                value = await action(); end = performance.now(); memory(); after = process.memoryUsage();
                // Give a timer delayed by synchronous work a chance to observe that gap.
                await new Promise(resolve => setTimeout(resolve, 5));
                const measured = active, cpu = process.cpuUsage(cpuBefore), resourceAfter = process.resourceUsage();
                return { value, metrics: { elapsedMs: end - start, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
                    baseline, after, peak: measured.peak, rssPeakDeltaBytes: measured.peak.rss - baseline.rss,
                    maxRSSKiBBefore: resourceBefore.maxRSS, maxRSSKiBAfter: resourceAfter.maxRSS,
                    eventLoopMaxMs: delay.max / 1e6, eventLoopP99Ms: delay.percentile(99) / 1e6, maxHeartbeatGapMs,
                    counts: measured.counts, maxConcatBytes: measured.maxConcatBytes } };
            } finally { clearInterval(timer); delay.disable(); active = null; }
        },
        restore() { for (const undo of restore.reverse()) undo(); },
        openSyncDescriptors() { return descriptors.size; }
    };
}
module.exports = { MiB, sha, environment, directories, prohibitNetworkAndProcesses, png, prepareDocuments, prepareMedia, observations };
