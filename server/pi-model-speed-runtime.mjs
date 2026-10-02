import { calculateCost } from '@earendil-works/pi-ai';
import speed from './pi-model-speed.js';
export function finalizeSpeedUsage(message, model, capability, requested, actual) {
    if (!capability.levels.length) return message;
    const multiplier = speed.tierMultiplier(actual ?? speed.requestTier(requested, capability), capability);
    const usage = structuredClone(message.usage);
    if (multiplier !== undefined) {
        calculateCost(model, usage);
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) usage.cost[field] *= multiplier;
    }
    return { ...message, usage, pivaneSpeed: { requested, serviceTier: actual ?? null,
        costMultiplier: multiplier ?? null, costBasis: actual === undefined ? 'requested-tier-estimate' : 'reported-tier' } };
}
// Independent helper calls use their own model's default speed; no main-session
// selection, global model preference or unrelated option is overwritten.
export async function completeWithSpeed(runtime, model, context, options, agentDir) {
    const capability = speed.speedCapability(model, speed.readSpeedConfig(agentDir));
    const level = capability.levels.includes(capability.defaultLevel) ? capability.defaultLevel : 'auto';
    const tier = speed.requestTier(level, capability); let actual;
    if (!capability.levels.length) return runtime.completeSimple(model, context, options);
    const response = await runtime.completeSimple(model, context, { ...options,
        onPayload: async (payload, selected) => {
            const changed = await options?.onPayload?.(payload, selected);
            const result = changed === undefined ? payload : changed;
            return tier ? { ...result, service_tier: tier } : result;
        },
        onProviderStreamEvent: async (data, selected) => {
            const served = data?.response?.service_tier ?? data?.service_tier;
            if (typeof served === 'string') actual = served;
            await options?.onProviderStreamEvent?.(data, selected);
        }
    });
    return finalizeSpeedUsage(response, model, capability, level, actual);
}
