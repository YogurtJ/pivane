import { resizeImage } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import images from './pi-image-context.js';

// Public SDK seams cover every model request, including continuation after tools
// and a physical model selected by a virtual router. No context-hook exception
// is used to block a request: Pi deliberately catches those exceptions.
export function installImageCompatibility(session, { emit } = {}) {
    const settings = session.settingsManager;
    let lastNotice = '', awaitingNewImages = false, cachedBytes = 0;
    const cache = new Map();
    const cachedResize = async (bytes, mimeType, profile) => {
        const key = createHash('sha256').update(bytes).update(JSON.stringify([mimeType, profile])).digest('hex');
        if (cache.has(key)) { const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit; }
        const result = await resizeImage(bytes, mimeType, profile), size = result?.data.length || 0;
        if (size <= 32 * 1024 * 1024) {
            while (cache.size && (cache.size >= 32 || cachedBytes + size > 32 * 1024 * 1024)) {
                const oldest = cache.keys().next().value; cachedBytes -= cache.get(oldest)?.data.length || 0; cache.delete(oldest);
            }
            cache.set(key, result); cachedBytes += size;
        }
        return result;
    };
    const assertInput = (model, newImages) => {
        if (newImages?.length && (!model?.input?.includes('image') || settings.getBlockImages()))
            throw Object.assign(new Error('当前模型或图片设置不接收图片，请切换支持图片的模型或开启图片输入；草稿已保留'), { code: 'IMAGE_INPUT_UNSUPPORTED' });
    };
    const notice = (model, omitted) => {
        const key = JSON.stringify([model?.provider, model?.id, omitted, settings.getBlockImages()]);
        if (key === lastNotice) return;
        lastNotice = key;
        emit?.({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'pivane-image-context', statusText: omitted ? `本次省略 ${omitted} 张图片，原图保留` : null });
        if (omitted) emit?.({ type: 'extension_ui_request', method: 'notify', notifyType: 'warning',
            message: `当前模型或图片设置不接收图片，本次省略 ${omitted} 张上下文图片；原图已保留，切回支持图片的模型后可再次使用。` });
    };
    const project = async (messages, model, report = false) => {
        const result = await images.projectImages(messages, model, { resizeImage: cachedResize,
            autoResize: settings.getImageAutoResize(), blocked: settings.getBlockImages() });
        if (report) notice(model, settings.getBlockImages() ? images.imageCount(session.sessionManager.buildSessionContext().messages) : result.omitted);
        return result.messages;
    };
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = async (model, context, options) => {
        options?.signal?.throwIfAborted();
        if (awaitingNewImages) assertInput(model, [true]);
        const messages = await project(context.messages, model, true);
        options?.signal?.throwIfAborted();
        if (model?.inputLimits?.maxRequestBytes && Buffer.byteLength(JSON.stringify({ ...context, messages })) > model.inputLimits.maxRequestBytes)
            throw Object.assign(new Error('请求上下文超过模型声明的字节上限，请减少图片或压缩上下文；原始记录已保留'), { code: 'IMAGE_CONTEXT_LIMIT' });
        awaitingNewImages = false;
        return stream(model, { ...context, messages }, options);
    };
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
        // Extension commands own their dispatch. Queued inputs are checked again
        // against the actual model when drained at the request boundary above.
        const ordinary = !/^\s*\/[^\s/]+(?:\s|$)/.test(text);
        if (ordinary) assertInput(session.model, options?.images);
        if (ordinary && !session.isStreaming && session.model?.api !== 'pi-virtual') {
            // Admission checks stay synchronous. Async decoding/resizing belongs
            // inside the active native request so abort cannot be followed by a late start.
            images.inspectImages([...session.sessionManager.buildSessionContext().messages,
                { role: 'user', content: [{ type: 'text', text }, ...(options?.images || [])], timestamp: 0 }], session.model,
            { blocked: settings.getBlockImages() });
        }
        const starting = ordinary && !session.isStreaming;
        if (starting) awaitingNewImages = Boolean(options?.images?.length);
        try { return await prompt(text, options); }
        finally { if (starting) awaitingNewImages = false; }
    };
    for (const name of ['steer', 'followUp']) {
        if (typeof session[name] !== 'function') continue;
        const send = session[name].bind(session);
        session[name] = async (text, newImages, ...options) => { assertInput(session.model, newImages); return send(text, newImages, ...options); };
    };
    const setModel = session.setModel.bind(session);
    session.setModel = async (...args) => {
        const result = await setModel(...args);
        const count = images.imageCount(session.messages);
        notice(session.model, !session.model?.input?.includes('image') || settings.getBlockImages() ? count : 0);
        return result;
    };
}
