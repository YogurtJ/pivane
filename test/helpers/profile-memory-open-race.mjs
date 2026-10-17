// Worker for pi-profile-memory-upgrade.test.js. Both workers take upstream's real
// memories column snapshot, then meet at a barrier before either ALTERs, which
// deterministically reproduces two first opens of one profile database.
import { workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const { bundle, root, barrier, prepare, busyTimeoutMs } = workerData;
const counter = new Int32Array(barrier);
const upstream = await import(pathToFileURL(bundle).href);
const proto = upstream.DatabaseManager.prototype;
const original = proto.getColumnNames;
let reached = false;
if (typeof original === 'function') proto.getColumnNames = function (db, table) {
    const snapshot = original.call(this, db, table);
    if (table === 'memories' && !reached) {
        reached = true;
        Atomics.add(counter, 0, 1);
        Atomics.notify(counter, 0);
        const deadline = Date.now() + 5000;
        while (Atomics.load(counter, 0) < 2 && Date.now() < deadline) Atomics.wait(counter, 0, Atomics.load(counter, 0), 50);
    }
    return snapshot;
};
try {
    if (prepare) createRequire(import.meta.url)('../../server/profile-memory/schema-prep.js').prepareProfileDatabase(root, bundle, { busyTimeoutMs });
} catch (error) {
    parentPort.postMessage({ ok: false, stage: 'prepare', reached, error: error.message, code: error.code });
    process.exit(0);
}
try {
    const manager = new upstream.DatabaseManager(root);
    try { manager.getDb(); } finally { manager.close(); }
    parentPort.postMessage({ ok: true, reached });
} catch (error) {
    parentPort.postMessage({ ok: false, stage: 'open', reached, error: error.message });
}
