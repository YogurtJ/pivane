// Native metadata and bounded text selection shared by the private bridge and tests.
const { createHash } = require('node:crypto');
const { customTypeIs } = require('./pivane-compat');
const TITLE_STATE = 'pivane-web-title';

function textOf(message, limit = 2000) {
    if (typeof message?.content === 'string') return message.content.slice(0, limit).trim();
    let text = '';
    for (const block of message?.content || []) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text.slice(0, limit - text.length);
        if (text.length >= limit) break;
    }
    return text.trim();
}

function titleSnapshot(manager, model) {
    const entries = manager.getEntries();
    const sessionId = manager.getSessionId();
    const state = entries.findLast(entry => entry.type === 'custom' && customTypeIs(entry, TITLE_STATE) && entry.data?.sessionId === sessionId)?.data;
    const nameRevision = entries.findLast(entry => entry.type === 'session_info')?.id || null;
    const branch = manager.getBranch();
    const revision = createHash('sha256');
    for (const entry of branch) {
        if (['message', 'compaction', 'branch_summary'].includes(entry.type)
            || entry.type === 'custom' && customTypeIs(entry, 'pivane-web-navigation')) revision.update(entry.id + '\n');
    }
    const messages = [];
    // Keep only recent questions and terminal answers, never tools, images or thinking.
    for (let i = branch.length - 1, budget = 8000; i >= 0 && messages.length < 6 && budget > 0; i--) {
        const entry = branch[i], message = entry.type === 'message' && entry.message;
        if (!message || !['user', 'assistant'].includes(message.role)) continue;
        if (message.role === 'assistant' && (message.stopReason && message.stopReason !== 'stop'
            || message.content?.some?.(block => block.type === 'toolCall'))) continue;
        const text = textOf(message, Math.min(2000, budget));
        if (!text) continue;
        budget -= text.length;
        messages.unshift({ role: message.role, text });
    }
    const greeting = /^(你好|您好|嗨|哈喽|在吗|早上好|晚上好|谢谢|好的|hi|hello|hey|thanks|thank you|ok)[\s!！?？。.,，~～]*$/i;
    const meaningful = messages.some(message => message.role === 'user' && !greeting.test(message.text));
    const contextRevision = revision.digest('hex');
    return { sessionId, name: manager.getSessionName() || '', nameRevision, contextRevision,
        eligible: !nameRevision && state?.status === 'pending' && state.lastContextRevision !== contextRevision, state, messages, meaningful,
        model: model && { provider: model.provider, id: model.id } };
}

function cleanTitle(value) {
    if (typeof value !== 'string') throw new Error('标题格式无效');
    const name = value.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)) throw new Error('标题格式无效');
    return name;
}

function handleTitleRequest(pi, ctx, input) {
    if (!ctx.sessionManager.getSessionFile()) throw new Error('临时会话不支持标题生成');
    const snapshot = titleSnapshot(ctx.sessionManager, ctx.model);
    if (input.action === 'snapshot') return snapshot;
    if (input.nameRevision !== snapshot.nameRevision || input.contextRevision !== snapshot.contextRevision) {
        throw new Error('会话或标题已变化，请重新生成标题');
    }
    if (input.action === 'claim') {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('请等待当前任务和队列结束');
        if (!snapshot.eligible || !snapshot.meaningful || !snapshot.messages.some(m => m.role === 'assistant')) return { claimed: false };
        pi.appendEntry(TITLE_STATE, { version: 1, sessionId: snapshot.sessionId, status: 'attempted', attemptId: input.attemptId, attempts: (snapshot.state?.attempts || 0) + 1 });
        return { claimed: true };
    }
    if (input.action === 'defer') {
        if (snapshot.state?.attemptId !== input.attemptId || snapshot.nameRevision) throw new Error('自动标题已失效');
        if (snapshot.state.attempts < 3) pi.appendEntry(TITLE_STATE, { ...snapshot.state, status: 'pending', lastContextRevision: snapshot.contextRevision });
        return { deferred: true };
    }
    if (input.action === 'commit') {
        if (input.attemptId && (snapshot.state?.attemptId !== input.attemptId || snapshot.nameRevision)) throw new Error('自动标题已失效');
        const name = cleanTitle(input.name);
        pi.setSessionName(name);
        return { name };
    }
    throw new Error('不支持的标题操作');
}

module.exports = { TITLE_STATE, titleSnapshot, cleanTitle, handleTitleRequest };
