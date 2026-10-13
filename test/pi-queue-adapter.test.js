const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Use the actual public Agent queues: this checks the pinned SDK seam separately
// from the end-to-end RPC transformations and native persistence assertions.
async function fixture(t, { failFollowUpClear = false, rewriteAfterAppend, onEvent } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-queue-adapter-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { installQueueAdapter, queueEnvelopePrefix } = await import('../server/pi-queue-adapter.mjs');
    const agent = new Agent(), manager = SessionManager.create(root, path.join(root, 'sessions'));
    if (rewriteAfterAppend) {
        const append = manager.appendMessage.bind(manager);
        manager.appendMessage = message => {
            const id = append(message); rewriteAfterAppend(manager.getSessionFile(), manager.getHeader()); return id;
        };
    }
    const session = { agent, sessionManager: manager, promptCalls: 0,
        prompt() { this.promptCalls++; }, sendCustomMessage() {}, sendUserMessage() {},
        steer(text, images) { agent.steer({ role: 'user', content: [{ type: 'text', text }, ...(images || [])], timestamp: Date.now() }); return 'queued'; },
        followUp(text, images) { agent.followUp({ role: 'user', content: [{ type: 'text', text }, ...(images || [])], timestamp: Date.now() }); return 'queued'; },
        clearQueue() { agent.clearAllQueues(); return { steering: [], followUp: [] }; } };
    if (failFollowUpClear) agent.clearFollowUpQueue = () => { throw new Error('controlled public clear failure'); };
    const events = [], token = randomUUID();
    installQueueAdapter(session, { token, sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId(),
        emit: record => { events.push(record); onEvent?.(record); } });
    const encoded = (id, message) => queueEnvelopePrefix + JSON.stringify({ id, token, message });
    const encodedClear = (id, generation, suppliedToken = token) => queueEnvelopePrefix + JSON.stringify({ id, token: suppliedToken, generation, operation: 'clear' });
    return { root, session, manager, agent, events, encoded, encodedClear };
}

test('public mode/peek clear captures all duplicate objects across both queues and restores one-at-a-time/all', async t => {
    const { session, agent, events, encoded } = await fixture(t);
    for (const mode of ['one-at-a-time', 'all']) {
        agent.steeringMode = mode; agent.followUpMode = mode;
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        session.steer(encoded(ids[0], 'duplicate'), [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }]);
        session.steer(encoded(ids[1], 'duplicate'), [{ type: 'image', mimeType: 'image/png', data: 'Yg==' }]);
        session.followUp(encoded(ids[2], 'duplicate'));
        session.clearQueue();
        const evidence = events.filter(event => event.phase === 'cleared').at(-1);
        assert.deepEqual(evidence.ids, ids);
        assert.deepEqual(evidence.legacy, { steering: [], followUp: [] });
        assert.equal(agent.steeringMode, mode); assert.equal(agent.followUpMode, mode);
        assert.equal(agent.hasQueuedMessages(), false);
    }
});

test('public clear failure restores both queue modes and emits no successful removal evidence', async t => {
    const { session, agent, events, encoded } = await fixture(t, { failFollowUpClear: true });
    agent.steeringMode = 'one-at-a-time'; agent.followUpMode = 'all';
    session.steer(encoded(randomUUID(), 'steering'));
    session.followUp(encoded(randomUUID(), 'follow-up'));
    assert.throws(() => session.clearQueue(), /controlled public clear failure/);
    assert.equal(agent.steeringMode, 'one-at-a-time'); assert.equal(agent.followUpMode, 'all');
    assert.equal(events.some(event => event.phase === 'cleared'), false);
});

async function appendProofFixture(t, rewriteAfterAppend) {
    const { PiQueueStore } = require('../server/pi-queue-store');
    let store, worker;
    const value = await fixture(t, { rewriteAfterAppend, onEvent: event => {
        if (event.phase === 'persisted') store.retire(worker, event.id);
        if (['queued', 'started'].includes(event.phase)) store.update(worker, event.id, event.phase, event.payload);
    } });
    store = new PiQueueStore(path.join(value.root, 'queue'));
    worker = { cwd: value.root, sessionPath: value.manager.getSessionFile(), sessionId: value.manager.getSessionId(), controls: { runtimeId: randomUUID() } };
    const id = store.reserve(worker, 'steering', { message: 'exact tracked physical record', images: [] });
    await value.session.steer(value.encoded(id, 'exact tracked physical record'));
    const message = value.agent.peekQueuedMessages()[0];
    const entryId = value.manager.appendMessage(message);
    return { ...value, store, worker, id, entryId };
}

