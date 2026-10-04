const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = require('node-fetch');
const BYPASS = ['localhost', '127.0.0.1', '[::1]'];
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
function environmentFor(proxy, inherited = process.env, nativeProxy = '', internalHost) {
    const env = {};
    for (const key of PROXY_KEYS) if (inherited[key] !== undefined) env[key] = inherited[key];
    if (proxy.mode === 'direct') {
        for (const key of PROXY_KEYS) delete env[key];
        // Empty values also stop the Pi httpProxy fallback (which uses ??=).
        env.HTTP_PROXY = ''; env.HTTPS_PROXY = ''; env.ALL_PROXY = '';
    } else if (proxy.mode === 'custom') {
        for (const key of PROXY_KEYS) delete env[key];
        env.HTTP_PROXY = proxy.url; env.HTTPS_PROXY = proxy.url;
    } else if (nativeProxy) {
        env.HTTP_PROXY ??= nativeProxy; env.HTTPS_PROXY ??= nativeProxy;
    }
    // Normalize casing and ALL_PROXY once so node-fetch, undici and native
    // provider transports consume the same effective values.
    const all = env.all_proxy || env.ALL_PROXY || '';
    const http = env.http_proxy || env.HTTP_PROXY || all;
    const https = env.https_proxy || env.HTTPS_PROXY || http || all;
    env.http_proxy = env.HTTP_PROXY = http; env.https_proxy = env.HTTPS_PROXY = https;
    env.all_proxy = env.ALL_PROXY = all;
    const noProxy = [...BYPASS, ...(internalHost && !['0.0.0.0', '::'].includes(internalHost) ? [internalHost.includes(':') ? `[${internalHost}]` : internalHost] : []),
        ...(inherited.no_proxy || inherited.NO_PROXY || '').split(','), ...(proxy.noProxy || '').split(',')].map(s => s.trim()).filter(Boolean);
    env.NO_PROXY = [...new Set(noProxy)].join(','); env.no_proxy = env.NO_PROXY;
    return env;
}
function bypasses(target, list) {
    const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || require('node:net').isIP(host) && (/^127\./.test(host) || /^::ffff:127\./.test(host))) return true;
    return list.split(/[,\s]+/).filter(Boolean).some(raw => {
        if (raw === '*') return true;
        let value = raw.toLowerCase(), port;
        const match = value.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
        if (match) { value = match[1]; port = match[2]; }
        if (port && port !== (target.port || (target.protocol === 'https:' ? '443' : '80'))) return false;
        value = value.replace(/^\[|\]$/g, '');
        const suffix = value.replace(/^\*?\./, '');
        return host === suffix || host.endsWith('.' + suffix);
    });
}
function proxyUrl(url, env = process.env) {
    const target = new URL(typeof url === 'object' && url.href ? url.href : url);
    if (bypasses(target, env.no_proxy || env.NO_PROXY || '')) return undefined;
    const value = target.protocol === 'https:' ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY
        : env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;
    if (!value) return undefined;
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('Invalid proxy configuration'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported proxy protocol');
    return parsed;
}
function proxyAgent(url, env) {
    const proxy = proxyUrl(url, env);
    return proxy ? new HttpsProxyAgent(proxy) : undefined;
}
// The node-fetch redirect callback recalculates proxy routing on every hop.
// Credentials and redirect policies remain owned by each existing executor.
async function networkFetch(url, options = {}) {
    const agents = new Set();
    const dispose = () => { for (const agent of agents) agent.destroy(); agents.clear(); };
    try {
        const response = await fetch(url, { ...options, agent: target => { const agent = proxyAgent(target, process.env); if (agent) agents.add(agent); return agent; } });
        if (response.body) { response.body.once('end', dispose); response.body.once('close', dispose); response.body.once('error', dispose); }
        else dispose();
        return response;
    } catch (error) { dispose(); throw error; }
}
let sdkNetwork;
function initializeSdkNetwork(timeoutMs) {
    if (!sdkNetwork) sdkNetwork = (async () => {
        const { pathToFileURL } = require('node:url');
        const path = require('node:path');
        const root = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent');
        const http = await import(pathToFileURL(path.join(root, 'dist/core/http-dispatcher.js')).href);
        http.configureHttpDispatcher(timeoutMs);
    })();
    return sdkNetwork;
}
function markSdkNetworkReady() { sdkNetwork = Promise.resolve(); }
module.exports = { environmentFor, bypasses, proxyUrl, proxyAgent, networkFetch, initializeSdkNetwork, markSdkNetworkReady };
