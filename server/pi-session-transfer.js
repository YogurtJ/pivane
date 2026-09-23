const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { replaceFileSync } = require('./pi-win32-native');

function patchExportSystemPrompt(file, systemPrompt) {
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return;
    const html = fs.readFileSync(file, 'utf8');
    const match = html.match(/(<script id="session-data" type="application\/json">)([^<]+)(<\/script>)/);
    if (!match) return;
    let data;
    try { data = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8')); }
    catch { return; }
    if (typeof data !== 'object' || data === null) return;
    data.systemPrompt = systemPrompt;
    const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    const patched = html.slice(0, match.index) + match[1] + encoded + match[3] + html.slice(match.index + match[0].length);
    const temporary = `${file}.pivane-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
        privateFiles.writePrivateFileSync(temporary, patched, true);
        replaceFileSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
}

const IMPORT_BYTES = 16 * 1024 * 1024;
const EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 50000;
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';

// Validate before handing uploaded data to Pi's permissive JSONL reader. Never skip bad lines.
function validateImport(content) {
    if (!text(content) || !content.trim()) fail('请选择非空的 Pi JSONL 会话文件');
    if (Buffer.byteLength(content) > IMPORT_BYTES) fail('会话文件超过 16 MiB 上限');
    const entries = [];
    for (const line of content.replace(/^\uFEFF/, '').split('\n')) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) fail('单条会话记录超过 8 MiB 上限');
        let value;
        try { value = JSON.parse(line); } catch { fail(`第 ${entries.length + 1} 条记录不是有效 JSON`); }
        if (!object(value)) fail('会话记录必须是 JSON 对象');
        const stack = [[value, 0]];
        while (stack.length) {
            const [item, depth] = stack.pop();
            if (depth > 64) fail('会话记录嵌套过深');
            if (item && typeof item === 'object') for (const child of Object.values(item)) {
                if (child && typeof child === 'object') stack.push([child, depth + 1]);
            }
        }
        entries.push(value);
        if (entries.length > MAX_ENTRIES + 1) fail('会话记录超过 50000 条上限');
    }
    const header = entries[0];
    if (header?.type !== 'session' || !text(header.id) || !header.id || ![2, 3].includes(header.version)
        || !text(header.cwd) || !text(header.timestamp) || !Number.isFinite(Date.parse(header.timestamp))) {
        fail('仅支持 Pi v2/v3 会话 JSONL；HTML 和其他 Agent 的记录不能导入');
    }
    const ids = new Map(), references = [];
    const usage = value => {
        if (!object(value) || !object(value.cost)
            || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => Number.isFinite(value[key]) && value[key] >= 0)
            || !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => Number.isFinite(value.cost[key]) && value.cost[key] >= 0)) fail('用量记录无效');
    };
    const contentBlocks = (content, roles) => {
        if (!Array.isArray(content)) fail('消息内容格式无效');
        for (const block of content) {
            if (!object(block) || !roles.includes(block.type)) fail('消息内容块类型无效');
            if (block.type === 'text' && !text(block.text) || block.type === 'thinking' && !text(block.thinking)
                || block.type === 'image' && (!text(block.data) || !/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType))
                || block.type === 'toolCall' && (!text(block.id) || !block.id || !text(block.name) || !object(block.arguments))) fail('消息内容块格式无效');
        }
    };
    const tool = value => {
        if (!object(value) || !text(value.name) || !value.name || !text(value.description) || !object(value.parameters)) fail('系统工具定义无效');
        if (value.constrainedSampling !== undefined && value.constrainedSampling !== false && !object(value.constrainedSampling)) fail('系统工具约束无效');
    };
    const message = msg => {
        if (!object(msg)) fail('消息格式无效');
        switch (msg.role) {
            case 'system':
                if (!(text(msg.content) || Array.isArray(msg.content))) fail('系统消息内容无效');
                if (Array.isArray(msg.content)) contentBlocks(msg.content, ['text']);
                if (msg.sections !== undefined && (!object(msg.sections) || Object.values(msg.sections).some(value => value !== null && !text(value)))) fail('系统消息分区无效');
                if (msg.toolsAdded !== undefined && (!Array.isArray(msg.toolsAdded) || msg.toolsAdded.some(value => { tool(value); return false; }))) fail('系统工具增量无效');
                if (msg.toolsRemoved !== undefined && (!Array.isArray(msg.toolsRemoved) || msg.toolsRemoved.some(value => !object(value) || !text(value.name) || !value.name))) fail('系统工具移除无效');
                if (!Number.isFinite(msg.timestamp)) fail('系统消息时间无效');
                break;
            case 'user': if (!text(msg.content)) contentBlocks(msg.content, ['text', 'image']); break;
            case 'assistant':
                contentBlocks(msg.content, ['text', 'image', 'thinking', 'toolCall']);
                if (![msg.provider, msg.model, msg.api].every(text) || !object(msg.usage)
                    || !['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(msg.stopReason)) fail('助手消息元数据无效');
                usage(msg.usage);
                break;
            case 'toolResult':
                if (!text(msg.toolCallId) || !text(msg.toolName) || typeof msg.isError !== 'boolean') fail('工具结果格式无效');
                contentBlocks(msg.content, ['text', 'image']);
                if (msg.usage !== undefined) usage(msg.usage);
                break;
            case 'compactionSummary': case 'branchSummary': if (!text(msg.summary)) fail('摘要消息无效'); break;
            case 'bashExecution': if (!text(msg.command) || !text(msg.output)) fail('命令记录格式无效'); break;
            case 'custom': case 'hookMessage':
                if (!text(msg.customType)) fail('扩展消息格式无效');
                if (!text(msg.content)) contentBlocks(msg.content, ['text', 'image']); break;
            default: fail('不支持的 Pi 消息类型');
        }
    };
    for (const entry of entries.slice(1)) {
        if (!text(entry.id) || !entry.id || entry.id.length > 128 || ids.has(entry.id)
            || entry.parentId !== null && (!text(entry.parentId) || !ids.has(entry.parentId))
            || !text(entry.timestamp) || !Number.isFinite(Date.parse(entry.timestamp))) fail('会话树含重复 ID、失效父节点或无效时间');
        switch (entry.type) {
            case 'message': message(entry.message); break;
            case 'model_change': if (!text(entry.provider) || !text(entry.modelId)) fail('模型记录无效'); break;
            case 'thinking_level_change': if (!text(entry.thinkingLevel)) fail('思考等级记录无效'); break;
            case 'session_info': if (!text(entry.name)) fail('会话名称无效'); break;
            case 'label': if (!text(entry.targetId) || entry.label !== undefined && !text(entry.label)) fail('书签记录无效'); break;
            case 'custom': if (!text(entry.customType)) fail('扩展记录无效'); break;
            case 'custom_message':
                if (!text(entry.customType) || typeof entry.display !== 'boolean') fail('扩展消息无效');
                if (!text(entry.content)) contentBlocks(entry.content, ['text', 'image']); break;
            case 'context_edit': {
                const target = ids.get(entry.targetId);
                const role = target?.type === 'custom_message' ? 'custom' : target?.type === 'message'
                    && ['user', 'assistant', 'toolResult'].includes(target.message.role) ? target.message.role : null;
                if (!['user', 'assistant', 'toolResult', 'custom'].includes(role)) fail('上下文修改引用了无效的消息');
                if (entry.replacement !== null) {
                    if (!object(entry.replacement)) fail('上下文修改替换内容无效');
                    if (!text(entry.replacement.content)) contentBlocks(entry.replacement.content,
                        role === 'assistant' ? ['text', 'image', 'thinking', 'toolCall'] : ['text', 'image']);
                }
                references.push([entry, entry.targetId]);
                break;
            }
            case 'usage':
                if (![entry.kind, entry.provider, entry.model].every(text)) fail('用量归属无效');
                usage(entry.usage);
                break;
            case 'branch_summary': if (!text(entry.summary) || !text(entry.fromId)) fail('分支摘要无效'); break;
            case 'compaction':
                if (!text(entry.summary) || !Number.isFinite(entry.tokensBefore)) fail('压缩摘要无效');
                if (entry.systemMessage !== undefined) message(entry.systemMessage);
                if (entry.retainedTail !== undefined) {
                    if (!Array.isArray(entry.retainedTail)) fail('压缩保留消息无效');
                    entry.retainedTail.forEach(message);
                } else if (entry.firstKeptEntryId !== entry.id) {
                    if (!ids.has(entry.firstKeptEntryId)) fail('压缩摘要引用了缺失的记录');
                    references.push([entry, entry.firstKeptEntryId]);
                }
                break;
            default: fail('不支持的 Pi 会话记录类型');
        }
        if (entry.usage !== undefined) usage(entry.usage);
        ids.set(entry.id, entry);
    }
    // Check branch-local references in linear time, including deep imported trees.
    // An earlier ID alone is insufficient: it may belong to an abandoned sibling.
    if (references.length) {
        const children = new Map(), ranges = new Map();
        for (const entry of ids.values()) {
            if (!children.has(entry.parentId)) children.set(entry.parentId, []);
            children.get(entry.parentId).push(entry.id);
        }
        let order = 0;
        const stack = (children.get(null) || []).map(id => [id, false]);
        while (stack.length) {
            const [id, closing] = stack.pop();
            if (closing) { ranges.get(id).end = order; continue; }
            ranges.set(id, { start: order++, end: null });
            stack.push([id, true]);
            for (const child of children.get(id) || []) stack.push([child, false]);
        }
        for (const [entry, targetId] of references) {
            const target = ranges.get(targetId), current = ranges.get(entry.id);
            if (!target || target.start >= current.start || current.start >= target.end) fail('会话引用不在当前分支的祖先记录中');
        }
    }
    return entries;
}

class PiSessionTransfer {
    constructor({ store, supervisor }) { this.store = store; this.supervisor = supervisor; this.running = 0; this.imports = new Map(); }

    async export(cwd, id, format) {
        if (!['html', 'jsonl'].includes(format)) fail('请选择 HTML 或 Pi JSONL 格式');
        if (this.running >= 2) fail('已有会话文件操作进行中，请稍后再试');
        this.running++;
        let temporary;
        try {
            const session = await this.store.getSession(cwd, id);
            const worker = await this.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            return await worker.exclusive(async (rpc, _runtime, operationToken) => {
                await this.store.getSession(session.cwd, session.id);
                if (fs.statSync(session.path).size > EXPORT_BYTES) fail('会话超过 64 MiB 网页导出上限');
                temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-export-'));
                privateFiles.privateDirectory(temporary);
                const output = path.join(temporary, `session.${format}`);
                if (format === 'html') {
                    await rpc('export_html', { outputPath: output }, 60000);
                    try {
                        const resources = await worker.getNativeResources(true, operationToken);
                        patchExportSystemPrompt(output, resources.body || resources.systemPrompt || '');
                    } catch { /* Native export remains valid if the optional prompt snapshot is unavailable. */ }
                } else {
                    const snapshot = await rpc('get_entries');
                    const { SessionManager, AgentSession } = await getSdk();
                    const manager = SessionManager.inMemory(session.cwd, { id: session.id }, snapshot.entries);
                    if (snapshot.leafId) manager.branch(snapshot.leafId); else manager.resetLeaf();
                    // The public native serializer only needs sessionManager. Bind that dependency
                    // explicitly instead of creating a second agent/runtime or copying its format logic.
                    AgentSession.prototype.exportToJsonl.call({ sessionManager: manager }, output);
                }
                if (fs.statSync(output).size > EXPORT_BYTES) fail('导出文件超过 64 MiB 上限');
                return { data: fs.readFileSync(output), filename: `pi-session-${session.id}.${format}`, format };
            });
        } finally {
            try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
            finally { this.running--; }
        }
    }

    async import(cwdInput, content, requestId) {
        const cwd = this.store.resolveProject(cwdInput);
        if (!text(requestId) || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) fail('导入请求 ID 无效');
        const entries = validateImport(content);
        const hash = createHash('sha256').update(cwd).update('\0').update(content).digest('hex');
        for (const [key, item] of this.imports) if (Date.now() - item.at > 30 * 60000) this.imports.delete(key);
        const previous = this.imports.get(requestId);
        if (previous) {
            if (previous.hash !== hash) fail('导入请求已用于另一个文件或项目');
            if (previous.sessionId) return { session: await this.store.getSession(cwd, previous.sessionId) };
            fail('该导入请求正在处理或结果不确定，请先核对目标项目线程');
        }
        if (this.running >= 2 || this.imports.size >= 100) fail('会话文件操作已达上限，请稍后再试');
        const receipt = { hash, at: Date.now() };
        this.imports.set(requestId, receipt); this.running++;
        let temporary;
        try {
            const { SessionManager, migrateSessionEntries } = await getSdk();
            migrateSessionEntries(entries);
            const targetCwd = this.store.resolveProject(cwd);
            const sessionDir = SessionManager.create(targetCwd).getSessionDir();
            temporary = fs.mkdtempSync(path.join(sessionDir, '.pi-import-'));
            const source = path.join(temporary, 'source.jsonl');
            privateFiles.writePrivateFileSync(source, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
            // forkFrom assigns a new native ID and target cwd, retaining every imported tree entry.
            // No runtime is started and no existing session is switched or overwritten.
            const manager = SessionManager.forkFrom(source, targetCwd, temporary);
            const staged = manager.getSessionFile();
            privateFiles.privateFileMode(staged);
            // Publish the complete native file atomically, without replacing an existing file.
            // Stage on the same filesystem; before publication its parent directory is private.
            fs.linkSync(staged, path.join(sessionDir, path.basename(staged)));
            const session = await this.store.getSession(targetCwd, manager.getSessionId());
            receipt.sessionId = session.id;
            return { session };
        } finally {
            try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
            finally { this.running--; }
        }
    }
}

function mountSessionTransfer(router, dependencies) {
    const transfer = new PiSessionTransfer(dependencies);
    const endpoint = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await handler(req, res); }
        catch (error) { res.status(error.code === 'SESSION_BUSY' ? 409 : 400).json({ error: error.message }); }
    };
    router.post('/sessions/:id/export', endpoint(async (req, res) => {
        const result = await transfer.export(req.body?.cwd, req.params.id, req.body?.format);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "sandbox; default-src 'none'");
        res.attachment(result.filename).type(result.format === 'html' ? 'text/html' : 'application/x-ndjson').send(result.data);
    }));
    router.post('/sessions/import', endpoint(async (req, res) => {
        const result = await transfer.import(req.body?.cwd, req.body?.content, req.body?.requestId);
        const preferences = dependencies.preferences;
        if (preferences?.getHiddenProjects().includes(result.session.cwd)) preferences.setProjectHidden(result.session.cwd, false);
        res.status(201).json(result);
    }));
    return transfer;
}

module.exports = { PiSessionTransfer, mountSessionTransfer, validateImport, IMPORT_BYTES, EXPORT_BYTES };
