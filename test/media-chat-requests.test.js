const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaLabService, SLOT_LIMITS } = require('../server/media-lab-service');
const { MediaChatRequests } = require('../server/media-chat-requests');
const { loadMediaProfile } = require('../server/media-profile');
const { saveExternalMedia, mediaHistory, deleteMedia } = require('../server/media-lab-storage');
const { MiniMaxVideoService } = require('../server/minimax-video-service');
const { TtsProviderService } = require('../server/tts-provider-service');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-media-chat-test-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

function fixture({ fetch } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(root, 'instance-'));
    const profile = loadMediaProfile(path.join(__dirname, '..'), { PI_MEDIA_PROFILE: 'clean', PI_MEDIA_CONFIG_DIR: path.join(dataRoot, 'config') });
    profile.models.push({ id: 'fixture-image', name: 'Fixture image', kind: 'image', adapter: 'http-json', parameters: {
        prompt: { type: 'textarea', required: true, maxLength: 200 }, size: { type: 'text', default: '1024x1024', maxLength: 40 } },
    connection: { url: 'http://127.0.0.1:8200/generate', outputPath: ['data', 0, 'b64_json'], mimeType: 'image/png' } });
    const requests = [];
    const lab = new MediaLabService({ profile, videoService: new MiniMaxVideoService({ rootDir: dataRoot, apiKeyResolver: async () => 'fixture' }),
        ttsService: new TtsProviderService({ rootDir: path.join(__dirname, '..'), gpuExec: '' }),
        fetch: fetch || (async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) }; }),
        saveExternal: input => saveExternalMedia(dataRoot, input), history: kind => mediaHistory(dataRoot, kind),
        deleteMedia: (kind, id) => deleteMedia(dataRoot, kind, id), generateImage: async () => ({}), generateTts: async () => ({}) });
    const file = path.join(dataRoot, 'media_chat_requests.json');
    return { lab, requests, file, dataRoot, chat: new MediaChatRequests({ lab, file }) };
}
const settle = chat => chat.execution;

test('a confirmed card executes once, persists its result and requires an explicit second generation', async () => {
    const { lab, chat, requests, file } = fixture();
    const plan = await lab.plan({ modelId: 'fixture-image', summary: 'Cover', parameters: { prompt: 'A cat keeping accounts' } });
    assert.deepEqual(chat.status([plan.id]).requests[plan.id].attempts, []);
    const first = await chat.run({ key: plan.id, modelId: plan.modelId, parameters: plan.parameters, confirmed: true });
    assert.equal(first.status, 'running');
    // A second tab or double click while running cannot submit again.
    await assert.rejects(chat.run({ key: plan.id, modelId: plan.modelId, parameters: plan.parameters, confirmed: true }), error => error.statusCode === 409);
    await settle(chat);
    const done = chat.status([plan.id]).requests[plan.id].attempts;
    assert.equal(done.length, 1);
    assert.equal(done[0].status, 'done');
    assert.match(done[0].asset.url, /^\/images\/lab_/);
    assert.equal(requests.length, 1);
    await assert.rejects(chat.run({ key: plan.id, modelId: plan.modelId, parameters: plan.parameters, confirmed: true }), error => error.statusCode === 409 && error.state.attempts.length === 1);
    // Records survive a restart; the ticket itself is never written.
    const stored = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(stored, /ticket/);
    assert.equal(new MediaChatRequests({ lab, file }).status([plan.id]).requests[plan.id].attempts[0].status, 'done');
    await chat.run({ key: plan.id, modelId: plan.modelId, parameters: { ...plan.parameters, prompt: 'Edited in the card' }, confirmed: true, again: true });
    await settle(chat);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].prompt, 'Edited in the card');
    assert.equal(chat.status([plan.id]).requests[plan.id].attempts.length, 2);
});

test('values the server normalizes come back for another confirmation instead of executing', async () => {
    const { chat, requests } = fixture();
    const key = 'plan-00000000-0000-4000-8000-000000000001';
    const result = await chat.run({ key, modelId: 'fixture-image', parameters: { prompt: 'No size given' }, confirmed: true });
    assert.equal(result.status, 'changed');
    assert.equal(result.parameters.size, '1024x1024');
    assert.equal(requests.length, 0);
    assert.deepEqual(chat.status([key]).requests[key].attempts, []);
    await assert.rejects(chat.run({ key, modelId: 'fixture-image', parameters: result.parameters }), /explicit confirmation/);
});

