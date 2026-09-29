const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { rehearsalRoot } = require('./release/guard.cjs');
test('release acceptance only accepts its marked temporary directory and exact demo project', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-release-'));
    const original = process.env.PI_RELEASE_RUN_ID;
    t.after(() => { if (original === undefined) delete process.env.PI_RELEASE_RUN_ID; else process.env.PI_RELEASE_RUN_ID = original; fs.rmSync(root, { recursive: true, force: true }); });
    process.env.PI_RELEASE_RUN_ID = randomUUID();
    assert.throws(() => rehearsalRoot(root));
    fs.writeFileSync(path.join(root, '.pivane-release.json'), JSON.stringify({ kind: 'pivane-release-acceptance-v1', runId: randomUUID() }));
    assert.throws(() => rehearsalRoot(root), /identity mismatch/);
    fs.writeFileSync(path.join(root, '.pivane-release.json'), JSON.stringify({ kind: 'pivane-release-acceptance-v1', runId: process.env.PI_RELEASE_RUN_ID }));
    assert.doesNotThrow(() => rehearsalRoot(root));
    assert.doesNotThrow(() => rehearsalRoot(path.join(root, 'projects/demo'), true));
    const runId = process.env.PI_RELEASE_RUN_ID;
    delete process.env.PI_RELEASE_RUN_ID;
    assert.throws(() => rehearsalRoot(root), /explicit release run identity/);
    process.env.PI_RELEASE_RUN_ID = runId;
    fs.writeFileSync(path.join(root, '.pivane-release.json'), JSON.stringify({ kind: 'wrong-kind', runId }));
    assert.throws(() => rehearsalRoot(root));
    assert.throws(() => rehearsalRoot(path.join(root, 'projects/another'), true), /dedicated demo/);
    assert.throws(() => rehearsalRoot(os.tmpdir()), /dedicated temporary/);
    assert.throws(() => rehearsalRoot(path.dirname(root)), /dedicated temporary/);
});

test('historical workspace names no longer bypass the temporary-directory guard', () => {
    // Synthetic strings only: no legacy user directory is created or modified.
    for (const root of ['/home/pivane-synthetic-user/pi-workspace', '/Users/pivane-synthetic-user/pi-workspace-mac-trial',
        'C:\\Users\\pivane-synthetic-user\\pi-workspace-windows-trial\\rehearsal']) {
        assert.throws(() => rehearsalRoot(root));
        assert.throws(() => rehearsalRoot(root + '/projects/demo', true));
    }
});
