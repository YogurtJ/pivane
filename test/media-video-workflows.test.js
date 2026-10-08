const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Response } = require('node-fetch');
const { normalizeModel } = require('../server/media-provider-service');
const { MediaHttpExecutor, validateHttp, defaultTimeout, MAX_TIMEOUT_MS } = require('../server/media-http-protocol');
const { MediaLabService } = require('../server/media-lab-service');
const { MediaChatRequests } = require('../server/media-chat-requests');
const { MediaReferences } = require('../server/media-references');
const { saveExternalMedia } = require('../server/media-lab-storage');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=';
const mp4 = Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0]);
const json = value => new Response(JSON.stringify(value));
function fixture(t, fetch) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-video-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const provider = { id: 'any-provider', baseUrl: 'http://fixture.invalid/api', auth: { mode: 'none' }, downloadOrigins: [] };
    const model = normalizeModel({ id: 'frames', name: 'Generic video', remoteModel: 'any-video', kind: 'video', parameters: {
        prompt: { type: 'text', required: true }, first: { type: 'image', role: 'first_frame' }, last: { type: 'image', role: 'last_frame' },
        clips: { type: 'video', multiple: true, maxItems: 3 }, images: { type: 'image', multiple: true, maxItems: 4 }
    }, http: { path: '/jobs', body: { input: { $params: true } },
        poll: { path: '/jobs/{id}', idPath: ['id'], statusPath: ['status'], pending: ['waiting'], succeeded: ['done'], failed: ['failed'], intervalMs: 1000 },
        response: { type: 'url', path: ['output'], mimeType: 'video/mp4' } } });
    const id = 'media:any-provider:frames';
    const providerService = {
        catalogModels: async () => [{ ...model, id, managedModelId: model.id, providerId: provider.id, adapter: 'http-provider', configured: true }],
        withExecution: async (_snapshot, operation) => operation({ provider, model, key: '' }), requestPreview: () => ({})
    };
    const lab = new MediaLabService({ profile: { models: [], image: {}, directory: root }, providerService,
        videoService: { getConfig: async () => ({ models: [] }), imagesDir: root + '/public/images', videosDir: root + '/public/videos' },
        ttsService: { getPublicConfig: () => ({ providers: [] }) }, saveExternal: input => saveExternalMedia(root, input) });
    lab.httpExecutor = new MediaHttpExecutor({ fetch, delay: async () => {} });
    lab.references = new MediaReferences({ directory: root + '/references' });
    const file = root + '/cards.json', chat = new MediaChatRequests({ lab, file });
    return { root, file, lab, chat, provider, model, id };
}

test('video defaults allow hours, preserve explicit budgets, and cap waits at 24 hours', () => {
    assert.equal(defaultTimeout('video'), 7200000);
    assert.equal(defaultTimeout('video', true), 7200000);
    assert.equal(defaultTimeout('image'), 600000);
    const http = { path: '/generate', body: {}, response: { type: 'binary', mimeType: 'video/mp4' } };
    assert.equal(validateHttp(http, {}, 'video').timeoutMs, 7200000);
    assert.equal(validateHttp({ ...http, timeoutMs: 21600000 }, {}, 'video').timeoutMs, 21600000);
    assert.equal(validateHttp({ ...http, timeoutMs: 600000 }, {}, 'video').timeoutMs, 600000);
    assert.throws(() => validateHttp({ ...http, timeoutMs: MAX_TIMEOUT_MS + 1 }, {}, 'video'), /timeout/);
});

test('execution applies defaults to valid saved contracts without an explicit budget', async t => {
    let budget; t.mock.method(AbortSignal, 'timeout', value => { budget = value; return new AbortController().signal; });
    const model = { kind: 'video', remoteModel: 'generic', parameters: {}, http: { path: '/video', body: {}, response: { type: 'binary', mimeType: 'video/mp4' } } };
    const executor = new MediaHttpExecutor({ fetch: async () => new Response(mp4) });
    await executor.execute({ provider: { baseUrl: 'http://fixture.invalid', auth: { mode: 'none' } }, key: '', model, parameters: {} });
    assert.equal(budget, 7200000);
});

