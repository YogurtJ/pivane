const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MediaReferences } = require('../server/media-references');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-chat-extension-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';

test('managed media tool uses the current branch image, preserves prompt text, and never executes a provider', async t => {
    const extension = path.join(__dirname, '../server/pi-media-chat-extension.ts');
    const { registerMediaChat } = require(process.env.PIVANE_TEST_PI_JITI).createJiti(extension)(extension);
    const events = new Map(), tools = new Map(), calls = [];
    let mediaResults = [];
    for (const key of ['PI_WEB_NAVIGATION_TOKEN', 'PI_WORKSPACE_INTERNAL_ORIGIN', 'PI_WORKSPACE_INTERNAL_TOKEN', 'PI_CODING_AGENT_DIR']) {
        const previous = process.env[key]; t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        process.env[key] = key === 'PI_CODING_AGENT_DIR' ? path.join(root, 'agent') : key.endsWith('ORIGIN') ? 'http://127.0.0.1:1' : 'synthetic';
    }
    const store = new MediaReferences({ directory: path.join(root, 'refs') });
    const model = { id: 'edit-fixture', kind: 'image', executable: true, parameters: { prompt: { type: 'textarea' }, image: { type: 'image', required: true } } };
    const { getSdk } = require('../server/pi-session-store');
    await getSdk();
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const route = new URL(url).pathname; calls.push(route);
        const body = options.body ? JSON.parse(options.body) : null;
        let data;
        if (route.startsWith('/api/media-agent/capabilities/')) data = { lab: { models: [model] } };
        else if (route === '/api/media-agent/references') data = store.put(body.data);
        else if (route === '/api/media-agent/validate') data = { plan: body.plan, ...(body.autoExecute && body.plan.modelId === 'auto-fixture' ? { autoExecution: { status: 'done', asset: { url: '/images/auto.png', kind: 'image' }, state: { attempts: [{ id: 'attempt-auto', status: 'done', asset: { url: '/images/auto.png', kind: 'image' } }] } } } : {}) };
        else if (route === '/api/media-agent/chat-images') { assert.deepEqual(body.keys, ['plan-11111111-2222-4333-8444-555555555555']); data = { images: [{ url: '/images/result.png' }] }; }
        else if (route === '/api/media-agent/chat-results') data = { requests: mediaResults.filter(row => body.keys.includes(row.key)) };
        else throw new Error('Unexpected request: ' + route);
        return { ok: true, json: async () => data };
    });
    registerMediaChat({ on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool) });
    let entries = [{ type: 'message', timestamp: '2026-01-01', message: { role: 'user', content: [{ type: 'image', data: png, mimeType: 'image/png' }] } }];
    const ctx = { mode: 'rpc', cwd: root, sessionManager: { getSessionFile: () => path.join(root, 'session.jsonl'), getBranch: () => entries } };
    events.get('session_start')({}, ctx);
    const tool = tools.get('media_generate');
    const run = parameters => tool.execute('fixture-call', { modelId: model.id, summary: 'Edit image', parameters }, new AbortController().signal, () => {}, ctx);
    const result = await run({ prompt: 'chat-image:-1', image: 'chat-image:-1' });
    assert.equal(result.details.plan.parameters.prompt, 'chat-image:-1', 'ordinary text is never interpreted as an attachment');
    assert.equal(await store.resolve(result.details.plan.parameters.image, 'image'), 'data:image/png;base64,' + png);
    assert.ok(!JSON.stringify(result).includes(png));
    await assert.rejects(run({ image: 'chat-image:2' }), /no attached image/);
    entries = [];
    await assert.rejects(run({ image: 'chat-image:-1' }), /no attached images/);
    entries = [{ type: 'message', message: { role: 'toolResult', toolName: 'media_generate', details: { plan: { id: 'plan-11111111-2222-4333-8444-555555555555' } } } }];
    assert.equal((await run({ image: 'chat-result:-1' })).details.plan.parameters.image, '/images/result.png');
    fs.writeFileSync(path.join(root, 'source.png'), Buffer.from(png, 'base64'));
    assert.match((await run({ image: 'file:source.png' })).details.plan.parameters.image, /^mediaref:/);
    await assert.rejects(run({ image: 'file:../outside.png' }), /不在当前项目/);
    const first = 'plan-11111111-2222-4333-8444-555555555555', last = 'plan-22222222-2222-4333-8444-555555555555';
    const attempt = 'aaaaaaaa-2222-4333-8444-555555555555';
    entries = [first, last].map((id, i) => ({ type: 'message', message: { role: 'toolResult', toolName: 'media_generate', details: { plan: { id, kind: i ? 'video' : 'image', summary: i ? 'Video' : 'First frame' } } } }));
    mediaResults = [{ key: first, attempts: [{ id: attempt, status: 'done', kind: 'image', asset: { kind: 'image', url: '/images/first.png' }, reference: 'media-result:' + first + '/' + attempt }] },
        { key: last, attempts: [{ id: attempt, status: 'done', kind: 'video', asset: { kind: 'video', url: '/videos/clip.mp4' }, reference: 'media-result:' + last + '/' + attempt }] }];
    Object.assign(model.parameters, { end: { type: 'image', role: 'last_frame' }, clips: { type: 'video', multiple: true } });
    const chained = await run({ image: 'media-result:' + first + '/' + attempt, end: 'chat-image:1', clips: ['chat-video:-1'] }).catch(e => e);
    assert.match(chained.message, /no attached images/);
    const composed = await run({ image: 'media-result:' + first + '/' + attempt, clips: ['media-result:' + last + '/' + attempt, 'chat-video:-1'] });
    assert.equal(composed.details.plan.parameters.image, '/images/first.png');
    assert.deepEqual(composed.details.plan.parameters.clips, ['/videos/clip.mp4', '/videos/clip.mp4']);
    await assert.rejects(run({ image: 'media-result:' + last + '/' + attempt }), /wrong media type/);
    const beforeReads = calls.length;
    const listing = JSON.parse((await tools.get('media_results').execute('results', { limit: 1 }, new AbortController().signal, () => {}, ctx)).content[0].text);
    assert.equal(listing.cards[0].summary, 'Video'); assert.equal(listing.nextOffset, 1);
    assert.ok(calls.slice(beforeReads).every(route => route === '/api/media-agent/chat-results'));
    entries = [];
    await assert.rejects(run({ image: 'media-result:' + first + '/' + attempt }), /not in the current conversation branch/);
    assert.ok(calls.every(url => url.startsWith('/api/media-agent/')));
    assert.ok(!calls.some(url => /execute|review/.test(url)));
    // Auto-executed result reports completion and enforces per-turn cap (MAX_AUTO_PER_TURN = 4)
    model.id = 'auto-fixture';
    events.get('turn_start')({}, ctx);
    for (let i = 0; i < 4; i++) {
        const autoRes = await tool.execute(`auto-${i}`, { modelId: 'auto-fixture', summary: `Auto ${i}`, parameters: { prompt: 'cat', image: '/images/first.png' } }, new AbortController().signal, () => {}, ctx);
        assert.match(autoRes.content[0].text, /Media generated automatically/);
        assert.equal(autoRes.details.autoExecution?.status, 'done');
    }
    const fifth = await tool.execute('auto-5', { modelId: 'auto-fixture', summary: 'Auto 5', parameters: { prompt: 'cat', image: '/images/first.png' } }, new AbortController().signal, () => {}, ctx);
    assert.match(fifth.content[0].text, /Card ready for the user to confirm/);
    assert.equal(fifth.details.autoExecution, undefined);
});
