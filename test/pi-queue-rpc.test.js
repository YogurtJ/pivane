const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-queue-rpc-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const { PiSessionStore } = require('../server/pi-session-store');
const refs = require('../public/pi-document-references');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const document = { id: 'd'.repeat(64), revision: 'e'.repeat(64), name: 'report.pdf', format: 'pdf', size: 42 };
async function waitFor(predicate) {
    for (let n = 0; n < 400; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('queue fixture condition timed out');
}

test('managed synthetic RPC: image/document/template queue recovery, durable ack, actual native proof and crash reconstruction', { timeout: 120000 }, async t => {
    let hold = true, requests = 0;
    const held = new Set();
    const finish = res => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 } }) + '\n\ndata: [DONE]\n\n');
    };
    const provider = http.createServer(async (req, res) => {
        for await (const _ of req) {} requests++;
        if (!hold) return finish(res);
        held.add(res); res.on('close', () => held.delete(res));
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
    fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
        models: [{ id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 8192, maxTokens: 1024, reasoning: false }]
    } } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', compaction: { enabled: false } }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'prompts', 'queued.md'), '---\ndescription: fixture template\n---\nExpanded requirement: $1\n');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'extensions', 'input.ts'), `export default function(pi) {
        pi.on('input', async event => {
            if (event.text === 'timeout before agent start') await new Promise(resolve => setTimeout(resolve, 1500));
            if (event.text === 'transform fixture') return { action: 'transform', text: 'Transformed requirement', images: event.images };
            if (event.text.startsWith('expand boundary')) {
                await new Promise(resolve => setTimeout(resolve, 100));
                return { action: 'transform', text: 'Expanded quota payload ' + 'E'.repeat(4000),
                    images: [...(event.images || []), { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
            }
        });
        pi.on('message_start', async (event, ctx) => {
            if (event.message.role === 'user' && event.message.content?.some(block => block.text === 'drained first')) {
                ctx.ui.setStatus('queue-fixture', 'drained'); await new Promise(resolve => setTimeout(resolve, 1500));
            }
        });
    }`);
    const store = new PiSessionStore();
    let supervisor = new PiAgentSupervisor();
    t.after(async () => {
        await supervisor.dispose(); for (const res of held) res.destroy(); provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
    });
    const session = await store.createSession(root, 'Queue fixture');
    let worker = await supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    assert.equal(worker.queueAdapterReady, true);
    const forwarded = []; const unsubscribe = worker.subscribe(event => forwarded.push(event));
    worker._handleEvent({ type: 'pivane_queue', token: 'foreign-runtime', sessionId: session.id, phase: 'queued', id: 'foreign' });
    worker._handleEvent({ type: 'pivane_queue', token: worker.queueToken, sessionId: 'foreign-session', phase: 'persisted', id: 'foreign' });
    worker._handleEvent({ type: 'pivane_queue', phase: 'malformed' });
    assert.equal(forwarded.length, 0, 'private queue evidence is intercepted even when stale, foreign or malformed');
    unsubscribe();
    // A timed-out prompt can still finish native preflight later while get_state reports idle.
    await assert.rejects(worker.request('prompt', { message: 'timeout before agent start' }, 20), error => error.code === 'RPC_TIMEOUT');
    assert.equal(worker.promptPending, 0); assert.equal(worker.promptAdmissionUncertain, true);
    assert.equal(worker.activity.snapshot().busy, false); assert.equal(worker.controls.recoveries.length, 0);
    const unobserved = await worker.request('get_state');
    assert.equal(unobserved.isStreaming, false); assert.equal(unobserved.pendingMessageCount, 0);
    assert.ok(worker.lifecycle().blockers.includes('prompt-admission-uncertain'));
    assert.equal(worker.isIdle(), false); assert.equal(supervisor.isIdle(), false);
    assert.equal(worker.promptAdmissionUncertain, true, 'idle snapshots never cancel unobserved future preflight');
    await assert.rejects(supervisor.acquireQueueReferenceLease(), /会话正在执行/);
    await assert.rejects(supervisor.withSessionMove(session.path, path.join(root, 'uncertain-move.jsonl'), () => {}), /会话正在运行/);
    const admissionRuntime = worker.controls.runtimeId, beforeTerminationRequests = requests;
    const admissionExit = once(worker, 'exit'); worker.client.child.kill('SIGKILL'); await admissionExit;
    worker = await supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    assert.notEqual(worker.controls.runtimeId, admissionRuntime); assert.equal(worker.promptAdmissionUncertain, false);
    assert.equal(requests, beforeTerminationRequests, 'terminating preflight starts no model and reconstructs without replay');
    const readRequest = worker.client.request.bind(worker.client);
    worker.client.request = (type, ...args) => type === 'get_session_stats'
        ? Promise.reject(Object.assign(new Error('controlled read timeout'), { code: 'RPC_TIMEOUT' })) : readRequest(type, ...args);
    await assert.rejects(worker.request('get_session_stats'), /controlled read timeout/);
    assert.equal(worker.promptAdmissionUncertain, false, 'read-only timeouts do not block prompt admission');
    worker.client.request = readRequest;
    await worker.request('prompt', { message: 'hold current turn' }); await waitFor(() => held.size);
    assert.equal(worker.controls.recoveries.length, 0, 'ordinary immediate input creates no queue journal');
    const raw = 'same ' + refs.marker(document);
    await worker.request('steer', { message: raw, images: [image] });
    await worker.request('follow_up', { message: raw, images: [{ ...image, data: 'aGVsbG8=' }] });
    await worker.request('steer', { message: '/queued original', images: [image] });
    await worker.request('steer', { message: 'transform fixture', images: [image] });
    assert.equal(worker.controls.intentions.length, 4, JSON.stringify((await supervisor.getQueueStore()).read().entries.map(item => ({ id: item.id, state: item.state, original: item.original.message }))));
    const privateQueueEvents = [];
    const queueHandler = worker.handleQueueEvent.bind(worker);
    worker.handleQueueEvent = event => { privateQueueEvents.push({ phase: event.phase, id: event.id, ids: event.ids, legacy: event.legacy }); return queueHandler(event); };
    const sent = requests;
    const recovery = await worker.recoverQueue(true);
    assert.equal(requests, sent, 'clear+abort never replay queued messages');
    assert.equal(recovery.recoveries.length, 4);
    assert.ok(recovery.recoveries.every(item => item.status === 'recovered'));
    assert.equal(JSON.stringify(recovery).includes(png), false, 'snapshots only carry image metadata');
    assert.ok(recovery.recoveries.some(item => item.steering.some(text => /Expanded requirement: original/.test(text))));
    assert.ok(recovery.recoveries.some(item => item.steering.includes('Transformed requirement')));
    const full = recovery.recoveries.map(item => worker.recoveryPayload({ recoveryId: item.id, runtimeId: recovery.runtimeId, revision: recovery.revision }));
    assert.equal(full.filter(item => item.original.message === raw).length, 2);
    const templateRecovery = full.find(item => item.original.message === '/queued original');
    assert.ok(templateRecovery, JSON.stringify({ items: full.map(item => ({ original: item.original.message, legacy: item.legacy, state: item.state })), events: privateQueueEvents }));
    assert.deepEqual(templateRecovery.payload.images, [image]);
    // abort's RPC acknowledgement can precede the matching SDK-call completion
    // frame. Recovered drafts remain, but actual execution must have ended.
    await waitFor(() => !worker.lifecycle().activity.busy);
    assert.equal(worker.runStartupCalls.size, 0);
    const documents = await supervisor.protectedDocuments(); assert.equal(documents.complete, true); assert.deepEqual(documents.ids, [document.id]);
    const release = await supervisor.acquireQueueReferenceLease();
    await assert.rejects(worker.request('prompt', { message: 'blocked by queue reference lease' }), /核验/);
    assert.equal((await supervisor.protectedDocuments()).revision, documents.revision); release();
    let queueStore = await supervisor.getQueueStore();
    const originalSave = queueStore.save;
    queueStore.save = () => { throw new Error('controlled ack persistence failure'); };
    assert.throws(() => worker.acknowledgeRecovery(full[0].id), /ack persistence/);
    assert.equal(worker.controls.recoveries.length, 4);
    queueStore.save = originalSave;
    const oldRuntime = worker.controls.runtimeId;
    await supervisor.dispose();
    supervisor = new PiAgentSupervisor();
    worker = await supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    queueStore = await supervisor.getQueueStore();
    assert.notEqual(worker.controls.runtimeId, oldRuntime);
    assert.equal(worker.controls.recoveries.length, 4); assert.equal(requests, sent);
    assert.throws(() => worker.recoveryPayload({ recoveryId: full[0].id, runtimeId: oldRuntime, revision: recovery.revision }), /已变化/);
    const target = path.join(root, 'target.jsonl');
    await assert.rejects(supervisor.withSessionMove(session.path, target, () => {}), /先处理/);
    const fork = await store.createSession(root, 'Fork fixture');
    const forkWorker = await supervisor.getWorker({ cwd: root, sessionPath: fork.path, sessionId: fork.id });
    assert.equal(forkWorker.controls.recoveries.length, 0);
    await forkWorker.request('prompt', { message: 'first queue-intended immediate race', streamingBehavior: 'steer' });
    await waitFor(() => forkWorker.activity.snapshot().busy && held.size && !forkWorker.controls.intentions.length && !forkWorker.controls.recoveries.length);
    assert.equal(forkWorker.controls.intentions.length, 0);
    assert.equal(forkWorker.controls.recoveries.length, 0, 'first-user physical append proves the immediate queue-intended race');
    await forkWorker.recoverQueue(true);
    for (const item of [...worker.controls.recoveries]) worker.acknowledgeRecovery(item.id);
    // Hold only the authenticated evidence; native clear runs once before its response times out.
    const nativeRequest = worker.client.request.bind(worker.client), nativeQueueHandler = worker.handleQueueEvent.bind(worker);
    let heldClearProof, clearDispatches = 0;
    worker.handleQueueEvent = event => {
        if (!heldClearProof && event.phase === 'cleared' && event.operationId) { heldClearProof = event; return; }
        return nativeQueueHandler(event);
    };
    worker.client.request = async (type, input, ...args) => {
        if (type === 'prompt' && input?.message?.startsWith('\u001ePIVANE_QUEUE_V1:')
            && JSON.parse(input.message.slice('\u001ePIVANE_QUEUE_V1:'.length)).operation === 'clear') {
            clearDispatches++; await nativeRequest(type, input, ...args);
            throw Object.assign(new Error('controlled timeout after native clear'), { code: 'RPC_TIMEOUT' });
        }
        return nativeRequest(type, input, ...args);
    };
    await worker.request('follow_up', { message: 'same late-clear text', images: [image] });
    await assert.rejects(worker.recoverQueue(false), /controlled timeout/);
    assert.equal(clearDispatches, 1); assert.equal(worker.queueClearOperations.size, 1);
    const pendingClear = worker.queueClearOperations.get(heldClearProof.operationId);
    assert.ok(pendingClear.fallbackIds.length > 0);
    assert.ok(queueStore.read().entries.some(entry => pendingClear.fallbackIds.includes(entry.id)));
    worker.client.request = nativeRequest; worker.handleQueueEvent = nativeQueueHandler;
    await worker.request('get_state'); assert.equal(worker.controlPending, false);
    await worker.request('follow_up', { message: 'same late-clear text', images: [{ ...image, data: 'aGVsbG8=' }] });
    await worker.recoverQueue(false); // A newer explicit operation gets its own proof and candidates.
    await worker.request('follow_up', { message: 'newer queue must not regress', images: [image] });
    const newer = worker.controls.intentions.find(item => item.followUp.includes('newer queue must not regress'));
    const beforeWrongGeneration = queueStore.protectedDocuments().revision;
    worker._handleEvent({ ...heldClearProof, generation: heldClearProof.generation + 1 });
    assert.equal(queueStore.protectedDocuments().revision, beforeWrongGeneration);
    assert.equal(worker.queueClearOperations.size, 1);
    worker._handleEvent(heldClearProof);
    assert.equal(worker.queueClearOperations.size, 0);
    assert.equal(queueStore.read().entries.some(entry => pendingClear.fallbackIds.includes(entry.id)), false);
    assert.equal(worker.controls.recoveries.some(item => item.legacy), false, 'late exact proof removes the matching fallback without text matching');
    assert.equal(worker.controls.intentions.find(item => item.id === newer.id).state, 'queued', 'old proof leaves newer queue state intact');
    assert.ok(worker.queueClearResponseIds.has(pendingClear.rpcId));
    const lateResponses = []; const unsubscribeLate = worker.subscribe(event => lateResponses.push(event));
    worker._handleEvent({ type: 'response', id: pendingClear.rpcId, command: 'prompt', success: true, data: { disposition: 'handled' } });
    unsubscribeLate();
    assert.deepEqual(lateResponses, [], 'the late private RPC acknowledgement never reaches browser subscribers');
    assert.equal(worker.queueClearResponseIds.size, 0);
    const afterLateProof = queueStore.protectedDocuments().revision;
    worker._handleEvent(heldClearProof);
    assert.equal(queueStore.protectedDocuments().revision, afterLateProof, 'duplicate old proof is private and inert');
    await worker.recoverQueue(false);
    for (const item of [...worker.controls.recoveries]) worker.acknowledgeRecovery(item.id);
    const previousOperations = worker.queueClearOperations;
    worker.queueClearOperations = new Map(Array.from({ length: 32 }, (_, n) => [String(n), {}]));
    await assert.rejects(worker.recoverQueue(false), /尚有未确认/);
    worker.queueClearOperations = previousOperations;
    const previousResponseIds = worker.queueClearResponseIds;
    worker.queueClearResponseIds = new Set(Array.from({ length: 32 }, (_, n) => 'unconfirmed-' + n));
    await assert.rejects(worker.recoverQueue(false), /尚有未确认/);
    worker.queueClearResponseIds = previousResponseIds;
    // Concurrent original reservations fit; expanded text/extra images do not fit as effective evidence.
    const previousLimits = { ...queueStore.limits };
    queueStore.limits = { ...previousLimits, sessionBytes: 5000, bytes: 12000 };
    const priorRecovery = queueStore.reserve(worker, 'steering', { message: 'previous explicit recovery', images: [] });
    queueStore.update(worker, priorRecovery, 'recovered', { message: 'previous explicit recovery', images: [] });
    worker.syncQueueRecoveries();
    const originalBoundary = { message: 'expand boundary ' + refs.marker(document), images: [image] };
    const beforeBoundaryRequests = requests;
    await Promise.all([worker.request('follow_up', originalBoundary), worker.request('follow_up', originalBoundary)]);
    const originalOnly = worker.controls.recoveries.filter(item => item.originalOnly);
    assert.equal(originalOnly.length, 2);
    assert.equal(queueStore.fault, null); assert.equal(worker.controls.persistenceError, undefined);
    assert.equal((await supervisor.protectedDocuments()).complete, false);
    assert.ok((await supervisor.protectedDocuments()).ids.includes(document.id));
    for (const item of originalOnly) {
        const recovered = worker.recoveryPayload({ recoveryId: item.id, runtimeId: worker.controls.runtimeId, revision: worker.controls.revision });
        assert.deepEqual(recovered.payload, originalBoundary); assert.equal(recovered.effectiveComplete, false);
        assert.equal(recovered.transformed, false); assert.equal(recovered.imageCount, 1, 'unpreserved effective second image is not claimed');
    }
    worker.acknowledgeRecovery(priorRecovery); // Expected evidence refusal must not fault unrelated acknowledgement.
    assert.equal(requests, beforeBoundaryRequests, 'expanded queued input and clear operations start no model');
    queueStore.limits = previousLimits;
    await worker.recoverQueue(false);
    for (const item of [...worker.controls.recoveries]) worker.acknowledgeRecovery(item.id);
    assert.equal((await supervisor.protectedDocuments()).complete, true);
    // An initial reservation failure never reaches native RPC and leaves the caller's draft intact.
    queueStore.limits = { ...previousLimits, sessionBytes: 1 };
    let rejectedDispatches = 0;
    worker.client.request = (...args) => { rejectedDispatches++; return nativeRequest(...args); };
    const draft = structuredClone(originalBoundary);
    await assert.rejects(worker.request('follow_up', draft), /额度/);
    assert.equal(rejectedDispatches, 0); assert.deepEqual(draft, originalBoundary);
    worker.client.request = nativeRequest; queueStore.limits = previousLimits;
    // Finite completion: exact message object -> native append ID/hash -> physical JSONL record.
    await worker.request('prompt', { message: 'hold second turn' }); await waitFor(() => held.size);
    await worker.request('steer', { message: 'exact duplicate', images: [image] });
    await worker.request('follow_up', { message: 'exact duplicate', images: [{ ...image, data: 'aGVsbG8=' }] });
    hold = false; for (const res of [...held]) { held.delete(res); finish(res); }
    await waitFor(() => !worker.activity.snapshot().busy && !worker.controls.intentions.length);
    assert.equal(worker.controls.recoveries.length, 0, 'proven physical native entries retire delivered intentions');
    const entries = (await worker.request('get_entries')).entries.filter(entry => entry.message?.role === 'user' && entry.message.content?.some(block => block.text === 'exact duplicate'));
    assert.equal(entries.length, 2);
    assert.notDeepEqual(entries[0].message.content.filter(block => block.type === 'image'), entries[1].message.content.filter(block => block.type === 'image'));
    // Both public queue modes are restored; a batch drained before start is not claimed as recovered.
    hold = true;
    await worker.setQueueMode('set_steering_mode', { mode: 'all', runtimeId: worker.shell.runtimeId, revision: worker.queueModeRevision });
    await worker.setQueueMode('set_follow_up_mode', { mode: 'all', runtimeId: worker.shell.runtimeId, revision: worker.queueModeRevision });
    await worker.request('prompt', { message: 'hold for drained batch' }); await waitFor(() => held.size);
    await worker.request('steer', { message: 'drained first', images: [image] });
    await worker.request('steer', { message: 'drained second', images: [image] });
    await worker.request('follow_up', { message: 'still in follow-up queue', images: [image] });
    for (const res of [...held]) { held.delete(res); finish(res); }
    await waitFor(() => worker.controls.statuses.get('queue-fixture') === 'drained');
    const drained = await worker.recoverQueue(false);
    const first = drained.recoveries.find(item => item.steering.includes('drained first'));
    const second = drained.recoveries.find(item => item.steering.includes('drained second'));
    assert.equal(first.status, 'uncertain'); assert.equal(second.status, 'uncertain');
    assert.equal(drained.recoveries.find(item => item.followUp.includes('still in follow-up queue')).status, 'recovered');
    const modes = await worker.request('get_state'); assert.equal(modes.steeringMode, 'all'); assert.equal(modes.followUpMode, 'all');
    // Crash while an extension is awaiting message_start, before native append.
    const drainedExit = once(worker, 'exit'); worker.client.child.kill('SIGKILL'); await drainedExit;
    worker = await supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    assert.equal(worker.controls.recoveries.filter(item => item.status === 'uncertain').length, 2);
    const physical = (await worker.request('get_entries')).entries;
    assert.equal(physical.some(entry => entry.message?.content?.some?.(block => block.text === 'drained first' || block.text === 'drained second')), false);
    for (const item of [...worker.controls.recoveries]) worker.acknowledgeRecovery(item.id);
    // Kill with an accepted queue; reconstruction retains full unknown payload without replay.
    hold = true;
    await worker.request('prompt', { message: 'hold before process crash' }); await waitFor(() => held.size);
    await worker.request('follow_up', { message: 'lost response fixture ' + refs.marker(document), images: [image] });
    const beforeCrash = requests;
    const oldWorker = worker;
    const exited = once(oldWorker, 'exit'); oldWorker.client.child.kill('SIGKILL'); await exited;
    worker = await supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    assert.equal(requests, beforeCrash);
    assert.equal(worker.controls.recoveries.length, 1); assert.equal(worker.controls.recoveries[0].state, 'unknown');
    const unknown = worker.recoveryPayload({ recoveryId: worker.controls.recoveries[0].id, runtimeId: worker.controls.runtimeId, revision: worker.controls.revision });
    assert.deepEqual(unknown.payload.images, [image]);
    assert.throws(() => oldWorker.acknowledgeRecovery(unknown.id), /已变化|关闭/);
    // Parent-injected reference guard also covers temporary admission and reads remain pure.
    supervisor.referenceGuard = { locked: true, assertWritable() { throw new Error('reference fixture lock'); } };
    await assert.rejects(worker.request('steer', { message: 'guarded' }), /reference fixture/);
    await assert.rejects(supervisor.createEphemeralWorker(root), /reference fixture/);
    await assert.rejects(supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id }), /reference fixture/);
    assert.throws(() => worker.acknowledgeRecovery(unknown.id), /reference fixture/);
    assert.equal((await supervisor.protectedDocuments()).complete, true);
    supervisor.referenceGuard = null;
    await supervisor.withSessionRemoval(session.path, async () => {
        await supervisor.stopSession(session.path);
        await assert.rejects(supervisor.forgetDeletedSession(session.path), /仍存在/);
        fs.unlinkSync(session.path); // Synthetic explicit-success deletion, no user data.
        await supervisor.forgetDeletedSession(session.path);
    });
    assert.deepEqual((await supervisor.protectedDocuments()).ids, []);
});
