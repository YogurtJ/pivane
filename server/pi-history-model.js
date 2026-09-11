// Bounded projections of the current native SessionManager. No files, caches or parallel history.
const { createHash } = require('node:crypto');
const MAX_TEXT = 8 * 1024 * 1024;
const PAGE_TEXT = 16000;
const error = (message, code = 'HISTORY_INVALID') => Object.assign(new Error(message), { code });
const idValid = id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id);
function validateHistoryRequest(kind, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('历史查询参数无效');
    if (kind === 'tree') return require('./pi-session-tree').validateTreeRequest(input);
    if (kind === 'search') {
        const q = input.q ?? '', scope = input.scope ?? 'branch', filter = input.filter ?? 'all', offset = input.offset ?? 0;
        if (typeof q !== 'string' || q.length > 200 || /[\x00-\x1f]/.test(q)) throw error('关键词最多 200 字符，不支持控制字符');
        if (!['branch', 'all'].includes(scope) || !['all', 'conversation', 'user', 'assistant', 'tool', 'summary'].includes(filter)) throw error('历史筛选无效');
        if (input.bookmarked !== undefined && typeof input.bookmarked !== 'boolean') throw error('书签筛选无效');
        if (!Number.isInteger(offset) || offset < 0 || offset > 50000) throw error('分页位置无效');
        if (offset && (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision))) throw error('请重新搜索后翻页');
        return { q: q.trim(), scope, filter, offset, bookmarked: input.bookmarked === true, revision: input.revision };
    }
    if (!idValid(input.entryId)) throw error('历史记录 ID 无效');
    if (kind === 'preview') {
        const offset = input.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > MAX_TEXT) throw error('正文分页位置无效');
        if (input.view !== undefined && !['body', 'record'].includes(input.view)) throw error('预览模式无效');
        return { entryId: input.entryId, offset, view: input.view || 'body' };
    }
    if (kind === 'bookmark') {
        if (typeof input.label !== 'string' || [...input.label].length > 80 || /[\x00-\x1f\x7f]/.test(input.label)) throw error('书签名称最多 80 字，不支持换行或控制字符');
        if (!idValid(input.expectedBookmarkRevision)) throw error('缺少书签修订，请重新打开记录');
        return { entryId: input.entryId, label: input.label.trim(), expectedBookmarkRevision: input.expectedBookmarkRevision };
    }
    throw error('不支持的历史操作');
}
function kindOf(entry) {
    if (['compaction', 'branch_summary'].includes(entry.type)) return 'summary';
    if (entry.type !== 'message' || !entry.message) return null;
    const message = entry.message;
    if (message.role === 'custom' && message.display !== true) return null;
    if (message.role === 'user') return 'user';
    if (message.role === 'assistant') {
        const content = message.content;
        if (Array.isArray(content) && content.length > 100000) throw error('单条记录内容过多，无法检索', 'HISTORY_LIMIT');
        const hasText = typeof content === 'string' ? /\S/.test(content) : Array.isArray(content) && content.some(b => b.type === 'text' && typeof b.text === 'string' && /\S/.test(b.text));
        if (!hasText && Array.isArray(content) && content.some(b => b.type === 'toolCall')) return 'tool';
        return hasText || message.errorMessage || ['error', 'aborted'].includes(message.stopReason) ? 'assistant' : null;
    }
    if (['toolResult', 'bashExecution'].includes(message.role)) return 'tool';
    if (message.role === 'custom') return 'assistant';
    return null;
}
function documentOf(entry, view = 'record') {
    const kind = kindOf(entry); if (!kind) return null;
    const parts = []; let size = 0, images = 0, hasTools = kind === 'tool';
    const add = value => {
        if (typeof value !== 'string' || !value) return;
        size += Buffer.byteLength(value, 'utf8') + 1;
        if (parts.length >= 100000) throw error('工具参数项目过多，无法显示此记录', 'HISTORY_LIMIT');
        if (size > MAX_TEXT) throw error('单条历史正文超过 8 MiB，暂不支持网页检索此记录', 'HISTORY_LIMIT');
        parts.push(value);
    };
    // Tool arguments are JSON, but do not stringify unbounded objects into one intermediate string.
    const args = (value, depth = 0) => {
        if (depth > 32) throw error('工具参数层级过深，无法显示此记录', 'HISTORY_LIMIT');
        if (typeof value === 'string') add(value);
        else if (value === null || ['boolean', 'number'].includes(typeof value)) add(String(value));
        else if (Array.isArray(value)) { add('['); for (const item of value) args(item, depth + 1); add(']'); }
        else if (value && typeof value === 'object') { add('{'); for (const [key, item] of Object.entries(value)) { add(`${key}:`); args(item, depth + 1); } add('}'); }
    };
    if (kind === 'summary') add(entry.summary);
    else {
        const m = entry.message;
        if (m.role === 'bashExecution') { add(m.command); add(m.output); }
        else if (typeof m.content === 'string') add(m.content);
        else if (Array.isArray(m.content)) for (const block of m.content) {
            if (block.type === 'text') add(block.text);
            else if (block.type === 'image') images++;
            else if (block.type === 'toolCall') { hasTools = true; if (view === 'record') { add(`工具：${block.name || 'tool'}`); args(block.arguments); } }
            // Thinking, signatures and hidden custom metadata are not searched or sent to the browser.
        }
        if (m.errorMessage) add(m.errorMessage);
        if (m.stopReason === 'aborted') add('回复已停止');
        else if (m.stopReason === 'error' || m.isError) add('执行失败');
    }
    return { kind, hasTools, images, text: parts.join('\n') };
}
function snapshot(manager, presentation) {
    const entries = manager.getEntries();
    if (entries.length > 50000) throw error('会话超过 50000 条原生记录，暂不支持网页历史检索', 'HISTORY_LIMIT');
    const labelVersions = new Map();
    for (const e of entries) if (e.type === 'label') labelVersions.set(e.targetId, e.id);
    const revision = createHash('sha256').update(JSON.stringify([manager.getSessionId(), manager.getLeafId(), entries.length, entries.at(-1)?.id])).digest('hex');
    const branch = manager.getBranch();
    const stages = presentation ? require('./pi-session-tree').replyStages(entries, branch, presentation.settled === true) : null;
    return { entries, revision, labelVersions, stages, branch: new Set(branch.map(e => e.id)), canBookmark: entries.some(e => e.type === 'message' && e.message?.role === 'assistant') };
}
function metadata(manager, view, entry, doc) {
    const label = manager.getLabel(entry.id) || '';
    return { entryId: entry.id, kind: doc.kind, hasTools: doc.hasTools, images: doc.images, timestamp: entry.message?.timestamp ?? entry.timestamp,
        replyStage: doc.kind === 'assistant' ? view.stages?.get(entry.id) || 'unknown' : undefined,
        summaryType: doc.kind === 'summary' ? entry.type : undefined,
        toolName: String(entry.message?.toolName || '').slice(0, 200), inCurrentBranch: view.branch.has(entry.id),
        label: label.slice(0, 256), labelTruncated: label.length > 256, bookmarkRevision: view.labelVersions.get(entry.id) || 'none', canBookmark: view.canBookmark };
}
function searchHistory(manager, raw, { settled = false } = {}) {
    const start = Date.now(), input = validateHistoryRequest('search', raw), view = snapshot(manager, { settled });
    if (input.offset && input.revision !== view.revision) throw error('历史有更新，请重新搜索后翻页', 'HISTORY_STALE');
    const needle = input.q ? new RegExp(input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') : null;
    const results = []; let total = 0, scanned = 0;
    for (let i = view.entries.length - 1; i >= 0; i--) {
        if (Date.now() - start > 1500) throw error('本次历史搜索超过时间预算，请缩小范围或仅查看书签', 'HISTORY_LIMIT');
        const entry = view.entries[i], kind = kindOf(entry);
        if (!kind || input.scope === 'branch' && !view.branch.has(entry.id)) continue;
        const label = manager.getLabel(entry.id) || '';
        if (input.bookmarked && !label) continue;
        const hasTools = kind === 'tool' || kind === 'assistant' && Array.isArray(entry.message.content) && entry.message.content.some(b => b.type === 'toolCall');
        if (input.filter === 'conversation' && kind === 'tool') continue;
        if (!['all', 'conversation'].includes(input.filter) && input.filter !== kind && !(input.filter === 'tool' && hasTools)) continue;
        const presentation = ['assistant', 'conversation'].includes(input.filter) ? 'body' : 'record';
        const doc = documentOf(entry, presentation);
        scanned += Buffer.byteLength(doc.text, 'utf8') + Buffer.byteLength(label, 'utf8');
        if (scanned > 64 * 1024 * 1024) throw error('检索文本超过 64 MiB，请缩小分支或记录类型范围', 'HISTORY_LIMIT');
        const match = needle?.exec(doc.text), labelMatch = needle?.test(label);
        if (needle && !match && !labelMatch) continue;
        if (total++ < input.offset || results.length >= 30) continue;
        const at = match?.index || 0, snippetStart = Math.max(0, at - 60);
        results.push({ ...metadata(manager, view, entry, doc), view: presentation, matchOffset: at, snippet: `${snippetStart ? '…' : ''}${doc.text.slice(snippetStart, snippetStart + 240)}${doc.text.length > snippetStart + 240 ? '…' : ''}` });
    }
    return { revision: view.revision, leafId: manager.getLeafId(), results, total, offset: input.offset, hasMore: total > input.offset + results.length, pageSize: 30 };
}
function previewHistory(manager, raw, { settled = false } = {}) {
    const input = validateHistoryRequest('preview', raw), view = snapshot(manager, { settled }), entry = manager.getEntry(input.entryId);
    const presentation = input.view === 'record' || kindOf(entry || {}) === 'tool' ? 'record' : 'body';
    const doc = entry && documentOf(entry, presentation);
    if (!doc) throw error('记录不存在或不属于可见历史', 'HISTORY_NOT_FOUND');
    const boundary = index => index > 0 && index < doc.text.length && /[\uD800-\uDBFF]/.test(doc.text[index - 1]) && /[\uDC00-\uDFFF]/.test(doc.text[index]) ? index - 1 : index;
    const offset = boundary(Math.min(input.offset, Math.max(0, doc.text.length - 1))), end = boundary(Math.min(doc.text.length, offset + PAGE_TEXT));
    const position = manager.getBranch().findLast(e => !['label', 'session_info', 'model_change', 'thinking_level_change', 'custom'].includes(e.type));
    return { ...metadata(manager, view, entry, doc), atCurrentPosition: position?.id === entry.id, view: presentation, revision: view.revision, leafId: manager.getLeafId(), navigation: require('./pi-session-tree').navigationKind(entry), text: doc.text.slice(offset, end), offset, totalCharacters: doc.text.length,
        nextOffset: end, previousOffset: boundary(Math.max(0, offset - PAGE_TEXT)), hasMore: end < doc.text.length, pageCharacters: PAGE_TEXT };
}
function setHistoryBookmark(manager, raw, setLabel) {
    const input = validateHistoryRequest('bookmark', raw), view = snapshot(manager), entry = manager.getEntry(input.entryId);
    if (!entry || !kindOf(entry)) throw error('记录不存在或不可设置书签', 'HISTORY_NOT_FOUND');
    if (!view.canBookmark) throw error('请等首条回复保存后再添加书签');
    if ((view.labelVersions.get(entry.id) || 'none') !== input.expectedBookmarkRevision) throw error('书签已被其他页面或终端修改，请重新读取记录', 'BOOKMARK_CONFLICT');
    if ((manager.getLabel(entry.id) || '') !== input.label) setLabel(entry.id, input.label || undefined);
    const updated = snapshot(manager);
    return { entryId: entry.id, label: manager.getLabel(entry.id) || '', bookmarkRevision: updated.labelVersions.get(entry.id) || 'none', leafId: manager.getLeafId() };
}
module.exports = { validateHistoryRequest, searchHistory, previewHistory, setHistoryBookmark, kindOf, documentOf, snapshot };
