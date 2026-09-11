const { randomUUID } = require('node:crypto');

// Only the current execution is retained; completed history belongs to Pi.
const OUTPUT_CHARACTERS = 65536;
function tail(text) {
    const value = String(text ?? '');
    let start = Math.max(0, value.length - OUTPUT_CHARACTERS);
    if (start && /[\uDC00-\uDFFF]/.test(value[start])) start++;
    return value.slice(start);
}
class PiShellExecution {
    constructor(worker) {
        this.worker = worker;
        this.runtimeId = randomUUID();
        this.revision = 0;
        this.job = null;
        this.timer = null;
    }
    get busy() { return Boolean(this.job && ['starting', 'running', 'stopping', 'uncertain'].includes(this.job.status)); }
    snapshot() { return { runtimeId: this.runtimeId, revision: this.revision, busy: this.busy, job: this.job ? { ...this.job } : null }; }
    changed(immediate = true) {
        this.revision++;
        if (!immediate) {
            this.timer ||= setTimeout(() => { this.timer = null; this.publish(); }, 150);
            this.timer.unref?.();
        } else { clearTimeout(this.timer); this.timer = null; this.publish(); }
    }
    publish() { this.worker._broadcast({ type: 'gateway_shell', shell: this.snapshot() }); }
    async start(input) {
        if (Object.keys(input).some(key => !['command', 'excludeFromContext'].includes(key))
            || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32768 || input.command.includes('\0')
            || input.excludeFromContext !== undefined && typeof input.excludeFromContext !== 'boolean') throw new Error('Shell 命令须为非空文字，最多 32768 字符；仅支持 command / excludeFromContext');
        const w = this.worker;
        if (this.busy || w.disposed || w.operation || w.controlPending || w.promptPending || w.compactPending || w.historyPending || w.historyWriting || w.resourceResults.size || w.contextCapture || w.pendingUi.size || w.activity.snapshot().busy) {
            throw new Error('请等待当前会话空闲后执行 Shell');
        }
        // Reserve before readiness/state awaits, including concurrent browser submissions.
        this.job = { id: randomUUID(), command: input.command, excludeFromContext: Boolean(input.excludeFromContext), status: 'starting', startedAt: Date.now(), output: '', displayTruncated: false };
        const job = this.job;
        this.changed();
        try {
            await w.ensureReady();
            const state = await w.request('get_state');
            if (w.disposed || state.isStreaming || state.isCompacting || state.pendingMessageCount || w.pendingUi.size || w.activity.snapshot().busy) throw new Error('当前会话尚未空闲');
            job.status = 'running';
            this.changed();
            // No request timeout: loss of the browser is not cancellation or permission to replay.
            this.completion = w.client.request('bash', { command: input.command, excludeFromContext: job.excludeFromContext }, null, id => { this.nativeId = id; })
                .then(result => {
                    job.output = tail(result.output);
                    job.displayTruncated = String(result.output || '').length > OUTPUT_CHARACTERS;
                    job.exitCode = result.exitCode;
                    job.cancelled = Boolean(result.cancelled);
                    job.truncated = Boolean(result.truncated);
                    job.fullOutputPath = typeof result.fullOutputPath === 'string' ? result.fullOutputPath.slice(0, 4096) : null;
                    job.status = result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'failed';
                    job.recorded = true;
                }, error => {
                    job.status = error.code === 'RPC_REJECTED' ? 'failed' : 'uncertain';
                    job.error = String(error.message).slice(0, 2000);
                    job.recorded = false;
                }).finally(() => {
                    job.finishedAt = Date.now(); this.nativeId = null;
                    w.lastUsedAt = Date.now(); this.changed();
                });
            return this.snapshot();
        } catch (error) {
            job.status = 'rejected'; job.error = error.message; job.finishedAt = Date.now(); this.changed(); throw error;
        }
    }
    handle(event) {
        if (event.type !== 'bash_execution_update') return false;
        // Untracked native execution does not become another Web execution or leak raw chunks.
        if (this.nativeId && event.id === this.nativeId && this.busy && typeof event.delta === 'string') {
            const combined = this.job.output + event.delta;
            this.job.displayTruncated ||= combined.length > OUTPUT_CHARACTERS;
            this.job.output = tail(combined); this.worker.lastUsedAt = Date.now(); this.changed(false);
        }
        return true;
    }
    async abort(id) {
        if (!this.busy || this.job.id !== id || this.job.status !== 'running') throw new Error('命令已结束、正在停止或执行状态已变化，请核对后操作');
        const job = this.job;
        job.status = 'stopping'; this.changed();
        try { await this.worker.client.request('abort_bash'); }
        catch (error) { if (this.busy && this.job === job) { job.error = '停止结果不确定，请等待命令终态或退出运行实例'; this.changed(); } throw error; }
        return this.snapshot();
    }
    async dispose() {
        clearTimeout(this.timer); this.timer = null;
        if (this.busy && this.worker.client.child) {
            // Best effort native process-tree cancellation before terminating the RPC child.
            try { await this.worker.client.request('abort_bash', {}, 2000); } catch {}
            if (this.completion) await Promise.race([this.completion, new Promise(resolve => setTimeout(resolve, 2000))]);
        }
    }
}
module.exports = { PiShellExecution, OUTPUT_CHARACTERS };
