'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { createIndex } = require('./index');
const { prepareProfileDatabase } = require('./schema-prep');
const MAX_HIT_IDS = 200, MAX_HITS_PER_ID = 1000;
// Advisory counters never wait behind another writer for the connection's normal 5 s.
const HIT_BUSY_TIMEOUT_MS = 100;

const ready = (async () => {
    const upstream = await import(pathToFileURL(workerData.bundle).href);
    prepareProfileDatabase(workerData.context.profileRoot, workerData.bundle);
    const db = new upstream.DatabaseManager(workerData.context.profileRoot);
    const index = createIndex(db, upstream, workerData.context);
    let search;
    upstream.registerSessionSearchTool({ registerTool: tool => { search = tool; } }, db, { variant: 'legacy' });
    return { index, search, upstream, db };
})();
// Observe initialization rejection even before the first message arrives.
ready.catch(() => {});
let queue = Promise.resolve();
parentPort.on('message', message => {
    queue = queue.then(async () => {
        try {
            const { index, search, upstream, db } = await ready;
            let result;
            if (message.operation === 'refresh') {
                index.reconcile();
                index.index(message.args.file);
                result = index.advance();
            } else if (message.operation === 'search') {
                index.reconcile();
                result = await search.execute('profile-search', message.args);
                if (index.reconcile()) throw new Error('Profile session sources changed; retry search');
                const coverage = index.coverage();
                result.details = { ...result.details, coverage };
                if (coverage.limited || !coverage.initialSweepComplete) result.content.push({ type: 'text',
                    text: 'Profile session recall is partial; backfill is still progressing or the scan limit was reached.' });
            } else if (message.operation === 'hits') {
                // Advisory recall counters for rows memory_search returned: [rowId, times] pairs,
                // applied with upstream recordSearchHits in one IMMEDIATE transaction. Never touches sources.
                const counts = message.args?.counts;
                if (!Array.isArray(counts) || !counts.length || counts.length > MAX_HIT_IDS || new Set(counts.map(pair => pair?.[0])).size !== counts.length
                    || !counts.every(pair => Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) && pair[0] > 0
                        && Number.isSafeInteger(pair[1]) && pair[1] > 0 && pair[1] <= MAX_HITS_PER_ID)) throw new Error('Invalid recall counts');
                const connection = db.getDb();
                const previous = Number(Object.values(connection.prepare('PRAGMA busy_timeout').get() || {})[0]);
                connection.exec(`PRAGMA busy_timeout = ${HIT_BUSY_TIMEOUT_MS}`);
                try {
                    connection.transaction(() => {
                        for (let level = 1, top = Math.max(...counts.map(pair => pair[1])); level <= top; level++)
                            upstream.recordSearchHits(db, counts.filter(pair => pair[1] >= level).map(pair => pair[0]));
                    }).immediate();
                } finally { connection.exec(`PRAGMA busy_timeout = ${Number.isSafeInteger(previous) && previous >= 0 ? previous : 5000}`); }
            } else if (message.operation === 'close') index.close();
            else throw new Error('Unknown profile index operation');
            parentPort.postMessage({ id: message.id, result });
        } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
    });
});
