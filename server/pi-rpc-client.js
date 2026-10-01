const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

const DEFAULT_REQUEST_TIMEOUT = 30000;
// Cold starts load Pi, its providers and every enabled extension. Windows file
// scanning can make that take a minute or more, so the readiness window is
// generous and configurable. The browser waits 180 s for an opened thread; the
// upper bound leaves room for the first snapshot after startup.
const DEFAULT_STARTUP_TIMEOUT = 120000;
const STARTUP_TIMEOUT_RANGE = Object.freeze({ min: 20000, max: 170000 });
const STARTUP_TIMEOUT_MESSAGE = 'Pi 运行实例启动超时，请重试连接；如经常出现，可调大 PIVANE_WEB_STARTUP_TIMEOUT_MS';
function startupTimeoutMs(value = process.env.PI_WEB_STARTUP_TIMEOUT_MS) {
    if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_STARTUP_TIMEOUT;
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_STARTUP_TIMEOUT;
    return Math.min(STARTUP_TIMEOUT_RANGE.max, Math.max(STARTUP_TIMEOUT_RANGE.min, Math.round(number)));
}
const rpcProcesses = new Set();
const stoppingProcesses = new WeakMap();
let rpcShuttingDown = false;
function stopRpcProcess(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
    if (stoppingProcesses.has(child)) return stoppingProcesses.get(child);
    const stopping = new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
    });
    stoppingProcesses.set(child, stopping);
    return stopping;
}
async function shutdownRpcProcesses() {
    rpcShuttingDown = true;
    await Promise.all([...rpcProcesses].map(stopRpcProcess));
}

function resolvePiCli() {
    const configured = process.env.PI_WEB_CLI;
    if (configured) return configured;

    const localCli = path.join(
        __dirname,
        '..',
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'cli.js'
    );
    if (!fs.existsSync(localCli)) {
        throw new Error(`Pi CLI not found at ${localCli}`);
    }
    return localCli;
}

class PiRpcClient extends EventEmitter {
    constructor({ cwd, sessionPath, noSession = false, extraArgs = [], env = {}, projectApproval, sideSeed, startupTimeoutMs: startupLimit }) {
        super();
        this.startupTimeoutMs = Number.isFinite(startupLimit) && startupLimit > 0 ? startupLimit : startupTimeoutMs();
        this.cwd = cwd;
        this.sessionPath = sessionPath;
        this.noSession = noSession;
        this.projectApproval = projectApproval;
        this.sideSeed = sideSeed;
        this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
        this.env = env && typeof env === 'object' ? env : {};
        this.child = null;
        this.pending = new Map();
        this.startupProbes = new Set();
        this.healthProbes = new Set();
        this.responseCount = 0;
        this.nextRequestId = 1;
        this.stdoutBuffer = '';
        this.stderrTail = '';
        this.disposed = false;
    }

