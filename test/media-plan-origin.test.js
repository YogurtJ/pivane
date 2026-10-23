const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaLabService } = require('../server/media-lab-service');
const { MediaChatRequests } = require('../server/media-chat-requests');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-origin-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const planId = 'plan-11111111-2222-4333-8444-555555555555';
const plan = { version: 1, id: planId, kind: 'image', modelId: 'fixture', summary: 'Origin fixture', parameters: { prompt: 'Synthetic' }, warnings: [] };

async function extensionFixture(t) {
    for (const key of ['PI_WEB_NAVIGATION_TOKEN', 'PI_WORKSPACE_INTERNAL_ORIGIN', 'PI_WORKSPACE_INTERNAL_TOKEN']) {
        const before = process.env[key];
        t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
        process.env[key] = key.endsWith('ORIGIN') ? 'http://127.0.0.1:1' : 'synthetic';
    }
    const { getSdk } = require('../server/pi-session-store');
    const { SessionManager } = await getSdk();
    const manager = SessionManager.create(root, fs.mkdtempSync(path.join(root, 'session-')));
    manager.appendMessage({ role: 'user', content: 'Generate a synthetic image', timestamp: 1 });
    const events = new Map(), tools = new Map(), calls = [], published = [];
    const fixture = { manager, calls, published, append: (type, data) => manager.appendCustomEntry(type, data) };
    const extension = path.join(__dirname, '../server/pi-media-chat-extension.ts');
    const { registerMediaChat } = require(process.env.PIVANE_TEST_PI_JITI).createJiti(extension)(extension);
    registerMediaChat({ on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool), appendEntry: (type, data) => fixture.append(type, data) });
    fixture.controller = new AbortController();
    const ctx = { mode: 'rpc', cwd: root, sessionManager: manager };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.includes('/capabilities/')) return { ok: true, json: async () => ({ lab: { models: [{ id: 'fixture', kind: 'image', parameters: {} }] } }) };
        const body = JSON.parse(options.body); calls.push({ endpoint, body, signal: options.signal });
        let data;
        if (endpoint.endsWith('/chat-results')) data = { requests: [{ key: planId, attempts: [{ id: 'attempt', status: 'uncertain', canResume: true }] }] };
        else if (body.stage === 'prepare') data = { plan, executionToken: 'private-preparation-token' };
        else {
            const reopened = SessionManager.open(manager.getSessionFile());
            const source = reopened.getBranch().find(entry => entry.customType === 'pivane-media-plan');
            assert.equal(source?.data.toolCallId, 'native-tool-call', 'native origin must be on disk before any execution request');
            assert.deepEqual(source.data.plan, plan);
            assert.doesNotMatch(fs.readFileSync(manager.getSessionFile(), 'utf8'), /private-preparation-token/);
            assert.equal(options.signal, fixture.controller.signal, 'cancellation remains attached to execution wait');
            if (fixture.failWait) return fixture.failWait();
            fixture.controller.abort();
            throw new DOMException('Synthetic wait stopped after execution accepted', 'AbortError');
        }
        return { ok: true, json: async () => data };
    });
    events.get('session_start')({}, ctx);
    fixture.run = () => tools.get('media_generate').execute('native-tool-call', { modelId: 'fixture', summary: plan.summary, parameters: plan.parameters }, fixture.controller.signal, () => {}, ctx);
    fixture.results = () => tools.get('media_results').execute('results', {}, new AbortController().signal, () => {}, ctx);
    return fixture;
}

test('stopping an execution wait preserves native plan/toolCall provenance for branch-only recovery', async t => {
    const f = await extensionFixture(t);
    await assert.rejects(f.run(), /Synthetic wait stopped/);
    assert.deepEqual(f.calls.map(call => call.body.stage), ['prepare', 'execute']);
    const before = f.calls.length;
    const results = JSON.parse((await f.results()).content[0].text);
    assert.equal(results.cards[0].key, planId);
    assert.equal(results.cards[0].attempts[0].canResume, true);
    assert.ok(f.calls.slice(before).every(call => call.endpoint.endsWith('/chat-results')), 'recovery only reads existing attempts');
    f.manager.appendMessage({ role: 'toolResult', toolName: 'media_generate', toolCallId: 'native-tool-call', content: [], details: { plan: { ...plan, summary: 'Stale legacy summary' } } });
    const deduplicated = JSON.parse((await f.results()).content[0].text);
    assert.equal(deduplicated.total, 1, 'native origin and legacy tool result share one card identity');
    assert.equal(deduplicated.cards[0].summary, plan.summary, 'native origin takes priority over a legacy duplicate');
    f.manager.branch(f.manager.getBranch().find(entry => entry.type === 'message').id);
    assert.equal(JSON.parse((await f.results()).content[0].text).total, 0, 'another branch cannot inherit unrelated cards');
});

test('native append failure or missing readback never reaches execution', async t => {
    for (const failure of ['throw', 'missing']) await t.test(failure, async t => {
        const f = await extensionFixture(t);
        f.append = () => { if (failure === 'throw') throw new Error('Synthetic native ENOSPC'); };
        await assert.rejects(f.run(), /ENOSPC|persist/);
        assert.deepEqual(f.calls.map(call => call.body.stage), ['prepare']);
    });
});

