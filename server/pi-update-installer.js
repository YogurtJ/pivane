const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { privateDir, readSafe, copySafe, atomicJson, hash } = require('./pi-maintenance-files');
const { outputRedactor, outputLines } = require('./pi-update-output');
const PI_PACKAGES = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-server'];
const exactVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length < 40;
function installEnvironment(env, directory) {
    const result = {};
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'LANG',
        'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (env[key]) result[key] = env[key];
    for (const file of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(directory, file), '', { flag: 'wx', mode: 0o600 });
    Object.assign(result, { npm_config_userconfig: path.join(directory, 'user.npmrc'), npm_config_globalconfig: path.join(directory, 'global.npmrc'),
        npm_config_cache: path.join(directory, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' });
    return result;
}
function npmCli(env = process.env) {
    const candidates = [env.PI_NPM_CLI, env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'];
    const found = candidates.find(file => file && path.isAbsolute(file) && fs.existsSync(file) && file.endsWith('npm-cli.js'));
    if (!found) throw new Error('npm CLI unavailable');
    return fs.realpathSync.native(found);
}
function runNode(args, { cwd, env, timeout = 20 * 60 * 1000, signal, onOutput = () => {}, secretEnv = env } = {}) {
    return new Promise((resolve, reject) => {
        const redact = outputRedactor(secretEnv);
        const emit = (stream, text) => onOutput(stream, text);
        const stdout = outputLines('stdout', emit, redact), stderr = outputLines('stderr', emit, redact);
        const display = args[0]?.endsWith('npm-cli.js') ? ['npm', ...args.slice(1)] : ['node', ...args];
        emit('system', redact('$ ' + display.map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ')));
        const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child.stdout.on('data', bytes => stdout.write(bytes)); child.stderr.on('data', bytes => stderr.write(bytes));
        let timedOut = false, spawnError;
        const stop = () => { timedOut = true; emit('system', 'Termination requested; waiting for the command to exit.'); child.kill('SIGTERM'); };
        const timer = setTimeout(stop, timeout);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        child.once('error', () => { spawnError = new Error('Update command could not start'); });
        // Stream completion and actual process exit precede the terminal result.
        child.once('close', (code, terminationSignal) => {
            clearTimeout(timer); signal?.removeEventListener('abort', stop);
            stdout.end(); stderr.end();
            const exitCode = spawnError ? null : code;
            emit('system', `Command finished: exit=${exitCode ?? 'unknown'}${terminationSignal ? `, signal=${terminationSignal}` : ''}`);
            if (!spawnError && code === 0 && !timedOut) resolve({ exitCode: 0 });
            else reject(Object.assign(spawnError || new Error('Update command failed or was terminated'), { exitCode, signal: terminationSignal, timedOut }));
        });
    });
}
function copyCode(root, destination) {
    privateDir(destination);
    const files = require('../scripts/source-files.cjs').distributionFiles(root), metadata = [];
    require('../scripts/check-docs.cjs').checkDocumentation(root, files);
    const budget = { files: 0, bytes: 0, maxBytes: 1024 ** 3, maxFiles: 20000 };
    for (const relative of new Set(files)) {
        const target = path.join(destination, relative); privateDir(path.dirname(target));
        metadata.push({ path: relative, ...copySafe(path.join(root, relative), target, budget) });
    }
    for (const file of metadata) if (hash(readSafe(path.join(root, file.path), 128 * 1024 * 1024)) !== file.sha256) throw new Error('Source changed while preparing update');
    atomicJson(path.join(destination, 'PI_SOURCE_SNAPSHOT.json'), { version: 1, files: metadata });
}
async function stagePi({ root, directory, version, env = process.env, signal, run = runNode, copy = copyCode, progress = () => {}, onOutput = () => {} }) {
    if (!exactVersion(version)) throw new Error('Pi update requires an exact stable version');
    copy(root, directory);
    const manifestPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(readSafe(manifestPath));
    const baselinePi = manifest.pivaneManaged?.baselinePi || manifest.dependencies[PI_PACKAGES[0]];
    for (const name of PI_PACKAGES) manifest.dependencies[name] = version;
    const overrides = manifest.overrides?.['@earendil-works/pi-server'];
    if (!overrides || typeof overrides !== 'object') throw new Error('Unknown Pi dependency layout');
    for (const name of Object.keys(overrides)) {
        if (!name.startsWith('@earendil-works/')) throw new Error('Unknown Pi override');
        overrides[name] = version;
    }
    manifest.pivaneManaged = { baselinePi, piVersion: version, validation: 'isolated-sdk-rpc' };
    atomicJson(manifestPath, manifest);
    const installEnv = installEnvironment(env, directory);
    await run([npmCli(env), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: directory, env: installEnv, signal, onOutput, secretEnv: env });
    const lock = JSON.parse(readSafe(path.join(directory, 'package-lock.json'), 16 * 1024 * 1024));
    for (const name of PI_PACKAGES) {
        const actual = JSON.parse(readSafe(path.join(directory, 'node_modules', name, 'package.json'))).version;
        if (actual !== version || lock.packages?.['node_modules/' + name]?.version !== version || lock.packages?.['']?.dependencies?.[name] !== version) throw new Error('Installed Pi version does not match the selected version');
    }
    progress('verifying');
    // Every runtime test runs with a newly allocated identity and no provider credentials.
    const probe = privateDir(path.join(directory, 'probe-data'));
    const probeEnv = Object.fromEntries(Object.entries(installEnv).filter(([key]) => !/proxy|^npm_/i.test(key)));
    Object.assign(probeEnv, { PI_UPDATE_PROBE: probe, PI_CODING_AGENT_DIR: path.join(probe, 'agent'), PI_PROJECT_ROOTS: probe,
        PI_MEDIA_DATA_DIR: path.join(probe, 'media'), PI_MEDIA_CONFIG_DIR: path.join(probe, 'agent/media-lab'), PI_WEB_DEFERRED_FILE: path.join(probe, 'deferred.json'),
        PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_WORKSPACE_BASE_URL: 'http://127.0.0.1:1' });
    await run([path.join(directory, 'server/pi-update-probe.js')], { cwd: probe, env: probeEnv, timeout: 90000, signal, onOutput, secretEnv: env });
    atomicJson(path.join(directory, 'PI_INSTALL_COMPLETE.json'), { version, completedAt: new Date().toISOString(), lockSha256: hash(readSafe(path.join(directory, 'package-lock.json'), 16 * 1024 * 1024)) });
    return directory;
}
module.exports = { stagePi, runNode, copyCode, npmCli, installEnvironment, exactVersion, PI_PACKAGES };
