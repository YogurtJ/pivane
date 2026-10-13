// Private operation receipts, not conversation history. An interrupted creation
// is never replayed; only a completed receipt can return the original result.
const fs = require('node:fs'), path = require('node:path');
const { getSdk } = require('./pi-session-store');
const { privateDir, readSafe, hash, atomicJson } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');
const { promptFromEntry } = require('./pi-message-payload');
const failure = (message, code, status = 409) => Object.assign(new Error(message), { status, code });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{16,80}$/.test(id);
class ForkRequests {
    constructor(store) { this.store = store; this.running = new Map(); }
    key(session, requestId) {
        if (!validId(requestId)) throw failure('分叉请求标识无效', 'FORK_REQUEST_INVALID', 400);
        return hash(JSON.stringify([session.cwd, session.id, requestId]));
    }
    async file(key, create = false) {
        let root = fs.realpathSync.native((await getSdk()).getAgentDir());
        for (const part of ['pivane-session-moves', 'fork-requests']) {
            root = path.join(root, part);
            let stat;
            try { stat = fs.lstatSync(root); }
            catch (error) { if (!create || error.code !== 'ENOENT') throw error; privateDir(root); stat = fs.lstatSync(root); }
            if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) throw failure('分叉操作回执位置已变化', 'FORK_REQUEST_CHANGED');
        }
        return path.join(root, key + '.json');
    }
    read(file, session, requestId) {
        let record;
        try { record = JSON.parse(readSafe(file, 65536)); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (record?.version !== 1 || record.requestId !== requestId || record.source?.cwd !== session.cwd
            || record.source.id !== session.id || record.source.created !== session.created
            || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !['pending', 'completed', 'failed', 'uncertain'].includes(record.status)
            || record.status === 'completed' && (!record.target?.id || record.target.cwd !== session.cwd || !record.target.created))
            throw failure('分叉操作回执无效或来源已变化', 'FORK_REQUEST_CHANGED');
        return record;
    }
    save(file, record, initial = false) {
        const json = JSON.stringify(record, null, 2) + '\n';
        if (Buffer.byteLength(json) > 65536) throw failure('分叉操作回执超过预算', 'FORK_REQUEST_LIMIT', 413);
        if (initial) writePrivateFileSync(file, json, true); else atomicJson(file, record);
    }
    async result(source, record) {
        let session;
        try {
            session = this.store.sessionMoves ? (await this.store.sessionMoves.resolve(record.target.cwd, record.target.id)).session
                : await this.store.getSession(record.target.cwd, record.target.id);
            if (session.created !== record.target.created) throw new Error('changed');
        } catch { throw failure('已创建的线程已删除或无法定位，请在线程列表中核对；不会重复创建', 'FORK_RESULT_UNAVAILABLE'); }
        let draft = null;
        if (record.draftEntryId) {
            // Read the original native question, never persist a second copy of
            // its text/images in the receipt. Appends/branch changes retain it.
            const { SessionManager } = await getSdk();
            const manager = this.store.profileManager(source, SessionManager);
            draft = promptFromEntry(manager.getEntry(record.draftEntryId));
        }
        return { session, draft, requestId: record.requestId };
    }
    async status(session, requestId) {
        const key = this.key(session, requestId);
        if (this.running.has(key)) return { requestId, status: 'pending' };
        let file;
        try { file = await this.file(key); }
        catch (error) { if (error.code === 'ENOENT') return { requestId, status: 'not_found' }; throw error; }
        const record = this.read(file, session, requestId);
        if (this.running.has(key)) return { requestId, status: 'pending' };
        if (!record) return { requestId, status: 'not_found' };
        if (record.status === 'completed') {
            try { return { requestId, status: 'completed', result: await this.result(session, record) }; }
            catch (error) { return { requestId, status: 'unavailable', error: error.message }; }
        }
        return { requestId, status: record.status === 'pending' ? 'uncertain' : record.status };
    }
    run(session, input, execute) {
        const key = this.key(session, input.requestId);
        if (input.expectedLeafId !== null && (typeof input.expectedLeafId !== 'string' || input.expectedLeafId.length > 160)
            || input.entryId !== undefined && (typeof input.entryId !== 'string' || !input.entryId || input.entryId.length > 160)
            || !['before', 'at'].includes(input.position === undefined ? 'before' : input.position)) throw failure('分叉请求参数无效', 'FORK_REQUEST_INVALID', 400);
        const fingerprint = hash(JSON.stringify([session.cwd, session.id, session.created, input.expectedLeafId, input.entryId ?? null, input.position ?? 'before']));
        const active = this.running.get(key);
        if (active) return active.fingerprint === fingerprint ? active.promise : Promise.reject(failure('此请求标识已用于不同分叉参数', 'FORK_REQUEST_CONFLICT'));
        // Reserve before any await, including receipt directory discovery.
        const operation = { fingerprint, promise: null }; this.running.set(key, operation);
        operation.promise = this.perform(session, input, key, fingerprint, execute).finally(() => this.running.delete(key));
        return operation.promise;
    }
    async perform(session, input, key, fingerprint, execute) {
        const file = await this.file(key, true), previous = this.read(file, session, input.requestId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw failure('此请求标识已用于不同分叉参数', 'FORK_REQUEST_CONFLICT');
            if (previous.status === 'completed') return this.result(session, previous);
            throw failure('此创建请求已结束或结果待确认，请查询结果并核对线程列表；不会重复创建', 'FORK_REQUEST_UNCERTAIN');
        }
        const record = { version: 1, requestId: input.requestId, fingerprint, status: 'pending',
            source: { cwd: session.cwd, id: session.id, created: session.created },
            draftEntryId: input.entryId && (input.position ?? 'before') === 'before' ? input.entryId : null };
        this.save(file, record, true);
        if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        let started = false;
        try {
            const result = await execute(() => { started = true; });
            // Empty-branch creation can return a presentation timestamp. Bind
            // the receipt to the canonical native header, just like lookup.
            const target = await this.store.getSession(result.session.cwd, result.session.id);
            record.target = { cwd: target.cwd, id: target.id, created: target.created };
            record.status = 'completed'; this.save(file, record);
            return { ...result, session: target, requestId: input.requestId };
        } catch (error) {
            record.status = started ? 'uncertain' : 'failed';
            try { this.save(file, record); } catch { /* A pending receipt also prohibits replay. */ }
            throw error;
        }
    }
}
module.exports = { ForkRequests };
