const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { selectTests, testEnvironment } = require('../scripts/run-tests.cjs');
const { sourceFiles } = require('../scripts/source-files.cjs');
const root = path.resolve(__dirname, '..');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-test-runner-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'test/nested'), { recursive: true });
    for (const file of ['a.test.js', 'nested/b.test.js', 'helper.cjs']) fs.writeFileSync(path.join(directory, 'test', file), '');
    return directory;
}

test('targeted selection uses the full-suite inventory, deduplicates and preserves discovery order', t => {
    const directory = fixture(t), all = sourceFiles(directory, 'tests');
    assert.deepEqual(selectTests(directory, []).files, all);
    assert.deepEqual(selectTests(directory, ['test']).files, all);
    assert.deepEqual(selectTests(directory, ['test/nested', 'test/a.test.js', './test/nested/b.test.js']).files, all);
    assert.deepEqual(selectTests(directory, ['test\\nested\\b.test.js', '--list', '--timing']), { files: ['test/nested/b.test.js'], list: true, timing: true });
    for (const args of [['test/missing'], ['test/a.test.js', 'test/missing'], ['test/helper.cjs'], ['--test-name-pattern=x'], ['../test'], ['/test/a.test.js'], ['test/../test/a.test.js'], ['test/*.test.js']]) {
        assert.throws(() => selectTests(directory, args));
    }
    fs.unlinkSync(path.join(directory, 'test/a.test.js'));
    fs.unlinkSync(path.join(directory, 'test/nested/b.test.js'));
    assert.throws(() => selectTests(directory, []), /No Node tests/);
});

test('selection still rejects linked source directories', t => {
    const directory = fixture(t), outside = fixture(t);
    fs.symlinkSync(outside, path.join(directory, 'test/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => selectTests(directory, ['test/a.test.js']), /symlink/);
});

test('targeted and full execution share credential filtering without mutating caller environment', () => {
    const input = { PATH: 'fixture', PI_CODING_AGENT_DIR: 'synthetic-agent', OPENAI_API_KEY: 'synthetic-secret', AWS_PROFILE: 'synthetic-profile',
        PIVANE_PORT: '9999', PIVANE_TEST_HERMES_BUNDLE: 'synthetic-bundle', PIVANE_TEST_PI_JITI: 'synthetic-loader', MINIMAX_API_KEY: 'synthetic-key' };
    const original = { ...input };
    assert.deepEqual(testEnvironment(input), { PATH: 'fixture', PI_CODING_AGENT_DIR: 'synthetic-agent', PIVANE_TEST_HERMES_BUNDLE: 'synthetic-bundle', PIVANE_TEST_PI_JITI: 'synthetic-loader' });
    assert.deepEqual(input, original);
});

test('CLI lists selected files without preparing a runtime and rejects partial typos', () => {
    const env = { ...testEnvironment(process.env), PIVANE_TEST_HERMES_BUNDLE: 'deliberately-missing-fixture' };
    const cli = path.join(root, 'scripts/run-tests.cjs');
    const listed = spawnSync(process.execPath, [cli, '--list', 'test/test-runner.test.js'], { env, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.trim(), 'test/test-runner.test.js');
    const invalid = spawnSync(process.execPath, [cli, 'test/test-runner.test.js', 'test/missing.test.js'], { env, encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /No Node tests match/);
});

test('timing reporter keeps TAP failures and Node exit status, including multiline labels', t => {
    const directory = fixture(t), file = path.join(directory, 'test/a.test.js');
    fs.writeFileSync(file, "const test = require('node:test'); test('passing', () => {}); test('failing\\nlabel', () => { throw Error('synthetic failure'); });");
    const env = testEnvironment(process.env);
    // This is a separate synthetic runner, not a child test registered with this test runner.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=' + pathToFileURL(path.join(root, 'scripts/test-timing-reporter.cjs')).href, file], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /not ok/);
    assert.match(result.stdout, /synthetic failure/);
    assert.match(result.stdout, /# Timing diagnostics/);
    assert.match(result.stdout, /# Slowest cases/);
    assert.match(result.stdout, /failing\\nlabel/);
});
