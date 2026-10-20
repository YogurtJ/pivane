const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { comfyRequest, createComfyRequest } = require('../server/comfy-http');
const frame = (body, status) => Buffer.concat([Buffer.from(body), Buffer.from('\n' + status)]);

test('Comfy transport works without newer curl flags and preserves JSON request bytes', async () => {
    const payload = JSON.stringify({ prompt: 'literal $(not-a-command)', newline: '\n' });
    const request = createComfyRequest({ run: async (program, args, options) => {
        assert.equal(program, 'curl'); assert.equal(args[0], '-q');
        assert.equal(args.includes('--fail-with-body'), false); assert.equal(args.includes('--retry-all-errors'), false);
        assert.equal(args[args.indexOf('--retry') + 1], '0');
        assert.equal(args[args.indexOf('--data-binary') + 1], payload);
        assert.equal(args[args.indexOf('-X') + 1], 'POST');
        assert.equal(options.encoding, 'buffer');
        return { stdout: frame('{"prompt_id":"fixture"}', '200') };
    } });
    assert.equal(await request('http://fixture', '/prompt', { method: 'post', body: payload }), '{"prompt_id":"fixture"}');
});

test('binary output removes only curl metadata, retaining status-like bytes in the image', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0, 0xff, 10, 0x34, 0x30, 0x34]);
    const request = createComfyRequest({ run: async () => ({ stdout: frame(bytes, '200') }) });
    assert.deepEqual(await request('http://fixture', '/view', { binary: true }), bytes);
});

test('read-only retries discard all output from failed attempts', async () => {
    let calls = 0, waits = 0;
    const request = createComfyRequest({ wait: async () => { waits++; }, run: async () => {
        calls++;
        if (calls === 1) throw Object.assign(Error('partial transfer'), { stdout: frame('partial', '000'), code: 18 });
        if (calls === 2) return { stdout: frame('busy', '503') };
        return { stdout: frame('final', '200') };
    } });
    assert.equal(await request('http://fixture', '/history/1'), 'final'); assert.equal(calls, 3); assert.equal(waits, 2);
});

for (const options of [{ method: 'POST', body: '{}' }, { body: '{}' }, { method: 'DELETE' }]) {
    test(`HTTP error body is preserved without replaying ${options.method || 'implicit POST'}`, async () => {
        let calls = 0;
        const request = createComfyRequest({ wait: async () => assert.fail('mutation must not retry'), run: async () => { calls++; return { stdout: frame('{"error":"queue rejected"}', '503') }; } });
        await assert.rejects(request('http://fixture', '/prompt', options), /HTTP 503.*queue rejected/);
        assert.equal(calls, 1);
    });
}

test('a dropped generation response is not retried and never exposes the command arguments', async () => {
    let calls = 0;
    const request = createComfyRequest({ run: async () => { calls++; throw Object.assign(Error('curl -H Authorization:Bearer PRIVATE_FIXTURE_KEY secret-prompt'), { code: 52, stdout: Buffer.from('\n000') }); } });
    await assert.rejects(request('http://fixture', '/prompt', { method: 'POST', body: 'secret-prompt' }), error => {
        assert.match(error.message, /52/); assert.doesNotMatch(error.message, /PRIVATE_FIXTURE_KEY|secret-prompt/); return true;
    });
    assert.equal(calls, 1);
});

test('read retries remain bounded and malformed status is never treated as success', async () => {
    for (const output of ['body without trailer', 'body\n000', 'body\n999', 'body\n503']) {
        let calls = 0, waits = 0;
        const request = createComfyRequest({ run: async () => { calls++; return { stdout: Buffer.from(output) }; }, wait: async () => { waits++; } });
        await assert.rejects(request('http://fixture', '/object_info'), /ComfyUI/);
        assert.equal(calls, 6); assert.equal(waits, 5);
    }
});

test('HTTP errors retain a bounded detail rather than a full upstream body', async () => {
    const request = createComfyRequest({ run: async () => ({ stdout: frame('x'.repeat(10000), '400') }) });
    await assert.rejects(request('http://fixture', '/prompt', { method: 'POST' }), error => {
        assert.match(error.message, /HTTP 400/); assert.ok(error.message.length < 750); return true;
    });
});

test('installed curl handles loopback JSON, exact binary, read retry and single-attempt writes', { timeout: 10000 }, async t => {
    const counts = new Map(), png = Buffer.from([0x89, 0x50, 0, 0xff, 10, 0x32, 0x30, 0x30]);
    const server = http.createServer(async (req, res) => {
        const count = (counts.get(req.url) || 0) + 1; counts.set(req.url, count);
        if (req.url === '/read') {
            res.writeHead(count === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
            return res.end(count === 1 ? '{"error":"busy"}' : '{"ok":true}');
        }
        if (req.url === '/image') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
        if (req.url === '/prompt') {
            let body = ''; for await (const chunk of req) body += chunk;
            assert.equal(body, '{"prompt":"literal $(not-a-command)"}');
            res.writeHead(422); return res.end('{"error":"workflow rejected"}');
        }
        if (req.url === '/uncertain') return req.socket.destroy();
        res.writeHead(404); res.end('missing');
    });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const previous = process.env.NO_PROXY; process.env.NO_PROXY = '127.0.0.1,localhost';
    t.after(() => { if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous; });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await comfyRequest(base, '/read', { timeout: 2 }), '{"ok":true}'); assert.equal(counts.get('/read'), 2);
    assert.deepEqual(await comfyRequest(base, '/image', { binary: true, timeout: 2 }), png);
    await assert.rejects(comfyRequest(base, '/prompt', { method: 'POST', body: '{"prompt":"literal $(not-a-command)"}', timeout: 2 }), /HTTP 422.*workflow rejected/);
    assert.equal(counts.get('/prompt'), 1);
    await assert.rejects(comfyRequest(base, '/uncertain', { method: 'POST', body: '{}', timeout: 2 }), /ComfyUI/);
    assert.equal(counts.get('/uncertain'), 1);
});