test('frames and ordered video references submit once; timed-out/restarted cards retrieve the same task without POST', async t => {
    const requests = [], budgets = []; let abort = new AbortController(), stop = true;
    t.mock.method(AbortSignal, 'timeout', value => { budgets.push(value); return abort.signal; });
    const f = fixture(t, async (url, options) => {
        requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
        if (options.method === 'POST') return json({ id: 'remote-job-1' });
        if (new URL(url).pathname.endsWith('/jobs/remote-job-1')) {
            const stored = JSON.parse(fs.readFileSync(f.file));
            assert.equal(stored[0].attempts[0].remote.taskId, 'remote-job-1', 'receipt saved before first poll');
            if (stop) { abort.abort(); return json({ status: 'waiting' }); }
            return json({ status: 'done', output: 'http://fixture.invalid/api/output.mp4' });
        }
        assert.ok(url.endsWith('/output.mp4')); return new Response(mp4);
    });
    f.model.http.poll.path = '/jobs/{id}?prompt={param:prompt}';
    const image = f.lab.references.put(png).ref, video = f.lab.references.put('data:video/mp4;base64,' + mp4.toString('base64')).ref;
    const plan = await f.lab.plan({ modelId: f.id, parameters: { prompt: 'Pan from first to last', first: image, last: image, images: [image], clips: [video] } });
    assert.equal(requests.length, 0);
    await f.chat.run({ key: plan.id, modelId: f.id, parameters: plan.parameters, confirmed: true });
    await f.chat.execution;
    assert.equal(requests[0].body.input.first, png);
    assert.equal(requests[0].body.input.last, png);
    assert.equal(requests[0].body.input.clips[0], 'data:video/mp4;base64,' + mp4.toString('base64'));
    const state = f.chat.publicState(plan.id).attempts[0];
    assert.equal(state.status, 'uncertain'); assert.equal(state.canResume, true);
    assert.equal(state.taskId, 'remote-job-1'); assert.doesNotMatch(JSON.stringify(state), /pollUrl|binding|fixture.invalid/);
    const disk = JSON.parse(fs.readFileSync(f.file)); disk[0].attempts[0].status = 'running'; disk[0].attempts[0].parameters = null; fs.writeFileSync(f.file, JSON.stringify(disk));
    const resumed = new MediaChatRequests({ lab: f.lab, file: f.file });
    assert.equal(resumed.publicState(plan.id).attempts[0].canResume, true);
    await assert.rejects(resumed.resume({ key: plan.id }), /Confirm retrieval/);
    // Do not need the old source attachments to retrieve a previously submitted job.
    fs.rmSync(f.lab.references.directory, { recursive: true });
    stop = false; abort = new AbortController(); f.model.http.timeoutMs = 21600000;
    await resumed.resume({ key: plan.id, confirmed: true });
    await resumed.execution;
    const done = resumed.publicState(plan.id).attempts[0];
    assert.equal(done.status, 'done'); assert.match(done.asset.url, /^\/videos\//); assert.equal(done.id, state.id);
    assert.equal(requests.filter(row => row.method === 'POST').length, 1);
    assert.deepEqual(budgets, [7200000, 21600000]);
    const result = resumed.results([plan.id]).requests[0].attempts[0];
    assert.equal(result.reference, 'media-result:' + plan.id + '/' + state.id);
    f.lab.references = new MediaReferences({ directory: f.root + '/references-again' });
    const next = await f.lab.plan({ modelId: f.id, parameters: { prompt: 'Use finished video', clips: [result.asset.url] } });
    assert.match(next.parameters.clips[0], /^mediaref:/);
    assert.equal(await f.lab.references.resolve(next.parameters.clips[0], 'video'), 'data:video/mp4;base64,' + mp4.toString('base64'));
});

test('confirmed provider failure is failed; legacy terminal receipts project failure without rewriting or replay', async t => {
    let posts = 0, gets = 0, ticket;
    const f = fixture(t, async (_url, request) => {
        if (request.method === 'POST') { posts++; return json({ id: 'terminal-task' }); }
        gets++; return json({ status: 'failed' });
    });
    const execute = f.lab.execute.bind(f.lab);
    t.mock.method(f.lab, 'execute', (...args) => { ticket = args[0]; return execute(...args); });
    const plan = await f.lab.plan({ modelId: f.id, parameters: { prompt: 'A video' } });
    await f.chat.run({ key: plan.id, modelId: f.id, parameters: plan.parameters, confirmed: true }); await f.chat.execution;
    const state = f.chat.publicState(plan.id).attempts[0];
    assert.equal(state.status, 'failed'); assert.equal(state.remoteTerminal, true); assert.equal(state.canResume, false);
    assert.equal(f.lab.executionStatus(ticket).status, 'failed');
    await assert.rejects(f.lab.execute(ticket), /Previous submission failed or is uncertain/);
    await assert.rejects(f.chat.resume({ key: plan.id, confirmed: true }), /No resumable/);
    const disk = JSON.parse(fs.readFileSync(f.file)); disk[0].attempts[0].status = 'uncertain';
    fs.writeFileSync(f.file, JSON.stringify(disk)); const before = fs.readFileSync(f.file, 'utf8');
    const restored = new MediaChatRequests({ lab: f.lab, file: f.file });
    const legacy = restored.publicState(plan.id).attempts[0];
    assert.equal(legacy.status, 'failed'); assert.equal(legacy.id, state.id); assert.equal(legacy.canResume, false);
    assert.equal(restored.results([plan.id]).requests[0].attempts[0].status, 'failed');
    assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'the existing journal remains intact');
    await assert.rejects(restored.resume({ key: plan.id, confirmed: true }), /No resumable/);
    assert.equal(posts, 1); assert.equal(gets, 1);
});

