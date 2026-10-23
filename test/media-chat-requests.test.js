const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaLabService, SLOT_LIMITS } = require('../server/media-lab-service');
const { MediaReferences } = require('../server/media-references');
const { MediaChatRequests } = require('../server/media-chat-requests');
const { loadMediaProfile } = require('../server/media-profile');
const { saveExternalMedia, mediaHistory, deleteMedia } = require('../server/media-lab-storage');
const { MiniMaxVideoService } = require('../server/minimax-video-service');
const { TtsProviderService } = require('../server/tts-provider-service');
const { normalizeModel } = require('../server/media-provider-service');
const { MediaHttpExecutor } = require('../server/media-http-protocol');
const { Response } = require('node-fetch');

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
    lab.references = new MediaReferences({ directory: path.join(dataRoot, 'refs') });
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


test('image edit cards keep short references across confirmation, execution, restart and gallery reuse', async () => {
    const { lab, chat, requests, file } = fixture();
    lab.profile.models[lab.profile.models.length - 1].parameters.image = { type: 'image', required: true };
    const image = `data:image/png;base64,${png.toString('base64')}`;
    const ref = lab.references.put(image).ref;
    const plan = await lab.plan({ modelId: 'fixture-image', parameters: { prompt: 'Make the background blue', image: ref } });
    assert.equal(plan.parameters.image, ref);
    assert.equal(requests.length, 0, 'planning never calls the image provider');
    const review = await lab.review({ modelId: plan.modelId, parameters: plan.parameters });
    assert.equal(review.parameters.image, ref);
    lab.discard(review.ticket);
    await chat.run({ key: plan.id, modelId: plan.modelId, parameters: plan.parameters, confirmed: true });
    await settle(chat);
    assert.equal(requests[0].image, image, 'the provider receives actual bytes, never a reference token');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /base64/);
    const images = chat.images([plan.id]).images;
    assert.equal(images.length, 1);
    const followup = await lab.plan({ modelId: plan.modelId, parameters: { prompt: 'Make it green', image: images[0].url } });
    assert.match(followup.parameters.image, /^mediaref:/);
    const restarted = new MediaChatRequests({ lab, file });
    await restarted.run({ key: plan.id, modelId: plan.modelId, parameters: restarted.publicState(plan.id).attempts[0].parameters, confirmed: true, again: true });
    await settle(restarted);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].image, image);
    // A replacement uploaded in the editor is also stored as a short reference.
    const next = await chat.run({ key: followup.id, modelId: followup.modelId, parameters: { ...followup.parameters, image }, confirmed: true });
    assert.equal(next.status, 'running');
    assert.equal(next.parameters.image, ref);
    await settle(chat);
});

test('waitFor resolves when an active attempt settles and mediaChatExecution preference defaults to image+tts on, video off', async () => {
    const { lab, chat, dataRoot } = fixture();
    const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
    const prefs = new WorkspacePreferencesService({ agentDir: dataRoot });
    assert.deepEqual(prefs.getMediaChatExecution(), { image: true, tts: true, video: false, revision: 0 });
    const updated = prefs.setMediaChatExecution({ image: false, video: true, expectedRevision: 0 });
    assert.deepEqual(updated, { image: false, tts: true, video: true, revision: 1 });
    assert.throws(() => prefs.setMediaChatExecution({ image: true, expectedRevision: 0 }), error => error.statusCode === 409);
    const plan = await lab.plan({ modelId: 'fixture-image', summary: 'Auto wait', parameters: { prompt: 'Fast cat' } });
    await chat.run({ key: plan.id, modelId: plan.modelId, parameters: plan.parameters, confirmed: true });
    const state = await chat.waitFor(plan.id, 5000);
    assert.equal(state.attempts[0].status, 'done');
    assert.match(state.attempts[0].asset.url, /^\/images\/lab_/);
});

