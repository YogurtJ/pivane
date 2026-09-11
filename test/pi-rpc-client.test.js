const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { PiRpcClient } = require('../server/pi-rpc-client');

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