    async start() {
        if (rpcShuttingDown || this.disposed) throw new Error('Pi transport is disposed or shutting down');
        if (this.child) return;

        const managed = this.extraArgs.includes(path.join(__dirname, 'pi-web-session-extension.ts')) && !process.env.PI_WEB_CLI;
        const args = [this.sideSeed ? path.join(__dirname, 'pi-side-runtime.mjs') : managed ? path.join(__dirname, 'pi-managed-runtime.mjs') : resolvePiCli(), '--mode', 'rpc'];
        if (this.noSession) args.push('--no-session');
        else args.push('--session', this.sessionPath);
        args.push(...this.extraArgs);
        const approval = this.projectApproval ?? (process.env.PI_WEB_APPROVE_PROJECTS === 'true' ? true : process.env.PI_WEB_APPROVE_PROJECTS === 'false' ? false : undefined);
        if (approval === true) args.push('--approve');
        if (approval === false) args.push('--no-approve');

        this.child = spawn(process.execPath, args, {
            cwd: this.cwd,
            env: {
                ...process.env,
                PI_SKIP_VERSION_CHECK: '1',
                PI_WORKSPACE_BASE_URL: process.env.PI_WORKSPACE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 11408}`,
                ...this.env
            },
            stdio: this.sideSeed ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
        });
        const processChild = this.child;
        this.processChild = processChild; rpcProcesses.add(processChild);
        const forgetProcess = () => { rpcProcesses.delete(processChild); if (this.processChild === processChild) this.processChild = null; };
        processChild.once('exit', forgetProcess);
        processChild.once('error', () => { if (!processChild.pid) forgetProcess(); });
        if (this.sideSeed) {
            this.child.stdio[3].on('error', () => this.child?.kill('SIGTERM'));
            this.child.stdio[3].end(JSON.stringify(this.sideSeed));
            this.sideSeed = null;
        }

        this._attachJsonlReader(this.child.stdout);
        this.child.stderr.on('data', chunk => {
            this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-16000);
        });
        this.child.on('error', error => this._handleExit(error));
        this.child.on('exit', (code, signal) => {
            const detail = this.stderrTail.trim();
            const suffix = detail ? `: ${detail}` : '';
            this._handleExit(new Error(`Pi RPC exited (${signal || code})${suffix}`));
        });

        const startupUi = new Promise((_, reject) => {
            this.startupListener = event => {
                if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
                    const error = new Error('扩展在启动阶段请求交互，当前 Pi RPC 无法处理。请在设置中停用该扩展，或使用支持 Web 的扩展版本后重新打开线程。');
                    error.code = 'STARTUP_UI_UNSUPPORTED'; reject(error);
                }
            };
            this.on('event', this.startupListener);
        });
        let probing = true;
        const readiness = async () => {
            const deadline = Date.now() + this.startupTimeoutMs;
            while (probing) {
                try {
                    return await this.request('get_state', {}, Math.min(1000, Math.max(1, deadline - Date.now())), id => this.startupProbes.add(id));
                } catch (error) {
                    // Some SDK bootstraps start consuming stdin before attaching RPC.
                    // Probe readiness using bounded, read-only requests on this same process.
                    // A process exit rejects at once; only a live, loading process is awaited.
                    if (!probing || error.code !== 'RPC_TIMEOUT') throw error;
                    if (Date.now() >= deadline) throw Object.assign(new Error(STARTUP_TIMEOUT_MESSAGE), { startupTimeoutMs: this.startupTimeoutMs });
                }
            }
        };
        const startedAt = Date.now();
        try { await Promise.race([readiness(), startupUi]); this.startupMs = Date.now() - startedAt; }
        catch (error) { if (error.code !== 'STARTUP_UI_UNSUPPORTED') error.code = 'RPC_STARTUP_FAILED'; throw error; }
        finally { probing = false; this.off('event', this.startupListener); this.startupListener = null; }
    }

    _attachJsonlReader(stream) {
        const decoder = new StringDecoder('utf8');

        stream.on('data', chunk => {
            this.stdoutBuffer += decoder.write(chunk);
            this._drainStdoutBuffer(false);
        });
        stream.on('end', () => {
            this.stdoutBuffer += decoder.end();
            this._drainStdoutBuffer(true);
        });
    }

    _drainStdoutBuffer(flush) {
        // Search only newly decoded chunks. Re-scanning/flattening the whole
        // incomplete get_messages frame on every pipe chunk is quadratic for images.
        this.stdoutChunks ||= [];
        this.stdoutQueue ||= [];
        if (this.stdoutBuffer) this.stdoutQueue.push(this.stdoutBuffer);
        this.stdoutBuffer = '';
        if (flush) this.stdoutFlush = true;
        // Event listeners can synchronously feed another chunk; retain wire order.
        if (this.stdoutDraining) return;
        this.stdoutDraining = true;
        try {
            while (this.stdoutQueue.length) {
                const chunk = this.stdoutQueue.shift();
                let start = 0, newline;
                while ((newline = chunk.indexOf('\n', start)) !== -1) {
                    this.stdoutChunks.push(chunk.slice(start, newline));
                    let line = this.stdoutChunks.join('');
                    this.stdoutChunks = [];
                    if (line.endsWith('\r')) line = line.slice(0, -1);
                    this._handleLine(line);
                    start = newline + 1;
                }
                if (start < chunk.length) this.stdoutChunks.push(chunk.slice(start));
            }
            if (this.stdoutFlush) {
                this.stdoutFlush = false;
                let line = this.stdoutChunks.join('');
                this.stdoutChunks = [];
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line) this._handleLine(line);
            }
        } finally { this.stdoutDraining = false; }
    }

    _handleLine(line) {
        if (!line.trim()) return;

        let record;
        try {
            record = JSON.parse(line);
        } catch (error) {
            this.emit('protocol_error', new Error(`Invalid Pi RPC JSON: ${error.message}`));
            return;
        }

        if (record.type === 'response') this.responseCount++;
        for (const probes of [this.startupProbes, this.healthProbes]) {
            if (record.type !== 'response' || !probes.has(record.id)) continue;
            probes.delete(record.id);
            if (!this.pending.has(record.id)) return; // Late probes are private readiness traffic.
        }
        if (record.type === 'response' && record.id && this.pending.has(record.id)) {
            const pending = this.pending.get(record.id);
            this.pending.delete(record.id);
            clearTimeout(pending.timer);
            if (record.success) {
                try { pending.resolve(pending.mapResponse ? pending.mapResponse(record.data) : record.data); }
                catch (error) { pending.reject(error); }
            }
            else {
                const error = new Error(record.error || `${record.command || 'RPC command'} failed`);
                error.code = 'RPC_REJECTED';
                pending.reject(error);
            }
            return;
        }

        this.emit('event', record);
    }

    send(record) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
            throw new Error('Pi RPC is not running');
        }
        this.child.stdin.write(`${JSON.stringify(record)}\n`);
    }

    request(type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT, onId, mapResponse) {
        if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
            return Promise.reject(new Error('Pi RPC is not running'));
        }

        const id = `web-${process.pid}-${this.nextRequestId++}`;
        return new Promise((resolve, reject) => {
            const timer = timeoutMs === null ? null : setTimeout(() => {
                this.pending.delete(id);
                const error = new Error(`Pi RPC command timed out: ${type}`);
                error.code = 'RPC_TIMEOUT';
                reject(error);
            }, timeoutMs);
            timer?.unref?.();
            this.pending.set(id, { resolve, reject, timer, mapResponse });
            onId?.(id);

            this.child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, error => {
                if (!error) return;
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.reject(error);
            });
        });
    }

    // Bounded liveness check of an established process. A reply that arrives
    // after the timer, or any other reply in the same window, proves that the
    // command loop still runs; only a silent process is reported unresponsive.
    async probe(timeoutMs) {
        if (!this.child) return false;
        const before = this.responseCount;
        try {
            await this.request('get_state', {}, timeoutMs, id => this.healthProbes.add(id));
            return true;
        } catch (error) {
            if (error.code === 'RPC_REJECTED') return true;
            if (error.code !== 'RPC_TIMEOUT') return false;
            // Let replies already waiting in the pipe be read before deciding.
            await new Promise(resolve => setImmediate(resolve));
            return this.responseCount !== before;
        }
    }

    _handleExit(error) {
        if (!this.child && this.disposed) return;
        this.child = null;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.startupProbes.clear();
        this.healthProbes.clear();
        if (!this.disposed) this.emit('exit', error);
    }

    dispose() {
        if (this.disposal) return this.disposal;
        this.disposed = true;
        const child = this.processChild || this.child;
        this.child = null;
        this.disposal = stopRpcProcess(child);
        return this.disposal;
    }
}

module.exports = { PiRpcClient, resolvePiCli, shutdownRpcProcesses, startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT, STARTUP_TIMEOUT_RANGE, STARTUP_TIMEOUT_MESSAGE };
