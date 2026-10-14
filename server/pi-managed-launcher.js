const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { privateDir, atomicJson, readSafe, backupRoots, recordInstallation, inside } = require('./pi-maintenance-files');
const { stagePi, exactVersion } = require('./pi-update-installer');
const { stageApplication, validRelease } = require('./pi-application-installer');
const { outputRedactor, appendOutput } = require('./pi-update-output');
const retention = require('./pi-managed-retention');

class ManagedLauncher {
    constructor({ root, env = process.env, networkEnvironment = env, stage = stagePi, stageApp = stageApplication, backup = backupRoots, forkServer = fork } = {}) {
        this.root = fs.realpathSync.native(root);
        this.directory = privateDir(path.join(this.root, '.pivane-runtime'));
        this.stateFile = path.join(this.directory, 'state.json');
        this.env = { ...env };
        this.networkEnvironment = { ...networkEnvironment };
        this.redact = outputRedactor(this.networkEnvironment);
        this.stage = stage; this.stageApp = stageApp; this.backup = backup; this.forkServer = forkServer;
        this.retention = retention.retentionLimits(this.env); this.cleaning = null; this.lastRetention = null;
        this.child = null; this.operation = null; this.closed = false;
        this.stoppingChildren = new WeakMap();
        this.nonce = randomUUID();
        this.state = { version: 1, active: null, previous: null, job: null };
    }
    loadState() {
        this.state = fs.existsSync(this.stateFile) ? JSON.parse(readSafe(this.stateFile)) : this.state;
        if (this.state.version !== 1 || this.state.needsRecovery) throw new Error('Invalid maintenance state or incomplete data restoration');
        this.releasePath(this.state.active); this.releasePath(this.state.previous);
        if (this.state.job && !['succeeded', 'failed', 'interrupted'].includes(this.state.job.phase)) {
            this.state.job.phase = 'interrupted'; this.state.job.error = 'interrupted'; this.save();
        }
    }
    releasePath(id) {
        if (id === null || id === undefined) return this.root;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid release identity');
        const dir = path.join(this.directory, 'releases', id);
        if (fs.realpathSync.native(dir) !== dir || !inside(this.directory, dir)) throw new Error('Invalid release directory');
        const marker = JSON.parse(readSafe(path.join(dir, 'PI_INSTALL_COMPLETE.json')));
        if (!exactVersion(marker.version) || marker.lockSha256 !== require('./pi-maintenance-files').hash(readSafe(path.join(dir, 'package-lock.json'), 16 * 1024 * 1024))) throw new Error('Managed installation is incomplete or changed');
        return dir;
    }
    log(job, stream, text) {
        appendOutput(job, stream, this.redact(text));
        if (!this.logTimer) this.logTimer = setTimeout(() => {
            this.logTimer = null;
            this.send({ type: 'maintenance-status', status: this.status() });
        }, 200);
    }
    save() { atomicJson(this.stateFile, this.state); this.send({ type: 'maintenance-status', status: this.status() }); }
    status() {
        return { supported: true, updateSupported: ['22', '24'].includes(process.versions.node.split('.')[0]) && !this.env.PI_WEB_CLI && !this.env.PI_PACKAGE_DIR,
            appUpdateSupported: ['22', '24'].includes(process.versions.node.split('.')[0]) && !this.env.PI_WEB_CLI && !this.env.PI_PACKAGE_DIR,
            activeRelease: this.state.active, previousRelease: this.state.previous, busy: Boolean(this.operation || this.cleaning || this.starting), job: this.state.job,
            storage: this.directory, backupScope: 'agent-sessions-media-config-history', nodeVersion: process.versions.node,
            retention: { releases: this.retention.releases, backups: this.retention.backups, last: this.lastRetention } };
    }
    // Cleanup owns admission until actual completion. Failure is reported in its
    // own status; it does not roll back a service that has already started.
    cleanup(job = null) {
        if (this.cleaning) return this.cleaning;
        if (this.closed) return Promise.resolve();
        const controller = new AbortController(); this.cleanupController = controller;
        this.lastRetention = { at: new Date().toISOString(), phase: 'running' };
        this.cleaning = Promise.resolve().then(async () => {
            if (controller.signal.aborted) throw new Error('Retention cancelled');
            if (this.retention.releases === null && this.retention.backups === null) { this.lastRetention = { at: new Date().toISOString(), phase: 'disabled' }; return; }
            const expected = { active: this.state.active, previous: this.state.previous };
            const plan = retention.planRetention(this.directory, this.state, this.retention, { completedJobId: job?.phase === 'retaining' ? job.id : undefined });
            if (plan.skipped) {
                this.lastRetention = { at: new Date().toISOString(), phase: 'skipped', reason: plan.skipped }; return;
            }
            const moved = retention.moveToTrash(this.directory, plan, expected);
            const purged = await retention.purgeTrash(this.directory, this.retention, { signal: controller.signal, completedJobId: job?.phase === 'retaining' ? job.id : undefined });
            this.lastRetention = { at: new Date().toISOString(), phase: 'succeeded', quarantinedReleases: moved.releases.length, quarantinedBackups: moved.backups.length, purged,
                keptReleases: plan.keepReleases.length, keptBackups: plan.keepBackups.length, incomplete: plan.incompleteReleases.length + plan.incompleteBackups.length };
            if (job) this.log(job, 'system', `Retention: kept ${plan.keepReleases.length} releases and ${plan.keepBackups.length} backups; quarantined ${moved.releases.length} releases and ${moved.backups.length} backups; purged ${purged} items.`);
        }).catch(() => {
            this.lastRetention = { at: new Date().toISOString(), phase: controller.signal.aborted ? 'cancelled' : 'failed', error: 'cleanup-incomplete' };
            if (job) this.log(job, 'system', 'Retention did not complete; preserved remaining items.');
            else console.error('Pivane retention did not complete; preserved remaining items.');
        }).finally(() => {
            this.cleaning = null; this.cleanupController = null;
            this.send({ type: 'maintenance-status', status: this.status() });
        });
        return this.cleaning;
    }
    send(message) { if (this.child?.connected) this.child.send({ ...message, nonce: this.nonce }, () => {}); }
    start() {
        if (this.starting) return this.starting;
        if (this.closed) return Promise.reject(new Error('Launcher is stopping'));
        this.starting = Promise.resolve().then(async () => {
            // The kernel owns this process lock; no stale PID deletion.
            const port = 40000 + createHash('sha256').update(this.root).digest().readUInt32BE(0) % 20000;
            this.guard = net.createServer(socket => socket.destroy());
            await new Promise((resolve, reject) => { this.guard.once('error', reject); this.guard.listen(port, '127.0.0.1', resolve); });
            if (this.closed) throw new Error('Launcher is stopping');
            this.loadState();
            await this.cleanup();
            if (this.closed) throw new Error('Launcher is stopping');
            await this.boot(this.state.active);
            if (this.closed) throw new Error('Launcher is stopping');
            this.send({ type: 'maintenance-activate' });
        }).finally(() => { this.starting = null; this.send({ type: 'maintenance-status', status: this.status() }); });
        return this.starting;
    }
    boot(release) {
        if (this.closed) throw new Error('Launcher is stopping');
        const root = this.releasePath(release);
        return new Promise((resolve, reject) => {
            const child = this.forkServer(path.join(root, 'server.js'), [], {
                cwd: this.root, execPath: process.execPath, execArgv: [],
                env: { ...this.env, PI_MANAGED_LAUNCHER: this.nonce, PI_MANAGED_BASE: this.root,
                    PI_CODING_AGENT_DIR: this.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'),
                    PI_MEDIA_DATA_DIR: this.env.PI_MEDIA_DATA_DIR || this.root },
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true
            });
            this.child = child; let ready = false;
            const timer = setTimeout(() => {
                if (!ready) { void this.stopChild().catch(() => {}); reject(new Error('Service startup timed out')); }
            }, 45000);
            child.on('message', message => {
                if (message?.nonce !== this.nonce || this.child !== child) return;
                if (message.type === 'maintenance-ready' && !ready) {
                    ready = true; clearTimeout(timer); this.backupInputs = message.backupInputs;
                    if (Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) this.env.PORT = String(message.port);
                    this.send({ type: 'maintenance-status', status: this.status() });
                    resolve();
                } else if (message.type === 'maintenance-request' && ready) {
                    void this.execute(message).catch(() => {});
                }
            });
            child.once('error', () => { clearTimeout(timer); reject(new Error('Service could not start')); });
            child.once('exit', code => {
                clearTimeout(timer);
                if (this.child === child) this.child = null;
                if (!ready) reject(new Error('Service exited before becoming ready'));
                else if (!this.closed && !this.operation) { console.error('Pivane child exited; launcher will not replay tasks'); void this.close().finally(() => process.exit(code || 1)); }
            });
        });
    }
    stopChild() {
        const child = this.child;
        if (!child) return Promise.resolve();
        const pending = this.stoppingChildren.get(child);
        if (pending) return pending;
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        let failure;
        const onError = () => { failure = new Error('Service shutdown did not complete cleanly'); };
        const exited = new Promise((resolve, reject) => child.once('exit', code => {
            child.removeListener('error', onError);
            if (!failure && code === 0) resolve();
            else reject(Object.assign(failure || new Error('Service shutdown did not complete cleanly'), { exitCode: code }));
        }));
        child.once('error', onError);
        this.stoppingChildren.set(child, exited);
        // Observe now, including when another operation is still awaiting work.
        // The original promise still rejects for every actual waiter.
        void exited.catch(() => {});
        try { this.send({ type: 'maintenance-shutdown' }); } catch { onError(); }
        // No timeout is cancellation; all callers share the actual exit wait.
        return exited;
    }
    execute(message) {
        if (this.operation || this.cleaning || this.starting || this.closed) { this.send({ type: 'maintenance-rejected', id: message.id }); return Promise.resolve(); }
        if (!['update', 'application', 'backup', 'restart'].includes(message.action) || message.action === 'application' && (!validRelease(message.release) || !this.status().appUpdateSupported) || !/^[a-f0-9-]{36}$/.test(message.id || '') || message.action === 'update' && (!exactVersion(message.version) || !this.status().updateSupported)) {
            this.send({ type: 'maintenance-rejected', id: message.id }); return Promise.resolve();
        }
        const controller = new AbortController(); this.controller = controller;
        const previous = this.state.active;
        const job = { id: message.id, action: message.action, targetVersion: message.version || null, phase: 'preparing', startedAt: new Date().toISOString(), backup: null,
            output: '', outputTruncated: false, exitCode: null, fromVersion: null, installedVersion: null };
        this.state.job = job;
        // Reserve before awaiting installation, shutdown or backup work.
        this.operation = Promise.resolve().then(async () => {
            job.fromVersion = message.action === 'application' ? JSON.parse(readSafe(path.join(this.releasePath(previous), 'package.json'))).version : JSON.parse(readSafe(require('node:fs').realpathSync.native(path.join(this.releasePath(previous), 'node_modules/@earendil-works/pi-coding-agent/package.json')))).version;
            this.log(job, 'system', message.action === 'update' ? `Updating Pivane's Pi: ${job.fromVersion} -> ${message.version}` : `Pivane operation: ${message.action}`);
            this.save(); this.send({ type: 'maintenance-accepted', id: message.id });
            let next = previous;
            if (message.action === 'update' || message.action === 'application') {
                job.phase = 'installing'; this.save();
                const releases = privateDir(path.join(this.directory, 'releases'));
                const destination = path.join(releases, message.id);
                if (fs.existsSync(destination)) throw new Error('Release directory already exists');
                await (message.action === 'application' ? this.stageApp : this.stage)({ root: this.releasePath(previous), directory: destination, version: message.version, release: message.release, env: this.networkEnvironment, signal: controller.signal,
                    progress: phase => { job.phase = phase; this.save(); },
                    onOutput: (stream, text) => this.log(job, stream, text) });
                next = message.id;
            }
            if (this.closed) throw new Error('Launcher is stopping');
            job.phase = 'stopping'; this.log(job, 'system', 'Waiting for the current service and Pi workers to stop.'); this.save();
            await this.stopChild();
            if (this.closed) throw new Error('Launcher is stopping');
            if (message.action !== 'restart') {
                job.phase = 'backing-up'; this.save();
                if (!Array.isArray(this.backupInputs) || !this.backupInputs.length || this.backupInputs.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Backup scope is unavailable');
                const backupDir = path.join(privateDir(path.join(this.directory, 'backups')), message.id);
                const copied = this.backup(this.backupInputs, backupDir);
                recordInstallation(backupDir, { release: previous, package: JSON.parse(readSafe(path.join(this.releasePath(previous), 'package.json'))),
                    lock: JSON.parse(readSafe(path.join(this.releasePath(previous), 'package-lock.json'), 16 * 1024 * 1024)) });
                job.backup = copied;
                this.log(job, 'system', `Backup complete: ${copied.files} files, ${copied.bytes} bytes.`);
                this.save();
            }
            job.phase = 'starting'; this.save();
            await this.boot(next);
            this.state.previous = next === previous ? this.state.previous : previous;
            this.state.active = next;
            // Retaining is a nonterminal phase: admission remains owned until
            // cleanup finishes and the ready child still exists.
            job.phase = 'retaining'; this.save();
            await this.cleanup(job);
            if (!this.child || this.closed) throw Object.assign(new Error('Service stopped before maintenance completed'), { maintenancePhase: 'starting' });
            job.phase = 'succeeded'; job.finishedAt = new Date().toISOString(); job.exitCode = 0;
            job.installedVersion = message.action === 'application' ? message.release.version : message.action === 'update' ? message.version : job.fromVersion;
            this.log(job, 'system', `Completed. Running ${message.action === 'application' ? 'Pivane' : 'Pi'} ${job.installedVersion}.`); this.save();
        }).catch(async error => {
            const failedPhase = error?.maintenancePhase || job.phase;
            job.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : null;
            this.log(job, 'stderr', `Failed during ${failedPhase}: ${error?.message || 'Unknown error'}`);
            job.phase = 'failed'; job.error = failedPhase; job.finishedAt = new Date().toISOString();
            this.state.active = previous;
            this.save();
            if (!this.closed) {
                if (failedPhase === 'starting') {
                    // Candidate startup is gated before any browser work. Wait for its exit before fallback.
                    try { await this.stopChild(); } catch { /* The process has exited; record failure, do not reuse it. */ }
                }
                if (!this.child) {
                    try { await this.boot(previous); } catch { console.error('Pivane recovery startup failed; use the retained installation and backup'); }
                }
            }
        }).finally(() => {
            clearTimeout(this.logTimer); this.logTimer = null;
            this.operation = null; this.controller = null; this.save();
            if (!this.closed) this.send({ type: 'maintenance-release', id: job.id });
        });
        return this.operation;
    }
    close() {
        if (this.closing) return this.closing;
        this.closed = true; this.controller?.abort(); this.cleanupController?.abort();
        // Observe all work immediately, before waiting for any single promise.
        const work = Promise.allSettled([this.starting, this.operation, this.cleaning]);
        const stopping = this.child ? this.stopChild() : null;
        const stopped = Promise.resolve(stopping).then(() => null, error => error);
        this.closing = Promise.resolve().then(async () => {
            let failure;
            try {
                const results = await work;
                failure = await stopped;
                if (!stopping) {
                    try { await this.stopChild(); } catch (error) { failure ||= error; }
                }
                failure ||= results.find(result => result.status === 'rejected')?.reason;
            } finally { if (this.guard?.listening) await new Promise(resolve => this.guard.close(resolve)); }
            if (failure) throw failure;
        });
        return this.closing;
    }

}
module.exports = { ManagedLauncher };
