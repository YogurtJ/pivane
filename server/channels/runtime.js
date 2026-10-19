const STATE = 'pivane-channel-turn';
const MESSAGE = 'pivane-channel-message';
const idPattern = /^[a-f0-9]{64}$/;
function stateFor(manager, id) {
    return manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === STATE
        && entry.data?.id === id && entry.data.sessionId === manager.getSessionId())?.data || null;
}
function outcome(manager, id) {
    const state = stateFor(manager, id);
    if (!state) return null;
    const entry = state.replyEntryId && manager.getBranch().find(e => e.id === state.replyEntryId);
    const body = entry?.type === 'message' && entry.message?.role === 'assistant'
        ? (entry.message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
    return { ...state, body: body.length > 60000 ? body.slice(0, 60000) + '\n\n[回复较长，请在 Pivane 网页查看完整内容。]' : body };
}
function registerChannelTurns(pi) {
    let active = null;
    pi.on('agent_settled', (event, ctx) => {
        if (!active) return;
        const branch = ctx.sessionManager.getBranch();
        const start = branch.findLastIndex(e => e.type === 'custom' && e.customType === STATE && e.data?.id === active.id && e.data.status === 'running');
        const reply = branch.slice(start + 1).findLast(e => e.type === 'message' && e.message?.role === 'assistant');
        const status = event.aborted || reply?.message?.stopReason === 'aborted' ? 'stopped'
            : !reply || reply.message.stopReason === 'error' ? 'error' : 'completed';
        pi.appendEntry(STATE, { ...active, status, replyEntryId: reply?.id || null, completedAt: Date.now() });
        active = null;
    });
    return (ctx, input) => {
        if (!input || !idPattern.test(input.id) || input.sessionId !== ctx.sessionManager.getSessionId()) throw new Error('Invalid channel turn');
        if (input.action === 'status') return outcome(ctx.sessionManager, input.id);
        if (input.action !== 'start' || active || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Channel target is busy');
        if (stateFor(ctx.sessionManager, input.id)) return { ...outcome(ctx.sessionManager, input.id), reused: true };
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 40000
            || typeof input.peerId !== 'string' || input.peerId.length > 256) throw new Error('Invalid channel message');
        if (!ctx.model) throw new Error('请先为线程配置可用模型');
        active = { version: 1, id: input.id, sessionId: input.sessionId, status: 'running', startedAt: Date.now() };
        pi.appendEntry(STATE, active);
        pi.sendMessage({ customType: MESSAGE, content: `[用户通过已绑定的微信私聊发来消息。请完成本次请求；回复将发送回该微信聊天。需要交互确认时请提示用户到 Pivane 网页处理。]\n\n${input.text}`,
            display: true, details: { channel: 'weixin', peerId: input.peerId, messageId: input.id } }, { triggerTurn: true });
        return active;
    };
}
module.exports = { STATE, MESSAGE, registerChannelTurns, stateFor, outcome };
