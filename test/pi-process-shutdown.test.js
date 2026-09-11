const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const shutdownModule = require.resolve('../server/pi-process-shutdown');
// Reproduce the hook loaded after startup by the locked Pi dependency.
const path = require('node:path');
const signalExit = createRequire(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/package.json')).resolve('signal-exit');
function fixture(fail) {
    const script = `
        let calls = 0;
        require(process.argv[1]).registerProcessShutdown(async () => {
            calls++;
            await new Promise(resolve => setTimeout(resolve, 60));
            if (process.argv[3] === 'fail') throw Error('synthetic disposal failure');
            console.log('DISPOSED:' + calls);
        });
        require(process.argv[2])(() => {});
        process.emit('SIGINT');
        process.emit('SIGTERM');
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, shutdownModule, signalExit, fail ? 'fail' : 'ok'], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => stdout += data);
        child.stderr.on('data', data => stderr += data);
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}
test('SIGINT/SIGTERM keep Pi signal-exit hooks from ending asynchronous disposal early', async () => {
    const result = await fixture(false);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.signal, null);
    assert.equal(result.stdout.trim(), 'DISPOSED:1');
});
test('shutdown disposal failure remains a failure and repeated signals do not replay disposal', async () => {
    const result = await fixture(true);
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.equal(result.signal, null);
    assert.match(result.stderr, /synthetic disposal failure/);
    assert.doesNotMatch(result.stdout, /DISPOSED/);
});
