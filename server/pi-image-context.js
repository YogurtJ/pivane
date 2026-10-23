// Request-only image projection. Native messages and tool results remain authoritative.
const { dimensions } = require('./pi-file-types');
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_IMAGE_BYTES = 128 * 1024 * 1024;
function imageError(location, reason) {
    return Object.assign(new Error(`${location}的图片${reason}；原始记录已保留。请更换图片、切换模型，或从较早位置分叉后继续。`), { code: 'IMAGE_CONTEXT_INVALID' });
}
function decodeImage(block, location) {
    if (typeof block.data !== 'string' || block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 256) throw imageError(location, '为空或超过 32 MiB 检查限额');
    const data = block.data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw imageError(location, '编码无效');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) throw imageError(location, '编码无效');
    const type = dimensions(bytes);
    if (!type || !type.width || !type.height) throw imageError(location, '格式无效，支持 PNG、JPEG、WebP、GIF');
    if (type.width > 32768 || type.height > 32768 || type.width * type.height > 64 * 1024 * 1024) throw imageError(location, '像素超过检查限额，请先缩小图片');
    return { bytes, type };
}
function imageCount(messages) {
    return messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter(block => block?.type === 'image').length : 0), 0);
}
function inspectImages(messages, model, { blocked = false } = {}) {
    if (blocked || !model?.input?.includes('image')) return;
    let count = 0, total = 0;
    const limits = model.inputLimits?.images || {};
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        let perMessage = 0;
        for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block?.type !== 'image') continue;
            const location = message.role === 'toolResult' ? `工具结果（第 ${index + 1} 条消息）` : `第 ${index + 1} 条上下文消息`;
            count++; perMessage++;
            if (limits.maxPerRequest && count > limits.maxPerRequest) throw imageError(location, `使请求超过模型的 ${limits.maxPerRequest} 张图片上限`);
            if (limits.maxPerMessage && perMessage > limits.maxPerMessage) throw imageError(location, `超过模型每条消息 ${limits.maxPerMessage} 张图片的上限`);
            total += decodeImage(block, location).bytes.length;
            if (total > MAX_CONTEXT_IMAGE_BYTES) throw imageError(location, '总量超过 128 MiB 检查限额');
        }
    }
}
async function projectImages(messages, model, { resizeImage, autoResize = true, blocked = false } = {}) {
    const supportsImages = !blocked && model?.input?.includes('image');
    const limits = model?.inputLimits?.images || {};
    let count = 0, omitted = 0, totalBytes = 0;
    const projected = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!Array.isArray(message.content)) { projected.push(message); continue; }
        let perMessage = 0, changed = false;
        const content = [];
        for (const block of message.content) {
            if (block?.type !== 'image') { content.push(block); continue; }
            const location = message.role === 'toolResult' ? `工具结果（第 ${index + 1} 条消息）` : `第 ${index + 1} 条上下文消息`;
            if (!supportsImages) {
                omitted++; changed = true;
                content.push({ type: 'text', text: blocked ? '[图片未发送：图片输入已在设置中关闭，原图保留]' : '[图片未发送：当前模型不支持图片输入，原图保留]' });
                continue;
            }
            count++; perMessage++;
            if (limits.maxPerRequest && count > limits.maxPerRequest) throw imageError(location, `使请求超过模型的 ${limits.maxPerRequest} 张图片上限`);
            if (limits.maxPerMessage && perMessage > limits.maxPerMessage) throw imageError(location, `超过模型每条消息 ${limits.maxPerMessage} 张图片的上限`);
            const decoded = decodeImage(block, location);
            totalBytes += decoded.bytes.length;
            if (totalBytes > MAX_CONTEXT_IMAGE_BYTES) throw imageError(location, '总量超过 128 MiB 检查限额');
            let data = decoded.bytes.toString('base64'), mimeType = decoded.type.mime;
            if (autoResize && resizeImage) {
                const resized = await resizeImage(decoded.bytes, mimeType, limits.resize);
                if (!resized) throw imageError(location, '无法转换到模型允许的尺寸');
                data = resized.data; mimeType = resized.mimeType;
            } else if (limits.resize && ((limits.resize.maxBytes && data.length > limits.resize.maxBytes)
                || (limits.resize.maxWidth && decoded.type.width > limits.resize.maxWidth)
                || (limits.resize.maxHeight && decoded.type.height > limits.resize.maxHeight))) throw imageError(location, '超过模型允许的尺寸，请开启自动缩放或缩小图片');
            const replacement = data === block.data && mimeType === block.mimeType ? block : { ...block, data, mimeType };
            changed ||= replacement !== block; content.push(replacement);
        }
        projected.push(changed ? { ...message, content } : message);
    }
    return { messages: projected, count, omitted };
}
module.exports = { decodeImage, imageCount, inspectImages, projectImages };
