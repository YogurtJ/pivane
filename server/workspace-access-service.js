const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const { replaceFileSync } = require('./pi-win32-native');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('node:crypto');
const express = require('express');

const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const internalRoutes = new Map([
    ['/api/media-agent/capabilities/image', 'GET'], ['/api/media-agent/capabilities/video', 'GET'], ['/api/media-agent/capabilities/tts', 'GET'],
    ['/api/media-agent/validate', 'POST'], ['/api/media-agent/connection-schema', 'GET'], ['/api/media-agent/connection/validate', 'POST']
]);

class WorkspaceAccessService extends EventEmitter {
    constructor(options = {}) {
        super();
        const configuredDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
        const agentDir = path.resolve(configuredDir.replace(/^~(?=$|\/)/, os.homedir()));
        this.filePath = path.resolve(options.filePath || path.join(agentDir, 'pi5-access.json'));
        this.envToken = options.envToken || (() => process.env.PI_WEB_TOKEN || '');
        this.secureCookie = options.secureCookie ?? process.env.PI_WEB_SECURE_COOKIE === 'true';
        this.cookieName = `pi_access_${digest(this.filePath).slice(0, 12)}`;
        this.internalToken = randomBytes(32).toString('base64url');
        // Separate from the media planning credential; only dedicated assistant workers receive it.
        this.extensionAssistantToken = randomBytes(32).toString('base64url');
        this.cachedToken = null;
        this.attempts = new Map();
        this.sockets = new Map();
        this.publicFiles = new Set(options.publicFiles || []);
        this.publicPrefixes = options.publicPrefixes || [];
        this.timer = setInterval(() => this.checkSockets(), 15000); this.timer.unref();
    }

    read() {
        let stat;
        try { stat = fs.lstatSync(this.filePath); }
        catch (error) {
            if (error.code === 'ENOENT') return { version: 1, enabled: false, revision: 'initial', sessions: [] };
            throw failure('访问配置无法读取，请在服务器检查或使用本地重置命令；未关闭验证', 503);
        }
        try {
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (data.version !== 1 || typeof data.enabled !== 'boolean' || typeof data.revision !== 'string'
                || !Array.isArray(data.sessions) || data.sessions.length > 64
                || data.enabled && (!/^[a-f0-9]{32}$/.test(data.salt) || !/^[a-f0-9]{64}$/.test(data.verifier))
                || data.sessions.some(s => !/^[a-f0-9]{64}$/.test(s.idHash) || !Number.isSafeInteger(s.expiresAt) || typeof s.tag !== 'string')) throw Error();
            return data;
        } catch { throw failure('访问配置无法读取，请在服务器检查或使用本地重置命令；未关闭验证', 503); }
    }

