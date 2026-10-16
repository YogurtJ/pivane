'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-pi130-runtime-')));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

test('GPT-6 API-key effort updates preserve request effort and record native replay metadata; ChatGPT login omits them', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null,
        modelsStorePath: path.join(root, 'catalog.json'), allowModelNetwork: false });
    const model = runtime.getModels().find(m => m.provider === 'openai' && m.api === 'openai-responses' && m.id.startsWith('gpt-6') && m.compat?.supportsMidConvoEffort);
    assert.ok(model, 'reviewed catalog declares the capability');
    const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-responses');
    const messages = [{ role: 'user', content: 'Synthetic cache fixture', timestamp: 1 }];
    const captured = [];
    for (const reasoning of ['high', 'low']) {
        const stream = streamSimple(model, { messages }, { apiKey: 'sk-synthetic', reasoning,
            onPayload: payload => { captured.push(payload); throw new Error('Synthetic stop before HTTP dispatch'); } });
        const result = await stream.result();
        assert.equal(result.stopReason, 'error');
        assert.equal(result.providerThinkingLevel, model.thinkingLevelMap?.[reasoning] || reasoning);
        assert.equal(captured.at(-1).reasoning.effort, 'medium');
        assert.equal(captured.at(-1).input.at(-1).type, 'configuration_update');
        assert.equal(captured.at(-1).input.at(-1).reasoning.effort, result.providerThinkingLevel);
    }
    const signedIn = streamSimple(model, { messages }, { apiKey: 'synthetic-oauth', reasoning: 'high',
        onPayload: payload => { captured.push(payload); throw new Error('Synthetic stop before HTTP dispatch'); } });
    assert.equal((await signedIn.result()).providerThinkingLevel, undefined);
    assert.equal(captured.at(-1).input.some(item => item.type === 'configuration_update'), false);
    assert.equal(captured.at(-1).reasoning.effort, model.thinkingLevelMap?.high || 'high');
});

test('native sandbox keeps capacity reserved through actual VM exit after repeated timeout or abort', { timeout: 15000 }, async () => {
    // Real RPC hosts retain stdin/IPC. Keep an equivalent host handle while
    // cancelled VM workers unref themselves; an exit promise alone is not a ref.
    const { MessageChannel } = require('node:worker_threads');
    const host = new MessageChannel(); host.port1.on('message', () => {});
    const { CodemodeSandbox } = await import('@earendil-works/pi-codemode');
    let live = 0, reservations = 0, releases = 0;
    const exits = [];
    let entered;
    const sandbox = new CodemodeSandbox({ timeoutMs: 1000,
        acquireWorker() { live++; reservations++; return () => { live--; releases++; }; },
        onWorkerStarted(exited) { exits.push(exited); },
        tools: [{ name: 'entered', execute() { entered.resolve(); return null; } }] });
    try {
        for (const mode of ['abort', 'timeout', 'abort', 'timeout']) {
            entered = deferred(); const controller = new AbortController();
            const pending = sandbox.execute('await tools.entered({}); store("failed",true); while(true){}', { signal: controller.signal });
            await entered.promise;
            if (mode === 'abort') controller.abort();
            const result = await pending;
            assert.equal(result.ok, false);
            assert.equal(result.error.kind, mode === 'abort' ? 'aborted' : 'timeout');
            assert.equal(result.storeWrites, undefined);
            await Promise.all(exits);
            assert.equal(live, 0);
            assert.equal(reservations, releases);
        }
        const recovered = await sandbox.execute('store("ok",true); return 3;');
        assert.equal(recovered.ok, true);
        assert.equal(recovered.value, 3);
        await Promise.all(exits);
        assert.equal(live, 0);
    } finally { await sandbox.close(); await Promise.all(exits); host.port1.close(); host.port2.close(); }
});

test('official Codemode executor limits concurrent VM workers across factory instances in one process', { timeout: 15000 }, async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const tools = [];
    for (let i = 0; i < 3; i++) sdk.createCodemodeExtension({ models: false })({
        registerTool: tool => tools.push(tool), getSettings: () => ({}), getAllTools: () => [], appendEntry() {} });
    const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
    let calls = 0;
    const context = { sessionManager: { getBranch: () => [] },
        tools: [{ name: 'fixture_wait', description: 'Synthetic gate', parameters: { type: 'object', properties: {} } }],
        executeTool: async () => { const index = calls++; entered[index].resolve(); await gates[index].promise;
            return { toolCall: { id: 'wait-' + index }, result: { content: [{ type: 'text', text: 'released' }] }, isError: false }; } };
    const first = tools[0].execute('one', { code: 'await tools.fixture_wait({}); return 1;' }, undefined, undefined, context);
    const second = tools[1].execute('two', { code: 'await tools.fixture_wait({}); return 2;' }, undefined, undefined, context);
    try {
        await Promise.all(entered.map(item => item.promise));
        const denied = await tools[2].execute('three', { code: 'return 3;' }, undefined, undefined, context);
        assert.equal(denied.isError, true);
        assert.match(denied.content.map(item => item.text).join('\n'), /worker limit reached/);
        assert.equal(calls, 2);
    } finally { gates.forEach(item => item.resolve()); await Promise.all([first, second]); }
});
