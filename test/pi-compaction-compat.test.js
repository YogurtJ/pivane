const test = require('node:test');
const assert = require('node:assert/strict');

test('Pi summarization omits toolChoice when the request has no tools', async () => {
    const { generateSummaryWithUsage } = await import('@earendil-works/pi-coding-agent');
    let requestOptions;
    const stream = {
        result: async () => ({
            role: 'assistant',
            content: [{ type: 'text', text: 'summary' }],
            stopReason: 'stop',
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            timestamp: Date.now()
        })
    };
    const streamFn = async (_model, _context, options) => {
        requestOptions = options;
        return stream;
    };
    const model = {
        id: 'compat-test',
        name: 'compat-test',
        api: 'openai-completions',
        provider: 'compat-test',
        baseUrl: 'http://localhost',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024
    };

    const result = await generateSummaryWithUsage(
        [{ role: 'user', content: 'Summarize this.', timestamp: Date.now() }],
        model,
        1024,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'off',
        streamFn
    );

    assert.equal(result.text, 'summary');
    assert.equal(Object.hasOwn(requestOptions, 'toolChoice'), false);
    assert.equal(requestOptions.cacheRetention, 'none');
});
