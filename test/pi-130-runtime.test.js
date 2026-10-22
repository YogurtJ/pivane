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

async function executors(count, appendEntry = () => {}) {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const tools = [];
    for (let i = 0; i < count; i++) sdk.createCodemodeExtension({ models: false })({
        registerTool: tool => tools.push(tool), getSettings: () => ({}), getAllTools: () => [], appendEntry });
    return tools;
}
const text = result => result.content.map(item => item.text || '').join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('official executor queues FIFO across factories, cancels waiting scripts and counts wait against the deadline', { timeout: 15000 }, async () => {
    const savedLimit = process.env.PI_CODEMODE_MAX_WORKERS;
    delete process.env.PI_CODEMODE_MAX_WORKERS;
    const entries = [], order = [], pending = [];
    const tools = await executors(6, (...entry) => entries.push(entry));
    const gates = Array.from({ length: 4 }, deferred), entered = Array.from({ length: 4 }, deferred);
    const context = { sessionManager: { getBranch: () => [] },
        tools: [{ name: 'fixture_wait', description: 'Synthetic gate', parameters: { type: 'object', properties: { index: { type: 'number' } } } }],
        executeTool: async (_name, args) => { const index = args.index; order.push(index); entered[index].resolve(); await gates[index].promise;
            return { toolCall: { id: 'wait-' + index }, result: { content: [{ type: 'text', text: 'released' }] }, isError: false }; } };
    const run = (index, code, signal) => { const result = tools[index].execute(String(index), { code }, signal, undefined, context); pending.push(result); return result; };
    const gated = index => `await tools.fixture_wait({index:${index}}); return 1;`;
    try {
        const first = run(0, gated(0)), second = run(1, gated(1));
        await Promise.all(entered.slice(0, 2).map(item => item.promise));
        let thirdSettled = false, fourthSettled = false;
        const third = run(2, gated(2)).finally(() => { thirdSettled = true; });
        const fourth = run(3, gated(3)).finally(() => { fourthSettled = true; });
        const controller = new AbortController();
        const cancelled = run(4, 'store("forbidden", true); await tools.fixture_wait({});', controller.signal);
        controller.abort();
        assert.match(text(await cancelled), /Script aborted:[\s\S]*The script did not start/);
        const timedOut = await run(5, '// @options: {"timeout_ms": 40}\nstore("forbidden", true); await tools.fixture_wait({});');
        assert.equal(timedOut.isError, true);
        assert.match(text(timedOut), /40 ms while waiting for a free codemode worker/);
        assert.equal(order.length, 2);
        assert.equal(thirdSettled, false); assert.equal(fourthSettled, false);
        gates[0].resolve(); await first; await entered[2].promise;
        assert.deepEqual(order.slice(0, 2).sort(), [0, 1]); assert.equal(order[2], 2); assert.equal(fourthSettled, false);
        gates[2].resolve(); await third; await entered[3].promise;
        gates[3].resolve(); gates[1].resolve();
        for (const result of await Promise.all([second, fourth])) assert.equal(result.isError, undefined);
        // A later successful run also flushes admission after timed-out/cancelled waiters.
        assert.equal((await run(0, 'return 9;')).isError, undefined);
        assert.equal(order.length, 4, 'removed waiters must never execute later');
        assert.deepEqual(entries, [], 'failed waiting scripts must never persist store writes');
    } finally {
        gates.forEach(item => item.resolve()); await Promise.all(pending);
        if (savedLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS; else process.env.PI_CODEMODE_MAX_WORKERS = savedLimit;
    }
});

test('official executor reads valid worker limits and falls back for invalid values', { timeout: 15000 }, async () => {
    const savedLimit = process.env.PI_CODEMODE_MAX_WORKERS;
    const tools = await executors(4);
    try {
        for (const [value, capacity] of [['3', 3], ['0', 2], ['-1', 2], ['1.5', 2], ['invalid', 2]]) {
            process.env.PI_CODEMODE_MAX_WORKERS = value;
            const gates = Array.from({ length: capacity + 1 }, deferred), entered = Array.from({ length: capacity + 1 }, deferred);
            let calls = 0;
            const context = { sessionManager: { getBranch: () => [] },
                tools: [{ name: 'fixture_wait', description: 'Synthetic gate', parameters: { type: 'object', properties: {} } }],
                executeTool: async () => { const index = calls++; entered[index].resolve(); await gates[index].promise;
                    return { toolCall: { id: String(index) }, result: { content: [{ type: 'text', text: 'ok' }] }, isError: false }; } };
            const pending = Array.from({ length: capacity + 1 }, (_, i) => tools[i].execute(String(i),
                { code: (i === capacity ? '// @options: {"timeout_ms": 80}\n' : '') + 'await tools.fixture_wait({});' }, undefined, undefined, context));
            try {
                await Promise.all(entered.slice(0, capacity).map(item => item.promise));
                const waiting = await pending[capacity];
                assert.equal(waiting.isError, true);
                assert.match(text(waiting), /while waiting for a free codemode worker/, value);
                assert.equal(calls, capacity, value);
            } finally { gates.forEach(item => item.resolve()); await Promise.all(pending); }
        }
    } finally { if (savedLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS; else process.env.PI_CODEMODE_MAX_WORKERS = savedLimit; }
});

test('expired host reservation denies a sandbox launch resumed after timeout and discards store writes', { timeout: 5000 }, async () => {
    const { CodemodeSandbox, loadQuickJSWasm } = await import('@earendil-works/pi-codemode');
    const { MessageChannel } = require('node:worker_threads');
    const host = new MessageChannel(); host.port1.on('message', () => {});
    const wasm = await loadQuickJSWasm(), loading = deferred();
    let launches = 0, reserved = true;
    const exits = [];
    const sandbox = new CodemodeSandbox({ wasm: loading.promise, timeoutMs: 40,
        acquireWorker() { if (!reserved) throw new Error("The script already settled"); launches++; return () => {}; }, onWorkerStarted(exit) { exits.push(exit); } });
    try {
        const result = await sandbox.execute('store("forbidden", true); return 1;');
        assert.equal(result.error.kind, 'timeout'); assert.equal(result.storeWrites, undefined);
        assert.equal(launches, 0);
        reserved = false; loading.resolve(wasm);
        await tick();
        assert.equal(launches, 0);
        reserved = true;
        const recovered = await sandbox.execute('return 2;', { timeoutMs: 1000 });
        assert.equal(recovered.ok, true); assert.equal(recovered.value, 2);
        assert.equal(launches, 1, 'only the successful follow-up launches a worker');
    } finally { loading.resolve(wasm); await sandbox.close(); await Promise.all(exits); host.port1.close(); host.port2.close(); }
});

test('official executor retains cross-factory capacity until actual worker exit after abort', { timeout: 5000 }, async () => {
    const { Worker, MessageChannel } = require('node:worker_threads');
    const host = new MessageChannel(); host.port1.on('message', () => {});
    const originalTerminate = Worker.prototype.terminate, savedLimit = process.env.PI_CODEMODE_MAX_WORKERS;
    const held = new Map(), stopping = deferred(), entered = deferred();
    const tools = await executors(2);
    const context = { sessionManager: { getBranch: () => [] },
        tools: [{ name: 'fixture_enter', description: 'Synthetic started signal', parameters: { type: 'object', properties: {} } }],
        executeTool: async () => { entered.resolve(); return { toolCall: { id: 'entered' }, result: { content: [] }, isError: false }; } };
    Worker.prototype.terminate = function () {
        if (!held.has(this)) { held.set(this, deferred()); stopping.resolve(); }
        return held.get(this).promise;
    };
    process.env.PI_CODEMODE_MAX_WORKERS = '1';
    const controller = new AbortController();
    let waiting;
    try {
        const first = tools[0].execute('aborted', { code: 'await tools.fixture_enter({}); while (true) {}' }, controller.signal, undefined, context);
        await entered.promise; controller.abort();
        assert.equal((await first).isError, true); await stopping.promise;
        let settled = false;
        waiting = tools[1].execute('queued', { code: 'return 42;' }, undefined, undefined, context).finally(() => { settled = true; });
        const expired = await tools[0].execute('deadline', { code: '// @options: {"timeout_ms": 40}\nreturn 0;' }, undefined, undefined, context);
        assert.match(text(expired), /while waiting for a free codemode worker/);
        assert.equal(settled, false); assert.equal(held.size, 1);
        Worker.prototype.terminate = originalTerminate;
        for (const [worker, done] of held) done.resolve(await originalTerminate.call(worker));
        const result = await waiting;
        assert.equal(result.isError, undefined); assert.match(text(result), /42/);
    } finally {
        Worker.prototype.terminate = originalTerminate;
        controller.abort();
        for (const [worker, done] of held) done.resolve(await originalTerminate.call(worker));
        if (waiting) await waiting;
        if (savedLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS; else process.env.PI_CODEMODE_MAX_WORKERS = savedLimit;
        host.port1.close(); host.port2.close();
    }
});

test('executor subtracts queue wait from the script deadline before execution', { timeout: 5000 }, async () => {
    const savedLimit = process.env.PI_CODEMODE_MAX_WORKERS;
    process.env.PI_CODEMODE_MAX_WORKERS = '1';
    const entries = [], tools = await executors(2, (...entry) => entries.push(entry));
    const entered = deferred(), release = deferred();
    let calls = 0;
    const context = { sessionManager: { getBranch: () => [] },
        tools: [{ name: 'fixture_wait', description: 'Synthetic bounded gate', parameters: { type: 'object', properties: {} } }],
        executeTool: async () => {
            if (++calls === 1) { entered.resolve(); await release.promise; }
            else await new Promise(resolve => setTimeout(resolve, 200));
            return { toolCall: { id: String(calls) }, result: { content: [] }, isError: false };
        } };
    let timer, first, second;
    try {
        first = tools[0].execute('holder', { code: 'await tools.fixture_wait({});' }, undefined, undefined, context);
        await entered.promise;
        second = tools[1].execute('deadline', { code: '// @options: {"timeout_ms": 400}\nawait tools.fixture_wait({}); store("forbidden", true);' }, undefined, undefined, context);
        timer = setTimeout(() => release.resolve(), 280);
        const result = await second;
        assert.equal(result.isError, true);
        assert.match(text(result), /Script timed out/);
        assert.equal(calls, 2, 'the queued script was admitted before its remaining deadline expired');
        assert.deepEqual(entries, [], 'the remaining deadline prevents successful store commit');
    } finally {
        clearTimeout(timer); release.resolve(); await Promise.all([first, second]);
        if (savedLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS; else process.env.PI_CODEMODE_MAX_WORKERS = savedLimit;
    }
});
