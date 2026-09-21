const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourceFiles, distributionFiles } = require('../scripts/source-files.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function put(root, name) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// synthetic source\n');
}

test('source discovery includes nested modules and tests without following user data or old copies', t => {
    const root = fixture(t);
    for (const file of ['server/session/runtime.js', 'server/session/bridge.ts', 'server/old.js.bak',
        'public/chat/transport.js', 'public/chat/view.css', 'public/images/private.js', 'public/vendor/library.js',
        'public/legacy-workspace/chat.js', 'public/.private/record.js', 'test/session/runtime.test.js', 'test/browser/page.cjs', 'test/helpers/fixture.cjs']) put(root, file);
    assert.deepEqual(sourceFiles(root, 'server'), ['server/session/bridge.ts', 'server/session/runtime.js']);
    assert.deepEqual(sourceFiles(root, 'public'), ['public/chat/transport.js', 'public/chat/view.css']);
    assert.deepEqual(sourceFiles(root, 'tests'), ['test/session/runtime.test.js']);
    assert.deepEqual(sourceFiles(root, 'browser'), ['test/browser/page.cjs']);
    assert.ok(sourceFiles(root, 'testSupport').includes('test/helpers/fixture.cjs'));
    assert.throws(() => sourceFiles(root, 'unknown'), /Unknown/);
});

test('source discovery refuses linked code directories instead of silently omitting their tests or packaging targets', t => {
    const root = fixture(t), outside = fixture(t);
    put(root, 'server/main.js'); put(outside, 'secret.js');
    fs.symlinkSync(outside, path.join(root, 'server/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => sourceFiles(root, 'server'), /symlink/);
});

test('release inventory includes its own discovery and checking tools and excludes maintenance and user data', () => {
    const files = distributionFiles(path.resolve(__dirname, '..'));
    for (const file of ['scripts/source-files.cjs', 'scripts/check-syntax.cjs', 'scripts/run-tests.cjs',
        'server/pi-update-installer.js', 'test/source-files.test.js', 'pi-packages/media-workbench/skills/media-workbench/SKILL.md']) assert.ok(files.includes(file), file);
    assert.equal(new Set(files).size, files.length);
    assert.equal(files.some(file => /^(?:backups|docs\/local|\.pivane-runtime|node_modules)\//.test(file)), false);
    assert.equal(files.some(file => /^public\/(?:images|audio|videos|downloads|legacy-workspace)\//.test(file)), false);
    assert.equal(files.includes('AGENTS.local.md'), false);
    assert.equal(files.includes('native/pi-win32-fd.lib'), false);
});
