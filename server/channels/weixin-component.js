const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { privateDir, readSafe, atomicJson, hash } = require('../pi-maintenance-files');
const { proxyFor } = require('../pi-update-service');
const SOURCES = Object.freeze([
    { name: '@tencent-weixin/openclaw-weixin', version: '2.4.10', url: 'https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.10.tgz', sha256: '69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb' },
    { name: 'qrcode-terminal', version: '0.12.0', url: 'https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-0.12.0.tgz', sha256: '3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706' }
]);
const API_FILES = ['dist/src/api/api.js', 'dist/src/api/types.js', 'dist/src/util/redact.js', 'dist/src/messaging/markdown-filter.js', 'dist/src/cdn/aes-ecb.js'];
const QR_FILES = ['index', 'QRMath', 'QR8bitByte', 'QRRSBlock', 'QRUtil', 'QRErrorCorrectLevel', 'QRBitBuffer', 'QRMaskPattern', 'QRPolynomial', 'QRMode'].map(n => `vendor/QRCode/${n}.js`);
// Packages are data until their archive hash has been checked. No npm lifecycle,
// peer dependencies, plugin entrypoint, OpenClaw runtime or terminal login runs.
function archiveFiles(bytes, source) {
    if (bytes.length > 2 * 1024 * 1024 || hash(bytes) !== source.sha256) throw new Error('渠道组件下载校验失败');
    const tar = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
    const result = new Map(); let offset = 0, ended = false;
    const str = b => b.toString('utf8').replace(/\0.*$/s, '');
    const oct = b => { const s = str(b).trim(); if (!/^[0-7]+$/.test(s)) throw new Error('Invalid component archive'); return parseInt(s, 8); };
    while (offset + 512 <= tar.length) {
        const h = tar.subarray(offset, offset + 512); offset += 512;
        if (h.every(b => b === 0)) { ended = true; if (tar.subarray(offset).some(b => b !== 0)) throw new Error('Trailing archive content'); break; }
        if (oct(h.subarray(148, 156)) !== h.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0)) throw new Error('Invalid component checksum');
        const prefix = str(h.subarray(345, 500));
        const name = (prefix ? prefix + '/' : '') + str(h.subarray(0, 100));
        const size = oct(h.subarray(124, 136)), type = h[156];
        if (![0, 48, 53].includes(type) || !name.startsWith('package/') || name.includes('\\') || name.split('/').some(s => s === '..' || s === '.')
            || offset + size > tar.length || size > 1024 * 1024 || result.size > 1000 || result.has(name.slice(8))) throw new Error('Unsafe component archive');
        if (type !== 53) result.set(name.slice(8), tar.subarray(offset, offset + size).toString('utf8'));
        offset += Math.ceil(size / 512) * 512;
    }
    if (!ended) throw new Error('Truncated component archive');
    const pkg = JSON.parse(result.get('package.json') || 'null');
    if (pkg?.name !== source.name || pkg.version !== source.version) throw new Error('Component identity mismatch');
    return result;
}
async function download(source, signal) {
    const fetch = require('node-fetch');
    const agent = proxyFor(source.url, process.env);
    try {
        const response = await fetch(source.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: 'error', size: 2 * 1024 * 1024, agent });
        if (!response.ok) throw new Error('渠道组件下载失败');
        return await response.buffer();
    } finally { agent?.destroy(); }
}
async function compile(api, qr) {
    const files = new Map();
    for (const name of API_FILES) { if (!api.has(name)) throw new Error('Missing reviewed module'); files.set('/api/' + name, api.get(name)); }
    for (const name of QR_FILES) { if (!qr.has(name)) throw new Error('Missing QR module'); files.set('/qr/' + name, qr.get(name)); }
    files.set('/api/dist/src/auth/accounts.js', 'export const loadConfigBotAgent = () => "Pivane/1"; export const loadConfigRouteTag = () => undefined;');
    // Upstream diagnostics may contain complete API responses. Pivane reports
    // bounded status codes in its own service; no provider payload is logged.
    files.set('/api/dist/src/util/logger.js', 'const noop=()=>{}; export const logger={debug:noop,info:noop,warn:noop,error:noop};');
    files.set('/package-fs.js', `export default {existsSync:()=>true,readFileSync:()=>${JSON.stringify(api.get('package.json'))}};`);
    files.set('/entry.js', `export * as api from './api/dist/src/api/api.js';
        export * as formatting from './api/dist/src/messaging/markdown-filter.js';
        export * as cryptoMedia from './api/dist/src/cdn/aes-ecb.js';
        import QRCode from './qr/vendor/QRCode/index.js';
        export function qrMatrix(value) { const qr = new QRCode(-1, 1); qr.addData(value); qr.make(); return qr.modules; }
        export function setTransport(transport) { pivaneChannelFetch = transport; }`);
    const built = await require('esbuild').build({ entryPoints: ['/entry.js'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
        banner: { js: 'let pivaneChannelFetch; const fetch = (...args) => pivaneChannelFetch(...args);' },
        define: { 'import.meta.url': JSON.stringify('file:///pivane-reviewed-weixin/api.js') },
        plugins: [{ name: 'reviewed-weixin-modules', setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
                if (args.path === 'node:fs') return { path: '/package-fs.js', namespace: 'reviewed' };
                if (['node:crypto', 'node:path', 'node:url'].includes(args.path)) return { path: args.path, external: true };
                let target = args.path.startsWith('/') ? args.path : path.posix.resolve(path.posix.dirname(args.importer || '/'), args.path);
                if (!files.has(target) && files.has(target + '.js')) target += '.js';
                if (!files.has(target)) throw new Error(`Unreviewed component import: ${args.path}`);
                return { path: target, namespace: 'reviewed' };
            });
            build.onLoad({ filter: /.*/, namespace: 'reviewed' }, args => ({ contents: files.get(args.path), loader: 'js' }));
        } }] });
    return built.outputFiles[0].text;
}
function apiLicense(files) { const text = files.get('LICENSE'); const start = text.indexOf('Permission is hereby granted'); if (start < 0) throw new Error('Missing MIT terms'); return text.slice(start); }
class WeixinComponent {
    constructor(directory, { get = download } = {}) { this.directory = directory; this.get = get; this.module = null; }
    get filename() { return path.join(this.directory, 'component.json'); }
    record() {
        try {
            const value = JSON.parse(readSafe(this.filename, 2 * 1024 * 1024));
            if (value.version !== 1 || value.sources?.map(s => s.sha256).join() !== SOURCES.map(s => s.sha256).join() || hash(value.code) !== value.codeHash) throw new Error('Invalid component receipt');
            return value;
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    status() { const r = this.record(); return { installed: Boolean(r), version: r ? SOURCES[0].version : null, availableVersion: SOURCES[0].version, sources: SOURCES.map(({ name, version }) => ({ name, version })) }; }
    async install(signal) {
        if (this.record()) return this.status();
        const archives = [];
        for (const source of SOURCES) archives.push(archiveFiles(await this.get(source, signal), source));
        const code = await compile(...archives);
        if (signal.aborted) throw new Error('安装已取消');
        // Verify independent loading and QR generation before publishing receipt.
        const loaded = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
        if (!loaded.qrMatrix('Pivane').length || typeof loaded.api.getUpdates !== 'function') throw new Error('Component probe failed');
        privateDir(this.directory);
        const licenses = archives.map((a, i) => ({ name: SOURCES[i].name, text: a.get('LICENSE') || a.get('LICENSE.txt') }));
        if (licenses.some(l => !l.text)) throw new Error('Missing upstream license');
        licenses.push({ name: 'QRCode for JavaScript', text: 'Copyright (c) 2009 Kazuhiko Arase\nMIT License\n\n' + apiLicense(archives[0]) });
        const upstreamFiles = [...API_FILES.map(name => ({ source: SOURCES[0].name, name, content: archives[0].get(name) })),
            ...QR_FILES.map(name => ({ source: SOURCES[1].name, name, content: archives[1].get(name) }))];
        atomicJson(this.filename, { version: 1, sources: SOURCES, code, codeHash: hash(code), licenses, upstreamFiles,
            adaptations: 'Pivane supplies account configuration, bounded network transport and private diagnostics; upstream module bytes are retained unchanged.', installedAt: new Date().toISOString() });
        return this.status();
    }
    async load(transport) {
        if (!this.module) {
            const r = this.record(); if (!r) throw new Error('请先安装微信连接组件');
            this.module = await import('data:text/javascript;base64,' + Buffer.from(r.code).toString('base64') + '#pivane-' + require('node:crypto').randomUUID());
        }
        this.module.setTransport(transport); return this.module;
    }
    uninstall() {
        try { readSafe(this.filename, 2 * 1024 * 1024); fs.unlinkSync(this.filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.module = null;
    }
}
module.exports = { WeixinComponent, SOURCES, archiveFiles, compile };
