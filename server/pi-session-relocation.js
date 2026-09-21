const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { privateDir, readSafe, backupRoots, atomicJson, hash } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const LIMITS = { maxFiles: 10000, maxBytes: 4 * 1024 ** 3 };
// Pi's documented default cwd encoding. The tests compare it with SessionManager.
function sessionDirectory(agentDir, cwd) {
    return path.join(agentDir, 'sessions', `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}
function decodeSession(bytes) {
    const newline = bytes.indexOf(10);
    if (newline < 0 || newline > 1024 * 1024 || bytes.length > MAX_SESSION_BYTES) throw new Error('Unsupported session size or header');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const records = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const header = records[0];
    if (header?.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id
        || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd) || typeof header.timestamp !== 'string'
        || records.slice(1).some(entry => entry.type === 'session')) throw new Error('Only complete native v3 sessions can be relocated');
    const seen = new Set();
    for (const entry of records.slice(1)) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
            || entry.parentId !== null && !seen.has(entry.parentId)) throw new Error('Session tree has duplicate, missing or forward entry links');
        seen.add(entry.id);
    }
    return { header, records, tail: bytes.subarray(newline + 1) };
}
function semanticSnapshot(SessionManager, document) {
    const manager = SessionManager.inMemory(document.header.cwd, undefined, document.records);
    const entries = manager.getEntries();
    // Full native histories can have tens of thousands of ancestors. Compare
    // their exact edges without recursively materializing/serializing getTree().
    return { id: manager.getSessionId(), name: manager.getSessionName(), leaf: manager.getLeafId(),
        entries, branch: manager.getBranch(), edges: entries.map(entry => [entry.id, entry.parentId]),
        labels: entries.filter(entry => entry.type === 'label').map(entry => [entry.targetId, manager.getLabel(entry.targetId)]),
        context: manager.buildSessionContext() };
}
async function relocateSessionBytes(bytes, { sourceCwd, targetCwd, paths = new Map() }) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const original = decodeSession(bytes);
    if (original.header.cwd !== sourceCwd) throw new Error('Session cwd does not match the relocation source');
    if (!path.isAbsolute(targetCwd) || path.normalize(targetCwd) !== targetCwd || targetCwd === sourceCwd) throw new Error('Invalid relocation destination');
    const header = { ...original.header, cwd: targetCwd };
    if (header.parentSession && paths.has(header.parentSession)) header.parentSession = paths.get(header.parentSession);
    const output = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), original.tail]);
    const relocated = decodeSession(output);
    const before = semanticSnapshot(SessionManager, original), after = semanticSnapshot(SessionManager, relocated);
    if (hash(Buffer.from(JSON.stringify(before))) !== hash(Buffer.from(JSON.stringify(after)))) throw new Error('Native session semantics changed during relocation');
    return { bytes: output, id: header.id, entries: before.entries.length, leaf: before.leaf,
        tailSha256: hash(original.tail), semanticSha256: hash(Buffer.from(JSON.stringify(before))) };
}
function sessionNames(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) throw new Error('Session directory contains an unexpected entry');
        return entry.name;
    }).sort();
}
function sameNames(directory, names) { return JSON.stringify(sessionNames(directory)) === JSON.stringify(names); }

// Offline operation: bind the same installation lock as ManagedLauncher. The
// caller must also stop independent Pi CLI writers; the lock cannot own those.
async function relocateProjectSessions({ installation, agentDir, sourceCwd, targetCwd, evidenceDir, externalWritersStopped = false }) {
    if (!externalWritersStopped) throw new Error('Confirm independent session writers are stopped');
    installation = fs.realpathSync.native(installation);
    agentDir = fs.realpathSync.native(agentDir);
    sourceCwd = path.resolve(sourceCwd); targetCwd = path.resolve(targetCwd);
    const sourceDir = sessionDirectory(agentDir, sourceCwd), targetDir = sessionDirectory(agentDir, targetCwd);
    if (sourceDir === targetDir || fs.existsSync(targetDir)) throw new Error('Session destination already exists or collides');
    if (fs.realpathSync.native(sourceDir) !== sourceDir) throw new Error('Session source must be canonical');
    const port = 40000 + createHash('sha256').update(installation).digest().readUInt32BE(0) % 20000;
    const guard = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(port, '127.0.0.1', resolve); });
    let quarantine, staging, sourceMoved = false, targetPublished = false;
    try {
        if (fs.existsSync(evidenceDir)) throw new Error('Relocation evidence directory already exists');
        const evidence = privateDir(evidenceDir), names = sessionNames(sourceDir);
        if (!names.length || names.length > LIMITS.maxFiles) throw new Error('Invalid session relocation count');
        // No outside parent links may be broken silently. Other project headers
        // need an explicit separate migration if they reference this directory.
        for (const bucket of fs.readdirSync(path.join(agentDir, 'sessions'), { withFileTypes: true })) {
            if (bucket.isSymbolicLink()) throw new Error('Linked session directories require an expanded migration scope');
            const directory = path.join(agentDir, 'sessions', bucket.name);
            if (directory === sourceDir || !bucket.isDirectory()) continue;
            for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.jsonl'))) {
                const bytes = readSafe(path.join(directory, name), MAX_SESSION_BYTES);
                const end = bytes.indexOf(10);
                if (end < 0 || end > 1024 * 1024) throw new Error('Cannot inspect another session header');
                const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)));
                if (header.parentSession?.startsWith(sourceDir + path.sep)) throw new Error('Another project has a parentSession reference; migration needs an expanded scope');
            }
        }
        const backup = backupRoots([sourceDir], path.join(evidence, 'backup'), LIMITS);
        const manifest = JSON.parse(readSafe(path.join(backup.directory, 'manifest.json'), 128 * 1024 * 1024));
        const paths = new Map(names.map(name => [path.join(sourceDir, name), path.join(targetDir, name)]));
        const transaction = privateDir(path.join(agentDir, '.pivane-relocations', randomUUID()));
        staging = privateDir(path.join(transaction, 'staged'));
        quarantine = path.join(transaction, 'original');
        if (fs.statSync(path.dirname(sourceDir)).dev !== fs.statSync(transaction).dev) throw new Error('Session relocation requires one filesystem');
        const rows = [];
        for (const name of names) {
            const original = path.join(sourceDir, name), bytes = readSafe(original, MAX_SESSION_BYTES);
            const entry = manifest.entries.find(entry => entry.path === original && entry.type === 'file');
            if (!entry || hash(bytes) !== entry.sha256) throw new Error('Session changed after backup');
            const result = await relocateSessionBytes(bytes, { sourceCwd, targetCwd, paths });
            writePrivateFileSync(path.join(staging, name), result.bytes, true);
            const { bytes: _bytes, ...metadata } = result;
            rows.push({ source: original, destination: path.join(targetDir, name), originalSha256: entry.sha256,
                sha256: hash(result.bytes), ...metadata });
        }
        // Every source is checked again after all asynchronous native validation.
        if (!sameNames(sourceDir, names)) throw new Error('Session membership changed during preparation');
        for (const row of rows) if (hash(readSafe(row.source, MAX_SESSION_BYTES)) !== row.originalSha256) throw new Error('Session changed during preparation');
        atomicJson(path.join(evidence, 'plan.json'), { version: 1, sourceCwd, targetCwd, sourceDir, targetDir, quarantine, rows });
        fs.renameSync(sourceDir, quarantine); sourceMoved = true;
        fs.renameSync(staging, targetDir); targetPublished = true;
        // Publish the result only after exact output and original backup checks.
        for (const row of rows) {
            if (hash(readSafe(row.destination, MAX_SESSION_BYTES)) !== row.sha256
                || hash(readSafe(path.join(quarantine, path.basename(row.source)), MAX_SESSION_BYTES)) !== row.originalSha256) throw new Error('Relocation verification failed');
        }
        const result = { version: 1, sourceCwd, targetCwd, sessions: rows.length, entries: rows.reduce((sum, row) => sum + row.entries, 0),
            backup: backup.directory, originals: quarantine, targetDir, finishedAt: new Date().toISOString() };
        atomicJson(path.join(evidence, 'result.json'), result);
        return result;
    } catch (error) {
        // No worker can start under this installation while the guard is held.
        // Keep the staged attempt for diagnosis; put the untouched source back.
        if (targetPublished) fs.renameSync(targetDir, staging);
        if (sourceMoved) fs.renameSync(quarantine, sourceDir);
        throw error;
    } finally { await new Promise(resolve => guard.close(resolve)); }
}

module.exports = { sessionDirectory, decodeSession, relocateSessionBytes, relocateProjectSessions };
