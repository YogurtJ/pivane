// Test-only IPC shutdown wrapper. The application exposes no shutdown endpoint.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.PI_RELEASE_BASE_DIR;
require('./guard.cjs').rehearsalRoot(root);
assert.equal(fs.readFileSync(path.join(root, 'projects/demo/release-marker.txt'), 'utf8'), 'pi-release-rehearsal-v1\n');
assert.ok(process.send, 'acceptance parent IPC is required');
process.on('message', message => {
    if (message?.type === 'pivane-release-stop' && message.runId === process.env.PI_RELEASE_RUN_ID) process.emit('SIGINT');
});
const application = process.env.PI_RELEASE_SERVER_DIR || path.resolve(__dirname, '../..');
assert.ok(['app', 'previous'].some(name => fs.realpathSync.native(application) === fs.realpathSync.native(path.join(root, name))));
process.once('disconnect', () => process.emit('SIGINT'));
require(path.join(application, 'server.js'));
