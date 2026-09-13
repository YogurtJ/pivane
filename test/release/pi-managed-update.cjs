// Explicit, isolated network trial. Never points at a user's identity or running service.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { copyCode } = require('../../server/pi-update-installer');
const { hash, readSafe } = require('../../server/pi-maintenance-files');
const assert = require('node:assert/strict');
const source = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    if (process.env.PI_RUN_MANAGED_UPDATE_TRIAL !== '1' || !['22', '24'].includes(process.versions.node.split('.')[0])) throw Error('Explicit trial opt-in and Node 22 or 24 are required');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-managed-update-trial-')));
    const app = path.join(root, 'app'), project = path.join(root, 'project'), agent = path.join(root, 'data/agent'), media = path.join(root, 'data/media');
    copyCode(source, app);
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(project); fs.mkdirSync(path.join(media, 'public/audio'), { recursive: true });
    fs.writeFileSync(path.join(agent, 'auth.json'), '{}\n');
    fs.writeFileSync(path.join(media, 'public/audio/fixture.wav'), Buffer.from('synthetic backup file'));
    const env = { PATH: process.env.PATH, HOME: os.homedir(), HOST: '127.0.0.1', PORT: '0',
        PI_CODING_AGENT_DIR: agent, PI_MEDIA_DATA_DIR: media, PI_MEDIA_CONFIG_DIR: path.join(agent, 'media-lab'), PI_PROJECT_ROOTS: project,
        PI_WEB_DEFERRED_FILE: path.join(root, 'data/deferred.json'), PI_WEB_TOKEN: 'managed-update-trial-only', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' };
    for (const key of ['SystemRoot', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [path.join(app, 'server.js')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    try {
        const startup = Date.now() + 30000;
        while (!/running at http:\/\/localhost:(\d+)/.test(output)) { if (child.exitCode !== null || Date.now() > startup) throw Error('Isolated trial service failed to start'); await delay(100); }
        const base = 'http://127.0.0.1:' + /running at http:\/\/localhost:(\d+)/.exec(output)[1];
        const api = async (route, body) => {
            const response = await fetch(base + '/api/pi/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer managed-update-trial-only', Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
            const value = await response.json(); if (!response.ok) throw Error('Trial API rejected: ' + response.status); return value;
        };
        let status;
        do { await delay(100); status = await api('settings/updates/maintenance'); } while (status.busy);
        const session = await api('sessions', { cwd: project, name: 'Managed update trial' });
        const before = fs.readFileSync(session.path), originalManifest = fs.readFileSync(path.join(app, 'package.json'));
        const ticket = await api('settings/updates/review', { action: 'update' });
        await api('settings/updates/execute', { ticket: ticket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true });
        const deadline = Date.now() + 20 * 60 * 1000; let previous;
        for (;;) {
            if (child.exitCode !== null || Date.now() > deadline) throw Error('Isolated update did not finish');
            try { status = await api('settings/updates/maintenance'); } catch { await delay(500); continue; }
            if (status.job?.id === ticket.id) {
                if (previous !== status.job.phase) { previous = status.job.phase; console.log(JSON.stringify({ phase: previous, target: ticket.version })); }
                if (!status.busy) break;
            }
            await delay(500);
        }
        assert.equal(status.job.phase, 'succeeded', JSON.stringify(status.job));
        assert.match(status.job.output, /\$ npm install/);
        assert.match(status.job.output, /Command finished: exit=0/);
        assert.equal(status.job.exitCode, 0);
        assert.equal(status.job.installedVersion, ticket.version);
        const versions = await api('settings/updates'); assert.equal(versions.piVersion, ticket.version); assert.equal(versions.managedPi, true);
        assert.deepEqual(fs.readFileSync(path.join(app, 'package.json')), originalManifest, 'original installation stays intact');
        assert.deepEqual(fs.readFileSync(session.path), before, 'native session bytes remain unchanged before reopening');
        const manifest = JSON.parse(readSafe(path.join(status.job.backup.directory, 'manifest.json')));
        for (const entry of manifest.entries.filter(e => e.type === 'file')) assert.equal(hash(fs.readFileSync(path.join(status.job.backup.directory, 'files', entry.object))), entry.sha256);
        const report = { root, sourcePi: ticket.currentVersion, installedPi: versions.piVersion, activeRelease: status.activeRelease, backup: status.job.backup,
            commandOutputReceived: true, exitCode: status.job.exitCode, normalServerEntry: true,
            nativeSessionPreserved: true, originalInstallationPreserved: true, backupHashesVerified: true };
        fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
