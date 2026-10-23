const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectImages, imageCount } = require('../server/pi-image-context');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64');
const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
const vision = { id: 'vision', input: ['text', 'image'] }, text = { id: 'text', input: ['text'] };

test('full request projection preserves user, custom and tool originals through model switches', async () => {
    const messages = ['user', 'toolResult', 'custom'].map(role => ({ role, content: [{ type: 'text', text: 'evidence' }, image], timestamp: 1 }));
    const before = structuredClone(messages), downgraded = await projectImages(messages, text);
    assert.equal(downgraded.omitted, 3); assert.equal(imageCount(downgraded.messages), 0);
    assert.ok(downgraded.messages.every(message => message.content[0].text === 'evidence' && /原图保留/.test(message.content[1].text)));
    assert.deepEqual(messages, before);
    assert.equal(imageCount((await projectImages(messages, vision)).messages), 3);
    assert.deepEqual(messages, before);
    assert.equal((await projectImages(messages, vision, { blocked: true })).omitted, 3);
});

test('request normalization verifies bytes, canonicalizes aliases/data URLs and enforces declared aggregate limits', async () => {
    const original = { role: 'toolResult', content: [{ ...image, mimeType: 'IMAGE/JPG', data: `data:image/png;base64,${image.data.slice(0, 20)}\n${image.data.slice(20)}` }] };
    const before = structuredClone(original), projected = await projectImages([original], vision);
    assert.equal(projected.messages[0].content[0].mimeType, 'image/png');
    assert.equal(projected.messages[0].content[0].data, image.data); assert.deepEqual(original, before);
    await assert.rejects(projectImages([{ role: 'toolResult', content: [{ ...image, data: 'AAAA' }] }], vision), /工具结果.*格式无效/);
    await assert.rejects(projectImages([{ role: 'user', content: [{ ...image, data: '***' }] }], vision), /编码无效/);
    // Invalid images do not need decoding when they are omitted for a text model.
    assert.equal((await projectImages([{ role: 'user', content: [{ ...image, data: '***' }] }], text)).omitted, 1);
    const giant = Buffer.from(png); giant.writeUInt32BE(32768, 16); giant.writeUInt32BE(32768, 20);
    await assert.rejects(projectImages([{ content: [{ ...image, data: giant.toString('base64') }] }], vision), /像素超过/);
    await assert.rejects(projectImages([{ content: [image, image] }], { ...vision, inputLimits: { images: { maxPerMessage: 1 } } }), /每条消息 1 张/);
    await assert.rejects(projectImages([{ content: [image] }, { content: [image] }], { ...vision, inputLimits: { images: { maxPerRequest: 1 } } }), /请求超过模型的 1 张/);
    await assert.rejects(projectImages([{ content: [image] }], { ...vision, inputLimits: { images: { resize: { maxBytes: 1 } } } }, { autoResize: false }), /开启自动缩放/);
});

test('resize derives request copies and final stream guard blocks images injected after prompt preflight', async () => {
    const seen = [], notices = [];
    const { installImageCompatibility } = await import('../server/pi-image-runtime.mjs');
    const history = [{ role: 'user', content: [image] }];
    const session = { settingsManager: { getImageAutoResize: () => false, getBlockImages: () => false },
        sessionManager: { buildSessionContext: () => ({ messages: history }) }, model: vision, messages: history, isStreaming: false,
        agent: { convertToLlm: messages => messages, streamFunction: async (model, context) => { seen.push(context); return 'stream'; } },
        prompt: async () => 'accepted', setModel: async function (model) { this.model = model; } };
    installImageCompatibility(session, { emit: event => notices.push(event) });
    assert.equal(await session.prompt('new question'), 'accepted');
    const invalid = { role: 'toolResult', content: [{ ...image, data: 'invalid' }] };
    await assert.rejects(session.agent.streamFunction(vision, { messages: [...history, invalid] }), /工具结果/);
    assert.equal(seen.length, 0);
    await session.setModel(text);
    assert.equal(notices.filter(event => event.method === 'notify').length, 1);
    await session.agent.streamFunction(text, { messages: history });
    assert.equal(imageCount(seen[0].messages), 0);
    await assert.rejects(session.prompt('new image', { images: [image] }), /不接收图片/);
    await session.setModel(vision);
    await session.agent.streamFunction(vision, { messages: history });
    assert.equal(imageCount(seen[1].messages), 1);
    await assert.rejects(session.agent.streamFunction({ ...vision, inputLimits: { maxRequestBytes: 1 } }, { messages: history }), /字节上限/);
    assert.equal(seen.length, 2);
    const abort = new AbortController();
    const cancelled = session.agent.streamFunction(vision, { messages: history }, { signal: abort.signal });
    abort.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(seen.length, 2, 'cancellation during request preparation never submits a provider call');
    assert.equal(history[0].content[0].data, image.data);
    const result = await projectImages(history, vision, { resizeImage: async () => ({ data: 'derived', mimeType: 'image/jpeg' }) });
    assert.equal(result.messages[0].content[0].data, 'derived'); assert.equal(history[0].content[0].data, image.data);
});
