const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const application = require('../package.json');
const { version: installedPi } = require('../node_modules/@earendil-works/pi-coding-agent/package.json');

const RELEASES = 'https://api.github.com/repos/YogurtJ/pivane/releases?per_page=100';
const PI_LATEST = 'https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest';
const RELEASE_PAGE = 'https://github.com/YogurtJ/pivane/releases';
const PI_PAGE = 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent';
const TTL = 5 * 60 * 1000;

function versionParts(value) {
    if (typeof value !== 'string' || value.length > 100) return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    const pre = match[4]?.split('.') || [];
    if (pre.some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === '0')) return null;
    return { core: match.slice(1, 4).map(BigInt), pre };
}
function compareVersions(a, b) {
    const x = versionParts(a), y = versionParts(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i], q = y.pre[i];
        if (p === q) continue;
        if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
        const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
        if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
        if (pn !== qn) return pn ? -1 : 1;
        return p > q ? 1 : -1;
    }
    return 0;
}
function relation(current, latest) {
    const comparison = compareVersions(current, latest);
    return comparison === null ? 'unknown' : comparison < 0 ? 'available' : comparison > 0 ? 'ahead' : 'current';
}
function proxyFor(url, env) {
    const target = new URL(url);
    const bypass = (env.no_proxy || env.NO_PROXY || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (bypass.some(item => {
        if (item === '*') return true;
        const [host, port] = item.split(':');
        if (port && port !== (target.port || '443')) return false;
        const suffix = host.replace(/^\*?\./, '');
        return target.hostname === suffix || (host.startsWith('.') || host.startsWith('*.')) && target.hostname.endsWith('.' + suffix);
    })) return undefined;
    const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
    if (!proxy) return undefined;
    const parsed = new URL(proxy);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported proxy');
    return new HttpsProxyAgent(parsed);
}

class UpdateService {
    constructor(options = {}) {
        this.fetch = options.fetch || fetch;
        this.env = options.env || process.env;
        this.now = options.now || Date.now;
        this.appVersion = options.appVersion || application.version;
        this.piVersion = options.piVersion || installedPi;
        this.bundledPiVersion = application.pivaneManaged?.baselinePi || application.dependencies['@earendil-works/pi-coding-agent'];
        this.platform = options.platform || process.platform;
        this.cache = new Map();
        this.inflight = new Map();
    }
    snapshot(channel = this.appVersion.includes('-') ? 'preview' : 'stable') {
        if (!['stable', 'preview'].includes(channel)) throw Object.assign(new Error('Invalid update channel'), { status: 400 });
        const cached = this.cache.get(channel);
        const automatic = this.notifications?.cachedPi();
        const pi = automatic && (!cached || automatic.checkedAt > Date.parse(cached.checkedAt))
            ? { version: automatic.version, status: relation(this.piVersion, automatic.version), releasesUrl: PI_PAGE }
            : cached?.pi;
        return {
            channel, platform: this.platform, installMode: 'manual',
            appVersion: this.appVersion, piVersion: this.piVersion, bundledPiVersion: this.bundledPiVersion,
            dependencyMatches: this.piVersion === (application.pivaneManaged?.piVersion || this.bundledPiVersion),
            managedPi: Boolean(application.pivaneManaged),
            checkedAt: cached?.checkedAt || null,
            cacheUntil: cached ? new Date(cached.expires).toISOString() : null,
            pivane: cached?.pivane || { status: 'unchecked', releasesUrl: RELEASE_PAGE },
            pi: pi || { status: 'unchecked', releasesUrl: PI_PAGE }
        };
    }
    async json(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        let agent;
        try {
            agent = proxyFor(url, this.env);
            const response = await this.fetch(url, {
                method: 'GET', redirect: 'error', size: 2 * 1024 * 1024, signal: controller.signal, agent,
                headers: { Accept: 'application/json', 'User-Agent': 'Pivane-Update-Check' }
            });
            if (!response.ok) throw new Error('Remote lookup failed');
            return await response.json();
        } finally { clearTimeout(timer); agent?.destroy(); }
    }
    async pivane(channel) {
        const releases = await this.json(RELEASES);
        if (!Array.isArray(releases) || releases.length > 100) throw new Error('Invalid release list');
        const candidates = releases.flatMap(release => {
            if (!release || release.draft || typeof release.tag_name !== 'string') return [];
            const version = release.tag_name.replace(/^v/, '');
            const parsed = versionParts(version);
            if (!parsed || (channel === 'stable' && (release.prerelease || parsed.pre.length))) return [];
            // Only expose fixed official asset paths. Remote HTML/URLs never become executable UI.
            const base = `${RELEASE_PAGE}/download/${encodeURIComponent(release.tag_name)}/`;
            const archive = `pivane-${version}.tar.gz`;
            const assets = Array.isArray(release.assets) ? release.assets : [];
            const asset = name => assets.some(a => a?.name === name && a.state === 'uploaded' && a.browser_download_url === base + name) ? base + name : null;
            return [{ version, prerelease: Boolean(release.prerelease || parsed.pre.length),
                releasesUrl: `${RELEASE_PAGE}/tag/${encodeURIComponent(release.tag_name)}`,
                downloadUrl: asset(archive), checksumUrl: asset(archive + '.sha256') }];
        }).sort((a, b) => compareVersions(b.version, a.version));
        if (!candidates.length) return { status: 'no-release', releasesUrl: RELEASE_PAGE };
        const latest = candidates[0];
        return { ...latest, status: relation(this.appVersion, latest.version) };
    }
    async pi() {
        const data = await this.json(PI_LATEST);
        if (data?.name !== '@earendil-works/pi-coding-agent' || !versionParts(data.version) || versionParts(data.version).pre.length) throw new Error('Invalid package version');
        return { status: relation(this.piVersion, data.version), version: data.version, releasesUrl: PI_PAGE };
    }
    check(channel) {
        this.snapshot(channel); // Validate before any network access.
        channel ||= this.appVersion.includes('-') ? 'preview' : 'stable';
        if (this.inflight.has(channel)) return this.inflight.get(channel);
        if (this.cache.get(channel)?.expires > this.now()) return Promise.resolve(this.snapshot(channel));
        // Reserve synchronously, before network requests; callers share one check per channel.
        const pending = Promise.resolve().then(async () => {
            const results = await Promise.allSettled([this.pivane(channel), this.pi()]);
            this.cache.set(channel, {
                checkedAt: new Date(this.now()).toISOString(), expires: this.now() + TTL,
                pivane: results[0].status === 'fulfilled' ? results[0].value : { status: 'error', releasesUrl: RELEASE_PAGE },
                pi: results[1].status === 'fulfilled' ? results[1].value : { status: 'error', releasesUrl: PI_PAGE }
            });
            if (results[1].status === 'fulfilled') {
                try { this.notifications?.recordSuccess(results[1].value); } catch { /* Manual version lookup remains usable if reminder storage is unavailable. */ }
            }
            return this.snapshot(channel);
        }).finally(() => this.inflight.delete(channel));
        this.inflight.set(channel, pending);
        return pending;
    }
}
function mountUpdateRoutes(router, service = new UpdateService(), hooks = {}) {
    const maintenance = hooks.maintenance || new (require('./pi-maintenance-client').MaintenanceClient)({ managed: false });
    const idle = hooks.idle || (() => false);
    const notifications = hooks.preferences ? new (require('./pi-update-notifications').UpdateNotifications)({ preferences: hooks.preferences, service, idle: () => !maintenance.locked && idle() }) : null;
    service.notifications = notifications;
    const notificationRoute = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (!notifications) return res.status(503).json({ error: 'Update reminders unavailable' });
            if (action === 'check' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
                return res.status(400).json({ error: 'Invalid update notification request' });
            }
            res.json(action === 'check' ? await notifications.check() : action === 'change' ? notifications.change(req.body) : notifications.snapshot());
        } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Update reminders unavailable' }); }
    };
    router.get('/settings/updates/notifications', notificationRoute('read'));
    router.post('/settings/updates/notifications', notificationRoute('change'));
    router.post('/settings/updates/automatic', notificationRoute('check'));
    router.get('/settings/updates/maintenance', (_req, res) => res.set('Cache-Control', 'no-store').json(maintenance.status()));
    router.post('/settings/updates/review', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !['action', 'channel'].includes(key))) throw Object.assign(new Error('维护操作无效'), { status: 400 });
            const action = req.body.action;
            if (req.body.channel !== undefined && (action !== 'application' || !['stable', 'preview'].includes(req.body.channel))) throw Object.assign(new Error('Invalid update channel'), { status: 400 });
            if (!['update', 'application', 'backup', 'restart'].includes(action)) throw Object.assign(new Error('维护操作无效'), { status: 400 });
            maintenance.assertAvailable(action, idle);
            let version, release;
            if (action === 'application') {
                const channel = req.body.channel || (service.appVersion.includes('-') ? 'preview' : 'stable');
                service.snapshot(channel);
                const candidate = await service.pivane(channel);
                if (candidate.status !== 'available' || !candidate.downloadUrl || !candidate.checksumUrl) throw Object.assign(new Error('此渠道没有可安装的 Pivane 新版本'), { status: 409 });
                const bytes = await require('./pi-application-installer').download(candidate.checksumUrl, { env: service.env, maxBytes: 1024 });
                const match = /^([a-f0-9]{64})  (pivane-[^\r\n]+\.tar\.gz)\r?\n?$/.exec(bytes.toString());
                if (!match || match[2] !== `pivane-${candidate.version}.tar.gz`) throw Error('Invalid release checksum');
                version = candidate.version; release = { version, sha256: match[1] };
            }
            if (action === 'update') {
                const upstream = await service.pi(); version = upstream.version;
                if (compareVersions(service.piVersion, version) !== -1) throw Object.assign(new Error('没有高于当前版本的 Pi 正式版'), { status: 409 });
            }
            res.json({ ...maintenance.review({ action, version, release }, idle), currentVersion: action === 'application' ? service.appVersion : service.piVersion });
        } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : '无法核对 Pi 更新版本，请稍后再试' }); }
    });
    router.post('/settings/updates/execute', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.status(202).json(maintenance.execute(req.body, { idle, pause: hooks.pause || (() => {}) })); }
        catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : '维护提交失败，请查看状态后再决定' }); }
    });
    const route = check => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const params = check ? req.body : req.query;
            if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'channel')
                || params.channel !== undefined && !['stable', 'preview'].includes(params.channel)) {
                return res.status(400).json({ error: 'Invalid update channel' });
            }
            res.json(check ? await service.check(params.channel) : service.snapshot(params.channel));
        } catch { res.status(503).json({ error: 'Update information unavailable' }); }
    };
    router.get('/settings/updates', route(false));
    router.post('/settings/updates/check', route(true));
}
module.exports = { UpdateService, mountUpdateRoutes, compareVersions, proxyFor };
