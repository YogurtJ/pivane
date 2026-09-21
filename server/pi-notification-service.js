const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const { replaceFileSync } = require('./pi-win32-native');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const webPush = require('web-push');
const fail = message => Object.assign(new Error(message), { status: 400 });
const hash = value => createHash('sha256').update(value).digest('hex');

// Only established browser push services may receive outbound requests. No redirects.
function subscription(value) {
    if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw fail('无效的通知订阅');
    let url; try { url = new URL(value.endpoint); } catch { throw fail('无效的推送地址'); }
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
        || !(host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
            || host === 'web.push.apple.com' || host.endsWith('.push.apple.com')
            || host === 'wns.windows.com' || host.endsWith('.notify.windows.com'))) throw fail('不支持此浏览器推送服务');
    const keys = value.keys;
    if (!keys || !/^[\w-]{87}$/.test(keys.p256dh) || !/^[\w-]{22}$/.test(keys.auth)
        || Buffer.from(keys.p256dh, 'base64url')[0] !== 4) throw fail('无效的订阅密钥');
    return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

class PiNotificationService {
    constructor({ access, store, filePath, send = webPush.sendNotification }) {
        this.access = access; this.store = store;
        this.filePath = filePath || require('./pivane-compat').dataFile(path.dirname(access.filePath), 'pivane-notifications.json');
        this.send = send; this.running = 0; this.seen = new Set(); this.lastTest = new Map();
    }
    read() {
        try {
            const stat = fs.lstatSync(this.filePath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw Error();
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length > 64 || !data.vapid?.publicKey || !data.vapid?.privateKey) throw Error();
            return data;
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            throw Object.assign(new Error('通知配置无法读取，请在服务器检查'), { status: 503 });
        }
    }
    write(data) {
        const temp = `${this.filePath}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
            privateFiles.writePrivateFileSync(temp, JSON.stringify(data) + '\n', true);
            replaceFileSync(temp, this.filePath);
        } finally { try { fs.unlinkSync(temp); } catch {} }
    }
    config() {
        let data = this.read();
        if (!data) { data = { version: 1, vapid: webPush.generateVAPIDKeys(), devices: [] }; this.write(data); }
        return data;
    }
    save(body, identity) {
        const sub = subscription(body?.subscription);
        const data = this.config(); const id = hash(sub.endpoint);
        data.devices = data.devices.filter(d => this.access.validIdentity(d.identity) && d.id !== id);
        if (data.devices.length >= 64) throw fail('通知设备已达 64 台上限');
        data.devices.push({ id, subscription: sub, identity, revision: randomUUID(), createdAt: Date.now() });
        this.write(data); return { enabled: true };
    }
    remove(body) {
        const sub = subscription(body?.subscription); const data = this.read();
        if (data) { data.devices = data.devices.filter(d => d.id !== hash(sub.endpoint)); this.write(data); }
        return { enabled: false };
    }
    status(body, identity) {
        const sub = subscription(body?.subscription); const data = this.read();
        return { enabled: Boolean(data?.devices.some(d => d.id === hash(sub.endpoint) && this.access.validIdentity(d.identity)
            && d.identity.tag === identity.tag)) };
    }
    async deliver(device, payload, vapid) {
        if (!this.access.validIdentity(device.identity)
            || !this.read()?.devices.some(d => d.id === device.id && d.revision === device.revision)) return false;
        try {
            await this.send(device.subscription, JSON.stringify(payload), { TTL: 300, urgency: 'normal', timeout: 10000,
                vapidDetails: { subject: 'https://github.com/YogurtJ/pivane', ...vapid } });
            return true;
        } catch (error) {
            if ([404, 410].includes(error.statusCode)) {
                const data = this.read();
                if (data) { data.devices = data.devices.filter(d => d.id !== device.id || d.revision !== device.revision); this.write(data); }
            }
            return false; // Never log endpoints, subscription keys or remote response bodies.
        }
    }
    async test(body, identity) {
        const sub = subscription(body?.subscription); const id = hash(sub.endpoint);
        if ((this.lastTest.get(id) || 0) > Date.now() - 10000) throw fail('请等待 10 秒后再测试');
        if (this.lastTest.size > 64) this.lastTest.clear();
        this.lastTest.set(id, Date.now());
        const data = this.read(); const device = data?.devices.find(d => d.id === id && this.access.validIdentity(d.identity) && d.identity.tag === identity.tag);
        if (!device) throw fail('请先启用本设备通知');
        if (!await this.deliver(device, { title: 'Pivane 测试通知', body: '本设备已连接系统通知。', id: randomUUID() }, data.vapid)) throw fail('推送未成功提交，请检查网络与订阅后重新启用');
        return { accepted: true };
    }
    async notify(event) {
        if (this.seen.has(event.completionId)) return;
        this.seen.add(event.completionId); if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
        if (this.running >= 4) return;
        this.running++;
        try {
            this.store.resolveProject(event.cwd);
            const data = this.read(); if (!data) return;
            const payload = { id: event.completionId, title: 'Pivane',
                body: event.kind === 'waiting' ? '任务正在等待你的确认。' : event.kind === 'error' ? '任务未成功完成，请打开工作台查看。' : '新的回复已完成，点击查看。' };
            // Bounded fanout, independent of model/worker lifetime.
            for (let i = 0; i < data.devices.length; i += 4) {
                await Promise.all(data.devices.slice(i, i + 4).map(d => this.deliver(d, payload, data.vapid)));
            }
        } catch { /* Notification failure must not interrupt an Agent. */ }
        finally { this.running--; }
    }
    mount(router) {
        const route = fn => async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try { res.json(await fn(req)); }
            catch (e) { res.status(e.status || 500).json({ error: e.message }); }
        };
        router.get('/notifications', route(() => ({ supported: true })));
        router.post('/notifications/key', route(() => ({ publicKey: this.config().vapid.publicKey })));
        router.post('/notifications/status', route(req => this.status(req.body, req.workspaceIdentity)));
        router.put('/notifications/subscription', route(req => this.save(req.body, req.workspaceIdentity)));
        router.delete('/notifications/subscription', route(req => this.remove(req.body)));
        router.post('/notifications/test', route(req => this.test(req.body, req.workspaceIdentity)));
    }
}
module.exports = { PiNotificationService, subscription };