test('physical first-header mismatch retains the intention despite an exact native entry ID/hash', async t => {
    const mutations = {
        type: header => ({ ...header, type: 'message' }),
        version: header => ({ ...header, version: header.version + 1 }),
        id: header => ({ ...header, id: randomUUID() }),
        cwd: header => ({ ...header, cwd: header.cwd + '-foreign' }),
        timestamp: header => ({ ...header, timestamp: '2000-01-01T00:00:00.000Z' }),
        parentSession: header => ({ ...header, parentSession: '/foreign/creation.jsonl' })
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        const value = await appendProofFixture(t, (file, header) => {
            const lines = fs.readFileSync(file, 'utf8').split('\n'); lines[0] = JSON.stringify(mutate(header));
            const replacement = file + '.replacement'; fs.writeFileSync(replacement, lines.join('\n')); fs.renameSync(replacement, file);
        });
        const physical = fs.readFileSync(value.manager.getSessionFile(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert.deepEqual(physical.find(entry => entry.id === value.entryId), value.manager.getEntry(value.entryId), name + ': exact record copied into replacement');
        assert.equal(value.events.some(event => event.phase === 'persisted'), false, name + ': mismatch is not persistence proof');
        assert.equal(value.store.read().entries[0].id, value.id, name + ': only intention retained');
    }
});

test('blank native frames permit proof, while malformed, partial and misplaced header frames retain it', async t => {
    const blank = await appendProofFixture(t, file => {
        fs.writeFileSync(file, '\n \t\r\n' + fs.readFileSync(file, 'utf8').replaceAll('\n', '\n\n'));
    });
    assert.equal(blank.events.some(event => event.phase === 'persisted'), true);
    assert.deepEqual(blank.store.read().entries, []);
    for (const frame of ['{broken}\n', 'null\n', '[]\n', '{"id":"missing-type"}\n', '{"type":"partial"']) {
        const value = await appendProofFixture(t, file => fs.appendFileSync(file, frame));
        assert.equal(value.events.some(event => event.phase === 'persisted'), false, frame);
        assert.equal(value.store.read().entries.length, 1);
    }
    const misplaced = await appendProofFixture(t, file => {
        const lines = fs.readFileSync(file, 'utf8').split('\n'); [lines[0], lines[1]] = [lines[1], lines[0]];
        fs.writeFileSync(file, lines.join('\n'));
    });
    assert.equal(misplaced.events.some(event => event.phase === 'persisted'), false);
    assert.equal(misplaced.store.read().entries.length, 1);
});

test('authenticated clear envelopes emit correlated proof before one acknowledgement without prompting', async t => {
    const order = [];
    const { session, agent, events, encoded, encodedClear } = await fixture(t, { onEvent: event => { if (event.phase === 'cleared') order.push('cleared'); } });
    const id = randomUUID(), operationId = randomUUID();
    await session.steer(encoded(id, 'queued user remains a queue member'));
    const queued = agent.peekQueuedMessages()[0];
    let acknowledgements = 0;
    const options = { preflightResult: disposition => { acknowledgements++; order.push('ack'); assert.equal(disposition, 'handled'); } };
    await assert.rejects(session.prompt(encodedClear(operationId, 1, 'foreign-token'), options), /Invalid managed queue envelope/);
    await assert.rejects(session.prompt(encodedClear(operationId, undefined), options), /Invalid managed clear operation/);
    await assert.rejects(session.steer(encodedClear(operationId, 1)), /Invalid managed clear operation/);
    assert.equal(agent.peekQueuedMessages()[0], queued);
    assert.equal(acknowledgements, 0); assert.equal(session.promptCalls, 0);
    await session.prompt(encodedClear(operationId, 1), options);
    assert.deepEqual(order, ['cleared', 'ack']); assert.equal(acknowledgements, 1); assert.equal(session.promptCalls, 0);
    const proof = events.find(event => event.phase === 'cleared');
    assert.equal(proof.operationId, operationId); assert.equal(proof.generation, 1); assert.deepEqual(proof.ids, [id]);
    assert.equal(agent.hasQueuedMessages(), false);
});
