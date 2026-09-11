// Runs only against newly created temporary identities and a local synthetic provider.
// Usage and the exact artifact identity belong in the release validation record.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync, fork } = require('node:child_process');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    assert.ok(['--archive', '--sha256', '--previous-archive', '--previous-sha256', '--browser', '--playwright', '--video', '--output'].includes(key), 'unknown acceptance option');
    assert.ok(process.argv[i + 1] && !args[key], 'option needs one value');
    args[key] = process.argv[i + 1];
}
for (const key of ['--archive', '--sha256', '--browser', '--playwright', '--output']) assert.ok(args[key], `${key} required`);
assert.equal(Boolean(args['--previous-archive']), Boolean(args['--previous-sha256']));
assert.equal(process.versions.node.split('.')[0], '22', 'release baseline requires an independent Node 22');
const output = path.resolve(args['--output']);
assert.ok(!fs.existsSync(output), 'acceptance output directory must be new');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pivane-release-'));
const runId = randomUUID();
fs.writeFileSync(path.join(root, '.pivane-release.json'), JSON.stringify({ kind: 'pivane-release-acceptance-v1', runId }), { mode: 0o600 });
const app = path.join(root, 'app'), previous = path.join(root, 'previous');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const systemNames = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemNames.has(key.toUpperCase())));
Object.assign(env, { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: path.join(root, 'data/agent'), PI_MEDIA_CONFIG_DIR: path.join(root, 'data/agent/media-lab'), PI_MEDIA_DATA_DIR: path.join(root, 'data/media'), PI_WEB_DEFERRED_FILE: path.join(root, 'data/agent/pi5-deferred-messages.json'), PI_PROJECT_ROOTS: path.join(root, 'projects'), PI_RELEASE_BASE_DIR: root, PI_RELEASE_PROJECT_DIR: path.join(root, 'projects/demo'), PI_RELEASE_RUN_ID: runId, PI_RELEASE_VIDEO_FILE: args['--video'] ? path.resolve(args['--video']) : path.join(app, 'test/fixtures/release-video.mp4'), PLAYWRIGHT_MODULE: path.resolve(args['--playwright']), CHROMIUM_PATH: path.resolve(args['--browser']) });
// npm configuration is independent of the user's registry/auth configuration.
for (const kind of ['user', 'global']) fs.writeFileSync(path.join(root, `npm-${kind}.conf`), '');
env.npm_config_userconfig = path.join(root, 'npm-user.conf');
env.npm_config_globalconfig = path.join(root, 'npm-global.conf');
env.npm_config_registry = 'https://registry.npmjs.org';
const npm = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'].find(file => fs.existsSync(file));
assert.ok(npm, 'npm CLI for the selected Node is required');
let server, provider, port, manifest, serverDirectory;
const children = new Set(), handles = [];
const result = { status: 'running', appVersion: null, artifactSha256: args['--sha256'], upgradeFromSha256: args['--previous-sha256'] || null, platform: process.platform, architecture: process.arch, osRelease: os.release(), node: process.versions.node, checks: [], paidProviderRequests: 0 };
function extract(archive, expected, destination) {
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(digest(fs.readFileSync(archive)), expected, 'archive SHA256 mismatch');
    fs.mkdirSync(destination);
    const tar = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
    const unpack = spawnSync(tar, ['-xzf', path.resolve(archive), '-C', destination, '--strip-components=1'], { env, encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const data = JSON.parse(fs.readFileSync(path.join(destination, 'TRIAL_MANIFEST.json'), 'utf8'));
    assert.equal(data.version, 1);
    for (const file of data.files) {
        assert.ok(!path.isAbsolute(file.path) && !file.path.includes('\\') && !file.path.split('/').includes('..'));
        assert.ok(!/^(?:docs\/local\/|backups\/|AGENTS\.local\.md$|\.env$|node_modules\/|public\/(?:images|videos|audio)\/)/i.test(file.path), 'private file in artifact');
        const filename = path.join(destination, file.path);
        assert.ok(fs.lstatSync(filename).isFile());
        assert.equal(digest(fs.readFileSync(filename)), file.sha256, `manifest mismatch: ${file.path}`);
    }
    return data;
}
function launch(file, label, options = {}) {
    const fd = fs.openSync(path.join(output, label + '.log'), 'w'); handles.push(fd);
    const spawnOptions = { cwd: options.cwd || app, env: options.env || env, stdio: ['ignore', fd, fd, ...(options.ipc ? ['ipc'] : [])] };
    const child = options.ipc ? fork(file, [], spawnOptions) : spawn(process.execPath, [file, ...(options.args || [])], spawnOptions);
    children.add(child); child.once('exit', () => children.delete(child));
    return child;
}
async function run(file, args, label, cwd = app) {
    const child = launch(file, label, { cwd, args });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`${label} failed (${code}); see ${label}.log`))); });
    result.checks.push(label);
}
async function waitReady(child, url, predicate) {
    for (let i = 0; i < 300; i++) {
        assert.equal(child.exitCode, null, 'test process exited before readiness');
        try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok && await predicate(await r.json())) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('test process readiness timeout');
}
function writeConfiguration(directory) {
    const settings = { HOST: '127.0.0.1', PORT: String(port), PI_WORKSPACE_BASE_URL: env.PI_RELEASE_TEST_URL };
    for (const key of ['PI_CODING_AGENT_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_MEDIA_DATA_DIR', 'PI_WEB_DEFERRED_FILE', 'PI_PROJECT_ROOTS']) settings[key] = env[key];
    fs.writeFileSync(path.join(directory, '.env'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
}
async function startServer(directory, label) {
    serverDirectory = directory;
    writeConfiguration(directory);
    const serverEnv = { ...env, PI_RELEASE_SERVER_DIR: directory };
    // Exercise the installed .env loader, as in the user installation instructions.
    for (const key of ['PI_CODING_AGENT_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_MEDIA_DATA_DIR', 'PI_WEB_DEFERRED_FILE', 'PI_PROJECT_ROOTS', 'PI_WORKSPACE_BASE_URL', 'PORT', 'HOST']) delete serverEnv[key];
    server = launch(path.join(app, 'test/release/serve.cjs'), label, { cwd: directory, env: serverEnv, ipc: true });
    await waitReady(server, env.PI_RELEASE_TEST_URL + '/api/pi/status', data => data.ok && data.projectRoots.length === 1 && data.projectRoots[0] === env.PI_PROJECT_ROOTS);
    const status = await (await fetch(env.PI_RELEASE_TEST_URL + '/api/pi/status')).json();
    for (const feature of ['fileViewer', 'sessionSearch', 'usageStats']) assert.equal(status[feature], true, feature);
}
async function stopServer() {
    if (!server) return;
    const activity = await (await fetch(env.PI_RELEASE_TEST_URL + '/api/pi/activity')).json();
    assert.ok(!activity.nativeSettingsBusy && activity.runtimes.every(item => !item.busy), 'rehearsal must be idle before shutdown');
    const legacy = serverDirectory === previous;
    if (legacy) {
        // The old package has the known once/signal-exit bug. End every worker first;
        // its exit is recorded separately and is never counted as RC graceful shutdown.
        const { WebSocket } = require(path.join(app, 'node_modules/ws'));
        for (const runtime of activity.runtimes) {
            const ws = new WebSocket(env.PI_RELEASE_TEST_URL.replace('http:', 'ws:') + '/api/pi/ws', { origin: env.PI_RELEASE_TEST_URL });
            await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
            let sequence = 0;
            const call = (type, body) => new Promise((resolve, reject) => {
                const id = String(++sequence);
                const timer = setTimeout(() => { ws.terminate(); reject(Error('legacy quit timeout')); }, 15000);
                function listen(raw) { const event = JSON.parse(raw); if (event.type === 'response' && event.id === id) { ws.off('message', listen); clearTimeout(timer); event.success ? resolve() : reject(Error(event.error)); } }
                ws.on('message', listen); ws.send(JSON.stringify({ id, type, ...body }));
            });
            try { await call('open_session', { cwd: runtime.cwd, sessionId: runtime.sessionId }); await call('quit_session', {}); }
            finally { ws.terminate(); }
        }
        assert.equal((await (await fetch(env.PI_RELEASE_TEST_URL + '/api/pi/activity')).json()).runtimes.length, 0);
    }
    const child = server;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('graceful test shutdown timeout')), 20000);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (legacy) result.previousPackageShutdown = { code, signal, workersEndedBeforeSignal: true, graceful: code === 0 && signal === null };
            const knownLegacy = legacy && ((process.platform === 'win32' && code === 1 && signal === null) || (code === null && signal === 'SIGINT'));
            if ((code === 0 && signal === null) || knownLegacy) resolve();
            else reject(Error(`test server exit ${code}/${signal}`));
        });
        child.send({ type: 'pivane-release-stop', runId });
    });
    server = null;
}
function initializeData() {
    for (const directory of [env.PI_CODING_AGENT_DIR, env.PI_MEDIA_DATA_DIR, env.PI_RELEASE_PROJECT_DIR]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(env.PI_RELEASE_PROJECT_DIR, 'release-marker.txt'), 'pi-release-rehearsal-v1\n');
}
function hashes() {
    const values = {};
    function visit(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) visit(file); else if (entry.isFile()) values[path.relative(root, file).replace(/\\/g, '/')] = digest(fs.readFileSync(file)); else throw Error('unexpected backup object'); } }
    visit(path.join(root, 'data')); visit(path.join(root, 'projects')); return values;
}
async function browser(phase, label) { env.PI_RELEASE_PHASE = phase; await run(path.join(app, 'test/browser/release-install.cjs'), [], label); }
async function state(mode, label) { await run(path.join(app, 'test/release/state.cjs'), [mode], label); }
async function cleanup() {
    for (const child of [...children]) {
        if (child === server && child.connected) { try { child.send({ type: 'pivane-release-stop', runId }); } catch {} }
        else child.kill('SIGTERM');
    }
    const deadline = Date.now() + 20000;
    while (children.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    for (const child of children) {
        if (child.exitCode !== null) continue;
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
    }
    for (const fd of handles) fs.closeSync(fd);
}
(async () => {
    try {
        manifest = extract(args['--archive'], args['--sha256'], app);
        result.appVersion = JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).version;
        assert.equal(result.appVersion, manifest.appVersion);
        result.manifestFilesVerified = manifest.files.length;
        initializeData();
        await run(npm, ['ci', '--no-audit', '--no-fund'], 'npm-ci');
        await run(npm, ['test'], 'node-tests');
        await run(npm, ['run', 'check'], 'syntax');
        await run(npm, ['run', 'check:docs'], 'documentation');
        await run(npm, ['audit', '--omit=dev', '--json'], 'audit');
        await run(npm, ['run', 'pack:release'], 'platform-packaging');
        port = await new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(error => error ? reject(error) : resolve(value)); }); });
        assert.notEqual(port, 3001);
        Object.assign(env, { PI_RELEASE_TEST_URL: `http://127.0.0.1:${port}`, PI_WORKSPACE_BASE_URL: `http://127.0.0.1:${port}`, PI_FILE_TEST_URL: `http://127.0.0.1:${port}`, PI_READING_TEST_URL: `http://127.0.0.1:${port}`, PI_NOTIFICATION_TEST_URL: `http://127.0.0.1:${port}` });
        provider = launch(path.join(app, 'test/release/provider.cjs'), 'synthetic-provider');
        await waitReady(provider, 'http://127.0.0.1:8089/health', data => data.runId === runId);
        await startServer(app, 'server-clean');
        await browser('install', 'browser-clean-install');
        await run(path.join(app, 'test/release/runtime.cjs'), [], 'runtime-clean');
        await stopServer();
        if (args['--previous-archive']) {
            extract(args['--previous-archive'], args['--previous-sha256'], previous);
            await run(npm, ['ci', '--no-audit', '--no-fund'], 'npm-ci-previous', previous);
            for (const name of ['data', 'projects']) fs.renameSync(path.join(root, name), path.join(root, 'clean-install-' + name));
            initializeData();
            await startServer(previous, 'server-previous');
            await browser('install', 'browser-previous-install');
        } else await startServer(app, 'server-seed');
        await state('seed', 'state-seed');
        await stopServer();
        await run(path.join(app, 'test/release/data.cjs'), [], 'synthetic-media');
        const before = hashes();
        for (const name of ['data', 'projects']) fs.cpSync(path.join(root, name), path.join(root, 'backup', name), { recursive: true });
        assert.deepEqual(hashes(), before);
        await startServer(app, 'server-update');
        await browser('verify', 'browser-update');
        await state('verify', 'state-update');
        await stopServer();
        for (const name of ['data', 'projects']) { fs.renameSync(path.join(root, name), path.join(root, 'after-update-' + name)); fs.cpSync(path.join(root, 'backup', name), path.join(root, name), { recursive: true }); }
        assert.deepEqual(hashes(), before, 'same-path restore must match before opening Pi');
        result.restoredFiles = Object.keys(before).length;
        result.restoreHashes = before;
        await startServer(app, 'server-restored');
        await browser('verify', 'browser-restored');
        await state('verify', 'state-restored');
        const search = await (await fetch(env.PI_RELEASE_TEST_URL + '/api/pi/sessions/search?' + new URLSearchParams({ q: 'RELEASE_REHEARSAL_OK', cwd: env.PI_RELEASE_PROJECT_DIR }))).json();
        assert.ok(search.results?.length > 0, 'restored cross-session search');
        await run(path.join(app, 'test/browser/pi-file-viewer.cjs'), [], 'browser-file-viewer');
        await stopServer();
        result.syntheticProviderRequests = (await (await fetch('http://127.0.0.1:8089/health')).json()).requests;
        for (const file of manifest.files) assert.equal(digest(fs.readFileSync(path.join(app, file.path))), file.sha256, 'candidate source changed during acceptance: ' + file.path);
        result.manifestUnchangedAfterTests = true;
        result.status = 'passed';
    } catch (error) { result.status = 'failed'; result.error = error.stack; process.exitCode = 1; }
    finally {
        await cleanup();
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
        // Retain failed isolated fixtures for diagnosis; successful identities are removed.
        if (result.status === 'passed') fs.rmSync(root, { recursive: true, force: true });
        else fs.writeFileSync(path.join(output, 'isolated-root.txt'), root);
        console.log(JSON.stringify({ status: result.status, output, artifactSha256: result.artifactSha256, checks: result.checks, error: result.error?.split('\n')[0] }, null, 2));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
