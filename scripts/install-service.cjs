const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { loadLocalEnv } = require('../server/pi-local-env');
const { privateDir } = require('../server/pi-maintenance-files');
const xml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
const ps = value => "'" + String(value).replace(/'/g, "''") + "'";
const unit = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
function plan({ root, home, node, platform, executablePath, url, desktop, user }) {
    for (const value of [root, home, node, executablePath, url, desktop || '', user || '']) if (/[\r\n\x00]/.test(value)) throw Error('Unsupported control character in installation path');
    const id = 'pivane-' + createHash('sha256').update(root).digest('hex').slice(0, 12);
    const directory = path.join(root, '.pivane-runtime', 'service');
    const runner = path.join(directory, 'run.cjs');
    const log = path.join(directory, 'service.log');
    const runnerText = `// Generated for this installation. No provider credentials are embedded.\nprocess.env.PATH = ${JSON.stringify(executablePath)};\nprocess.chdir(${JSON.stringify(root)});\nconst fs = require('node:fs');\nconst stopFile = ${JSON.stringify(path.join(directory, 'stop-request'))};\nif (fs.existsSync(stopFile)) { console.error('A stop request remains; inspect and remove it before starting.'); process.exit(1); }\nconst launcher = require(${JSON.stringify(path.join(root, 'server/pi-server-entry.js'))}).startManaged(${JSON.stringify(root)});\nconst timer = setInterval(() => { if (fs.existsSync(stopFile)) { clearInterval(timer); process.emit('SIGTERM'); } }, 1000);\nprocess.on('exit', () => { if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); });\n`;
    const result = { id, directory, runner, runnerText, url, log, platform, files: [] };
    if (platform === 'linux') {
        result.service = path.join(home, '.config/systemd/user', id + '.service');
        result.files.push({ path: result.service, content: `[Unit]\nDescription=Pivane personal workspace\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nType=simple\nWorkingDirectory=${root.replace(/%/g, '%%')}\nExecStart=${unit(node)} ${unit(runner)}\nEnvironment=${unit('HOME=' + home)}\nRestart=on-failure\nRestartSec=10\nKillMode=mixed\nTimeoutStopSec=infinity\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` });
    } else if (platform === 'darwin') {
        result.label = 'app.pivane.' + id;
        result.service = path.join(home, 'Library/LaunchAgents', result.label + '.plist');
        result.files.push({ path: result.service, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(result.label)}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>0</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n` });
        if (desktop) result.files.push({ path: path.join(desktop, `Pivane-${id.slice(7)}.webloc`), content: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>${xml(url)}</string></dict></plist>\n` });
    } else if (platform === 'win32') {
        result.service = path.join(directory, 'task.xml');
        // InteractiveToken means the existing user's profile/identity, without a saved password.
        result.files.push({ path: result.service, content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="User"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>${xml(node)}</Command><Arguments>${xml('"' + runner + '"')}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions></Task>\n`, encoding: 'utf16le' });
        if (desktop) result.files.push({ path: path.join(desktop, `Pivane-${id.slice(7)}.url`), content: `[InternetShortcut]\r\nURL=${url}\r\n` });
    } else throw Error('Supported platforms: Linux, macOS and Windows');
    return result;
}
function powershell(command) {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference = "Stop"; ' + command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
}
async function install({ root = path.resolve(__dirname, '..'), noShortcut = false } = {}) {
    root = fs.realpathSync.native(root);
    if (process.platform !== 'win32' && process.getuid?.() === 0) throw Error('Run as the intended ordinary user, not root');
    if (root.includes(path.sep + '.pivane-runtime' + path.sep)) throw Error('Install from the original application directory, not a managed release');
    if (!fs.existsSync(path.join(root, '.env'))) throw Error('Create the instance .env with fixed absolute data paths before installing');
    const env = {}; loadLocalEnv(path.join(root, '.env'), env);
    const port = Number(env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('A fixed valid PORT is required');
    const url = new URL(`http://127.0.0.1:${port}`);
    const home = os.homedir();
    const desktop = noShortcut || process.platform === 'linux' ? null : process.platform === 'win32' ? powershell('[Environment]::GetFolderPath("Desktop")') : path.join(home, 'Desktop');
    const user = process.platform === 'win32' ? powershell('[Security.Principal.WindowsIdentity]::GetCurrent().Name') : os.userInfo().username;
    const value = plan({ root, home, node: process.execPath, platform: process.platform, executablePath: process.env.PATH || '', url: url.href, desktop, user });
    // Never adopt an unknown process or replace an existing service/shortcut.
    if (fs.existsSync(value.directory) || value.files.some(f => fs.existsSync(f.path))) throw Error('Service files already exist; inspect the retained installation before changing it');
    if (process.platform === 'linux') execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 10000 });
    if (process.platform === 'win32' && powershell(`if (Get-ScheduledTask -TaskName ${ps(value.id)} -ErrorAction SilentlyContinue) { 'exists' }`) === 'exists') throw Error('Scheduled task already exists');
    await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(Error('Port is occupied; stop the existing instance safely before installation'))); server.listen(port, env.HOST || '127.0.0.1', () => server.close(resolve)); });
    privateDir(value.directory);
    fs.writeFileSync(value.runner, value.runnerText, { flag: 'wx', mode: 0o600 });
    for (const file of value.files) {
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        fs.writeFileSync(file.path, file.content, { flag: 'wx', mode: 0o600, encoding: file.encoding || 'utf8' });
    }
    const receipt = path.join(value.directory, 'installation.json');
    fs.writeFileSync(receipt, JSON.stringify({ id: value.id, platform: value.platform, url: value.url, service: value.service, files: value.files.map(f => f.path), log: value.platform === 'linux' ? `journalctl --user -u ${value.id}` : value.platform === 'win32' ? 'Task Scheduler history / LastTaskResult; foreground npm start for application output' : value.log, phase: 'prepared' }, null, 2), { flag: 'wx', mode: 0o600 });
    if (process.platform === 'linux') {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
        execFileSync('systemctl', ['--user', 'enable', '--now', value.id + '.service'], { stdio: 'inherit' });
    } else if (process.platform === 'darwin') execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, value.service], { stdio: 'inherit' });
    else powershell(`Register-ScheduledTask -TaskName ${ps(value.id)} -Xml ([IO.File]::ReadAllText(${ps(value.service)})) | Out-Null; Start-ScheduledTask -TaskName ${ps(value.id)}`);
    let ready = false;
    for (let i = 0; i < 45; i++) {
        try { const response = await fetch(url.href + 'api/access/status', { signal: AbortSignal.timeout(1500), redirect: 'error' }); const data = await response.json(); if (response.ok && typeof data.authenticated === 'boolean') { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const record = JSON.parse(fs.readFileSync(receipt)); record.phase = ready ? 'http-ready' : 'readiness-unconfirmed'; fs.writeFileSync(receipt, JSON.stringify(record, null, 2));
    if (!ready) throw Error('Service registered but HTTP readiness was not confirmed. Inspect installation.json and service logs; do not install again');
    console.log(JSON.stringify(record, null, 2));
    if (process.platform === 'linux') console.log('User service starts at login. For a server that must start at boot and survive logout, an administrator should enable linger for this user (loginctl enable-linger).');
    else console.log('Starts when this user logs in. Sleeping or shutting down this computer makes it unavailable.');
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--no-shortcut')) { console.error('Usage: node scripts/install-service.cjs [--no-shortcut]'); process.exitCode = 1; }
    else install({ noShortcut: args.includes('--no-shortcut') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { plan, install };
