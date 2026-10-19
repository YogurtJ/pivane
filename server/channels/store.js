const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { privateDir, readSafe, atomicJson, hash } = require('../pi-maintenance-files');
const { openPrivateFileSync, privateFileMode } = require('../pi-private-files');
const empty = () => ({ version: 1, revision: randomUUID(), accounts: [], bindings: [], peers: [], jobs: [] });
const pending = job => ['queued', 'dispatching', 'running', 'ready', 'sending', 'uncertain'].includes(job.status);
class ChannelStore {
    constructor(directory) { this.directory = directory; this.file = path.join(directory, 'state.json'); this.ownerFile = path.join(directory, 'owner.sqlite'); this.owner = null; this.value = empty(); this.diskHash = null; this.load(); }
    load() {
        let bytes;
        try { bytes = readSafe(this.file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const value = JSON.parse(bytes);
        if (value.version !== 1 || typeof value.revision !== 'string' || !['accounts', 'bindings', 'peers', 'jobs'].every(k => Array.isArray(value[k]))
            || value.accounts.length > 10 || value.bindings.length > 200 || value.peers.length > 500 || value.jobs.length > 5000) throw new Error('消息渠道记录无效');
        const id = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\x00-\x1f]/.test(s);
        if (value.accounts.some(a => !a || !id(a.id) || !id(a.userId) || typeof a.enabled !== 'boolean'
            || typeof a.token !== 'string' || !a.token || a.token.length > 8192
            || !/^https:\/\/ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(a.baseUrl || '')
            || typeof a.cursor !== 'string' || a.cursor.length > 65536
            || !Array.isArray(a.allowedUsers) || a.allowedUsers.length > 100 || !a.allowedUsers.every(id))
            || new Set(value.accounts.map(a => a.id)).size !== value.accounts.length
            || value.bindings.some(b => !b || !id(b.id) || !id(b.accountId) || !id(b.peerId) || !id(b.sessionId)
                || typeof b.cwd !== 'string' || !path.isAbsolute(b.cwd) || b.cwd.length > 4096)
            || value.jobs.some(j => !j || typeof j.id !== 'string' || typeof j.status !== 'string')
            || value.peers.some(p => !p || !id(p.accountId) || !id(p.peerId) || typeof p.contextToken !== 'string' || p.contextToken.length > 8192
                || p.typingTicket !== undefined && (typeof p.typingTicket !== 'string' || p.typingTicket.length > 4096)))
            throw new Error('消息渠道账号或绑定记录无效');
        this.value = value; this.diskHash = hash(bytes);
    }
    claim() {
        if (this.owner) return;
        privateDir(this.directory);
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
            try { if (!fs.lstatSync(this.ownerFile + suffix).isFile()) throw new Error('Unsafe channel owner file'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!fs.existsSync(this.ownerFile)) { try { fs.closeSync(openPrivateFileSync(this.ownerFile)); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
        privateFileMode(this.ownerFile);
        const { DatabaseSync } = require('node:sqlite');
        const lock = new DatabaseSync(this.ownerFile);
        try {
            lock.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, nonce TEXT NOT NULL); BEGIN IMMEDIATE');
            const previous = lock.prepare('SELECT pid,nonce FROM owner WHERE id=1').get();
            if (previous) {
                let alive = true;
                try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
                if (alive) throw new Error('此身份的消息渠道已由另一个服务管理');
            }
            const owner = { pid: process.pid, nonce: randomUUID() };
            lock.prepare('INSERT OR REPLACE INTO owner VALUES (1,?,?)').run(owner.pid, owner.nonce);
            lock.exec('COMMIT'); this.owner = owner; this.lock = lock;
        } catch (error) { try { lock.exec('ROLLBACK'); } catch {} lock.close(); throw error; }
        this.change(value => { for (const job of value.jobs) if (['dispatching', 'running', 'sending'].includes(job.status)) { job.status = 'uncertain'; job.reason = 'restart'; } });
    }
    change(fn, { config = false, revision } = {}) {
        if (!this.owner) throw new Error('渠道服务未取得写入所有权');
        const owner = this.lock.prepare('SELECT nonce FROM owner WHERE id=1').get();
        if (owner?.nonce !== this.owner.nonce) throw new Error('渠道所有者已变化');
        let diskHash = null;
        try { diskHash = hash(readSafe(this.file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (diskHash !== this.diskHash || revision !== undefined && revision !== this.value.revision) throw Object.assign(new Error('消息渠道配置已变化，请刷新核对'), { status: 409 });
        const next = structuredClone(this.value), result = fn(next);
        if (config) next.revision = randomUUID();
        if (Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024) throw new Error('渠道记录超过容量，请先处理待核对消息');
        atomicJson(this.file, next); this.diskHash = hash(readSafe(this.file)); this.value = next; return result;
    }
    close() {
        if (!this.owner) return;
        try { this.lock.prepare('DELETE FROM owner WHERE id=1 AND nonce=?').run(this.owner.nonce); }
        finally { this.lock.close(); this.lock = null; this.owner = null; }
    }
}
module.exports = { ChannelStore, pending };
