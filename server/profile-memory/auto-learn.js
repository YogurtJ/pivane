'use strict';

const MAX_INPUT = 6000;
const MAX_CONTENT = 300;
const MIN_INTERVAL_MS = 15 * 60 * 1000;

function reviewModelConfig(raw) {
    try {
        const value = JSON.parse(raw || 'null');
        return value && typeof value.provider === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(value.provider)
            && typeof value.modelId === 'string' && value.modelId.length <= 200 && value.modelId.length > 0
            ? { provider: value.provider, modelId: value.modelId } : null;
    } catch { return null; }
}

function reviewText(event) {
    if (event.outcome !== 'completed' || !event.context?.contextMessages) return null;
    const messages = event.context.contextMessages;
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    if (lastUser < 0) return null;
    const chosen = messages.slice(lastUser).filter(m => m.role === 'user' || m.role === 'assistant');
    const text = chosen.map(m => {
        const parts = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join(' ') : '';
        return `${m.role}: ${parts.slice(0, 3000)}`;
    }).join('\n').slice(0, MAX_INPUT);
    return chosen.some(m => m.role === 'assistant') && text.length >= 80 ? text : null;
}

function createReviewer(pi, { context, store, projectStore, tools, allowed }) {
    const config = reviewModelConfig(process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL);
    let turns = 0, lastAttempt = 0, attempts = 0;
    async function review(event, ctx) {
        if (!context.memory.enabled || !context.memory.autoLearn || !allowed(ctx)) return;
        const text = reviewText(event);
        if (!text || ctx.signal?.aborted) return;
        turns++;
        if (turns % 3 || attempts >= 4 || Date.now() - lastAttempt < MIN_INTERVAL_MS) return;
        lastAttempt = Date.now(); attempts++;
        const record = (status, reason) => pi.appendEntry('pivane-profile-review', {
            version: 1, profileId: context.profileId, status, reason, at: new Date().toISOString(),
        });
        const deadline = AbortSignal.timeout(20000);
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
        if (!config) { record('unsupported', 'model-not-configured'); return; }
        try {
            const model = ctx.modelRegistry.getModel(config.provider, config.modelId);
            const available = model && (await ctx.modelRegistry.getAvailable(config.provider, { signal }))
                .some(m => m.provider === config.provider && m.id === config.modelId);
            if (!allowed(ctx) || signal.aborted || !available || !Number.isFinite(model.cost?.input)
                || model.cost.input > 1 || !Number.isFinite(model.cost?.output)
                || model.cost.output > 2) { record('unsupported', 'model-unavailable-or-over-budget'); return; }
            await store.loadFromDisk();
            await projectStore.loadFromDisk();
            const before = JSON.stringify([store.getMemoryEntries(), store.getUserEntries(), projectStore.getMemoryEntries()]);
            const reply = await ctx.modelRegistry.completeSimple(model, { systemPrompt: `Review only the latest user/assistant exchange for durable profile facts or a reusable correction. Do not infer study mastery from the assistant's explanation. Never store secrets, credentials, or conversation excerpts. Return only JSON {"target":"memory|user|project","content":"..."} for ONE compact stable fact, or {} if none. Max ${MAX_CONTENT} characters. No tools.`,
                messages: [{ role: 'user', content: text, timestamp: Date.now() }] },
            { signal, timeoutMs: 20000, maxTokens: 220, reasoning: 'minimal', toolChoice: 'none', cacheRetention: 'none' });
            if (!allowed(ctx) || signal.aborted || reply.stopReason !== 'stop') { record('skipped', 'interrupted'); return; }
            const raw = reply.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
            if (raw.length > 600 || !raw.startsWith('{')) { record('skipped', 'invalid-proposal'); return; }
            const proposal = JSON.parse(raw);
            if (!Object.keys(proposal).length) { record('skipped', 'no-durable-fact'); return; }
            if (!['memory', 'user', 'project'].includes(proposal.target) || typeof proposal.content !== 'string'
                || !proposal.content.trim() || proposal.content.length > MAX_CONTENT || Object.keys(proposal).some(k => !['target', 'content'].includes(k))) {
                record('skipped', 'invalid-proposal'); return;
            }
            await store.loadFromDisk();
            await projectStore.loadFromDisk();
            if (!allowed(ctx) || signal.aborted || before !== JSON.stringify([store.getMemoryEntries(), store.getUserEntries(), projectStore.getMemoryEntries()])) {
                record('skipped', 'memory-changed'); return;
            }
            const result = await tools.get('memory_add').execute('profile-review', proposal, signal, undefined, ctx);
            record(result.details?.success && !result.details?.warning ? 'completed' : 'error',
                result.details?.success && !result.details?.warning ? 'saved' : 'write-unconfirmed');
        } catch { record('error', 'review-failed'); }
    }
    return { review, configured: Boolean(config) };
}
module.exports = { createReviewer, reviewModelConfig, reviewText };
