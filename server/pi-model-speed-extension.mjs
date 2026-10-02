import { randomUUID } from 'node:crypto';
import { finalizeSpeedUsage } from './pi-model-speed-runtime.mjs';
import speed from './pi-model-speed.js';
import compat from './pivane-compat.js';

// Project-owned hooks apply to managed sessions, isolated side chat and children.
// No timers, remote capability probes or changes to upstream provider adapters.
export function registerModelSpeed(pi, { agentDir, inherited, bridge = false, command = false, preserveExisting = true } = {}) {
    let config = speed.readSpeedConfig(agentDir), selections = new Map(), currentRequest, legacySession = false;
    const runtimeId = randomUUID(); let revision = 0;
    const key = model => JSON.stringify([model?.provider, model?.id]);
    const restore = ctx => {
        selections = new Map();
        const branch = ctx.sessionManager.getBranch();
        legacySession = preserveExisting && branch.some(entry => entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role));
        for (const entry of branch) if (entry.type === 'custom' && entry.customType === speed.ENTRY && speed.LEVELS.includes(entry.data?.level))
            selections.set(JSON.stringify([entry.data.provider, entry.data.modelId]), entry.data.level);
    };
    const snapshot = ctx => {
        const capability = speed.speedCapability(ctx.model, config);
        const inheritedLevel = inherited?.provider === ctx.model?.provider && inherited?.modelId === ctx.model?.id ? inherited.level : undefined;
        const requested = selections.get(key(ctx.model)) ?? inheritedLevel ?? (legacySession ? 'auto' : capability.defaultLevel);
        return { runtimeId, revision, provider: ctx.model?.provider || null, modelId: ctx.model?.id || null,
            ...capability, level: capability.levels.includes(requested) ? requested : 'auto' };
    };
    const report = ctx => { if (bridge && ctx.mode === 'rpc') ctx.ui.notify(JSON.stringify({ pivaneSpeedState: snapshot(ctx) })); };
    const persist = (ctx, level) => {
        if (selections.get(key(ctx.model)) === level) return;
        pi.appendEntry(speed.ENTRY, { version: 1, provider: ctx.model.provider, modelId: ctx.model.id, level });
        selections.set(key(ctx.model), level);
    };
    const control = (ctx, input) => {
        const state = snapshot(ctx);
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('请等待当前任务和队列结束后切换速度');
        if (!input || Object.keys(input).some(k => !['runtimeId', 'revision', 'provider', 'modelId', 'level'].includes(k))
            || input.runtimeId !== runtimeId || input.revision !== revision || input.provider !== state.provider || input.modelId !== state.modelId) throw new Error('模型或速度设置已变化，请刷新后再选择');
        if (!state.levels.includes(input.level)) throw new Error('当前渠道下的模型不支持此速度档位');
        persist(ctx, input.level); revision++; report(ctx);
        return snapshot(ctx);
    };
    pi.on('session_start', (_event, ctx) => { restore(ctx); report(ctx); });
    pi.on('model_select', (_event, ctx) => { revision++; report(ctx); });
    pi.on('session_tree', (_event, ctx) => { restore(ctx); revision++; report(ctx); });
    pi.on('before_agent_start', (_event, ctx) => {
        const state = snapshot(ctx);
        if (state.levels.length) persist(ctx, state.level);
    });
    pi.on('before_provider_request', (event, ctx) => {
        const state = snapshot(ctx);
        currentRequest = { model: ctx.model, capability: state, requested: state.level, actual: undefined };
        const tier = speed.requestTier(state.level, state);
        if (tier && event.payload && typeof event.payload === 'object') return { ...event.payload, service_tier: tier };
    });
    pi.on('provider_stream_event', event => {
        const request = currentRequest;
        if (!request || event.provider !== request.model?.provider || event.model !== request.model?.id) return;
        const data = event.data;
        const tier = data?.response?.service_tier ?? data?.service_tier;
        if (typeof tier === 'string' && ['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'].includes(tier)) request.actual = tier;
    });
    pi.on('message_end', event => {
        const request = currentRequest, message = event.message;
        if (message.role !== 'assistant' || !request || message.provider !== request.model?.provider || message.model !== request.model?.id
            || !request.capability.levels.length) return;
        // Recalculate from tokens: upstream may have applied an older multiplier.
        return { message: finalizeSpeedUsage(message, request.model, request.capability, request.requested, request.actual) };
    });
    if (command) pi.registerCommand(compat.INTERNAL_COMMAND, { description: 'Pivane internal speed-v1', handler: async (args, ctx) => {
        const request = JSON.parse(args);
        if (ctx.mode !== 'rpc' || request.token !== process.env.PI_WEB_NAVIGATION_TOKEN || request.mode !== 'speed') throw new Error('Invalid speed request');
        try { ctx.ui.notify(JSON.stringify({ pivaneSpeedReply: request.id, success: true, data: control(ctx, request.input) })); }
        catch (error) { ctx.ui.notify(JSON.stringify({ pivaneSpeedReply: request.id, success: false, error: error.message })); }
    } });
    return { snapshot, control, capability: model => speed.speedCapability(model, config), reload(ctx) {
        config = speed.readSpeedConfig(agentDir); revision++; report(ctx);
    } };
}
