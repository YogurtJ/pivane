const test = require('node:test');
const assert = require('node:assert/strict');
const { outputRedactor, outputLines, appendOutput } = require('../server/pi-update-output');
const { runNode } = require('../server/pi-update-installer');

test('update output preserves split UTF-8 while redacting credentials, ANSI and private blocks', () => {
    const records = [];
    const redact = outputRedactor({ PI_WEB_TOKEN: 'fixture-private-token', HTTPS_PROXY: 'http://alice:password@example.invalid:1234' });
    const stream = outputLines('stdout', (_type, text) => records.push(text), redact);
    const bytes = Buffer.from('\x1b[32m安装中\x1b[0m fixture-private-token\nhttps://alice:password@example.invalid\nAuthorization: Bearer hidden-value\nCookie: first=secret\rCookie: second=hidden\n-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----\nDone');
    for (let i = 0; i < bytes.length; i += 3) stream.write(bytes.subarray(i, i + 3));
    stream.end();
    const text = records.join('\n');
    assert.match(text, /安装中/); assert.match(text, /Done/); assert.match(text, /redacted/);
    for (const secret of ['fixture-private-token', 'alice', 'password@example', 'hidden-value', 'first=secret', 'second=hidden', 'private-body', '\x1b']) assert.ok(!text.includes(secret), secret);
});

test('unbounded output is discarded and the retained journal has a bounded redacted tail', () => {
    const records = [], stream = outputLines('stderr', (_type, text) => records.push(text), outputRedactor());
    stream.write(Buffer.from('x'.repeat(30000))); stream.write(Buffer.from('x'.repeat(30000) + '\nfinished\n')); stream.end();
    assert.deepEqual(records, ['[oversized output line omitted]', 'finished']);
    const job = {};
    for (let i = 0; i < 1000; i++) appendOutput(job, 'stdout', 'a'.repeat(100));
    assert.equal(job.outputTruncated, true); assert.ok(job.output.length <= 32768);
});

test('command runner reports stdout, stderr and actual nonzero exit without losing the final partial line', async () => {
    const lines = [];
    await assert.rejects(runNode(['-e', "process.stdout.write('working\\n'); process.stderr.write('fixture-private-token'); process.exitCode=7"], {
        env: {}, secretEnv: { API_KEY: 'fixture-private-token' }, onOutput: (stream, text) => lines.push({ stream, text })
    }), error => error.exitCode === 7);
    assert.ok(lines.some(line => line.stream === 'stdout' && line.text === 'working'));
    assert.ok(lines.some(line => line.stream === 'stderr' && line.text === '[redacted]'));
    assert.ok(lines.some(line => line.text.includes('exit=7')));
    assert.ok(!JSON.stringify(lines).includes('fixture-private-token'));
    assert.deepEqual(await runNode(['-e', 'process.exitCode=0'], { env: {} }), { exitCode: 0 });
});
