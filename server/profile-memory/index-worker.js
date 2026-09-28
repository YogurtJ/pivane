'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { createIndex } = require('./index');

const ready = (async () => {
    const upstream = await import(pathToFileURL(workerData.bundle).href);
    const db = new upstream.DatabaseManager(workerData.context.profileRoot);
    const index = createIndex(db, upstream, workerData.context);
    let search;
    upstream.registerSessionSearchTool({ registerTool: tool => { search = tool; } }, db, { variant: 'legacy' });
    return { index, search };
})();
// Observe initialization rejection even before the first message arrives.
ready.catch(() => {});
let queue = Promise.resolve();
parentPort.on('message', message => {
    queue = queue.then(async () => {
        try {
            const { index, search } = await ready;
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
            } else if (message.operation === 'close') index.close();
            else throw new Error('Unknown profile index operation');
            parentPort.postMessage({ id: message.id, result });
        } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
    });
});
