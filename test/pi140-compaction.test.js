'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-pi140-compaction-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('native split-turn and history summaries preserve custom focus and use the model output limit', async t => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        requests.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'summary', choices: [{ index: 0, delta: { content: 'Synthetic checkpoint' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const sdk = await import('@earendil-works/pi-coding-agent');
    const model = { provider: 'fixture', id: 'summary', api: 'openai-completions', name: 'Synthetic summary', input: ['text'],
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, contextWindow: 100000, maxTokens: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const preparation = { firstKeptEntryId: 'retained', messagesToSummarize: [],
        turnPrefixMessages: [{ role: 'user', content: 'Preserve the migration decision.', timestamp: 1 }],
        isSplitTurn: true, tokensBefore: 100, previousSummary: 'Previous checkpoint remains.',
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 } };
    const split = await sdk.compact(preparation, model, 'synthetic', undefined, 'keep migration decisions');
    assert.equal(requests.length, 1, 'a split turn with no history needs only the prefix summary');
    assert.match(split.summary, /Previous checkpoint remains/);
    assert.match(split.summary, /Turn Context \(split turn\)/);
    assert.match(JSON.stringify(requests[0].messages), /Additional focus: keep migration decisions/);
    await sdk.generateSummary(preparation.turnPrefixMessages, model, 123, 'synthetic', undefined, undefined, 'keep history decisions');
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].messages), /Additional focus: keep history decisions/);
    for (const request of requests) {
        assert.equal(request.max_tokens ?? request.max_completion_tokens, model.maxTokens);
        assert.equal(request.tools, undefined); assert.equal(request.tool_choice, undefined);
    }
});
