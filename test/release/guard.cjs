const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function rehearsalRoot(value, project = false) {
    const normalized = String(value).replace(/\\/g, '/');
    const root = project ? normalized.replace(/\/projects\/demo$/, '') : normalized;
    assert.ok(!project || root !== normalized, 'dedicated demo project required');
    const historical = /^\/(?:home|Users)\/[^/]+\/pi-workspace(?:-mac-trial)?$/.test(root)
        || /^[A-Za-z]:\/Users\/[^/]+\/pi-workspace-windows-trial\/rehearsal$/.test(root);
    if (historical) return;
    const temp = fs.realpathSync.native(os.tmpdir());
    const actual = fs.realpathSync.native(root);
    const relative = path.relative(temp, actual);
    assert.match(relative, /^pivane-release-[A-Za-z0-9_-]+$/, 'dedicated temporary release directory required');
    const marker = JSON.parse(fs.readFileSync(path.join(actual, '.pivane-release.json'), 'utf8'));
    assert.ok(/^[a-f0-9-]{36}$/.test(process.env.PI_RELEASE_RUN_ID || ''), 'explicit release run identity required');
    assert.equal(marker.runId, process.env.PI_RELEASE_RUN_ID, 'release run identity mismatch');
    assert.equal(marker.kind, 'pivane-release-acceptance-v1');
}
module.exports = { rehearsalRoot };
