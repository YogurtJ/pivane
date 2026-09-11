const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Response } = require('node-fetch');
const { MiniMaxVideoService } = require('../server/minimax-video-service');

test('normalizes MiniMax H3 text and image video parameters', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-minimax-video-normalize-'));
    const service = new MiniMaxVideoService({ rootDir: root, apiKeyResolver: async () => 'test-key' });
    const text = service.normalizeRequest({ prompt: 'cinematic', duration: 99, resolution: '2K', ratio: 'adaptive' });
    assert.equal(text.model.id, 'MiniMax-H3');
    assert.equal(text.duration, 15);
    assert.equal(text.resolution, '2K');
    assert.equal(text.ratio, '16:9');

    const image = service.normalizeRequest({
        prompt: 'turn around',
        model: 'MiniMax-H3-Max',
        duration: 4,
        resolution: '2K',
        ratio: '9:16',
        imageData: `data:image/png;base64,${Buffer.from('image').toString('base64')}`
    });
    assert.equal(image.duration, 5);
    assert.equal(image.resolution, '768P');
    assert.equal(image.ratio, 'adaptive');
    assert.ok(image.sourceImage.dataUrl.startsWith('data:image/png;base64,'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('creates, polls, downloads, and records a MiniMax H3 video', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-minimax-video-generate-'));
    const calls = [];
    let queryCount = 0;
    const fakeFetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (String(url).endsWith('/v2/video_generation')) {
            return new Response(JSON.stringify({ task_id: 'task_123' }), { status: 200 });
        }
        if (String(url).includes('/v2/query/video_generation/task_123')) {
            queryCount += 1;
            const task = queryCount === 1
                ? { id: 'task_123', status: 'running' }
                : { id: 'task_123', status: 'succeeded', model: 'MiniMax-H3', content: { url: 'https://cdn.example.test/video.mp4' }, resolution: '2K', duration: 6, ratio: '16:9', usage: { total_seconds: 6 } };
            return new Response(JSON.stringify({ task }), { status: 200 });
        }
        if (String(url) === 'https://cdn.example.test/video.mp4') {
            return new Response(Buffer.from('fake-mp4'), { status: 200, headers: { 'content-length': '8' } });
        }
        return new Response('not found', { status: 404 });
    };
    const service = new MiniMaxVideoService({
        rootDir: root,
        fetch: fakeFetch,
        apiKeyResolver: async () => 'test-key',
        pollIntervalMs: 1,
        timeoutMs: 2000
    });
    const result = await service.generate({ prompt: 'A calm ocean shot', duration: 6, resolution: '2K', ratio: '16:9' });
    assert.equal(result.ok, true);
    assert.equal(result.video.source, 'minimax-h3-v2');
    assert.equal(result.video.duration, 6);
    assert.ok(fs.existsSync(path.join(root, 'public', 'videos', result.video.filename)));
    const creation = calls.find(call => call.url.endsWith('/v2/video_generation'));
    assert.deepEqual(creation.body, {
        model: 'MiniMax-H3',
        content: [{ type: 'text', text: 'A calm ocean shot' }],
        resolution: '2K',
        duration: 6,
        ratio: '16:9'
    });
    const history = JSON.parse(fs.readFileSync(path.join(root, 'video_history.json'), 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].taskId, 'task_123');
    assert.equal(JSON.stringify(history).includes('test-key'), false);
    fs.rmSync(root, { recursive: true, force: true });
});
