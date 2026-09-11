// Enumerate tests in Node so cmd.exe and POSIX shells run the same suite.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).sort();
if (!files.length) throw new Error('No Node tests found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join(root, 'test', name))], {
    cwd: root, env: process.env, stdio: 'inherit'
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === null ? 1 : result.status;
