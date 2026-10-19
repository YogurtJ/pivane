const { randomUUID } = require('node:crypto');
const { proxyFor } = require('../pi-update-service');
const BASE = 'https://ilinkai.weixin.qq.com';
function apiOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname)) throw new Error('微信返回的服务地址不受信任');
    return url.origin;
}
// The upstream API receives a bounded transport, not the host's global fetch.
// Deadlines include body consumption and redirects never forward a bot token.
function createTransport(stoppingSignal, getLoginSignal = () => undefined) {
    return async (url, options = {}) => {
        apiOrigin(url);
        const pathname = new URL(url).pathname;
        const loginSignal = pathname.endsWith('/get_qrcode_status') ? getLoginSignal() : undefined;
        const stopping = pathname.endsWith('/notifystop') ? [] : [stoppingSignal];
        const agent = proxyFor(url, process.env);
        try {
            const response = await require('node-fetch')(url, { ...options, redirect: 'error', size: 2 * 1024 * 1024, agent,
                signal: AbortSignal.any([...stopping, AbortSignal.timeout(40000), ...(options.signal ? [options.signal] : []), ...(loginSignal ? [loginSignal] : [])]) });
            const body = await response.text();
            return { ok: response.ok, status: response.status, text: async () => body };
        } finally { agent?.destroy(); }
    };
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
    message(raw) {
        if (raw.group_id || raw.room_id || raw.message_type !== 1 || raw.message_state !== undefined && raw.message_state !== 2 || !validId(raw.from_user_id)
            || !validId(String(raw.message_id ?? '')) || !Array.isArray(raw.item_list)) return null;
        const text = raw.item_list.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n');
        const unsupported = raw.item_list.some(item => item.type !== 1);
        if (text.length > 40000 || raw.context_token != null && (typeof raw.context_token !== 'string' || raw.context_token.length > 8192)) return null;
        return { messageId: String(raw.message_id), peerId: raw.from_user_id, text, contextToken: raw.context_token || null, unsupported };
    }
    async send(account, peer, text, clientId) {
        if (!peer.contextToken) throw new Error('微信回复上下文已失效，请在微信发送一条新消息');
        return this.api.sendMessage({ baseUrl: account.baseUrl, token: account.token, body: { msg: {
            from_user_id: '', to_user_id: peer.peerId, client_id: clientId, message_type: 2, message_state: 2,
            item_list: [{ type: 1, text_item: { text } }], context_token: peer.contextToken
        } } });
    }
}
module.exports = { WeixinAdapter, createTransport, apiOrigin, validId, BASE };