test('preparation tokens bind one canonical plan and concurrent duplicates never submit twice', async () => {
    let clock = 0, submissions = 0;
    const lab = new MediaLabService({ now: () => clock, profile: { models: [] } });
    lab.plan = async () => structuredClone(plan);
    const file = path.join(root, 'requests.json');
    lab.review = async input => ({ ticket: 'synthetic-ticket', model: { id: 'fixture', kind: 'image', executable: true }, parameters: input.parameters });
    lab.canExecute = () => true;
    lab.execute = async () => { submissions++; return { result: { image: { url: '/images/synthetic.png' } } }; };
    lab.chatRequests = new MediaChatRequests({ lab, file });
    const prepared = await lab.prepareChatPlan({ modelId: 'fixture', toolCallId: 'native-tool-call', autoExecute: true });
    assert.equal(submissions, 0);
    assert.equal(prepared.plan.id, planId);
    prepared.plan.parameters.prompt = 'Tampered after prepare';
    const commit = { executionToken: prepared.executionToken, planId, toolCallId: 'native-tool-call' };
    await assert.rejects(lab.executeChatPlan({ ...commit, toolCallId: 'wrong' }, { image: true }), /identity/);
    await Promise.all([lab.executeChatPlan(commit, { image: true }), lab.executeChatPlan(commit, { image: true })]);
    await lab.chatRequests.execution;
    assert.equal(submissions, 1);
    const recovered = await lab.executeChatPlan(commit, { image: true });
    assert.equal(recovered.autoExecution.state.attempts.length, 1);
    assert.equal(recovered.autoExecution.status, 'done');
    assert.equal(recovered.autoExecution.state.attempts[0].parameters.prompt, 'Synthetic');
    assert.equal(recovered.autoExecution.state.attempts[0].toolCallId, 'native-tool-call');
    assert.equal(submissions, 1);
    clock = 600001;
    await assert.rejects(lab.executeChatPlan(commit, { image: true }), /expired|unavailable/);
    assert.equal(submissions, 1);
});

test('preparations reserve bounded capacity before await and expire without executing', async () => {
    let clock = 0;
    const lab = new MediaLabService({ now: () => clock, profile: { models: [] } });
    const release = Promise.withResolvers();
    lab.plan = async () => { await release.promise; return structuredClone(plan); };
    const pending = Array.from({ length: 100 }, (_, index) => lab.prepareChatPlan({ toolCallId: `call-${index}`, plan: {} }));
    await assert.rejects(lab.prepareChatPlan({ toolCallId: 'over-cap', plan: {} }), error => error.statusCode === 429);
    release.resolve(); await Promise.all(pending);
    clock = 600001;
    assert.ok((await lab.prepareChatPlan({ toolCallId: 'after-expiry', plan: {} })).executionToken);
    assert.equal(lab.chatPreparations.size, 1);
    lab.plan = async () => ({ ...plan, parameters: { prompt: 'x'.repeat(8 * 1024 * 1024) } });
    await assert.rejects(lab.prepareChatPlan({ toolCallId: 'oversize', plan: {} }), /memory limit/);
    assert.equal(lab.chatPreparations.size, 1, 'failed preparation frees its reserved capacity');
});

test('disabled policy and pre-execution journal failure consume authorization without retry', async t => {
    for (const outcome of ['disabled', 'save-failure']) await t.test(outcome, async () => {
        let posts = 0;
        const lab = new MediaLabService({ profile: { models: [] } });
        lab.plan = async () => structuredClone(plan);
        lab.review = async input => ({ ticket: 'synthetic', model: { id: 'fixture', kind: 'image', executable: true }, parameters: input.parameters });
        lab.canExecute = () => true; lab.discard = () => {};
        lab.execute = async () => { posts++; return {}; };
        lab.chatRequests = new MediaChatRequests({ lab, file: path.join(root, outcome + '.json') });
        const save = lab.chatRequests.save.bind(lab.chatRequests);
        if (outcome === 'save-failure') lab.chatRequests.save = () => { throw new Error('Synthetic origin journal ENOSPC'); };
        const prepared = await lab.prepareChatPlan({ toolCallId: 'native-tool-call', autoExecute: true, plan: {} });
        const commit = { executionToken: prepared.executionToken, planId, toolCallId: 'native-tool-call' };
        const response = await lab.executeChatPlan(commit, { image: outcome !== 'disabled' });
        assert.equal(response.autoExecution.status, 'not_started');
        if (outcome === 'save-failure') assert.match(response.autoExecution.error, /ENOSPC/);
        lab.chatRequests.save = save;
        await lab.executeChatPlan(commit, { image: true });
        assert.equal(posts, 0, 'a duplicate token cannot retry even after policy or storage recovers');
        assert.equal(lab.chatRequests.publicState(planId).attempts.length, 0);
    });
});

test('a lost execution HTTP response recovers the same native card using local status reads', async t => {
    const f = await extensionFixture(t);
    f.failWait = () => { throw new Error('Synthetic execution response lost'); };
    await assert.rejects(f.run(), /response lost/);
    assert.equal(f.controller.signal.aborted, false);
    const before = f.calls.length;
    const result = JSON.parse((await f.results()).content[0].text);
    assert.equal(result.cards[0].key, planId);
    assert.equal(result.cards[0].status, 'uncertain');
    assert.equal(result.cards[0].attempts[0].canResume, true);
    assert.deepEqual(f.calls.slice(before).map(call => call.endpoint), ['/api/media-agent/chat-results']);
    assert.equal(f.calls.filter(call => call.body.stage === 'execute').length, 1);
});
