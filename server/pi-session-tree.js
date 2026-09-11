// Read-only outline of native entries. Hidden metadata keeps its ancestry but no payload leaves the worker.
const { createHash } = require('node:crypto');
const fail = message => { throw new Error(message); };
const validId = id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id);
function navigationKind(entry) {
    if (entry?.type === 'compaction' || entry?.type === 'branch_summary') return 'after';
    if (entry?.type !== 'message') return null;
    const m = entry.message;
    if (m?.role === 'user') return 'before';
    if (m?.role === 'assistant' && !['toolUse', 'pending', 'error', 'aborted'].includes(m.stopReason)
        && (typeof m.content === 'string' ? m.content.trim() : Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text?.trim()) && !m.content.some(b => b.type === 'toolCall'))) return 'after';
    return null;
}
function revisionOf(manager) {
    const entries = manager.getEntries();
    if (entries.length > 50000) fail('会话超过 50000 条原生记录，请使用终端会话树');
    return createHash('sha256').update(JSON.stringify([manager.getSessionId(), manager.getLeafId(), entries.length, entries.at(-1)?.id])).digest('hex');
}
function validateTreeRequest(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('会话树参数无效');
    const offset = input.offset ?? 0, collapsed = input.collapsed ?? [];
    if (!Number.isInteger(offset) || offset < 0 || offset > 50000) fail('会话树分页无效');
    if (!Array.isArray(collapsed) || collapsed.length > 256 || collapsed.some(id => !validId(id))) fail('折叠位置无效');
    if (input.focus !== undefined && input.focus !== 'current' && !validId(input.focus)) fail('定位位置无效');
    if (input.revision !== undefined && !/^[a-f0-9]{64}$/.test(input.revision)) fail('会话树修订无效');
    return { offset, collapsed, focus: input.focus, revision: input.revision };
}
function validateNavigation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['entryId', 'expectedLeafId', 'revision', 'summarize', 'customInstructions'].includes(k))) fail('导航参数无效');
    if (!validId(input.entryId) || !(input.expectedLeafId === null || validId(input.expectedLeafId)) || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) fail('请重新预览记录后继续');
    if (typeof input.summarize !== 'boolean') fail('请选择是否携带摘要');
    if (input.customInstructions !== undefined && (typeof input.customInstructions !== 'string' || input.customInstructions.length > 2000)) fail('摘要重点最多 2000 字符');
    if (!input.summarize && input.customInstructions) fail('请先选择携带摘要');
    return { entryId: input.entryId, expectedLeafId: input.expectedLeafId, revision: input.revision, summarize: input.summarize, customInstructions: input.customInstructions || '' };
}
function checkNavigation(manager, input) {
    const clean = validateNavigation(input);
    if (manager.getLeafId() !== clean.expectedLeafId || revisionOf(manager) !== clean.revision) fail('会话已有更新，请重新预览目标后继续');
    const target = manager.getEntry(clean.entryId);
    if (!navigationKind(target)) fail('请从用户问题、已完成回复或摘要继续；执行中的记录仅供查看');
    return target;
}
// Classify against the unfiltered native tree, before pagination or folding. A stop
// reason alone does not make a reply final: another assistant/tool may follow it.
function replyStages(entries, branch, settled) {
    const stages = new Map(), next = new Map();
    const lastUser = branch.findLastIndex(e => e.type === 'message' && e.message?.role === 'user');
    const activeTail = new Set(branch.slice(lastUser + 1).map(e => e.id));
    // Bit flags describe the first meaningful successor on each child path.
    const USER = 1, CONTINUATION = 2, END = 4, UNKNOWN = 8;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i], m = e.type === 'message' ? e.message : null;
        const following = next.get(e.id) || END;
        let signal = following;
        if (m?.role === 'assistant') {
            const tools = Array.isArray(m.content) && m.content.some(b => b.type === 'toolCall');
            const stage = m.stopReason === 'error' ? 'error' : m.stopReason === 'aborted' ? 'stopped'
                : tools || m.stopReason === 'toolUse' || (following & CONTINUATION) ? 'progress'
                : !settled && activeTail.has(e.id) ? 'pending'
                : ['stop', 'length'].includes(m.stopReason) && !(following & UNKNOWN) ? 'final' : 'unknown';
            stages.set(e.id, stage); signal = CONTINUATION;
        } else if (m?.role === 'user') signal = USER;
        else if (m?.role === 'toolResult') signal = CONTINUATION;
        else if (m || ['compaction', 'branch_summary', 'custom_message'].includes(e.type)) signal = UNKNOWN;
        if (e.parentId) next.set(e.parentId, (next.get(e.parentId) || 0) | signal);
    }
    return stages;
}
function sessionTree(manager, raw = {}, { settled = false } = {}) {
    const input = validateTreeRequest(raw), revision = revisionOf(manager);
    if (input.offset && input.revision !== revision) fail('会话树已有更新，请刷新后翻页');
    const entries = manager.getEntries(), { kindOf } = require('./pi-history-model');
    const nearest = new Map(), nodes = new Map(), roots = [], start = Date.now();
    const branch = manager.getBranch(), active = new Set(branch.map(e => e.id));
    const stages = replyStages(entries, branch, settled);
    for (const e of entries) {
        if (Date.now() - start > 1500) fail('会话树超过读取时间预算，请使用终端查看');
        const parentId = nearest.get(e.parentId) || null, kind = kindOf(e);
        // The outline shows conversational landmarks; tool and private metadata remain searchable separately.
        if (!kind || kind === 'tool') { nearest.set(e.id, parentId); continue; }
        const m = e.message;
        const chunks = kind === 'summary' ? [{ type: 'text', text: e.summary }] : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : m?.content || [];
        if (!Array.isArray(chunks) || chunks.length > 100000) fail('单条记录过大，无法展示会话树');
        let snippet = '';
        for (const block of chunks) { if (block.type === 'text' && typeof block.text === 'string') snippet += block.text.slice(0, 180 - snippet.length); if (snippet.length >= 180) break; }
        const row = { entryId: e.id, parentId, kind, snippet: snippet.replace(/\s+/g, ' ').trim() || (kind === 'user' ? '图片问题' : '回复已停止或失败'),
            label: String(manager.getLabel(e.id) || '').slice(0, 80), timestamp: m?.timestamp ?? e.timestamp,
            replyStage: kind === 'assistant' ? stages.get(e.id) || 'unknown' : undefined,
            inCurrentBranch: active.has(e.id), navigation: navigationKind(e), summaryType: kind === 'summary' ? e.type : undefined, children: [] };
        nodes.set(e.id, row); nearest.set(e.id, e.id);
        if (parentId && nodes.has(parentId)) nodes.get(parentId).children.push(row); else roots.push(row);
    }
    const currentId = nearest.get(manager.getLeafId()) || null;
    const focusId = input.focus === 'current' ? currentId : input.focus;
    const collapsed = new Set(input.collapsed);
    for (let n = nodes.get(focusId); n; n = nodes.get(n.parentId)) collapsed.delete(n.entryId);
    const outline = [], stack = roots.slice().reverse().map(n => [n, 0]);
    while (stack.length) {
        const [n, depth] = stack.pop(), { children, ...row } = n;
        outline.push({ ...row, depth, childCount: children.length, collapsed: collapsed.has(n.entryId), current: n.entryId === currentId,
            parentPreview: nodes.get(n.parentId)?.snippet || '' });
        if (!collapsed.has(n.entryId)) for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + (children.length > 1 ? 1 : 0)]);
    }
    const pageSize = 100, focusIndex = outline.findIndex(n => n.entryId === focusId);
    const offset = focusIndex >= 0 ? Math.floor(focusIndex / pageSize) * pageSize : Math.min(input.offset, Math.max(0, Math.floor((outline.length - 1) / pageSize) * pageSize));
    return { revision, leafId: manager.getLeafId(), currentId, rows: outline.slice(offset, offset + pageSize), offset, pageSize, total: outline.length, hasMore: outline.length > offset + pageSize, collapsed: [...collapsed] };
}
module.exports = { sessionTree, replyStages, navigationKind, revisionOf, validateTreeRequest, validateNavigation, checkNavigation };
