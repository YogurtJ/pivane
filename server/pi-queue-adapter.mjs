import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import files from './pi-maintenance-files.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const queueEnvelopePrefix = '\u001ePIVANE_QUEUE_V1:';

// Reviewed for Pi 1.1.0: only public Session/Agent/SessionManager methods are
// wrapped. Object identity binds input -> queue -> native append, never text.
export function installQueueAdapter(session, { token, sessionPath, sessionId, emit }) {
    if (!token || !sessionPath) return;
    if (typeof emit !== 'function') throw new Error('Managed queue requires the native RPC output transport');
    const agent = session.agent, manager = session.sessionManager;
    for (const method of ['steer', 'followUp', 'prompt', 'peekQueuedMessages', 'clearSteeringQueue', 'clearFollowUpQueue', 'subscribe']) {
        if (typeof agent[method] !== 'function') throw new Error(`Managed queue SDK missing public Agent.${method}`);
    }
    const scope = new AsyncLocalStorage(), identities = new WeakMap(), awaitingProof = new Map();
    const headerIdentity = header => header && header.type === 'session' && Number.isSafeInteger(header.version) && header.version > 0
        && header.id === sessionId && typeof header.cwd === 'string' && typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp))
        ? JSON.stringify([header.type, header.version, header.id, header.cwd, header.timestamp, header.parentSession ?? null]) : null;
    const boundHeader = headerIdentity(structuredClone(manager.getHeader()));
    const boundCwd = manager.getCwd();
    const report = (phase, data = {}) => emit({ type: 'pivane_queue', token, sessionId, phase, ...data });
    const payload = message => ({ message: (message.content || []).filter(block => block.type === 'text').map(block => block.text).join(''),
        images: (message.content || []).filter(block => block.type === 'image').map(({ type, mimeType, data }) => ({ type, mimeType, data })) });
    for (const name of ['prompt', 'steer', 'followUp']) {
        const original = session[name].bind(session);
        session[name] = async (text, ...args) => {
            if (typeof text !== 'string' || !text.startsWith(queueEnvelopePrefix)) return original(text, ...args);
            const envelope = JSON.parse(text.slice(queueEnvelopePrefix.length));
            if (envelope.token !== token || !uuid.test(envelope.id)) throw new Error('Invalid managed queue envelope');
            if (envelope.operation === 'clear') {
                if (name !== 'prompt' || !Number.isSafeInteger(envelope.generation) || envelope.generation < 1
                    || typeof args[0]?.preflightResult !== 'function') throw new Error('Invalid managed clear operation');
                clearOperation = { operationId: envelope.id, generation: envelope.generation };
                try {
                    session.clearQueue();
                    args[0].preflightResult('handled');
                    return;
                } finally { clearOperation = null; }
            }
            if (envelope.operation !== undefined || typeof envelope.message !== 'string') throw new Error('Invalid managed queue envelope');
            return scope.run({ id: envelope.id }, () => original(envelope.message, ...args));
        };
    }
    for (const name of ['sendCustomMessage', 'sendUserMessage']) {
        const original = session[name].bind(session);
        session[name] = (...args) => scope.run(undefined, () => original(...args));
    }
    for (const [name, kind] of [['steer', 'steering'], ['followUp', 'followUp']]) {
        const original = agent[name].bind(agent);
        agent[name] = message => {
            const current = scope.getStore();
            if (current && !current.captured && message.role === 'user') {
                current.captured = true;
                identities.set(message, current.id);
                report('queued', { id: current.id, kind, payload: payload(message) });
            }
            return original(message);
        };
    }
    // A queue-intended prompt can race with settlement and reach immediate input.
    const originalPrompt = agent.prompt.bind(agent);
    agent.prompt = (input, ...args) => {
        const current = scope.getStore();
        if (current && !current.captured && Array.isArray(input)) {
            const users = input.filter(message => message.role === 'user');
            if (users.length === 1) {
                current.captured = true;
                identities.set(users[0], current.id);
                report('started', { id: current.id, payload: payload(users[0]) });
            }
        }
        return originalPrompt(input, ...args);
    };
    agent.subscribe(event => {
        const id = identities.get(event.message);
        if (id && event.type === 'message_start') report('started', { id });
    });
    const prove = () => {
        if (!awaitingProof.size) return;
        try {
            if (!boundHeader || headerIdentity(manager.getHeader()) !== boundHeader || manager.getCwd() !== boundCwd
                || manager.getSessionId() !== sessionId || manager.getSessionFile() !== sessionPath || fs.realpathSync.native(sessionPath) !== sessionPath
                || fs.realpathSync.native(manager.getHeader().cwd) !== fs.realpathSync.native(boundCwd)) return;
            const lines = files.readSafe(sessionPath, 128 * 1024 ** 2).toString('utf8').split('\n');
            if (lines.pop() !== '') return; // A partial native frame is never completion proof.
            const records = new Map();
            let header = false;
            for (const line of lines) {
                if (!line.trim()) continue; // Native JSONL accepts blank frames.
                const entry = JSON.parse(line);
                if (!entry || Array.isArray(entry) || typeof entry !== 'object' || typeof entry.type !== 'string' || typeof entry.id !== 'string') return;
                if (!header) {
                    if (headerIdentity(entry) !== boundHeader) return;
                    header = true;
                } else if (entry.type === 'session') return;
                if (records.has(entry.id)) return;
                records.set(entry.id, digest(JSON.stringify(entry)));
            }
            if (!header) return;
            for (const [id, proof] of awaitingProof) if (records.get(proof.entryId) === proof.entryHash) {
                report('persisted', { id, ...proof }); awaitingProof.delete(id);
            }
        } catch { /* Unreadable, changing or over-budget history stays uncertain. */ }
    };
    const append = manager.appendMessage.bind(manager);
    manager.appendMessage = message => {
        const entryId = append(message); // Native SDK persists before this public call returns.
        const id = identities.get(message);
        if (id) awaitingProof.set(id, { entryId, entryHash: digest(JSON.stringify(manager.getEntry(entryId))) });
        prove(); // Also handles SDK versions that defer the first physical flush.
        return entryId;
    };
    let clearing = null, clearOperation = null;
    for (const [name, kind, mode] of [['clearSteeringQueue', 'steering', 'steeringMode'], ['clearFollowUpQueue', 'followUp', 'followUpMode']]) {
        const original = agent[name].bind(agent);
        agent[name] = () => {
            if (clearing) {
                const before = agent[mode];
                let messages;
                try { agent[mode] = 'all'; messages = agent.peekQueuedMessages(); }
                finally { agent[mode] = before; }
                for (const message of messages) {
                    const id = identities.get(message);
                    if (id) clearing.ids.push(id);
                    else if (message.role === 'user') clearing.legacy[kind].push(payload(message).message);
                }
            }
            return original();
        };
    }
    const clear = session.clearQueue.bind(session);
    session.clearQueue = () => {
        const modes = { steering: agent.steeringMode, followUp: agent.followUpMode };
        clearing = { operationId: clearOperation?.operationId ?? null, generation: clearOperation?.generation ?? null,
            ids: [], legacy: { steering: [], followUp: [] } };
        try {
            const result = clear();
            report('cleared', clearing);
            return result;
        } finally {
            clearing = null;
            agent.steeringMode = modes.steering; agent.followUpMode = modes.followUp;
        }
    };
    report('ready');
}
