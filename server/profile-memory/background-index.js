'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

// Only disposable history indexing and advisory memory_search recall counters live
// here, off the RPC event loop. Native JSONL writes and memory mutations remain with
// their existing owners. One in-flight refresh plus one pending refresh coalesces
// settled events without retaining session bodies.
// Counts waiting for the worker coalesce per row ID; beyond this many distinct IDs they are dropped.
const MAX_PENDING_HIT_IDS = 200, MAX_HITS_PER_ID = 1000;
function createBackgroundIndex(context, bundle) {
    const worker = new Worker(path.join(__dirname, 'index-worker.js'), { workerData: { context, bundle } });
    let serial = 0, failed = null, closing = false, refresh = null, pendingFile = null;
    let pendingHits = new Map(), hitsInFlight = false;
    const requests = new Map();
    const fail = error => {
        failed = error;
        for (const request of requests.values()) request.reject(error);
        requests.clear();
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`Profile index worker exited (${code})`)));
    worker.on('message', message => {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    });
    const request = (operation, args) => {
        if (failed) return Promise.reject(failed);
        return new Promise((resolve, reject) => {
            const id = ++serial;
            requests.set(id, { resolve, reject });
            worker.postMessage({ id, operation, args });
        });
    };
    function takeHits() { const counts = [...pendingHits]; pendingHits = new Map(); return counts; }
    function flushHits() {
        if (hitsInFlight || !pendingHits.size || closing || failed) return;
        hitsInFlight = true;
        request('hits', { counts: takeHits() }).catch(() => {}).finally(() => { hitsInFlight = false; flushHits(); });
    }
    function schedule(file) {
        if (closing || failed) return;
        pendingFile = file;
        if (refresh) return;
        refresh = (async () => {
            while (pendingFile && !closing) {
                const current = pendingFile; pendingFile = null;
                await request('refresh', { file: current });
            }
        })().catch(() => { /* Search retries verification; failed backfill never proves coverage. */ })
            .finally(() => { refresh = null; });
    }
    return {
        schedule,
        async search(args) {
            if (closing) throw new Error('Profile index is closed');
            if (refresh) await refresh;
            return request('search', args);
        },
        // Fire-and-forget: a lost or failed count never affects the search result. At most one
        // batch waits in the serial queue (bounded by the worker's short busy timeout); later
        // counts coalesce here, so contention or a long refresh cannot pile up queued writes.
        recordHits(ids) {
            if (closing || failed || !Array.isArray(ids) || !ids.length || ids.length > 20
                || !ids.every(id => Number.isSafeInteger(id) && id > 0)) return false;
            for (const id of new Set(ids)) {
                if (!pendingHits.has(id) && pendingHits.size >= MAX_PENDING_HIT_IDS) continue;
                pendingHits.set(id, Math.min((pendingHits.get(id) || 0) + 1, MAX_HITS_PER_ID));
            }
            flushHits();
            return true;
        },
        async close() {
            if (closing) return;
            closing = true; pendingFile = null;
            try {
                if (refresh) await refresh;
                // One last bounded batch for counts that were still coalescing; then close.
                if (!failed && pendingHits.size) request('hits', { counts: takeHits() }).catch(() => {});
                if (!failed) await request('close');
            }
            finally { await worker.terminate(); }
        },
    };
}
module.exports = { createBackgroundIndex };
