import { performance } from 'node:perf_hooks';

// Only boundary hooks: no stream-delta handlers, timers, history scans or extra
// writes. Pi persists this small snapshot with its normal assistant message.
export function registerRequestStats(pi, { now = () => performance.now() } = {}) {
    let active = false, compacting = false, started;
    let outputTokens = 0, requestMs = 0, requests = 0, excludedRequests = 0;
    const reset = () => {
        started = undefined;
        outputTokens = requestMs = requests = excludedRequests = 0;
    };
    pi.on('agent_start', () => {
        // Automatic overflow recovery/retries emit another agent_start before
        // agent_settled. Preserve the same run's totals across those starts.
        if (!active) reset();
        active = true;
    });
    pi.on('message_start', event => {
        // Steering/follow-up user messages begin a new visible reply segment.
        if (event.message?.role === 'user') reset();
    });
    pi.on('before_provider_request', () => {
        if (active && !compacting && started === undefined) started = now();
        // A transport retry within this message retains the original start;
        // its request time includes transport retry/backoff, not tool waiting.
    });
    pi.on('session_before_compact', () => { compacting = true; started = undefined; });
    const compactDone = () => { compacting = false; started = undefined; };
    pi.on('session_compact', compactDone);
    pi.on('session_compact_failed', compactDone);
    pi.on('message_end', event => {
        const message = event.message;
        if (!active || compacting || message?.role !== 'assistant') return;
        const elapsed = started === undefined ? NaN : now() - started;
        started = undefined;
        const usage = message.usage, output = usage?.output;
        // All-zero usage is also Pi's fallback when the provider omits usage.
        const valid = ['stop', 'length', 'toolUse'].includes(message.stopReason)
            && Number.isFinite(elapsed) && elapsed > 0
            && Number.isSafeInteger(output) && output >= 0
            && (output > 0 || Number.isFinite(usage?.totalTokens) && usage.totalTokens > 0);
        if (valid && Number.isSafeInteger(outputTokens + output) && Number.isFinite(requestMs + elapsed)) {
            outputTokens += output; requestMs += elapsed; requests++;
        } else excludedRequests++;
        return { message: { ...message, pivaneRequestStats: {
            version: 1, outputTokens, requestMs, requests, excludedRequests
        } } };
    });
    const clear = () => { active = compacting = false; reset(); };
    for (const event of ['agent_settled', 'session_start', 'session_switch', 'session_tree', 'session_shutdown']) pi.on(event, clear);
}
