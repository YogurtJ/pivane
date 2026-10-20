const STATE = 'pivane-channel-turn';
const MESSAGE = 'pivane-channel-message';
const DELIVERABLE_ENTRY = 'pivane-deliverable';
const idPattern = /^[a-f0-9]{64}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function stateFor(manager, id) {
    return manager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === STATE
        && entry.data?.id === id && entry.data.sessionId === manager.getSessionId())?.data || null;
}
function outcome(manager, id) {
    const state = stateFor(manager, id);
    if (!state) return null;
    const branch = manager.getBranch();
    const start = branch.findLastIndex(e => e.type === 'custom' && e.customType === STATE && e.data?.id === id && e.data.status === 'running');
    const entry = state.replyEntryId && branch.find(e => e.id === state.replyEntryId);
    const body = entry?.type === 'message' && entry.message?.role === 'assistant'
        ? (entry.message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
    const deliverables = [];
    const mediaPlans = [];
    if (start >= 0) {
        const seen = new Set();
        const seenPlans = new Set();
        for (const item of branch.slice(start + 1)) {
            if (item.type === 'custom' && item.customType === DELIVERABLE_ENTRY && item.data?.id && item.data.manifestRevision) {
                const key = `${item.data.id}:${item.data.manifestRevision}`;
                if (!seen.has(key)) { seen.add(key); deliverables.push({ id: item.data.id, manifestRevision: item.data.manifestRevision }); }
            }
            if (item.type === 'message' && item.message?.role === 'toolResult' && !item.message.isError
                && ['media_generate', 'media_plan_request'].includes(item.message.toolName)) {
                const plan = item.message.details?.plan;
                if (typeof plan?.id === 'string' && /^plan-[0-9a-f-]{36}$/.test(plan.id) && !seenPlans.has(plan.id)) {
                    seenPlans.add(plan.id);
                    mediaPlans.push({ id: plan.id, kind: plan.kind || '', modelId: plan.modelId || '', summary: String(plan.summary || '').slice(0, 200),
                        prompt: String(plan.parameters?.prompt || plan.parameters?.text || '').slice(0, 300) });
                }
            }
        }
    }
    return { ...state, deliverables, mediaPlans, body: body.length > 60000 ? body.slice(0, 60000) + '\n\n[回复较长，请在 Pivane 网页查看完整内容。]' : body };
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
        const text = typeof input.text === 'string' ? input.text : '';
        const images = Array.isArray(input.images) ? input.images : [];
        if (text.length > 40000 || images.length > 6 || (!text.trim() && !images.length)
            || typeof input.peerId !== 'string' || input.peerId.length > 256) throw new Error('Invalid channel message');
        let encodedBytes = 0;
        for (const image of images) {
            if (!image || image.type !== 'image' || !IMAGE_TYPES.has(image.mimeType)
                || typeof image.data !== 'string' || !image.data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('Invalid channel image');
            encodedBytes += image.data.length;
        }
        if (encodedBytes > 24 * 1024 * 1024) throw new Error('Channel image attachments exceed limit');
        if (!ctx.model) throw new Error('请先为线程配置可用模型');
        if (images.length && !ctx.model.input?.includes('image')) throw new Error('当前线程模型不支持图片输入，请用 /model 切换到支持视觉的模型');
        active = { version: 1, id: input.id, sessionId: input.sessionId, status: 'running', startedAt: Date.now() };
        pi.appendEntry(STATE, active);
        const header = '[用户通过已绑定的微信私聊发来消息。请完成本次请求；回复、自动生成完成的媒体（图片/音频）及本次通过 deliver_files 发布的文件/图片将自动发送回该微信聊天。若存在待确认的媒体生成卡片（如视频），用户可在微信发送 /confirm 直接确认生成，或到 Pivane 网页处理。]';
        const promptText = `${header}\n\n${text.trim() || '请查看我发来的图片。'}`;
        const content = images.length
            ? [{ type: 'text', text: promptText }, ...images.map(({ mimeType, data }) => ({ type: 'image', mimeType, data }))]
            : promptText;
        pi.sendMessage({ customType: MESSAGE, content, display: true,
            details: { channel: 'weixin', peerId: input.peerId, messageId: input.id, bodyOffset: header.length + 2, imageCount: images.length } }, { triggerTurn: true });
        return active;
    };
}
module.exports = { STATE, MESSAGE, DELIVERABLE_ENTRY, registerChannelTurns, stateFor, outcome };
