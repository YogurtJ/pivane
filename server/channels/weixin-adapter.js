const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { proxyFor } = require('../pi-update-service');
const { classify } = require('../pi-file-types');
const BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
function apiOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname)) throw new Error('微信返回的服务地址不受信任');
    return url.origin;
}
function cdnOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^(?:[a-z0-9-]+\.)*cdn\.weixin\.qq\.com$/.test(url.hostname)) throw new Error('微信 CDN 地址不受信任');
    return url.origin;
}
// The upstream API receives a bounded transport, not the host's global fetch.
// Deadlines include body consumption and redirects never forward a bot token.
function createTransport(stoppingSignal, getLoginSignal = () => undefined) {
    return async (url, options = {}) => {
        const parsed = new URL(url);
        const isCdn = /^(?:[a-z0-9-]+\.)*cdn\.weixin\.qq\.com$/.test(parsed.hostname);
        if (isCdn) cdnOrigin(url);
        else apiOrigin(url);
        const pathname = parsed.pathname;
        const loginSignal = pathname.endsWith('/get_qrcode_status') ? getLoginSignal() : undefined;
        const stopping = pathname.endsWith('/notifystop') ? [] : [stoppingSignal];
        const agent = proxyFor(url, process.env);
        const maxSize = isCdn ? MAX_MEDIA_BYTES + 65536 : 2 * 1024 * 1024;
        try {
            const response = await require('node-fetch')(url, { ...options, redirect: 'error', size: maxSize, agent,
                signal: AbortSignal.any([...stopping, AbortSignal.timeout(isCdn ? 60000 : 40000), ...(options.signal ? [options.signal] : []), ...(loginSignal ? [loginSignal] : [])]) });
            const buffer = await response.buffer();
            // sendTyping discards the API response. Inspect only this endpoint
            // here so upstream still builds its own request/base_info unchanged.
            if (!isCdn && pathname === '/ilink/bot/sendtyping') {
                try { checkTypingResponse(JSON.parse(buffer.toString('utf8'))); }
                catch { throw new Error('微信输入状态请求失败'); }
            }
            return { ok: response.ok, status: response.status, statusText: response.statusText || '', headers: response.headers,
                text: async () => buffer.toString('utf8'),
                arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
        } finally { agent?.destroy(); }
    };
}
function checkTypingResponse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ['ret', 'errcode'].some(key => value[key] !== undefined && value[key] !== 0)) throw new Error('微信输入状态请求失败');
}
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value); }
class WeixinAdapter {
    constructor(module) { this.module = module; this.api = module.api; }
    async loginStart(signal, localTokens = []) {
        const data = JSON.parse(await this.api.apiPostFetch({ baseUrl: BASE, endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
            body: JSON.stringify({ local_token_list: localTokens.slice(-10) }), timeoutMs: 15000, abortSignal: signal, label: 'login' }));
        if (!validId(data.qrcode) || typeof data.qrcode_img_content !== 'string' || data.qrcode_img_content.length > 4096) throw new Error('微信未返回有效二维码');
        return { id: randomUUID(), qrcode: data.qrcode, matrix: this.module.qrMatrix(data.qrcode_img_content), baseUrl: BASE, status: 'wait', expiresAt: Date.now() + 5 * 60 * 1000 };
    }
    async loginPoll(login, code) {
        const data = JSON.parse(await this.api.apiGetFetch({ baseUrl: login.baseUrl,
            endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}${code ? '&verify_code=' + encodeURIComponent(code) : ''}`,
            timeoutMs: 35000, label: 'login-status' }));
        if (data.status === 'scaned_but_redirect') login.baseUrl = apiOrigin('https://' + data.redirect_host);
        if (data.status === 'confirmed') {
            if (!validId(data.ilink_bot_id) || !validId(data.ilink_user_id) || typeof data.bot_token !== 'string' || !data.bot_token || data.bot_token.length > 8192) throw new Error('微信登录身份不完整');
            return { status: 'confirmed', account: { id: data.ilink_bot_id, userId: data.ilink_user_id, token: data.bot_token,
                baseUrl: apiOrigin(data.baseurl || BASE), enabled: true, allowedUsers: [data.ilink_user_id], cursor: '' } };
        }
        const allowed = ['wait', 'scaned', 'need_verifycode', 'expired', 'verify_code_blocked', 'binded_redirect', 'scaned_but_redirect'];
        if (!allowed.includes(data.status)) throw new Error('未知微信登录状态');
        return { status: data.status };
    }
    async poll(account, signal) {
        const result = await this.api.getUpdates({ baseUrl: account.baseUrl, token: account.token, get_updates_buf: account.cursor, abortSignal: signal });
        if (result.ret && result.ret !== 0 || result.errcode && result.errcode !== 0) throw new Error('微信连接暂不可用，请检查登录状态');
        if (result.msgs !== undefined && (!Array.isArray(result.msgs) || result.msgs.length > 1000) || result.get_updates_buf !== undefined && (typeof result.get_updates_buf !== 'string' || result.get_updates_buf.length > 65536)) throw new Error('微信消息超过预算');
        return result;
    }
    async notify(account, start) {
        return this.api[start ? 'notifyStart' : 'notifyStop']({ baseUrl: account.baseUrl, token: account.token, timeoutMs: 5000 });
    }
    async typingTicket(account, peer) {
        if (!peer?.contextToken || typeof this.api.getConfig !== 'function') return '';
        let resp;
        try { resp = await this.api.getConfig({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: peer.peerId, contextToken: peer.contextToken, timeoutMs: 5000 }); }
        catch { throw new Error('微信输入状态票据请求失败'); }
        checkTypingResponse(resp);
        return typeof resp.typing_ticket === 'string' && resp.typing_ticket.length <= 4096 ? resp.typing_ticket : '';
    }
    async typing(account, peer, ticket, active = true) {
        if (!ticket || typeof this.api.sendTyping !== 'function') return;
        try {
            const result = await this.api.sendTyping({ baseUrl: account.baseUrl, token: account.token, timeoutMs: 5000,
                body: { ilink_user_id: peer.peerId, typing_ticket: ticket, status: active ? 1 : 2 } });
            if (result !== undefined) checkTypingResponse(result);
        } catch { throw new Error('微信输入状态请求失败'); }
    }
    message(raw) {
        if (raw.group_id || raw.room_id || raw.message_type !== 1 || raw.message_state !== undefined && raw.message_state !== 2 || !validId(raw.from_user_id)
            || !validId(String(raw.message_id ?? '')) || !Array.isArray(raw.item_list)) return null;
        const text = raw.item_list.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n');
        const images = [];
        for (const item of raw.item_list) {
            if (item.type !== 2) continue;
            const img = item.image_item;
            const query = typeof img?.media?.encrypt_query_param === 'string' && img.media.encrypt_query_param.length <= 4096 ? img.media.encrypt_query_param : '';
            const fullUrl = typeof img?.media?.full_url === 'string' && img.media.full_url.length <= 4096 ? img.media.full_url : '';
            if (!query && !fullUrl) return null;
            const aesKey = typeof img?.aeskey === 'string' && /^[0-9a-fA-F]{32}$/.test(img.aeskey) ? Buffer.from(img.aeskey, 'hex').toString('base64')
                : typeof img?.media?.aes_key === 'string' && img.media.aes_key.length <= 256 ? img.media.aes_key : '';
            images.push({ encryptQueryParam: query, fullUrl, aesKey });
        }
        const unsupported = raw.item_list.some(item => item.type !== 1 && item.type !== 2) || images.length > 6;
        if (text.length > 40000 || raw.context_token != null && (typeof raw.context_token !== 'string' || raw.context_token.length > 8192)) return null;
        return { messageId: String(raw.message_id), peerId: raw.from_user_id, text, images: unsupported ? [] : images, contextToken: raw.context_token || null, unsupported };
    }
    async downloadImage(ref) {
        if (!ref || !this.module.cdnDecrypt) throw new Error('微信图片组件不可用');
        if (ref.fullUrl) cdnOrigin(ref.fullUrl);
        const bytes = ref.aesKey
            ? await this.module.cdnDecrypt.downloadAndDecryptBuffer(ref.encryptQueryParam || '', ref.aesKey, CDN_BASE, 'pivane-image', ref.fullUrl || undefined)
            : await this.module.cdnDecrypt.downloadPlainCdnBuffer(ref.encryptQueryParam || '', CDN_BASE, 'pivane-image-plain', ref.fullUrl || undefined);
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error('微信图片大小超出限制');
        const type = classify(bytes, 'image.bin');
        if (type.kind !== 'image') throw new Error('微信图片格式不支持或像素超出限制');
        return { type: 'image', mimeType: type.mime, data: bytes.toString('base64') };
    }
    async send(account, peer, text, clientId) {
        if (!peer.contextToken) throw new Error('微信回复上下文已失效，请在微信发送一条新消息');
        return this.api.sendMessage({ baseUrl: account.baseUrl, token: account.token, body: { msg: {
            from_user_id: '', to_user_id: peer.peerId, client_id: clientId, message_type: 2, message_state: 2,
            item_list: [{ type: 1, text_item: { text } }], context_token: peer.contextToken
        } } });
    }
    async sendMedia(account, peer, media, clientId) {
        if (!peer.contextToken) throw new Error('微信回复上下文已失效，请在微信发送一条新消息');
        if (!this.module.cryptoMedia || !this.module.cdnUpload || typeof this.api.getUploadUrl !== 'function') throw new Error('微信媒体上传组件不可用');
        const bytes = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes);
        if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error('微信发送文件大小超出 16 MiB 限制');
        const isImage = media.kind === 'image';
        const rawsize = bytes.length;
        const rawfilemd5 = createHash('md5').update(bytes).digest('hex');
        const filesize = this.module.cryptoMedia.aesEcbPaddedSize(rawsize);
        const filekey = randomBytes(16).toString('hex');
        const aeskey = randomBytes(16);
        const aeskeyHex = aeskey.toString('hex');
        const uploadResp = await this.api.getUploadUrl({
            baseUrl: account.baseUrl, token: account.token, filekey, media_type: isImage ? 1 : 3,
            to_user_id: peer.peerId, rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskeyHex
        });
        const uploadFullUrl = typeof uploadResp?.upload_full_url === 'string' && uploadResp.upload_full_url.trim() ? uploadResp.upload_full_url.trim() : undefined;
        if (uploadFullUrl) cdnOrigin(uploadFullUrl);
        const uploadParam = typeof uploadResp?.upload_param === 'string' && uploadResp.upload_param ? uploadResp.upload_param : undefined;
        if (!uploadFullUrl && !uploadParam) throw new Error('微信未返回有效的媒体上传地址');
        const { downloadParam } = await this.module.cdnUpload.uploadBufferToCdn({
            buf: bytes, uploadFullUrl, uploadParam, filekey, cdnBaseUrl: CDN_BASE, aeskey, label: 'pivane-upload'
        });
        const mediaRef = { encrypt_query_param: downloadParam, aes_key: Buffer.from(aeskeyHex).toString('base64'), encrypt_type: 1 };
        const item = isImage
            ? { type: 2, image_item: { media: mediaRef, mid_size: filesize } }
            : { type: 4, file_item: { media: mediaRef, file_name: String(media.name || 'file.bin').slice(0, 240), len: String(rawsize) } };
        return this.api.sendMessage({ baseUrl: account.baseUrl, token: account.token, body: { msg: {
            from_user_id: '', to_user_id: peer.peerId, client_id: clientId, message_type: 2, message_state: 2,
            item_list: [item], context_token: peer.contextToken
        } } });
    }
}
module.exports = { WeixinAdapter, createTransport, apiOrigin, cdnOrigin, validId, BASE, CDN_BASE, MAX_MEDIA_BYTES };