test('last slot-free save failure marks a queued card unsubmitted and requires explicit confirmation without blocking the next card', { timeout: 5000 }, async t => {
    const blockerRelease = Promise.withResolvers(), nextRelease = Promise.withResolvers();
    const bodies = [], executed = [], reviewed = [], errors = [];
    const { chat, lab, file } = fixture();
    const modelId = 'fixture-local';
    // One real execution slot makes this completion the last slot-free event.
    // The backend is synthetic; MediaLabService still owns execution and notifications.
    lab.fluxBaseUrl = 'http://fixture.invalid';
    lab.profile.models.push({ id: modelId, name: 'Synthetic local image', kind: 'image', adapter: 'flux2',
        parameters: { prompt: { type: 'text', required: true, maxLength: 200 } } });
    t.mock.method(lab, 'generateImage', async payload => {
        bodies.push(payload.prompt);
        if (payload.prompt === 'blocker') await blockerRelease.promise;
        if (payload.prompt === 'next card') await nextRelease.promise;
        return { image: { url: `/images/synthetic-${bodies.length}.png` } };
    });
    const [blocker, failedKey, nextKey] = [299, 300, 301].map(index => `plan-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const submit = (key, prompt, again = false) => chat.run({ key, modelId, parameters: { prompt }, confirmed: true, ...(again ? { again: true } : {}) });
    const save = chat.save.bind(chat), review = lab.review.bind(lab), execute = lab.execute.bind(lab);
    let fault = false, saveFaults = 0;
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    t.mock.method(chat, 'save', (...args) => {
        if (fault && chat.entries.get(failedKey)?.attempts.at(-1)?.status === 'running') {
            fault = false; saveFaults++;
            throw Object.assign(new Error('Synthetic ENOSPC at last slot-free'), { code: 'ENOSPC' });
        }
        return save(...args);
    });
    t.mock.method(lab, 'review', async input => {
        const result = await review(input);
        reviewed.push({ prompt: input.parameters.prompt, ticket: result.ticket });
        return result;
    });
    t.mock.method(lab, 'execute', (ticket, options) => {
        const attempt = [...chat.entries.values()].flatMap(entry => entry.attempts).find(attempt => attempt.ticket === ticket);
        const stored = JSON.parse(fs.readFileSync(file, 'utf8')).flatMap(entry => entry.attempts);
        assert.equal(stored.find(item => item.id === attempt.id).status, 'running', 'execution starts only after a durable reservation');
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /ticket/);
        executed.push({ prompt: attempt.parameters.prompt, ticket });
        return execute(ticket, options);
    });
    try {
        assert.equal((await submit(blocker, 'blocker')).status, 'running');
        assert.equal(lab.inFlight, 1);
        assert.equal((await submit(failedKey, 'retry card')).status, 'queued');
        assert.equal((await submit(nextKey, 'next card')).status, 'queued');
        const failedAttemptId = chat.publicState(failedKey).attempts[0].id;
        assert.deepEqual(bodies, ['blocker']);
        // Observe the actual notification's pump; never call pump from the test.
        const pumped = Promise.withResolvers(), pump = chat.pump.bind(chat);
        let notifications = 0;
        t.mock.method(chat, 'pump', async (...args) => {
            if (notifications++ === 0) assert.equal(lab.inFlight, 0, 'the last running request finished before dispatch');
            try { return await pump(...args); }
            finally { pumped.resolve(); }
        });
        fault = true;
        blockerRelease.resolve();
        await pumped.promise;
        assert.equal(saveFaults, 1);
        const failed = chat.status([failedKey]).requests[failedKey].attempts[0];
        assert.equal(failed.status, 'failed', 'a storage failure is visible instead of waiting indefinitely for another event');
        assert.equal(failed.id, failedAttemptId);
        assert.match(failed.error, /could not be saved.*nothing was submitted/i);
        assert.ok(failed.finishedAt);
        assert.equal(failed.startedAt, undefined);
        assert.equal(chat.entries.get(failedKey).attempts[0].ticket, undefined);
        assert.equal(executed.filter(item => item.prompt === 'retry card').length, 0);
        assert.equal(bodies.filter(prompt => prompt === 'retry card').length, 0);
        const discarded = reviewed.filter(item => item.prompt === 'retry card').at(-1).ticket;
        assert.equal(lab.tickets.has(discarded), false, 'the failed reservation never consumes or retains its fresh ticket');
        assert.ok(errors.some(message => /ENOSPC/.test(message)));
        assert.equal(chat.publicState(nextKey).attempts[0].status, 'running', 'the same slot-free dispatch continues to the next confirmation');
        assert.deepEqual(bodies, ['blocker', 'next card']);
        assert.equal(chat.waiting.length, 0);
        const stored = JSON.parse(fs.readFileSync(file, 'utf8')).find(entry => entry.key === failedKey).attempts[0];
        assert.equal(stored.status, 'failed');
        assert.equal(stored.id, failedAttemptId);
        assert.match(stored.error, /nothing was submitted/i);
        const restartFile = path.join(path.dirname(file), 'failed-restart.json');
        fs.copyFileSync(file, restartFile);
        const restarted = new MediaChatRequests({ lab: { onSlotFree() {} }, file: restartFile });
        assert.equal(restarted.publicState(failedKey).attempts[0].status, 'failed');
        assert.equal(restarted.waiting.length, 0, 'restart cannot replay a failed confirmation');
        await assert.rejects(submit(failedKey, 'retry card'), error => error.statusCode === 409 && error.state.attempts[0].status === 'failed');
        nextRelease.resolve();
        await chat.execution;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(lab.inFlight, 0);
        assert.equal(chat.publicState(failedKey).attempts[0].status, 'failed', 'later slot-free events never retry the failed confirmation');
        assert.equal(bodies.filter(prompt => prompt === 'retry card').length, 0);
        const confirmed = await submit(failedKey, 'retry card', true);
        assert.equal(confirmed.status, 'running');
        await chat.execution;
        const attempts = chat.publicState(failedKey).attempts;
        assert.deepEqual(attempts.map(attempt => attempt.status), ['failed', 'done']);
        assert.notEqual(attempts[1].id, failedAttemptId);
        assert.equal(executed.filter(item => item.prompt === 'retry card').length, 1);
        assert.equal(bodies.filter(prompt => prompt === 'retry card').length, 1, 'only explicit again submits the previously failed card, exactly once');
        assert.notEqual(executed.find(item => item.prompt === 'retry card').ticket, discarded);
        await assert.rejects(submit(failedKey, 'retry card'), error => error.statusCode === 409);
        assert.deepEqual(bodies, ['blocker', 'next card', 'retry card']);
        assert.equal(new MediaChatRequests({ lab: { onSlotFree() {} }, file }).publicState(failedKey).attempts.at(-1).status, 'done');
    } finally {
        fault = false; blockerRelease.resolve(); nextRelease.resolve();
        await chat.execution;
        await new Promise(resolve => setImmediate(resolve));
    }
});

function pollingFixture(fetch) {
    const f = fixture();
    const provider = { id: 'synthetic', baseUrl: 'http://fixture.invalid/api', auth: { mode: 'none' }, downloadOrigins: [] };
    const model = normalizeModel({ id: 'async-image', name: 'Async image', kind: 'image', remoteModel: 'synthetic-image',
        parameters: { prompt: { type: 'text', required: true } },
        http: { path: '/jobs', body: { input: { $params: true } },
            poll: { path: '/jobs/{id}', idPath: ['id'], statusPath: ['status'], pending: ['waiting'], succeeded: ['done'], failed: ['failed'], intervalMs: 1000 },
            response: { type: 'base64', path: ['output'], mimeType: 'image/png' } } });
    const modelId = 'media:synthetic:async-image';
    f.lab.providerService = {
        catalogModels: async () => [{ ...model, id: modelId, providerId: provider.id, managedModelId: model.id, adapter: 'http-provider', configured: true }],
        withExecution: async (_snapshot, operation) => operation({ provider, model, key: '' }), requestPreview: () => ({})
    };
    f.lab.httpExecutor = new MediaHttpExecutor({ fetch, delay: async () => {} });
    return { ...f, modelId };
}

test('accepted-task receipt save failure stays uncertain without polling or reposting and can resume after storage recovers', async t => {
    let posts = 0, gets = 0, fault = false;
    const errors = [], f = pollingFixture(async (_url, options) => {
        if (options.method === 'POST') {
            posts++; fault = true;
            return new Response(JSON.stringify({ id: 'accepted-task' }));
        }
        assert.equal(options.method, 'GET'); gets++;
        const attempt = JSON.parse(fs.readFileSync(f.file, 'utf8'))[0].attempts[0];
        assert.equal(attempt.status, 'running');
        assert.equal(attempt.remote.taskId, 'accepted-task', 'retrieval waits for a durable receipt');
        return new Response(JSON.stringify({ status: 'done', output: png.toString('base64') }));
    });
    const save = f.chat.save.bind(f.chat), tickets = [], execute = f.lab.execute.bind(f.lab);
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    t.mock.method(f.chat, 'save', (...args) => {
        if (fault) throw Object.assign(new Error('Synthetic receipt ENOSPC'), { code: 'ENOSPC' });
        return save(...args);
    });
    t.mock.method(f.lab, 'execute', (ticket, options) => { tickets.push(ticket); return execute(ticket, options); });
    const plan = await f.lab.plan({ modelId: f.modelId, parameters: { prompt: 'One accepted task' } });
    await f.chat.run({ key: plan.id, modelId: f.modelId, parameters: plan.parameters, confirmed: true });
    await f.chat.execution;
    const uncertain = f.chat.publicState(plan.id).attempts[0];
    assert.equal(posts, 1); assert.equal(gets, 0, 'receipt failure stops before the first remote GET');
    assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.canResume, true);
    assert.equal(uncertain.taskId, 'accepted-task');
    assert.equal(f.lab.executionStatus(tickets[0]).status, 'uncertain');
    assert.doesNotMatch(JSON.stringify(uncertain), /pollUrl|binding|fixture.invalid/);
    assert.ok(errors.some(message => /ENOSPC/.test(message)));
    const stored = JSON.parse(fs.readFileSync(f.file, 'utf8'))[0].attempts[0];
    assert.equal(stored.status, 'running'); assert.equal(stored.remote, undefined);
    const restartFile = path.join(path.dirname(f.file), 'receipt-restart.json');
    fs.copyFileSync(f.file, restartFile);
    const restarted = new MediaChatRequests({ lab: { onSlotFree() {} }, file: restartFile });
    const recovered = restarted.publicState(plan.id).attempts[0];
    assert.equal(recovered.status, 'uncertain'); assert.equal(recovered.canResume, false);
    assert.doesNotMatch(recovered.error, /nothing was submitted/);
    await assert.rejects(restarted.resume({ key: plan.id, confirmed: true }), /No resumable/);
    await assert.rejects(f.chat.run({ key: plan.id, modelId: f.modelId, parameters: plan.parameters, confirmed: true }), error => error.statusCode === 409);
    await assert.rejects(execute(tickets[0]), /Previous submission failed or is uncertain/);
    assert.equal(posts, 1); assert.equal(gets, 0);
    fault = false;
    await f.chat.resume({ key: plan.id, confirmed: true });
    await f.chat.execution;
    const done = f.chat.publicState(plan.id).attempts[0];
    assert.equal(done.id, uncertain.id); assert.equal(done.status, 'done');
    assert.equal(posts, 1); assert.equal(gets, 1, 'explicit resume retrieves the accepted task without a new POST');
    assert.notEqual(tickets[0], tickets[1]);
    assert.equal(new MediaChatRequests({ lab: f.lab, file: f.file }).publicState(plan.id).attempts[0].status, 'done');
});
