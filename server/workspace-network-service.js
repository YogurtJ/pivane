const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { readSafe, atomicJson, privateDir } = require('./pi-maintenance-files');
const { environmentFor, proxyAgent, proxyUrl } = require('./workspace-network-transport');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const defaults = () => ({ version: 1, revision: 'initial', listen: null, proxy: { mode: 'environment', url: '', noProxy: '' } });
function loopback(host) {
    const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    return value === 'localhost' || value === '::1' || Boolean(net.isIP(value) && (/^127\./.test(value) || /^::ffff:127\./.test(value)));
}
function validateProxy(value) {
    if (!object(value) || Object.keys(value).some(key => !['mode', 'url', 'noProxy'].includes(key)) || !['environment', 'direct', 'custom'].includes(value.mode)) throw fail('请选择有效的代理方式');
    const url = value.url ?? '', noProxy = value.noProxy ?? '';
    if (typeof url !== 'string' || url.length > 2048 || typeof noProxy !== 'string' || noProxy.length > 2048) throw fail('代理配置过长');
    if (value.mode === 'custom') {
        let parsed;
        try { parsed = new URL(url); } catch { throw fail('请输入完整的 HTTP 或 HTTPS 代理地址'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || /[\s\u0000-\u001f]/.test(url)) throw fail('代理仅支持 HTTP/HTTPS 地址；请勿填写账号、密码、路径或查询参数');
    } else if (url) throw fail('仅自定义模式需要代理地址');
    if (noProxy.split(',').some(item => item.trim() && !/^(?:\*|(?:\*\.)?\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?::\d{1,5})?|\[[a-f0-9:]+\](?::\d{1,5})?|::1)$/i.test(item.trim()))) throw fail('绕过地址请用逗号分隔的主机名或 IP，不支持路径和 CIDR');
    return { mode: value.mode, url: value.mode === 'custom' ? new URL(url).href.replace(/\/$/, '') : '', noProxy: noProxy.split(',').map(s => s.trim()).filter(Boolean).join(',') };
}
function readConfiguration(file) {
    try {
        const value = JSON.parse(readSafe(file, 16384));
        if (!object(value) || value.version !== 1 || typeof value.revision !== 'string' || value.revision.length > 100 || ![null, 'local', 'devices'].includes(value.listen)) throw Error();
        if (value.defaultListen !== undefined && !['local', 'legacy'].includes(value.defaultListen)) throw Error();
        return { ...value, proxy: validateProxy(value.proxy) };
    } catch (error) {
        if (error.code === 'ENOENT') return defaults();
        throw fail('网络配置无法读取，请在服务器修复；未回退为开放访问或直连', 503);
    }
}
class WorkspaceNetworkService {
    constructor({ env = process.env, root = process.cwd(), filePath, fetch = require('node-fetch'), interfaces = os.networkInterfaces } = {}) {
        this.env = { ...env }; this.fetch = fetch; this.interfaces = interfaces;
        const agent = path.resolve((env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent')).replace(/^~(?=$|[\\/])/, os.homedir()));
        this.filePath = filePath || path.join(agent, 'pivane-network.json');
        this.config = readConfiguration(this.filePath);
        // A prior managed release proves an existing installation. Preserve its
        // unspecified bind instead of silently disconnecting remote users.
        this.legacy = false;
        try { if (env.PI_MEDIA_PROFILE !== 'clean') { const state = JSON.parse(readSafe(path.join(env.PI_MANAGED_BASE || root, '.pivane-runtime/state.json'), 1024 * 1024)); this.legacy = typeof state.active === 'string'; } }
        catch (error) { if (error.code !== 'ENOENT') throw fail('无法核对原监听配置，请在部署配置中明确设置 HOST', 503); }
        if (this.config.defaultListen) this.legacy = this.config.defaultListen === 'legacy';
        this.host = this.resolveHost(this.config.listen);
        this.nativeProxy = '';
        try {
            const settings = JSON.parse(readSafe(path.join(agent, 'settings.json'), 1024 * 1024));
            if (settings.httpProxy !== undefined && typeof settings.httpProxy !== 'string') throw Error();
            this.nativeProxy = settings.httpProxy || '';
        } catch (error) { if (error.code !== 'ENOENT') throw fail('无法读取 Pi 网络配置，请先修复原生设置', 503); }
        this.bootConfig = structuredClone(this.config);
        this.bootEnv = environmentFor(this.config.proxy, this.env, this.nativeProxy, this.host);
        this.testBusy = false; this.tests = []; this.address = null;
    }
    resolveHost(listen) { return this.env.HOST || (listen === 'devices' ? '0.0.0.0' : listen === 'local' ? '127.0.0.1' : this.legacy ? undefined : '127.0.0.1'); }
    initialize() {
        // Freeze the first known default outside release snapshots. A later
        // application update must not turn a new loopback install into wildcard.
        if (this.config.revision !== 'initial') return;
        const current = readConfiguration(this.filePath);
        if (current.revision !== 'initial') throw fail('网络配置已变化，请重新启动核对', 409);
        privateDir(path.dirname(this.filePath));
        this.config = { ...current, revision: randomUUID(), defaultListen: this.legacy ? 'legacy' : 'local' };
        atomicJson(this.filePath, this.config);
        this.bootConfig = structuredClone(this.config);
    }
    applyEnvironment(env) {
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
            if (this.bootEnv[key] === undefined) delete env[key]; else env[key] = this.bootEnv[key];
        }
        // Child SDK entrypoints must not reintroduce native httpProxy in direct mode.
        env.PIVANE_NETWORK_MODE = this.bootConfig.proxy.mode;
    }
    attach(address, access) { this.address = address; this.access = access; }
    assertStartup(access) {
        if (this.config.listen === 'devices' && !this.env.HOST && !access.configuration().enabled) throw fail('开放其他设备访问前必须开启登录验证；请在服务器恢复本机监听或配置访问 Token', 503);
    }
    assertAccessChange(enabled) {
        if (enabled) return;
        const saved = readConfiguration(this.filePath);
        if (!loopback(this.address?.address || this.host) || !loopback(this.resolveHost(saved.listen))) throw fail('请先改为仅本机监听并重启生效，再关闭登录验证', 409);
    }
    snapshot() {
        const saved = readConfiguration(this.filePath);
        const host = this.resolveHost(saved.listen);
        const currentHost = this.address?.address || this.host || '::';
        const pendingListen = host !== this.host;
        const nextEnv = environmentFor(saved.proxy, this.env, this.nativeProxy, host);
        const pendingProxy = !equal(nextEnv, this.bootEnv) || !equal(saved.proxy, this.bootConfig.proxy);
        const port = this.address?.port || Number(this.env.PORT || 11408);
        const format = value => `http://${value.includes(':') ? `[${value}]` : value}:${port}`;
        const addresses = [];
        if (loopback(currentHost) || ['0.0.0.0', '::'].includes(currentHost)) addresses.push({ url: format(currentHost === '::1' ? '::1' : '127.0.0.1'), kind: 'local' });
        if (!loopback(currentHost)) {
            if (['0.0.0.0', '::'].includes(currentHost)) {
                for (const entries of Object.values(this.interfaces())) for (const item of entries || []) {
                    if (!item.internal && net.isIP(item.address) && !item.address.includes('%') && !item.address.startsWith('fe80:') && (currentHost === '::' || item.family === 'IPv4')) addresses.push({ url: format(item.address), kind: 'candidate' });
                }
            } else if (net.isIP(currentHost)) addresses.push({ url: format(currentHost), kind: 'candidate' });
        }
        return { revision: saved.revision, saved: { listen: saved.listen, proxy: saved.proxy },
            current: { host: currentHost, port, local: loopback(currentHost), proxyMode: this.bootConfig.proxy.mode, usesProxy: Boolean(proxyUrl('https://api.github.com', this.bootEnv)), secureCookie: Boolean(this.access?.secureCookie) },
            listenSource: this.env.HOST ? 'deployment' : saved.listen ? 'workspace' : this.legacy ? 'legacy' : 'default',
            listenEditable: !this.env.HOST, pendingListen, pendingProxy, restartRequired: pendingListen || pendingProxy,
            authEnabled: Boolean(this.access?.configuration().enabled),
            environmentProxy: Boolean(this.env.https_proxy || this.env.HTTPS_PROXY || this.env.http_proxy || this.env.HTTP_PROXY || this.env.all_proxy || this.env.ALL_PROXY),
            nativeProxy: Boolean(this.nativeProxy), addresses: [...new Map(addresses.map(item => [item.url, item])).values()].slice(0, 12) };
    }
    save(body) {
        if (!object(body) || body.confirmed !== true || Object.keys(body).some(k => !['expectedRevision', 'confirmed', 'section', 'value'].includes(k))) throw fail('网络设置参数无效');
        const current = readConfiguration(this.filePath);
        if (body.expectedRevision !== current.revision) throw fail('网络设置已变化，请刷新核对后再保存', 409);
        const next = { ...current, defaultListen: current.defaultListen || (this.legacy ? 'legacy' : 'local'), revision: randomUUID() };
        if (body.section === 'listen') {
            if (this.env.HOST) throw fail('监听地址由部署配置 HOST 管理，请在服务器修改', 403);
            if (!['local', 'devices'].includes(body.value)) throw fail('请选择访问范围');
            if (body.value === 'devices' && !this.access?.configuration().enabled) throw fail('请先开启登录验证，再允许其他设备连接', 403);
            next.listen = body.value;
        } else if (body.section === 'proxy') next.proxy = validateProxy(body.value);
        else if (body.section === 'discard' && body.value === null) { next.listen = this.bootConfig.listen; next.proxy = structuredClone(this.bootConfig.proxy); }
        else throw fail('网络设置分区无效');
        privateDir(path.dirname(this.filePath));
        // Recheck before replacement; never overwrite a changed draft revision.
        if (readConfiguration(this.filePath).revision !== current.revision) throw fail('网络设置已变化，请刷新核对后再保存', 409);
        try { atomicJson(this.filePath, next); }
        catch { throw fail('网络设置保存结果不确定，请刷新核对；未自动重试', 503); }
        return this.snapshot();
    }
    async test(body) {
        if (!object(body) || Object.keys(body).some(k => !['proxy', 'target'].includes(k)) || !['github', 'npm'].includes(body.target)) throw fail('请选择 GitHub 或 npm 测试目标');
        const proxy = validateProxy(body.proxy);
        const now = Date.now(); this.tests = this.tests.filter(time => now - time < 60000);
        if (this.testBusy || this.tests.length >= 6) throw fail('连接测试过于频繁，请稍后再试', 429);
        this.testBusy = true; this.tests.push(now);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        let agent;
        try {
            const target = body.target === 'github' ? 'https://api.github.com/repos/YogurtJ/pivane' : 'https://registry.npmjs.org/-/ping';
            agent = proxyAgent(target, environmentFor(proxy, this.env, this.nativeProxy, this.host));
            const response = await this.fetch(target, { method: 'GET', redirect: 'error', size: 16384, signal: controller.signal, agent, headers: { 'User-Agent': 'Pivane-Network-Test' } });
            response.body?.destroy();
            return { reached: true, ok: response.ok, status: response.status, durationMs: Date.now() - now };
        } catch { return { reached: false, ok: false, durationMs: Date.now() - now }; }
        finally { clearTimeout(timer); agent?.destroy(); this.testBusy = false; }
    }
    mount(app, access) {
        this.access = access;
        const handler = (write, action) => async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try {
                const identity = access.authenticate(req);
                if (!identity) throw fail('请先登录工作台', 401);
                if (!access.csrf(req, identity, write)) throw fail('网络设置请求来源无效', 403);
                if (write && !access.configuration().enabled) throw fail('请先开启登录验证，再修改网络设置', 403);
                res.json(await action(req.body));
            } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : '无法读取网络状态，请在服务器核对配置' }); }
        };
        app.get('/api/network/settings', handler(false, () => this.snapshot()));
        app.put('/api/network/settings', handler(true, body => this.save(body)));
        app.post('/api/network/test', handler(true, body => this.test(body)));
    }
}
module.exports = { WorkspaceNetworkService, validateProxy, readConfiguration, loopback };
