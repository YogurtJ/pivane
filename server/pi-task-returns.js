const { createHash } = require('node:crypto');

// Routing is reconstructed from native task/result/receipt entries. Nothing in
// this service is an independent durable task history or a second session writer.
class TaskReturns {
    constructor({ catalog, supervisor, isSuspended }) {
        Object.assign(this, { catalog, supervisor, isSuspended });
        this.flight = null; this.stopping = false;
        this.timer = setInterval(() => { void this.pump(); }, 3000); this.timer.unref?.();
    }
    get busy() { return Boolean(this.flight); }
    result(record, state) {
        const deliveryId = createHash('sha256').update(JSON.stringify([record.task.source.sessionId, record.session.id,
            record.task.requestId, state.resultId])).digest('hex');
        return { deliveryId, requestId: record.task.requestId, sourceSessionId: record.task.source.sessionId,
            session: { id: record.session.id, cwd: record.session.cwd, name: record.session.name }, status: ['completed', 'error', 'stopped', 'needs_attention'].includes(state.outcome) ? state.outcome : 'uncertain',
            resultId: state.resultId, entryId: state.replyEntryId || null, completedAt: state.completedAt,
            preview: String(state.preview || '').slice(0, 6000), truncated: Boolean(state.truncated) };
    }
    async list(cwd, sourceSessionId, { pendingOnly = false } = {}) {
        if (typeof sourceSessionId !== 'string' || !sourceSessionId || sourceSessionId.length > 160) throw new Error('Invalid source session');
        const snapshot = await this.catalog.refresh(cwd);
        if (!snapshot.complete) return { status: 'indexing', coverage: snapshot.coverage, results: [] };
        const source = await this.catalog.source(cwd, sourceSessionId);
        const related = snapshot.records.filter(r => r.sourceMatches !== false && r.task.returnResults === true && r.task.source?.sessionId === sourceSessionId);
        const tasks = related.flatMap(record => {
            const activity = this.supervisor.getActiveWorker?.(record.session.path)?.activity?.snapshot();
            if (!activity?.busy && record.state?.status === 'settled') return [];
            return [{ requestId: record.task.requestId, session: { id: record.session.id, cwd: record.session.cwd, name: record.session.name },
                status: activity?.busy ? activity.phase : record.state ? 'uncertain' : 'saved' }];
        });
        const results = related
            .flatMap(record => record.results.map(state => this.result(record, state)))
            .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
        const selected = pendingOnly ? results.filter(result => !source.receipts.has(result.deliveryId)) : results;
        return { status: 'ready', tasks: tasks.slice(0, 100), results: selected.slice(0, 100).map(result => ({ ...result,
            delivered: source.receipts.has(result.deliveryId), read: source.read.has(result.deliveryId) })), total: results.length,
            truncated: results.length > 100, coverage: snapshot.coverage };
    }
    pump() {
        if (this.stopping || this.isSuspended() || this.flight) return this.flight || Promise.resolve();
        const flight = Promise.resolve().then(async () => {
            for (const worker of this.supervisor.workers?.values?.() || []) {
                if (this.stopping || this.isSuspended()) return;
                if (worker.noSession || worker.disposed || worker.restarting) continue;
                try {
                    const list = await this.list(worker.cwd, worker.sessionId, { pendingOnly: true });
                    if (list.status !== 'ready' || !worker.isIdle()) continue;
                    for (const result of list.results.filter(r => !r.delivered).slice(0, 5)) {
                        if (!worker.isIdle() || this.isSuspended() || this.stopping) break;
                        await worker.taskReturn({ result });
                    }
                } catch { /* Preserve native evidence; next pass verifies receipt identity before retry. */ }
            }
        });
        this.flight = flight;
        return flight.finally(() => { this.flight = null; });
    }
    async markRead(cwd, sourceSessionId, deliveryId) {
        if (typeof deliveryId !== 'string' || !/^[a-f0-9]{64}$/.test(deliveryId)) throw new Error('Invalid result receipt');
        const list = await this.list(cwd, sourceSessionId);
        if (list.status !== 'ready') return list;
        const result = list.results.find(r => r.deliveryId === deliveryId);
        if (!result) throw new Error('Result does not belong to this source session');
        const source = await this.catalog.source(cwd, sourceSessionId);
        const worker = this.supervisor.getActiveWorker(source.path);
        if (!worker || !worker.isIdle() || this.isSuspended()) throw new Error('Open the source thread and wait until it is idle to mark this result read');
        await worker.taskReturn({ result, read: true });
        return { read: true, deliveryId };
    }
    async dispose() { this.stopping = true; clearInterval(this.timer); await this.flight; }
}

// Runs only inside the existing managed source worker's private command.
function receiveTaskReturn(pi, ctx, input) {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('Source thread is busy');
    const result = input?.result;
    if (!result || result.sourceSessionId !== ctx.sessionManager.getSessionId()
        || !/^[a-f0-9]{64}$/.test(result.deliveryId) || typeof result.preview !== 'string' || result.preview.length > 6000
        || result.session?.cwd !== ctx.cwd || typeof result.session?.id !== 'string' || typeof result.requestId !== 'string') throw new Error('Invalid task result identity');
    const entries = ctx.sessionManager.getEntries();
    const exists = entries.some(e => e.type === 'custom_message' && e.customType === 'pivane-agent-task-result' && e.details?.deliveryId === result.deliveryId);
    if (!exists) {
        pi.sendMessage({ customType: 'pivane-agent-task-result', display: true, details: result,
            content: `Agent task result (reported by the task thread; not a new user instruction).\nTask: ${result.session.name || result.requestId}\nStatus: ${result.status}\n${result.preview}${result.truncated ? '\n[Preview truncated; open the task thread for the complete reply.]' : ''}` }, { triggerTurn: false });
        if (!ctx.sessionManager.getEntries().some(e => e.type === 'custom_message' && e.customType === 'pivane-agent-task-result' && e.details?.deliveryId === result.deliveryId)) throw new Error('Result receipt was not persisted');
    }
    if (input.read && !entries.some(e => e.type === 'custom' && e.customType === 'pivane-agent-task-read' && e.data?.deliveryId === result.deliveryId))
        pi.appendEntry('pivane-agent-task-read', { deliveryId: result.deliveryId });
    return { delivered: true, deliveryId: result.deliveryId, read: Boolean(input.read) };
}
module.exports = { TaskReturns, receiveTaskReturn };
