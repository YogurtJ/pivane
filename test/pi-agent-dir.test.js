const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/pi-agent-dir.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-dir-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function run(directory, args = []) {
    const env = { PATH: process.env.PATH, HOME: os.homedir() };
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'TEMP', 'TMP']) {
        if (process.env[name]) env[name] = process.env[name];
    }
    if (directory !== undefined) env.PI_CODING_AGENT_DIR = directory;
    return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
}

test('installation resolver uses the native home default and does not initialize missing identities', () => {
    const expected = path.join(os.homedir(), '.pi', 'agent');
    for (const value of [undefined, '']) {
        const result = run(value);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), fs.existsSync(expected) ? fs.realpathSync.native(expected) : expected);
    }
    const missing = path.join(root, 'new identity');
    const result = run(missing);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), missing);
    assert.equal(fs.existsSync(missing), false);
});

test('installation resolver preserves custom identity contents and supports spaces and Pi tilde expansion', () => {
    const directory = path.join(root, 'existing identity'); fs.mkdirSync(directory);
    const marker = path.join(directory, 'auth.json');
    const original = '{"synthetic-marker":"must-not-be-printed"}\n';
    fs.writeFileSync(marker, original);
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, fs.realpathSync.native(directory) + '\n');
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-be-printed/);
    assert.equal(fs.readFileSync(marker, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(directory), ['auth.json']);
    const tilde = run('~/.pi/agent');
    const standard = run();
    assert.equal(tilde.status, 0, tilde.stderr);
    assert.equal(tilde.stdout, standard.stdout);
});

test('installation resolver rejects invalid configured paths without falling back to another identity', () => {
    const file = path.join(root, 'file'); fs.writeFileSync(file, 'fixture');
    for (const value of ['relative/path', file, path.join(root, 'line\nbreak')]) {
        const result = run(value);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
    }
    assert.notEqual(run(undefined, ['--unknown']).status, 0);
});