test('recovery rejects connection changes and terminal provider failures; concurrent resume cannot duplicate a query', async t => {
    let posts = 0, gets = 0, failPoll = true, terminal = false, release;
    const f = fixture(t, async (_url, request) => {
        if (request.method === 'POST') { posts++; return json({ id: 'task' }); }
        gets++;
        if (failPoll) throw Error('offline');
        if (!terminal) await new Promise(resolve => { release = resolve; });
        return json({ status: 'failed' });
    });
    const plan = await f.lab.plan({ modelId: f.id, parameters: { prompt: 'A video' } });
    await f.chat.run({ key: plan.id, modelId: f.id, parameters: plan.parameters, confirmed: true }); await f.chat.execution;
    const before = gets; f.provider.baseUrl = 'http://other.invalid/api';
    await f.chat.resume({ key: plan.id, confirmed: true }); await f.chat.execution;
    assert.equal(gets, before); assert.equal(posts, 1);
    f.provider.baseUrl = 'http://fixture.invalid/api'; failPoll = false;
    const pending = f.chat.resume({ key: plan.id, confirmed: true });
    assert.ok(f.chat.preparing, 'maintenance sees the reservation before model discovery finishes');
    await assert.rejects(f.chat.resume({ key: plan.id, confirmed: true }), /already being submitted|No resumable/);
    await pending;
    while (!release) await new Promise(resolve => setImmediate(resolve));
    terminal = true; release(); await f.chat.execution;
    assert.equal(f.chat.publicState(plan.id).attempts[0].status, 'failed');
    assert.equal(f.chat.publicState(plan.id).attempts[0].canResume, false);
    await assert.rejects(f.chat.resume({ key: plan.id, confirmed: true }), /No resumable/);
    assert.equal(posts, 1);
});
