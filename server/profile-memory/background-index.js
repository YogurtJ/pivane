'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

// Only disposable history indexing lives here. Native JSONL writes and memory
// mutations remain with their existing owners. One in-flight refresh plus one
// pending refresh coalesces settled events without retaining session bodies.
function createBackgroundIndex(context, bundle) {
    const worker = new Worker(path.join(__dirname, 'index-worker.js'), { workerData: { context, bundle } });
    let serial = 0, failed = null, closing = false, refresh = null, pendingFile = null;
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
        async close() {
            if (closing) return;
            closing = true; pendingFile = null;
            try { if (refresh) await refresh; if (!failed) await request('close'); }
            finally { await worker.terminate(); }
        },
    };
}
module.exports = { createBackgroundIndex };