test('failures are recorded without retry; a request interrupted by a restart becomes uncertain', async () => {
    let calls = 0;
    const { chat, lab, file } = fixture({ fetch: async () => { calls++; throw new Error('network down'); } });
    const key = 'plan-00000000-0000-4000-8000-000000000002';
    const parameters = { prompt: 'Fails', size: '1024x1024' };
    await chat.run({ key, modelId: 'fixture-image', parameters, confirmed: true });
    await settle(chat);
    const attempt = chat.status([key]).requests[key].attempts[0];
    assert.equal(attempt.status, 'uncertain');
    assert.equal(calls, 1);
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    records[0].attempts[0].status = 'running';
    fs.writeFileSync(file, JSON.stringify(records));
    const restarted = new MediaChatRequests({ lab, file });
    assert.equal(restarted.status([key]).requests[key].attempts[0].status, 'uncertain');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].attempts[0].status, 'uncertain');
});

test('unreadable records block new submissions without being overwritten', async () => {
    const { lab, dataRoot } = fixture();
    const file = path.join(dataRoot, 'broken.json');
    fs.writeFileSync(file, '{not json');
    const chat = new MediaChatRequests({ lab, file });
    await assert.rejects(chat.run({ key: 'plan-00000000-0000-4000-8000-000000000004', modelId: 'fixture-image', parameters: { prompt: 'x', size: '1x1' }, confirmed: true }), error => error.statusCode === 503);
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
    assert.throws(() => chat.status(['not-a-plan']), /plan ids/);
});

test('cards confirmed while every slot is busy queue in order, can be cancelled and never survive a restart as submitted', async () => {
    // Each request waits until the test releases it, like a slow image service.
    const releases = [], bodies = [];
    const { chat, lab, file } = fixture({ fetch: (url, options) => new Promise(resolve => {
        bodies.push(JSON.parse(options.body).prompt);
        releases.push(() => resolve({ ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) }));
    }) });
    const key = index => `plan-00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`;
    const total = SLOT_LIMITS.remote + 2;
    const results = [];
    for (let index = 0; index < total; index++) results.push(await chat.run({ key: key(index), modelId: 'fixture-image', parameters: { prompt: `card ${index}`, size: '1024x1024' }, confirmed: true }));
    assert.deepEqual(results.map(result => result.status), [...Array(SLOT_LIMITS.remote).fill('running'), 'queued', 'queued']);
    assert.equal(bodies.length, SLOT_LIMITS.remote);
    const waiting = chat.status([key(total - 2), key(total - 1)]).requests;
    assert.equal(waiting[key(total - 2)].attempts[0].position, 1);
    assert.equal(waiting[key(total - 1)].attempts[0].position, 2);
    // A queued card cannot be confirmed twice, and only queued requests can be cancelled.
    await assert.rejects(chat.run({ key: key(total - 2), modelId: 'fixture-image', parameters: { prompt: 'again', size: '1024x1024' }, confirmed: true, again: true }), error => error.statusCode === 409);
    assert.throws(() => chat.cancel({ key: key(0) }), error => error.statusCode === 409);
    assert.equal(chat.cancel({ key: key(total - 1) }).state.attempts[0].status, 'cancelled');
    // A queued request was never sent: after a restart it is "failed", never "uncertain".
    const restarted = new MediaChatRequests({ lab: { onSlotFree() {} }, file });
    assert.equal(restarted.status([key(total - 2)]).requests[key(total - 2)].attempts[0].status, 'failed');
    assert.match(restarted.status([key(total - 2)]).requests[key(total - 2)].attempts[0].error, /nothing was submitted/);
    // Freeing one slot starts the oldest queued card after a fresh review.
    releases.shift()();
    for (let i = 0; i < 50 && bodies.length === SLOT_LIMITS.remote; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(bodies.slice(SLOT_LIMITS.remote), [`card ${total - 2}`]);
    assert.equal(chat.status([key(total - 2)]).requests[key(total - 2)].attempts[0].status, 'running');
    for (const release of releases.splice(0)) release();
    await settle(chat);
    assert.equal(bodies.length, SLOT_LIMITS.remote + 1, 'the cancelled card is never sent');
    const final = chat.status(Array.from({ length: total }, (_, index) => key(index))).requests;
    assert.deepEqual(Object.values(final).map(state => state.attempts[0].status), [...Array(total - 1).fill('done'), 'cancelled']);
    assert.equal(lab.inFlight, 0);
});

test('local backends run one at a time while remote slots stay available', () => {
    const { lab } = fixture();
    assert.equal(lab.canExecute({ adapter: 'zimage', kind: 'image' }), true);
    lab.running.local = 1;
    assert.equal(lab.canExecute({ adapter: 'zimage', kind: 'image' }), false);
    assert.equal(lab.canExecute({ adapter: 'http-provider', kind: 'image' }), true);
    lab.running.video = SLOT_LIMITS.video; lab.running.remote = SLOT_LIMITS.video;
    assert.equal(lab.canExecute({ adapter: 'http-provider', kind: 'video' }), false);
    assert.equal(lab.canExecute({ adapter: 'http-provider', kind: 'tts' }), true);
});
