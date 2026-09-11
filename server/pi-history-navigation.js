const { randomUUID } = require('node:crypto');
const { validateNavigation } = require('./pi-session-tree');
// A single navigation belongs to the existing worker. Only status metadata is retained here.
class PiHistoryNavigation {
    constructor(worker) { this.worker = worker; this.runtimeId = randomUUID(); this.revision = 0; this.job = null; this.busy = false; }
    snapshot() { return { runtimeId: this.runtimeId, revision: this.revision, busy: this.busy, job: this.job && { ...this.job } }; }
    publish(status) {
        if (status) this.job.status = status;
        this.revision++;
        this.worker._broadcast({ type: 'gateway_navigation', navigation: this.snapshot() });
    }
    async run(raw, pauseDeferred) {
        const input = validateNavigation(raw), w = this.worker;
        if (w.noSession) throw new Error('临时会话不提供持久分支导航');
        if (this.busy) throw new Error('导航尚未完成，请等待结果');
        this.busy = true; this.cancelRequested = false; this.submitted = false;
        this.job = { id: randomUUID(), targetId: input.entryId, status: 'preparing', summarize: input.summarize, startedAt: Date.now() };
        this.publish();
        try {
            const result = await w.exclusive(async rpc => {
                if (this.cancelRequested) return { cancelled: true };
                pauseDeferred();
                const result = await w.navigate(rpc, { mode: 'tree', input }, {
                    timeoutMs: 600000,
                    beforeSend: () => {
                        if (this.cancelRequested) return false;
                        this.submitted = true; this.publish(input.summarize ? 'summarizing' : 'navigating');
                        return true;
                    }
                });
                return result;
            });
            this.job.status = result?.cancelled ? 'cancelled' : 'done';
            return result;
        } catch (error) {
            this.job.status = error.code === 'RPC_TIMEOUT' ? 'uncertain' : 'error';
            this.job.error = String(error.message || '导航未完成').slice(0, 500);
            throw error;
        } finally {
            this.busy = false; this.job.finishedAt = Date.now(); this.publish();
            // Re-read after any attempted mutation, including an extension failure after moving the leaf.
            w._broadcast({ type: 'gateway_context_changed' });
        }
    }
    async cancel(id) {
        if (!this.busy || id !== this.job?.id) throw new Error('该导航已结束，请刷新当前位置');
        if (this.cancelRequested) return this.snapshot();
        this.cancelRequested = true; this.publish('stopping');
        if (this.submitted) await this.worker.client.request('abort', {}, 120000);
        // ACK alone never releases the exclusive operation; the original navigation response does.
        return this.snapshot();
    }
    handle(event) {
        if (!this.busy || !this.job.summarize) return;
        if (event.type === 'summarization_retry_scheduled') { this.job.attempt = event.attempt; this.publish('retrying'); }
        if (event.type === 'summarization_retry_attempt_start' && event.source === 'branchSummary') this.publish(this.cancelRequested ? 'stopping' : 'summarizing');
    }
}
module.exports = { PiHistoryNavigation };
