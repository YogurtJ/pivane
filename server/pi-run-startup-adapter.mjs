import { randomUUID } from 'node:crypto';

// Pi 1.2 publishes agent_start after before_agent_start, and agent_settled before
// deferred wakes finish. Hold the public SDK call across both boundaries. Prompt
// also owns deferred custom wakes requested by its agent_settled handlers.
export function installRunStartupAdapter(session, { token, sessionId, emit }) {
    if (!token) return;
    if (typeof emit !== 'function' || typeof session.prompt !== 'function' || typeof session.sendCustomMessage !== 'function')
        throw new Error('Managed run startup requires public prompt/custom-message methods and the RPC transport');
    let sequence = 0;
    for (const name of ['prompt', 'sendCustomMessage']) {
        const original = session[name];
        session[name] = async function (...args) {
            const options = args[1];
            // Notes and nextTurn context do not start a run; their durable ownership
            // remains with the native session/queue adapter.
            if (name === 'sendCustomMessage' && (!options?.triggerTurn || options.deliverAs === 'nextTurn'))
                return original.apply(this, args);
            const id = randomUUID();
            const report = phase => emit({ type: 'pivane_run_startup', token, sessionId, id, sequence: ++sequence, phase });
            report('started');
            try { return await original.apply(this, args); }
            finally { report('finished'); }
        };
    }
}
