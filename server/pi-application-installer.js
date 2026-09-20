const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const fetch = require('node-fetch');
const { privateDir, readSafe, atomicJson, hash } = require('./pi-maintenance-files');
const { npmCli, installEnvironment, runNode, exactVersion } = require('./pi-update-installer');
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?$/;
const MAX_ARCHIVE = 64 * 1024 * 1024, MAX_EXPANDED = 256 * 1024 * 1024;
function validRelease(release) {
    return release && VERSION.test(release.version) && release.version.length < 80 && /^[a-f0-9]{64}$/.test(release.sha256);
}
async function download(url, { env, signal, request = fetch, maxBytes = MAX_ARCHIVE } = {}) {
    const { proxyFor } = require('./pi-update-service');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 120000);
    try {
        for (let redirects = 0; redirects < 4; redirects++) {
            const target = new URL(url);
            if (target.protocol !== 'https:' || target.username || target.password || target.port || !['github.com', 'release-assets.githubusercontent.com'].includes(target.hostname)) throw Error('Untrusted release download origin');
            const agent = proxyFor(url, env || process.env);
            try {
                const response = await request(url, { redirect: 'manual', size: maxBytes, signal: controller.signal, agent, headers: { 'User-Agent': 'Pivane-Application-Update' } });
                if ([301, 302, 303, 307, 308].includes(response.status)) { response.body?.destroy(); url = new URL(response.headers.get('location'), url).href; continue; }
                if (!response.ok) throw Error('Release download failed');
                const bytes = await response.buffer();
                if (bytes.length > maxBytes) throw Error('Release download exceeds budget');
                return bytes;
            } finally { agent?.destroy(); }
        }
        throw Error('Too many release redirects');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
// Parse only regular files/directories in the bounded release archive. Never invoke
// tar on untrusted paths, or create symlinks, devices, hardlinks or metadata entries.
function unpack(bytes, version, directory) {
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
    const files = new Map(), names = new Set(); let offset = 0, ended = false;
    const prefix = `pivane-${version}/`;
    const text = buffer => buffer.toString('utf8').replace(/\0.*$/s, '');
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512); offset += 512;
        if (header.every(b => b === 0)) { ended = true; if (tar.subarray(offset).some(b => b !== 0)) throw Error('Trailing archive content'); break; }
        const octal = buffer => { const value = text(buffer).trim(); if (!/^[0-7]+$/.test(value)) throw Error('Invalid tar number'); return parseInt(value, 8); };
        const checksum = octal(header.subarray(148, 156));
        if (header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0) !== checksum) throw Error('Invalid tar header');
        const name = (text(header.subarray(345, 500)) ? text(header.subarray(345, 500)) + '/' : '') + text(header.subarray(0, 100));
        const type = header[156], size = octal(header.subarray(124, 136));
        if (![0, 48, 53].includes(type) || !name.startsWith(prefix) || name.includes('\\') || /[\x00-\x1f\x7f:]/.test(name)) throw Error('Unsupported archive entry');
        const relative = name.slice(prefix.length).replace(/\/$/, '');
        if (relative && relative.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Unsafe archive path');
        if (offset + size > tar.length || size > 32 * 1024 * 1024 || names.size >= 20000 || names.has(relative.toLowerCase())) throw Error('Invalid archive size or duplicate entry');
        names.add(relative.toLowerCase());
        if (type === 53) { if (size) throw Error('Invalid directory'); }
        else { if (!relative) throw Error('Invalid file'); files.set(relative, tar.subarray(offset, offset + size)); }
        offset += Math.ceil(size / 512) * 512;
    }
    if (!ended) throw Error('Truncated archive');
    const manifest = JSON.parse(files.get('TRIAL_MANIFEST.json')?.toString() || 'null');
    if (manifest?.product !== 'Pivane' || manifest.appVersion !== version || !Array.isArray(manifest.files) || manifest.files.length !== files.size - 1) throw Error('Release manifest mismatch');
    const listed = new Set();
    for (const entry of manifest.files) {
        if (listed.has(entry.path) || !files.has(entry.path) || entry.path === 'TRIAL_MANIFEST.json' || hash(files.get(entry.path)) !== entry.sha256 || files.get(entry.path).length !== entry.bytes) throw Error('Release file integrity mismatch');
        listed.add(entry.path);
    }
    // User data and installation control files must never be supplied by a package.
    for (const name of files.keys()) if (/(^|\/)(?:node_modules|\.git|\.pivane-runtime|backups|local)(\/|$)/.test(name) || /^(?:\.env|auth\.json|PI_.*\.json)$/.test(name) || /^public\/(?:images|videos|audio)\//.test(name)) throw Error('Release contains private or runtime files');
    privateDir(directory);
    for (const [name, body] of files) { const destination = path.join(directory, name); privateDir(path.dirname(destination)); fs.writeFileSync(destination, body, { flag: 'wx', mode: 0o600 }); }
    return manifest;
}
async function stageApplication({ directory, release, env = process.env, signal, run = runNode, get = download, progress = () => {}, onOutput = () => {} }) {
    if (!validRelease(release)) throw Error('Invalid application release identity');
    progress('downloading');
    const url = `https://github.com/YogurtJ/pivane/releases/download/v${release.version}/pivane-${release.version}.tar.gz`;
    const bytes = await get(url, { env, signal });
    if (bytes.length > MAX_ARCHIVE || hash(bytes) !== release.sha256) throw Error('Application archive SHA256 mismatch');
    const manifest = unpack(bytes, release.version, directory);
    const pkg = JSON.parse(readSafe(path.join(directory, 'package.json')));
    const lock = JSON.parse(readSafe(path.join(directory, 'package-lock.json'), 16 * 1024 * 1024));
    const pi = pkg.dependencies?.['@earendil-works/pi-coding-agent'];
    if (pkg.name !== 'pivane' || pkg.version !== release.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version || !exactVersion(pi) || manifest.piVersion !== pi) throw Error('Application package identity mismatch');
    progress('installing');
    const installEnv = installEnvironment(env, directory);
    await run([npmCli(env), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, env: installEnv, signal, onOutput, secretEnv: env });
    if (JSON.parse(readSafe(path.join(directory, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version !== pi) throw Error('Installed Pi mismatch');
    progress('verifying');
    const probe = privateDir(path.join(directory, 'probe-data'));
    const probeEnv = Object.fromEntries(Object.entries(installEnv).filter(([key]) => !/proxy|^npm_/i.test(key)));
    Object.assign(probeEnv, { PI_UPDATE_PROBE: probe, PI_CODING_AGENT_DIR: path.join(probe, 'agent'), PI_PROJECT_ROOTS: probe, PI_MEDIA_DATA_DIR: path.join(probe, 'media'), PI_MEDIA_CONFIG_DIR: path.join(probe, 'agent/media-lab'), PI_WEB_DEFERRED_FILE: path.join(probe, 'deferred.json'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_WORKSPACE_BASE_URL: 'http://127.0.0.1:1' });
    await run([path.join(directory, 'server/pi-update-probe.js')], { cwd: probe, env: probeEnv, timeout: 90000, signal, onOutput, secretEnv: env });
    atomicJson(path.join(directory, 'PI_INSTALL_COMPLETE.json'), { version: pi, appVersion: pkg.version, archiveSha256: release.sha256, completedAt: new Date().toISOString(), lockSha256: hash(readSafe(path.join(directory, 'package-lock.json'), 16 * 1024 * 1024)) });
    return directory;
}
module.exports = { stageApplication, unpack, download, validRelease };
