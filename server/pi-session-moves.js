const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { privateDir, atomicJson, readSafe, hash } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');
const { decodeSession, relocateSessionBytes } = require('./pi-session-relocation');
const { customTypeIs } = require('./pivane-compat');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');

const MAX_BYTES = 64 * 1024 * 1024;
const fail = (message, code = 'SESSION_MOVE_CONFLICT') => Object.assign(new Error(message), { code, status: 409 });
const reference = session => ({ cwd: session.cwd, id: session.id, path: session.path });
const sameRef = (a, cwd, id) => a?.cwd === cwd && a.id === id;
const pending = record => !['committed', 'rolled_back'].includes(record.status);
const statStamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const stamp = file => statStamp(fs.lstatSync(file, { bigint: true }));
function readSource(file) {
    const fd = io.openReadSync(file);
    try {
        const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!before.isFile() || before.size > BigInt(MAX_BYTES) || descriptorPathSync(fd) !== file) throw fail('来源会话文件或大小无效');
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0, size;
        while (length < bytes.length && (size = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += size;
        if (length !== Number(before.size) || statStamp(before) !== statStamp(fs.fstatSync(fd, { bigint: true }))
            || statStamp(before) !== stamp(file) || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity))
            throw fail('来源会话在读取期间变化');
        return { bytes: bytes.subarray(0, length), identity, sourceStamp: statStamp(before) };
    } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// This journal records a filesystem operation and its recovery evidence, never a
// second conversation. Unknown/interrupted operations remain blocked on restart.
class PiSessionMoves {
    constructor({ store, supervisor, preferences, usage, deferred, cron, sideChat, busy = () => false, isSuspended = () => false }) {
        Object.assign(this, { store, supervisor, preferences, usage, deferred, cron, sideChat, busy, isSuspended });
        this.running = 0; this.stopping = false; this.flight = null;
        store.sessionMoves = this;
    }
    async journal() {
        const { getAgentDir } = await getSdk();
        const root = path.join(getAgentDir(), 'pivane-session-moves');
        const file = path.join(root, 'records.json');
        let document;
        try { document = JSON.parse(readSafe(file, 4 * 1024 * 1024)); }
        catch (error) { if (error.code !== 'ENOENT') throw fail('线程移动记录无法读取，请先修复记录'); document = { version: 1, records: [] }; }
        if (document.version !== 1 || !Array.isArray(document.records) || document.records.length > 1000
            || document.records.some(record => !record || !['prepared', 'committed', 'rolled_back', 'recovery'].includes(record.status)
                || !/^[A-Za-z0-9-]{16,80}$/.test(record.requestId) || typeof record.id !== 'string'
                || ![record.source, record.target].every(ref => ref?.id === record.id && typeof ref.cwd === 'string' && path.isAbsolute(ref.cwd)
                    && typeof ref.path === 'string' && path.isAbsolute(ref.path)))) throw fail('线程移动记录无效，请先核对恢复证据');
        return { root, file, document };
    }
    async assertAvailable(cwd, id) {
        const reserved = () => this.reserved?.some(ref => sameRef(ref, cwd, id));
        if (reserved()) throw fail('线程正在移动，请等待完成', 'SESSION_BUSY');
        const { document } = await this.journal();
        if (reserved()) throw fail('线程正在移动，请等待完成', 'SESSION_BUSY');
        if (document.records.some(record => pending(record) && (sameRef(record.source, cwd, id) || sameRef(record.target, cwd, id))))
            throw fail('此线程有尚未完成的移动，请先核对移动记录和原始备份', 'SESSION_MOVE_RECOVERY');
    }
    async verify(session, record) {
        const bytes = readSafe(session.path, MAX_BYTES), parsed = decodeSession(bytes);
        if (parsed.header.id !== session.id || parsed.header.cwd !== session.cwd
            || !Number.isSafeInteger(record.tailLength) || record.tailLength < 0 || parsed.tail.length < record.tailLength
            || hash(parsed.tail.subarray(0, record.tailLength)) !== record.tailSha256) throw fail('移动后的原生历史已变化，无法证明旧引用归属');
    }
    async resolve(cwdInput, id) {
        const { document } = await this.journal();
        let cwd, accessible = true;
        try { cwd = this.store.resolveProject(cwdInput); }
        catch (error) {
            accessible = false;
            if (typeof cwdInput !== 'string' || !path.isAbsolute(cwdInput)) throw error;
            cwd = path.resolve(cwdInput);
            if (!this.store.roots.some(root => cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
                || !document.records.some(record => record.status === 'committed' && sameRef(record.source, cwd, id))) throw error;
        }
        await this.assertAvailable(cwd, id);
        // An actual current session takes precedence over historical relocation evidence.
        const direct = accessible && (await this.store.listSessions(cwd)).find(session => session.id === id);
        if (direct) return { session: await this.store.getSession(cwd, id), moved: false };
        let current = { cwd, id }, last;
        for (const record of document.records) {
            if (record.status === 'committed' && sameRef(record.source, current.cwd, current.id)) { current = record.target; last = record; }
        }
        if (!last) throw fail('会话已不存在', 'SESSION_NOT_FOUND');
        const session = await this.store.getSession(current.cwd, id);
        if (session.path !== current.path) throw fail('移动后的会话文件身份已变化');
        await this.verify(session, last);
        return { session, moved: true, sourceCwd: cwd };
    }
    async deliveryProof(session) {
        const { document } = await this.journal();
        const grants = new Map([[session.cwd, null]]), chain = [];
        let cursor = reference(session);
        for (const record of [...document.records].reverse()) {
            if (record.status !== 'committed' || record.id !== session.id || record.target.path !== cursor.path || record.target.cwd !== cursor.cwd) continue;
            chain.push(record); cursor = record.source;
        }
        if (!chain.length) return grants;
        const parsed = decodeSession(readSafe(session.path, MAX_BYTES));
        if (parsed.header.id !== session.id || parsed.header.cwd !== session.cwd) throw fail('移动后的会话身份已变化');
        const cutoffs = new Map();
        let budget = 0;
        for (const record of chain) {
            if (!Number.isSafeInteger(record.tailLength) || record.tailLength < 0 || record.tailLength > parsed.tail.length
                || (budget += record.tailLength) > 256 * 1024 * 1024
                || hash(parsed.tail.subarray(0, record.tailLength)) !== record.tailSha256) throw fail('历史交付的移动前缀无法证明或超过预算');
            cutoffs.set(record.source.cwd, Math.max(cutoffs.get(record.source.cwd) || 0, record.tailLength));
            if (record.source.cwd !== session.cwd) grants.set(record.source.cwd, new Set());
        }
        // A past project only grants refs that existed before leaving that
        // project. This also preserves valid refs inherited by native forks,
        // without granting newly appended foreign refs after a move.
        const limit = Math.max(...cutoffs.values());
        for (let position = 0; position < limit;) {
            let end = parsed.tail.indexOf(10, position);
            if (end < 0) end = parsed.tail.length;
            const text = parsed.tail.subarray(position, end).toString('utf8').trim();
            const next = end < parsed.tail.length ? end + 1 : end;
            if (text) {
                const entry = JSON.parse(text);
                if (entry.type === 'custom' && entry.customType === 'pivane-deliverable' && entry.data?.id && entry.data.manifestRevision) {
                    for (const [cwd, cutoff] of cutoffs) if (next <= cutoff && grants.get(cwd))
                        grants.get(cwd).add(entry.data.id + ':' + entry.data.manifestRevision);
                }
            }
            position = next;
        }
        return grants;
    }
    globalBlockers(session) {
        const reasons = [];
        if (this.isSuspended() || this.stopping || this.supervisor.disposing || this.busy()) reasons.push('工作台有相关后台操作，请等待完成后再移动');
        if (this.deferred?.list(session.cwd, session.id).some(job => !['sent', 'cancelled'].includes(job.status))) reasons.push('线程有预约消息，请先处理或取消预约');
        if (this.cron?.db.homes().some(home => home.cwd === session.cwd && home.sessionId === session.id)
            || this.cron?.db.jobs().some(job => !job.deleted && job.target.kind === 'thread' && job.target.cwd === session.cwd && job.target.sessionId === session.id))
            reasons.push('线程被定时任务或助手主对话引用，请先解除这些关联');
        if ([...(this.sideChat?.parents.values() || [])].some(parent => parent.source?.cwd === session.cwd && parent.source?.sessionId === session.id)
            || [...(this.sideChat?.connections || [])].some(connection => connection.reference.source?.cwd === session.cwd && connection.reference.source?.sessionId === session.id))
            reasons.push('线程有侧聊，请先关闭侧聊后再移动');
        return reasons;
    }
    async inspect(session, targetCwd, { locked = false } = {}) {
        const { SessionManager, getAgentDir } = await getSdk();
        const { bytes, sourceStamp, identity } = readSource(session.path), parsed = decodeSession(bytes);
        if (parsed.header.id !== session.id || parsed.header.cwd !== session.cwd) throw fail('原生会话身份已变化');
        const reasons = this.globalBlockers(session);
        const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
        const worker = this.supervisor.getActiveWorker(session.path);
        if (!locked && (!this.supervisor.isSessionIdle(session.path) || worker?.titleGeneration)) add('请等待线程、标题生成和后台子 Agent 空闲后再移动');
        for (const entry of parsed.records.slice(1)) {
            if (entry.type === 'custom' && (customTypeIs(entry, 'pivane-agent-task') || customTypeIs(entry, 'pivane-agent-task-receipt')
                || customTypeIs(entry, 'pivane-agent-message-out'))) add('线程有任务回执或线程间消息关系，首版暂不支持移动');
            if (entry.type === 'custom_message' && ['pivane-agent-message', 'pivane-agent-task-message', 'pivane-agent-task-receipt'].some(type => customTypeIs(entry, type)))
                add('线程有任务回执或线程间消息关系，首版暂不支持移动');
            if (entry.type === 'custom' && ['pivane-assistant-project', 'pivane-profile-authoring', 'pivane-extension-assistant'].includes(entry.customType))
                add('助手项目、档案编辑和扩展助手线程暂不支持移动');
            if (entry.type === 'custom' && entry.customType === 'pivane-agent-profile' && entry.data?.sessionId === session.id && entry.data.profileId)
                add('线程绑定了助手档案与记忆来源，首版暂不支持移动');
        }
        const directory = SessionManager.create(targetCwd).getSessionDir();
        if (path.dirname(session.path) === directory) throw fail('目标项目与来源共用会话目录，不能移动');
        if ((await this.store.listSessions(targetCwd)).some(item => item.id === session.id)) add('目标项目已存在相同会话 ID');
        const target = { cwd: targetCwd, id: session.id, path: path.join(directory, path.basename(session.path)) };
        if (fs.existsSync(target.path)) add('目标会话文件已存在，不能覆盖');
        // Inspect only bounded native files, yielding between files. Cross-thread
        // references are structured metadata; never replace historical body text.
        const root = path.join(getAgentDir(), 'sessions');
        const membership = [];
        let count = 0, total = 0;
        const refers = ref => ref?.sessionId === session.id && typeof ref.cwd === 'string'
            && (() => { try { return this.store.resolveProject(ref.cwd) === session.cwd; } catch { return ref.cwd === session.cwd; } })();
        for (const bucket of fs.readdirSync(root, { withFileTypes: true })) {
            if (bucket.isSymbolicLink()) throw fail('会话发现目录含链接，请先核对目录');
            if (!bucket.isDirectory()) continue;
            const folder = path.join(root, bucket.name), names = fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')).sort();
            membership.push([folder, names]);
            for (const name of names) {
                const file = path.join(folder, name);
                if (++count > 10000) throw fail('会话引用检查超过文件预算');
                if (file === session.path) continue;
                const data = readSafe(file, MAX_BYTES); total += data.length;
                if (total > 256 * 1024 * 1024) throw fail('会话引用检查超过读取预算');
                const lines = new TextDecoder('utf-8', { fatal: true }).decode(data).split('\n').filter(line => line.trim());
                const header = JSON.parse(lines.shift());
                if (header?.type !== 'session') throw fail('无法核对其他会话的原生引用');
                let parent = header.parentSession;
                if (typeof parent === 'string' && path.isAbsolute(parent)) { try { parent = fs.realpathSync.native(parent); } catch { /* A missing historic parent remains metadata. */ } }
                if (parent === session.path) add('此线程是其他分叉的父会话，首版暂不支持单独移动');
                for (const line of lines) {
                    const entry = JSON.parse(line), value = entry.data || entry.details;
                    if (entry.type === 'custom' && customTypeIs(entry, 'pivane-agent-task') && refers(value?.source)
                        || entry.type === 'custom' && customTypeIs(entry, 'pivane-agent-message-out') && (refers(value?.to) || refers(value?.from)))
                        add('其他线程保存了此线程的任务或消息关系，首版暂不支持移动');
                }
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        for (const [folder, names] of membership) if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')).sort()))
            throw fail('会话目录在引用检查期间变化，请重新预览');
        if (hash(readSafe(session.path, MAX_BYTES)) !== hash(bytes)) throw fail('线程在引用检查期间变化，请重新预览');
        return { bytes, parsed, target, reasons, sourceStamp, identity, revision: hash(bytes) };
    }
    async preview(cwdInput, id, targetInput) {
        const session = await this.store.getSession(cwdInput, id), targetCwd = this.store.resolveProject(targetInput);
        if (targetCwd === session.cwd) throw fail('请选择不同的目标项目');
        const inspected = await this.inspect(session, targetCwd);
        return { source: { cwd: session.cwd, id, name: session.name }, targetCwd, revision: inspected.revision,
            canMove: inspected.reasons.length === 0, blockers: inspected.reasons };
    }
    move(cwd, id, input) {
        if (!input || Object.keys(input).some(key => !['cwd', 'targetCwd', 'expectedRevision', 'requestId'].includes(key))
            || !/^[A-Za-z0-9-]{16,80}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
            return Promise.reject(fail('移动参数无效，请重新预览'));
        if (this.running || this.stopping) return Promise.reject(fail('已有线程移动进行中，请先核对结果'));
        this.running++;
        this.flight = this.perform(cwd, id, input).finally(() => { this.running--; this.flight = null; });
        return this.flight;
    }
    async perform(cwdInput, id, input) {
        const journal = await this.journal(), previous = journal.document.records.find(record => record.requestId === input.requestId);
        if (previous) {
            const historic = value => {
                let cwd;
                try { cwd = this.store.resolveProject(value); }
                catch (error) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw error; cwd = path.resolve(value); }
                if (!this.store.roots.some(root => cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) throw fail('移动请求来源已不在允许范围');
                return cwd;
            };
            const sourceCwd = historic(cwdInput), targetCwd = historic(input.targetCwd);
            if (previous.id !== id || previous.source.cwd !== sourceCwd || previous.target.cwd !== targetCwd || previous.revision !== input.expectedRevision)
                throw fail('移动请求 ID 已用于其他参数');
            if (previous.status === 'committed') return { ...await this.resolve(sourceCwd, id), requestId: input.requestId };
            throw fail('该移动请求已执行或结果不确定，请先核对记录；不会再次执行');
        }
        if (journal.document.records.length >= 1000) throw fail('移动记录已达上限，请先整理恢复证据');
        const sourceCwd = this.store.resolveProject(cwdInput), targetCwd = this.store.resolveProject(input.targetCwd);
        const session = await this.store.getSession(sourceCwd, id);
        if (sourceCwd === targetCwd) throw fail('请选择不同的目标项目');
        const { SessionManager } = await getSdk();
        const target = { cwd: targetCwd, id, path: path.join(SessionManager.create(targetCwd).getSessionDir(), path.basename(session.path)) };
        this.reserved = [reference(session), target];
        let stopped = false;
        try {
            const result = await this.supervisor.withSessionMove(session.path, target.path, async worker => {
                const inspected = await this.inspect(session, targetCwd, { locked: true });
                if (inspected.reasons.length) throw fail(inspected.reasons.join('；'));
                if (inspected.revision !== input.expectedRevision) throw fail('线程已变化，请重新预览');
                return this.usage.withSessionRelocation(async usage => {
                    worker?._broadcast({ type: 'gateway_session_moving' });
                    stopped = true;
                    await this.supervisor.stopSession(session.path);
                    await usage.preserve(session.path);
                    const transformed = await relocateSessionBytes(inspected.bytes, { sourceCwd, targetCwd });
                    if (!io.sameIdentityAtPath(session.path, inspected.identity) || stamp(session.path) !== inspected.sourceStamp || hash(readSafe(session.path, MAX_BYTES)) !== inspected.revision) throw fail('线程在准备期间变化，请重新预览');
                    if (this.globalBlockers(session).length) throw fail('相关后台状态已变化，请重新预览');
                    this.store.resolveProject(sourceCwd); this.store.resolveProject(targetCwd);
                    const root = privateDir(journal.root), evidence = privateDir(path.join(root, input.requestId));
                    const destination = privateDir(path.dirname(target.path));
                    if (destination !== path.dirname(target.path)) throw fail('目标会话目录身份已变化');
                    if (fs.statSync(destination).dev !== fs.statSync(evidence).dev || fs.statSync(path.dirname(session.path)).dev !== fs.statSync(evidence).dev)
                        throw fail('首版只支持同一文件系统内的会话移动');
                    const backup = path.join(evidence, 'original.jsonl'), staged = path.join(evidence, 'staged.jsonl');
                    writePrivateFileSync(backup, inspected.bytes, true); writePrivateFileSync(staged, transformed.bytes, true);
                    const modified = fs.statSync(session.path).mtime;
                    fs.utimesSync(backup, modified, modified.getTime() / 1000 + 0.000001);
                    fs.utimesSync(staged, modified, modified.getTime() / 1000 + 0.000001);
                    if (fs.statSync(staged).mtime.getTime() !== modified.getTime()) throw fail('无法保留会话修改时间');
                    const snapshot = this.preferences.captureSessionReferences(session, target);
                    const record = { requestId: input.requestId, id, revision: inspected.revision, source: reference(session), target,
                        status: 'prepared', createdAt: new Date().toISOString(), backup, staged,
                        originalSha256: inspected.revision, outputSha256: hash(transformed.bytes),
                        tailLength: inspected.parsed.tail.length, tailSha256: transformed.tailSha256, preferences: snapshot };
                    journal.document.records.push(record);
                    // Reserve room for the terminal status before publishing any session bytes.
                    if (Buffer.byteLength(JSON.stringify(journal.document, null, 2)) > 4 * 1024 * 1024 - 256) throw fail('移动日志已达读取预算，请先整理恢复证据');
                    atomicJson(journal.file, journal.document);
                    let published = false, sourceRemoved = false, preferencesAttempted = false, usageAttempted = false;
                    try {
                        if (!io.sameIdentityAtPath(session.path, inspected.identity) || stamp(session.path) !== inspected.sourceStamp || hash(readSafe(session.path, MAX_BYTES)) !== inspected.revision) throw fail('线程在发布前变化');
                        if (fs.existsSync(target.path)) throw fail('目标文件已存在，不能覆盖');
                        fs.linkSync(staged, target.path); published = true; syncDirectory(destination);
                        if (hash(readSafe(target.path, MAX_BYTES)) !== record.outputSha256) throw fail('移动文件验证失败');
                        if (!io.sameIdentityAtPath(session.path, inspected.identity) || stamp(session.path) !== inspected.sourceStamp) throw fail('来源文件在发布期间变化');
                        fs.unlinkSync(session.path); sourceRemoved = true; syncDirectory(path.dirname(session.path));
                        preferencesAttempted = true; this.preferences.moveSessionReferences(session, target, snapshot);
                        usageAttempted = true; await usage.relocate(reference(session), target);
                        if (hash(readSafe(target.path, MAX_BYTES)) !== record.outputSha256) throw fail('移动后会话已变化');
                        fs.unlinkSync(staged); syncDirectory(evidence);
                        record.status = 'committed'; record.completedAt = new Date().toISOString(); atomicJson(journal.file, journal.document);
                    } catch (error) {
                        try {
                            if (sourceRemoved) {
                                const restored = path.join(evidence, 'restored.jsonl');
                                writePrivateFileSync(restored, readSafe(backup, MAX_BYTES), true);
                                fs.utimesSync(restored, modified, modified.getTime() / 1000 + 0.000001);
                                fs.linkSync(restored, session.path); fs.unlinkSync(restored); syncDirectory(path.dirname(session.path));
                            }
                            if (usageAttempted) await usage.relocate(target, reference(session));
                            if (preferencesAttempted) this.preferences.restoreSessionReferences(session, target, snapshot);
                            if (published) {
                                if (hash(readSafe(target.path, MAX_BYTES)) !== record.outputSha256) throw fail('目标文件已变化，必须人工核对恢复');
                                fs.unlinkSync(target.path); syncDirectory(destination);
                            }
                            if (hash(readSafe(session.path, MAX_BYTES)) !== record.originalSha256) throw fail('来源恢复验证失败');
                            record.status = 'rolled_back'; atomicJson(journal.file, journal.document);
                        } catch {
                            record.status = 'recovery'; atomicJson(journal.file, journal.document);
                            throw fail('移动未完成，自动恢复未通过；原始备份已保留，请核对移动记录', 'SESSION_MOVE_RECOVERY');
                        }
                        throw error;
                    }
                    for (const cwd of [sourceCwd, targetCwd]) { this.store.sessionListCache.delete(cwd); this.store.sessionLists.delete(cwd); }
                    return { session: { ...session, ...target }, requestId: input.requestId, moved: true };
                });
            });
            this.reserved = null;
            this.supervisor.emit('sessionMove', { source: reference(session), session: result.session });
            return result;
        } catch (error) {
            if (stopped) this.supervisor.emit('sessionMove', { source: reference(session), failed: true });
            throw error;
        } finally { this.reserved = null; }
    }
    async dispose() { this.stopping = true; await this.flight?.catch(() => {}); }
}
function mountSessionMoves(router, dependencies) {
    const service = new PiSessionMoves(dependencies);
    const endpoint = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await handler(req)); }
        catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code }); }
    };
    router.get('/sessions/:id/resolve', endpoint(req => service.resolve(req.query.cwd, req.params.id)));
    router.get('/sessions/:id/move', endpoint(req => service.preview(req.query.cwd, req.params.id, req.query.targetCwd)));
    router.post('/sessions/:id/move', endpoint(req => service.move(req.body?.cwd, req.params.id, req.body)));
    return service;
}
module.exports = { PiSessionMoves, mountSessionMoves };
