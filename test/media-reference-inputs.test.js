const test = require('node:test');
const assert = require('node:assert/strict');
const { Response } = require('node-fetch');
const { validateDefinition, validateParameters, MediaLabService } = require('../server/media-lab-service');
const { MediaAgentService } = require('../server/media-agent-service');
const { normalizeModel } = require('../server/media-provider-service');
const { connectionTemplates } = require('../server/media-connection-planner');
const { renderTemplate, validateHttp, MediaHttpExecutor } = require('../server/media-http-protocol');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=', 'base64');
const image = 'data:image/png;base64,' + png.toString('base64');
const video = 'data:video/mp4;base64,' + Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0]).toString('base64');
const template = id => normalizeModel({ ...connectionTemplates().find(t => t.id === id).model, remoteModel: 'fixture' });

test('ordered multiple references validate counts, roles, media types and aggregate limits', () => {
    const model = { id: 'multi', kind: 'image', adapter: 'manual', parameters: { images: { type: 'image', multiple: true, maxItems: 2, required: true, role: 'reference' } } };
    assert.doesNotThrow(() => validateDefinition(model));
    assert.deepEqual(validateParameters(model.parameters, { images: [image, image] }).images, [image, image]);
    for (const value of [[], [image, image, image], image, [video], ['attachment:stale']]) assert.throws(() => validateParameters(model.parameters, { images: value }));
    for (const field of [{ type: 'text', multiple: true }, { type: 'image', multiple: true, maxItems: 100 }, { type: 'video', role: 'unknown' }]) assert.throws(() => validateDefinition({ ...model, parameters: { a: field } }));
    assert.throws(() => validateParameters({ a: { type: 'image', multiple: true, maxItems: 16 }, b: { type: 'image', multiple: true, maxItems: 16 } }, { a: Array(16).fill(image), b: Array(5).fill(image) }), /20 reference/);
});

test('first/last-frame mappings omit absent optional parts; multimodal references retain order and exact roles', () => {
    const frames = template('ark-video-frames');
    const first = renderTemplate(frames.http.body, { prompt: 'Animate', first_frame: image }, 'fixture', frames.parameters);
    assert.equal(first.content.length, 2); assert.equal(first.content[1].role, 'first_frame'); assert.equal(first.content[1].image_url.url, image);
    const both = renderTemplate(frames.http.body, { prompt: 'Animate', first_frame: image, last_frame: image }, 'fixture', frames.parameters);
    assert.equal(both.content.length, 3); assert.equal(both.content[2].role, 'last_frame');
    const refs = template('ark-video-references');
    const body = renderTemplate(refs.http.body, { prompt: 'Animate', images: [image, image], videos: [video] }, 'fixture', refs.parameters);
    assert.deepEqual(body.content.map(part => part.role), [undefined, 'reference_image', 'reference_image', 'reference_video']);
    assert.equal(body.content[3].video_url.url, video);
    assert.equal(renderTemplate(refs.http.body, { prompt: 'Text only' }, 'fixture', refs.parameters).content.length, 1);
    const gemini = template('gemini-image-multi');
    const parts = renderTemplate(gemini.http.body, { prompt: 'Edit', images: [image, image] }, 'fixture', gemini.parameters).contents[0].parts;
    assert.equal(parts.length, 3); assert.deepEqual(parts[1].inlineData, { mimeType: 'image/png', data: png.toString('base64') });
});

test('multiple image edit references become repeated multipart binary parts in one request', async () => {
    const model = template('openai-image-multi'); let calls = 0;
    const executor = new MediaHttpExecutor({ fetch: async (_url, request) => {
        calls++; assert.equal(request.body.toString().split('name="image[]"').length - 1, 2);
        assert.ok(request.body.includes(png)); assert.ok(!request.body.includes(Buffer.from(image)));
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    } });
    await executor.execute({ provider: { baseUrl: 'https://fixture.invalid', auth: { mode: 'none' } }, key: '', model, parameters: { prompt: 'Edit', images: [image, image] } });
    assert.equal(calls, 1);
});

test('media mapping rejects invalid parameter kinds, credential keys and unbounded concatenation', () => {
    const model = template('ark-video-frames');
    for (const value of [{ $media: { parameter: 'prompt', format: 'image_url' } }, { $media: { parameter: 'first_frame', format: 'video_url' } }, { $media: { parameter: 'first_frame', format: 'image_url', api_key: 'bad' } }, { $concat: Array(65).fill([]) }]) assert.throws(() => validateHttp({ ...model.http, body: { content: value } }, model.parameters, 'video'));
    assert.throws(() => renderTemplate({ content: { $concat: ['not an array'] } }, {}, 'fixture'), /arrays/);
});

test('optional planner receives every reference image but only opaque list tokens in its textual context', async () => {
    const model = { id: 'multi', name: 'Multi', kind: 'image', adapter: 'manual', parameters: { prompt: { type: 'text', required: true }, images: { type: 'image', multiple: true } } };
    const lab = new MediaLabService({ profile: { models: [model], image: {}, directory: '/tmp' }, videoService: { getConfig: async () => ({ models: [] }) }, ttsService: { getPublicConfig: () => ({ providers: [] }) } });
    const agent = new MediaAgentService(); agent.mediaLabService = lab;
    agent.getPlannerCandidates = async () => [{ provider: 'fixture', modelId: 'fixture', input: ['image'] }];
    agent.runPlanner = async ({ current, images, plannerPrompt }) => {
        assert.equal(images.length, 2); assert.match(current.parameters.images, /^attachment:/); assert.ok(!plannerPrompt.includes(png.toString('base64')));
        return lab.plan({ modelId: 'multi', parameters: { prompt: 'Edited', images: current.parameters.images } });
    };
    const result = await agent.createLabPlan({ kind: 'image', selectedModelId: 'multi', instruction: 'Edit', parameters: { prompt: 'Original', images: [image, image] } });
    assert.deepEqual(result.plan.parameters.images, [image, image]); assert.equal(lab.planningAttachments.size, 0);
});
