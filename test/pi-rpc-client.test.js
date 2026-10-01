const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PiRpcClient } = require('../server/pi-rpc-client');

test('startup retries only bounded read-only probes on one process and hides late probe replies', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-readiness-'));
    const script = path.join(root, 'fixture.cjs');
    fs.writeFileSync(script, `let buffer = '', first = true; process.stdin.on('data', chunk => {
        buffer += chunk; let at;
        while ((at = buffer.indexOf('\\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
            const reply = () => process.stdout.write(JSON.stringify({ type: 'response', id: message.id, command: message.type, success: true, data: {} }) + '\\n');
            if (first) { first = false; setTimeout(reply, 1400); } else reply();
        }
    });`);
    const before = process.env.PI_WEB_CLI; process.env.PI_WEB_CLI = script;
    const client = new PiRpcClient({ cwd: root, noSession: true }), events = [];
    t.after(async () => { await client.dispose(); if (before === undefined) delete process.env.PI_WEB_CLI; else process.env.PI_WEB_CLI = before; fs.rmSync(root, { recursive: true, force: true }); });
    client.on('event', event => events.push(event));
    await client.start(); const pid = client.child.pid;
    assert.equal(client.nextRequestId, 3, 'startup issued two get_state requests');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(client.child.pid, pid); assert.equal(client.startupProbes.size, 0); assert.deepEqual(events, []);
    assert.deepEqual(await client.request('get_state'), {});
});

test('RPC framing splits on LF only and preserves Unicode separators', async () => {
    const client = new PiRpcClient({ cwd: '/tmp', sessionPath: '/tmp/unused.jsonl' });
    const stream = new PassThrough();
    client._attachJsonlReader(stream);

    const eventPromise = new Promise((resolve, reject) => {
        client.once('event', resolve);
        client.once('protocol_error', reject);
    });

    const record = {
        type: 'message_update',
        assistantMessageEvent: {
            type: 'text_delta',
            delta: `first\u2028second\u2029third`
        }
    };
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const split = Math.floor(encoded.length / 2);
    stream.write(encoded.subarray(0, split));
    stream.end(encoded.subarray(split));

    const parsed = await eventPromise;
    assert.equal(parsed.assistantMessageEvent.delta, 'first\u2028second\u2029third');
});

test('RPC framing accepts CRLF input records', async () => {
    const client = new PiRpcClient({ cwd: '/tmp', sessionPath: '/tmp/unused.jsonl' });
    const stream = new PassThrough();
    client._attachJsonlReader(stream);
    const eventPromise = new Promise(resolve => client.once('event', resolve));
    stream.end('{"type":"agent_settled"}\r\n');
    assert.equal((await eventPromise).type, 'agent_settled');
});


test('large image snapshots scan fragments linearly and preserve the following event', async () => {
    const client = new PiRpcClient({ cwd: '/tmp', noSession: true }), stream = new PassThrough();
    client._attachJsonlReader(stream);
    const events = []; client.on('event', event => events.push(event));
    const content = 'x'.repeat(12 * 1024 * 1024) + '中文\u2028尾部';
    let response;
    client.pending.set('snapshot', { resolve: value => { response = value; }, reject: error => { throw error; }, timer: null });
    const bytes = Buffer.from(JSON.stringify({ type: 'response', id: 'snapshot', success: true, data: { content } })
        + '\r\n' + JSON.stringify({ type: 'agent_settled' }) + '\n');
    const original = String.prototype.indexOf; let searched = 0;
    String.prototype.indexOf = function (needle, from = 0) {
        if (needle === '\n') searched += Math.max(0, this.length - from);
        return original.call(this, needle, from);
    };
    try {
        for (let offset = 0; offset < bytes.length; offset += 16381) stream.write(bytes.subarray(offset, offset + 16381));
        stream.end();
    } finally { String.prototype.indexOf = original; }
    assert.equal(response.content, content);
    assert.equal(events.length, 1); assert.equal(events[0].type, 'agent_settled');
    assert.ok(searched < bytes.length * 2, 'LF search work must stay proportional to received bytes');
    assert.equal(client.pending.size, 0); assert.equal(client.stdoutBuffer, '');
    assert.equal(client.stdoutChunks.length, 0);
});

test('framing flushes a fragmented unterminated record once and handles reentrant input in wire order', async () => {
    const client = new PiRpcClient({ cwd: '/tmp', noSession: true }), stream = new PassThrough();
    client._attachJsonlReader(stream); const events = [];
    client.on('event', event => { events.push(event.type); if (event.type === 'first') stream.write('{"type":"third"}\n'); });
    stream.write('{"type":"first"}\n{"type":"second"}\n');
    stream.write('{"type":"last","text":"'); stream.end('中文"}\r');
    await new Promise(resolve => stream.once('end', resolve));
    assert.deepEqual(events, ['first', 'second', 'third', 'last']);
    assert.equal(client.stdoutChunks.length, 0);
});
