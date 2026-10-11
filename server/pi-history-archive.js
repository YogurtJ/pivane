// Read-only projections of the native branch prefix omitted by the latest compaction.
const { createHash } = require('node:crypto');
const error = (message, code = 'HISTORY_INVALID') => Object.assign(new Error(message), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
function validateArchiveRequest(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('压缩前查询参数无效');
    const view = input.view ?? 'index', offset = input.offset ?? 0, revision = input.revision;
    if (!['index', 'turns', 'process'].includes(view)) throw error('压缩前查询视图无效');
    if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) throw error('压缩前记录修订无效');
    if (view === 'turns') {
        if (!integer(input.start) || !integer(input.end) || input.start >= input.end || input.end - input.start > 24 || !revision) throw error('压缩前回合范围无效');
        return { view, start: input.start, end: input.end, revision };
    }
    if (!integer(offset) || (view === 'index' && offset > 50000) || (view === 'process' && (!integer(input.index) || !revision)) || (offset > 0 && !revision)) throw error('压缩前分页位置无效');
    return { view, offset, revision, ...(view === 'process' ? { index: input.index } : {}) };
}
const timestamp = entry => entry.message?.timestamp ?? entry.timestamp;
function startKind(entry) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') return 'summary';
    if (entry.type === 'custom_message' && entry.display !== false) return 'agent';
    if (entry.type === 'message' && entry.message?.role === 'user') return 'user';
    if (entry.type === 'message' && entry.message?.role === 'custom' && entry.message.display === true) return 'agent';
    return null;
}
function blocks(content) { return Array.isArray(content) ? content.slice(0, 10000) : []; }
// Iterate code points only up to the requested cap; never spread or concatenate full text.
function clip(value, limit, singleLine = false) {
    if (typeof value !== 'string') return { text: '', truncated: false };
    // Skipped whitespace still costs a scan step, so a huge blank argument cannot stall the worker.
    let text = '', count = 0, space = false, scanned = 0;
    const scanLimit = limit + 4096;
    for (const point of value) {
        if (++scanned > scanLimit) return { text: singleLine ? text.trimEnd() : text, truncated: true };
        if (singleLine && /\s/u.test(point)) { if (!text || space) continue; space = true; }
        else space = false;
        if (count === limit) return { text: singleLine ? text.trimEnd() : text, truncated: true };
        text += singleLine && space ? ' ' : point; count++;
    }
    return { text: singleLine ? text.trimEnd() : text, truncated: false };
}
function textOf(entry, limit, check) {
    const content = entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.summary : entry.type === 'custom_message' ? entry.content : entry.message?.content;
    if (typeof content === 'string') return clip(content, limit);
    let text = '', count = 0, images = 0, truncated = false;
    for (const block of blocks(content)) {
        check();
        if (block?.type === 'image') { images++; continue; }
        if (count > limit) { truncated = true; continue; }
        if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text) continue;
        if (text) { text += '\n'; count++; }
        const part = clip(block.text, Math.max(0, limit + 1 - count));
        text += part.text; count += [...part.text].length; truncated ||= part.truncated;
    }
    const result = clip(text, limit);
    return { text: result.text, truncated: truncated || result.truncated, images };
}
function hasText(entry, check) {
    // Search in bounded chunks so even blank replies observe the projection deadline.
    const nonblank = value => {
        for (let start = 0; start < value.length; start += 8192) {
            check();
            if (/\S/u.test(value.slice(start, start + 8192))) return true;
        }
        return false;
    };
    const content = entry.message?.content;
    if (typeof content === 'string') return nonblank(content);
    for (const block of blocks(content)) { check(); if (block?.type === 'text' && typeof block.text === 'string' && nonblank(block.text)) return true; }
    return false;
}
function toolsOf(entry) { return blocks(entry.message?.content).filter(block => block?.type === 'toolCall'); }
const failed = message => Boolean(message.errorMessage || ['error', 'aborted'].includes(message.stopReason));
const bashError = message => Boolean(message.cancelled || (message.exitCode != null && message.exitCode !== 0));
function historyArchive(manager, raw) {
    const began = Date.now(), check = () => { if (Date.now() - began > 1500) throw error('压缩前记录查询超过时间预算', 'HISTORY_LIMIT'); };
    const input = validateArchiveRequest(raw), entries = manager.getEntries();
    if (entries.length > 50000) throw error('会话超过 50000 条原生记录', 'HISTORY_LIMIT');
    const path = manager.getBranch(); check();
    let ci = -1;
    for (let i = 0; i < path.length; i++) { check(); if (path[i].type === 'compaction') ci = i; }
    const compaction = path[ci];
    const ki = compaction ? path.findIndex((entry, i) => i < ci && entry.id === compaction.firstKeptEntryId) : -1;
    const cut = ki >= 0 ? ki : Math.max(0, ci);
    const revision = createHash('sha256').update(JSON.stringify(compaction ? ['archive-v1', manager.getSessionId(), compaction.id, path[cut].id, cut] : ['archive-v1', manager.getSessionId(), null])).digest('hex');
    if (input.revision !== undefined && input.revision !== revision) throw error('压缩前记录已变化，请重新加载', 'HISTORY_STALE');
    const turns = []; let current = null, orphans = 0;
    for (let i = 0; i < cut; i++) {
        check(); const entry = path[i], kind = startKind(entry);
        if (kind) {
            const turn = { entry, kind, entries: [], tools: 0, errors: 0, texts: 0, bashes: 0, lastText: null, lastAssistant: null, endedAt: timestamp(entry) };
            turns.push(turn); if (kind !== 'summary') current = turn;
            continue;
        }
        const role = entry.type === 'message' && entry.message?.role;
        if (!['assistant', 'toolResult', 'bashExecution'].includes(role)) continue;
        if (!current) { orphans++; continue; }
        current.entries.push(entry); current.endedAt = timestamp(entry);
        if (role === 'assistant') {
            current.lastAssistant = entry;
            if (hasText(entry, check)) { current.lastText = entry; current.texts++; }
            current.tools += toolsOf(entry).length;
        } else if (role === 'bashExecution') { current.bashes++; if (bashError(entry.message)) current.errors++; }
        else if (entry.message.isError) current.errors++;
    }
    const continues = Boolean(compaction && !startKind(path[cut]) && current);
    if (continues) current.continues = true;
    const replyOf = turn => turn.continues ? null : turn.lastText || (turn.lastAssistant && failed(turn.lastAssistant.message) ? turn.lastAssistant : null);
    const metadata = (turn, index) => ({ index, kind: turn.kind, entryId: turn.entry.id, timestamp: timestamp(turn.entry),
        ...(turn.kind === 'agent' ? { customType: clip(turn.entry.customType ?? turn.entry.message?.customType, 64).text } : {}),
        ...(turn.kind === 'summary' ? { summaryType: turn.entry.type, ...(turn.entry.type === 'compaction' ? { tokensBefore: turn.entry.tokensBefore } : {}) } : {}),
        ...(turn.continues ? { continues: true } : {}) });
    const indexTurn = (turn, index) => {
        const question = textOf(turn.entry, 12000, check), reply = replyOf(turn);
        const source = turn.kind === 'agent' ? question.text.split(/\r?\n/, 1)[0] : question.text;
        return { ...metadata(turn, index), title: turn.kind === 'summary' ? '' : clip(source, 160, true).text, images: question.images || 0, tools: turn.tools,
            reply: reply ? { entryId: reply.id, excerpt: textOf(reply, 600, check).text, ...(reply.message.stopReason !== undefined ? { stopReason: clip(reply.message.stopReason, 80).text } : {}), ...(failed(reply.message) ? { failed: true } : {}) } : null };
    };
    const fullTurn = (turn, index) => {
        const question = textOf(turn.entry, 12000, check), reply = replyOf(turn), message = reply?.message, text = reply && textOf(reply, 20000, check);
        return { ...metadata(turn, index), text: question.text, textTruncated: question.truncated, images: question.images || 0,
            reply: reply ? { entryId: reply.id, timestamp: timestamp(reply), model: clip(message.model, 120).text, stopReason: clip(message.stopReason, 80).text,
                errorMessage: clip(message.errorMessage, 1000).text, text: text.text, truncated: text.truncated } : null,
            process: { steps: turn.tools + turn.texts - (reply && reply === turn.lastText ? 1 : 0) + turn.bashes, tools: turn.tools, errors: turn.errors, startedAt: timestamp(turn.entry), endedAt: turn.endedAt } };
    };
    const bytes = value => Buffer.byteLength(JSON.stringify(value));
    const total = turns.length;
    if (input.view === 'index') {
        if (input.offset > total) throw error('压缩前分页位置越界');
        const result = { revision, total, offset: input.offset, hasMore: false, pageSize: 100, continues, compactionId: compaction?.id || null, turns: [] };
        for (let i = input.offset; i < Math.min(total, input.offset + 100); i++) {
            check(); const turn = indexTurn(turns[i], i); result.turns.push(turn);
            if (bytes(result) > 160 * 1024) { result.turns.pop(); break; }
        }
        result.hasMore = input.offset + result.turns.length < total; check(); return result;
    }
    if (input.view === 'turns') {
        if (input.end > total) throw error('压缩前回合范围越界');
        const result = { revision, total, start: input.end, end: input.end, turns: [] };
        for (let i = input.end - 1; i >= input.start; i--) {
            check(); const turn = fullTurn(turns[i], i); result.turns.unshift(turn); result.start = i;
            if (bytes(result) > 192 * 1024) {
                if (result.turns.length > 1) { result.turns.shift(); result.start = i + 1; break; }
                // JSON escaping can exceed the byte budget even within the code-point caps.
                for (const [object, key, flag] of [[turn.reply, 'text', 'truncated'], [turn, 'text', 'textTruncated'], [turn.reply, 'errorMessage', null]]) {
                    if (!object || bytes(result) <= 192 * 1024) continue;
                    const points = [...object[key]]; let low = 0, high = points.length;
                    while (low < high) { const middle = Math.ceil((low + high) / 2); object[key] = points.slice(0, middle).join(''); if (bytes(result) <= 192 * 1024) low = middle; else high = middle - 1; }
                    object[key] = points.slice(0, low).join(''); if (flag) object[flag] = true;
                }
                break;
            }
        }
        check(); return result;
    }
    if (input.index >= total) throw error('压缩前回合位置越界');
    const turn = turns[input.index], reply = replyOf(turn), results = new Map(), steps = [];
    for (const entry of turn.entries) { check(); if (entry.message.role === 'toolResult') results.set(entry.message.toolCallId, entry); }
    for (const entry of turn.entries) {
        check(); const message = entry.message;
        if (message.role === 'assistant') {
            if (entry !== reply && hasText(entry, check)) steps.push({ entryId: entry.id, kind: 'text', label: clip(textOf(entry, 12000, check).text, 200, true).text, isError: failed(message), timestamp: timestamp(entry) });
            for (const tool of toolsOf(entry)) {
                check(); const args = tool.arguments, result = results.get(tool.id);
                let label;
                if (args && typeof args === 'object') {
                    for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description']) if (typeof args[key] === 'string') { label = args[key]; break; }
                    if (label === undefined) for (const key in args) { check(); if (Object.hasOwn(args, key) && typeof args[key] === 'string') { label = args[key]; break; } }
                }
                steps.push({ entryId: entry.id, kind: 'tool', name: clip(tool.name, 80).text, label: clip(label, 200, true).text, isError: Boolean(result?.message.isError), timestamp: timestamp(entry), ...(result ? { resultEntryId: result.id } : {}) });
            }
        } else if (message.role === 'bashExecution') steps.push({ entryId: entry.id, kind: 'bash', label: clip(message.command, 200, true).text, isError: bashError(message), timestamp: timestamp(entry) });
    }
    if (input.offset > steps.length) throw error('压缩前过程分页位置越界');
    const result = { revision, index: input.index, total: steps.length, offset: input.offset, hasMore: false, steps: [] };
    for (let i = input.offset; i < Math.min(steps.length, input.offset + 100); i++) { check(); result.steps.push(steps[i]); if (bytes(result) > 160 * 1024) { result.steps.pop(); break; } }
    result.hasMore = input.offset + result.steps.length < steps.length; check(); return result;
}
module.exports = { validateArchiveRequest, historyArchive };
