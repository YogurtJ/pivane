const test = require('node:test');
const assert = require('node:assert/strict');
const { MediaLabService, validateParameters, validateDefinition } = require('../server/media-lab-service');
const { MediaAgentService } = require('../server/media-agent-service');
const { MediaHttpExecutor, renderTemplate } = require('../server/media-http-protocol');
const { connectionTemplates } = require('../server/media-connection-planner');
const { normalizeModel } = require('../server/media-provider-service');
const { Response } = require('node-fetch');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const image = 'data:image/png;base64,' + png.toString('base64');
const model = () => ({ id: 'reference', kind: 'image', adapter: 'manual', parameters: { prompt: { type: 'text', required: true }, image: { type: 'image', required: true } } });
function labFixture() {
    return new MediaLabService({ profile: { models: [model()], directory: '/tmp', image: {} }, videoService: { getConfig: async () => ({ models: [] }) }, ttsService: { getPublicConfig: () => ({ providers: [] }) } });
}
test('attachment parameters validate signatures, format, required fields and aggregate budget', () => {
    assert.doesNotThrow(() => validateDefinition(model()));
    assert.deepEqual(validateParameters(model().parameters, { prompt: 'Poster', image }), { prompt: 'Poster', image });
    for (const value of ['', 'https://example.invalid/image.png', 'data:image/png;base64,YmFk', image.replace('image/png', 'video/mp4'), image + '!']) {
        assert.throws(() => validateParameters(model().parameters, { prompt: 'Poster', image: value }));
    }
    assert.throws(() => validateParameters(model().parameters, { prompt: 'Poster' }), /required/);
    assert.throws(() => validateDefinition({ ...model(), parameters: { image: { type: 'image', default: image } } }), /defaults/);
    const bytes = Buffer.alloc(11 * 1024 * 1024); png.copy(bytes);
    const large = 'data:image/png;base64,' + bytes.toString('base64');
    assert.throws(() => validateParameters({ a: { type: 'image' }, b: { type: 'image' } }, { a: large, b: large }), /combined/);
    const video = 'data:video/mp4;base64,' + Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0]).toString('base64');
    assert.equal(validateParameters({ video: { type: 'video' } }, { video }).video, video);
});
test('reference templates map exact image bytes through multipart and Gemini inlineData', async () => {
    for (const id of ['openai-image-edit', 'gemini-image-edit', 'ark-image-edit', 'ark-video-first-frame']) normalizeModel({ ...connectionTemplates().find(t => t.id === id).model, remoteModel: 'fixture' });
    const definition = normalizeModel({ ...connectionTemplates().find(t => t.id === 'openai-image-edit').model, remoteModel: 'fixture' });
    let count = 0;
    const executor = new MediaHttpExecutor({ fetch: async (url, options) => {
        count++;
        assert.match(String(url), /\/images\/edits$/);
        assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=pivane-/);
        assert.ok(Buffer.isBuffer(options.body));
        assert.ok(options.body.includes(png));
        assert.match(options.body.toString(), /name="image"; filename="reference.png"\r\nContent-Type: image\/png\r\n\r\n/);
        assert.ok(!options.body.includes(Buffer.from(image)));
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    } });
    const output = await executor.execute({ provider: { baseUrl: 'https://example.invalid', auth: { mode: 'none' } }, key: '', model: definition, parameters: { prompt: 'Poster', image } });
    assert.ok(output.bytes.equals(png)); assert.equal(count, 1);
    const gemini = connectionTemplates().find(t => t.id === 'gemini-image-edit').model;
    const body = renderTemplate(gemini.http.body, { prompt: 'Poster', image }, 'fixture', gemini.parameters);
    assert.deepEqual(body.contents[0].parts[1].inlineData, { mimeType: 'image/png', data: png.toString('base64') });
});
test('planner sees actual images without base64 in text or environment and preserves attachments', async () => {
    const lab = labFixture(), agent = new MediaAgentService(); agent.mediaLabService = lab;
    agent.getPlannerCandidates = async () => [{ provider: 'fixture', modelId: 'fixture' }];
    let token;
    agent.runPlanner = async ({ current, images, plannerPrompt }) => {
        token = current.parameters.image;
        assert.match(token, /^attachment:/);
        assert.equal(JSON.stringify(current).includes(png.toString('base64')), false);
        assert.equal(plannerPrompt.includes(png.toString('base64')), false);
        assert.deepEqual(images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
        const result = await lab.plan({ modelId: 'reference', parameters: { prompt: 'Planned', image: token } });
        assert.equal(result.parameters.image, token);
        return result;
    };
    const result = await agent.createLabPlan({ kind: 'image', selectedModelId: 'reference', instruction: 'Use the reference', parameters: { prompt: 'Poster', image } });
    assert.equal(result.plan.parameters.image, image);
    assert.equal(result.plan.parameters.prompt, 'Planned');
    assert.equal(lab.planningAttachments.size, 0);
    await assert.rejects(lab.plan({ modelId: 'reference', parameters: { prompt: 'Poster', image: token } }), /unavailable/);
    agent.runPlanner = async () => { throw new Error('fixture failure'); };
    await assert.rejects(agent.createLabPlan({ kind: 'image', selectedModelId: 'reference', instruction: 'Use it', parameters: { image } }), /fixture failure/);
    assert.equal(lab.planningAttachments.size, 0);
});