    write(data) {
        const temporary = `${this.filePath}.tmp-${randomUUID()}`;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
            if (fs.existsSync(this.filePath) && !fs.lstatSync(this.filePath).isFile()) throw Error();
            privateFiles.writePrivateFileSync(temporary, JSON.stringify(data) + '\n', true);
            replaceFileSync(temporary, this.filePath);
        } catch { throw failure('访问配置保存失败，请刷新核对；未自动重试', 503); }
        finally { try { fs.unlinkSync(temporary); } catch {} }
    }

    configuration() {
        const data = this.read();
        const env = this.envToken();
        return { data, env, enabled: Boolean(env) || data.enabled, tag: digest(`${data.revision}\0${env}`) };
    }

    settings() {
        const c = this.configuration();
        return { accessControl: true, enabled: c.enabled, source: c.env ? 'environment' : 'workspace', editable: !c.env,
            revision: c.tag, hasToken: Boolean(c.env || c.data.verifier), secureCookie: this.secureCookie,
            sessionHours: 12, rememberDays: 30 };
    }

    allowAttempt(req) {
        const now = Date.now();
        for (const [key, slot] of this.attempts) if (slot.until <= now) this.attempts.delete(key);
        const ip = req.socket?.remoteAddress || 'local';
        for (const key of ['global', ip]) {
            const slot = this.attempts.get(key);
            if (slot && slot.count >= (key === 'global' ? 60 : 10)) throw failure('验证尝试过多，请一分钟后再试', 429);
        }
        if (this.attempts.size > 1000 && !this.attempts.has(ip)) throw failure('验证请求过多，请稍后再试', 429);
    }

    failedAttempt(req) {
        for (const key of ['global', req.socket?.remoteAddress || 'local']) {
            const slot = this.attempts.get(key) || { count: 0, until: Date.now() + 60000 }; slot.count++; this.attempts.set(key, slot);
        }
    }

    verifyToken(token, c, req) {
        if (typeof token !== 'string' || !token || Buffer.byteLength(token) > 4096) return false;
        const fingerprint = digest(token);
        if (this.cachedToken?.tag === c.tag && equal(this.cachedToken.fingerprint, fingerprint)) return true;
        this.allowAttempt(req);
        const valid = c.env ? equal(fingerprint, digest(c.env)) : c.data.enabled && equal(scryptSync(token, c.data.salt, 32).toString('hex'), c.data.verifier);
        if (valid) this.cachedToken = { tag: c.tag, fingerprint };
        else this.failedAttempt(req);
        return valid;
    }

    authenticate(req, explicitToken) {
        const c = this.configuration();
        if (!c.enabled) return { kind: 'open', tag: c.tag };
        const header = req.headers?.authorization;
        const token = explicitToken || (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '');
        if (token || header) return this.verifyToken(token, c, req) ? { kind: 'token', tag: c.tag } : null;
        const cookies = String(req.headers?.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(this.cookieName + '='));
        if (cookies.length !== 1) return null;
        const raw = cookies[0].slice(this.cookieName.length + 1);
        if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
        const idHash = digest(raw);
        const session = c.data.sessions.find(s => s.idHash === idHash && s.tag === c.tag && s.expiresAt > Date.now());
        return session ? { kind: 'cookie', tag: c.tag, idHash, expiresAt: session.expiresAt } : null;
    }

    validIdentity(identity) {
        if (!identity) return false;
        try {
            const c = this.configuration();
            if (identity.tag !== c.tag) return false;
            if (identity.kind === 'open') return !c.enabled;
            if (identity.kind === 'token') return c.enabled;
            return c.enabled && c.data.sessions.some(s => s.idHash === identity.idHash && s.tag === c.tag && s.expiresAt > Date.now());
        } catch { return false; }
    }

    trackSocket(socket, identity) {
        this.sockets.set(socket, identity);
        socket.once('close', () => this.sockets.delete(socket));
    }

    checkSockets() {
        for (const [socket, identity] of this.sockets) if (!this.validIdentity(identity)) {
            this.sockets.delete(socket); socket.close(4401, 'Access expired or revoked');
        }
    }

    sameOrigin(req) {
        try {
            const origin = new URL(req.headers.origin);
            return origin.origin === `${req.socket?.encrypted || this.secureCookie ? 'https' : 'http'}://${req.headers.host}`;
        } catch { return false; }
    }

    originAllowed(req) {
        const origin = req.headers?.origin;
        if (!origin) return req.headers?.['sec-fetch-site'] !== 'cross-site';
        if (this.sameOrigin(req)) return true;
        // Explicit cross-origin integrations must supply a bearer/WS token, never ambient cookies.
        return String(process.env.PI_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).includes(origin);
    }

    csrf(req, identity, strict = false) {
        if (!this.originAllowed(req)) return false;
        if (req.headers.origin && !this.sameOrigin(req) && identity?.kind !== 'token') return false;
        if (strict) return req.headers['x-pi-access'] === '1';
        if (identity?.kind === 'cookie' && !safeMethods.has(req.method)) return this.sameOrigin(req) || req.headers['x-pi-access'] === '1';
        return true;
    }

    issueCookie(data, tag, remember, res) {
        const value = randomBytes(32).toString('base64url');
        const ttl = remember ? 30 * 86400000 : 12 * 3600000;
        data.sessions = data.sessions.filter(s => s.expiresAt > Date.now() && s.tag === tag).slice(-63);
        data.sessions.push({ idHash: digest(value), expiresAt: Date.now() + ttl, tag });
        res.setHeader('Set-Cookie', `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${this.secureCookie ? '; Secure' : ''}${remember ? `; Max-Age=${ttl / 1000}` : ''}`);
    }

    clearCookie(res) {
        res.setHeader('Set-Cookie', `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie ? '; Secure' : ''}`);
    }

    middleware() {
        return (req, res, next) => {
            try {
                let pathname; try { pathname = decodeURIComponent(req.path); } catch { throw failure('Invalid path'); }
                const normalized = path.posix.normalize(pathname) === pathname && !pathname.includes('\\');
                if ((req.method === 'GET' || req.method === 'HEAD') && normalized
                    && (this.publicFiles.has(pathname) || this.publicPrefixes.some(prefix => pathname.startsWith(prefix)))) return next();
                if (!this.originAllowed(req)) throw failure('Origin is not allowed', 403);
                const internal = internalRoutes.get(pathname) === req.method && equal(String(req.headers.authorization || ''), `Bearer ${this.internalToken}`);
                const assistantPath = pathname.replace(/^\/api\/pi(?=\/)/, '');
                const assistant = req.method === 'POST' && ['/extension-assistant/inventory', '/extension-assistant/package'].includes(assistantPath)
                    && equal(String(req.headers.authorization || ''), `Bearer ${this.extensionAssistantToken}`);
                const threadPath = pathname.replace(/^\/api\/pi(?=\/)/, '');
                const thread = req.method === 'POST' && /^\/agent-threads\/(create|status|models)$/.test(threadPath)
                    ? this.agentThreadIdentity?.(req) : null;
                const identity = internal ? { kind: 'internal' } : assistant ? { kind: 'extension-assistant' } : thread || this.authenticate(req);
                if (req.method === 'OPTIONS') {
                    res.set({ 'Access-Control-Allow-Origin': req.headers.origin || '', Vary: 'Origin',
                        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Pi-Access' });
                    return res.sendStatus(204);
                }
                if (!identity) throw failure('请登录工作台或提供有效访问 Token', 401);
                if (!this.csrf(req, identity)) throw failure('Origin or CSRF check failed', 403);
                req.workspaceIdentity = identity;
                res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
                if (req.headers.origin && !this.sameOrigin(req)) res.set({ 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' });
                next();
            } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
        };
    }

    mount(app) {
        const router = express.Router(); router.use(express.json({ limit: '16kb', strict: true }));
        const respond = (fn, { publicRoute = false, write = false } = {}) => (req, res) => {
            res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            try {
                if (!this.originAllowed(req)) throw failure('Origin is not allowed', 403);
                const identity = this.authenticate(req);
                if (!publicRoute && !identity) throw failure('请先登录工作台', 401);
                if (!this.csrf(req, identity, write)) throw failure('Origin or CSRF check failed', 403);
                if (write && !req.is('application/json')) throw failure('访问写请求必须使用 JSON', 415);
                if (req.headers.origin && !this.sameOrigin(req) && identity?.kind === 'token') res.set({ 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' });
                return fn(req, res, identity);
            } catch (error) {
                res.removeHeader('Set-Cookie');
                if (error.status === 429) res.set('Retry-After', '60');
                res.status(error.status || 503).json({ error: error.message });
            }
        };
        router.get('/status', respond((req, res, identity) => res.json({ accessControl: true, enabled: this.configuration().enabled, authenticated: Boolean(identity) }), { publicRoute: true }));
        router.get('/settings', respond((_req, res) => res.json(this.settings())));
        router.post('/login', respond((req, res) => {
            const c = this.configuration(); this.allowAttempt(req);
            if (!c.enabled) return res.json({ ok: true, enabled: false });
            if (!this.verifyToken(req.body?.token, c, req)) throw failure('Token 不正确', 401);
            this.issueCookie(c.data, c.tag, req.body.remember === true, res); this.write(c.data);
            res.json({ ok: true, enabled: true });
        }, { publicRoute: true, write: true }));
        router.post('/logout', respond((req, res, identity) => {
            if (identity?.kind === 'cookie') { const data = this.read(); data.sessions = data.sessions.filter(s => s.idHash !== identity.idHash); this.write(data); }
            this.clearCookie(res); this.checkSockets(); res.json({ ok: true });
        }, { publicRoute: true, write: true }));
        router.post('/revoke', respond((_req, res) => {
            const data = this.read(); data.sessions = []; this.write(data); this.clearCookie(res); this.checkSockets(); res.json({ ok: true });
        }, { write: true }));
        router.put('/settings', respond((req, res) => {
            const c = this.configuration(), body = req.body;
            if (c.env) throw failure('访问验证由 PI_WEB_TOKEN 管理，请在服务器修改', 403);
            if (!body || typeof body.enabled !== 'boolean' || body.confirmed !== true || Object.keys(body).some(k => !['enabled', 'token', 'generate', 'confirmed', 'expectedRevision'].includes(k))) throw failure('访问设置参数无效');
            if (body.expectedRevision !== c.tag) throw failure('访问设置已变化，请刷新后再修改', 409);
            let newToken;
            if (body.enabled) {
                if (body.generate === true && body.token) throw failure('请选择自行设置或生成 Token');
                newToken = body.generate === true ? randomBytes(32).toString('base64url') : body.token;
                if (typeof newToken !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(newToken)) throw failure('Token 需为 16–256 个英文字符、数字或符号，不含空格');
            }
            const data = { version: 1, enabled: body.enabled, revision: randomUUID(), sessions: [] };
            if (newToken) { data.salt = randomBytes(16).toString('hex'); data.verifier = scryptSync(newToken, data.salt, 32).toString('hex'); }
            const tag = digest(`${data.revision}\0`);
            if (body.enabled) this.issueCookie(data, tag, false, res); else this.clearCookie(res);
            this.write(data); this.cachedToken = newToken ? { tag, fingerprint: digest(newToken) } : null;
            this.checkSockets(); res.json({ ...this.settings(), ...(body.generate === true && newToken ? { generatedToken: newToken } : {}) });
        }, { write: true }));
        router.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: '访问请求格式无效或过大' }));
        app.use('/api/access', router);
        app.use(this.middleware());
    }

    dispose() { clearInterval(this.timer); this.sockets.clear(); }
}

module.exports = { WorkspaceAccessService };
