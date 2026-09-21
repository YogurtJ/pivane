const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const { INTERNAL_COMMAND, INTERNAL_COMMAND_PATTERN } = require('./pivane-compat');

function validateMessage(input, { plain = false } = {}) {
    if (typeof input.message !== 'string' || input.message.length > 400000) throw new Error('消息必须为不超过 400000 字符的文本');
    if (plain && /^\s*\//.test(input.message)) throw new Error('此操作仅支持普通消息，不支持斜杠命令');
    if (new RegExp(`^\\s*/${INTERNAL_COMMAND_PATTERN}(?:\\s|:|$)`).test(input.message)) throw new Error('内部会话命令不能直接发送');
    if (input.images !== undefined && !Array.isArray(input.images)) throw new Error('图片格式无效');
    const images = input.images || [];
    if (images.length > 6) throw new Error('一次最多发送 6 张图片');
    let bytes = 0;
    for (const image of images) {
        if (!image || image.type !== 'image' || !IMAGE_TYPES.has(image.mimeType)
            || typeof image.data !== 'string' || !image.data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('图片附件无效');
        bytes += image.data.length;
    }
    if (bytes > 24 * 1024 * 1024) throw new Error('图片附件过大');
    if (!input.message.trim() && !images.length) throw new Error('消息不能为空');
    return { message: input.message, images: images.map(({ type, mimeType, data }) => ({ type, mimeType, data })) };
}

function activeBranch({ entries, leafId }) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const branch = [];
    const seen = new Set();
    for (let id = leafId; id; id = byId.get(id)?.parentId) {
        if (seen.has(id) || !byId.has(id)) throw new Error('会话分支无效');
        seen.add(id);
        branch.unshift(byId.get(id));
    }
    return branch;
}

function promptFromEntry(entry) {
    if (entry?.type !== 'message' || entry.message?.role !== 'user') throw new Error('请选择用户消息');
    const content = entry.message.content;
    return {
        message: typeof content === 'string' ? content : (content || []).filter(block => block.type === 'text').map(block => block.text).join(''),
        images: Array.isArray(content) ? content.filter(block => block.type === 'image') : []
    };
}

function replyText(message) {
    const content = message?.content;
    return (typeof content === 'string' ? content : (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')).trim();
}

function isReplyForkPoint(entry) {
    const message = entry?.message;
    return entry?.type === 'message' && message?.role === 'assistant'
        && (!message.stopReason || ['stop', 'length'].includes(message.stopReason))
        && (!Array.isArray(message.content) || !message.content.some(block => block.type === 'toolCall'))
        && Boolean(replyText(message));
}

function assertSendable(runtime, payload) {
    if (!runtime.model) throw new Error('请先选择可用模型');
    if (payload.images.length && !runtime.model.input?.includes('image')) throw new Error('当前模型不支持图片输入');
}

module.exports = { INTERNAL_COMMAND, validateMessage, activeBranch, promptFromEntry, replyText, isReplyForkPoint, assertSendable };
