// Native media provenance is separate from a tool's eventual success/error result.
// Only the managed worker appends this record through ExtensionAPI.appendEntry.
const MEDIA_PLAN_ENTRY = 'pivane-media-plan';
const PLAN_KEY = /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_TOOLS = new Set(['media_generate', 'media_plan_request']);
function mediaPlanRecord(data) {
    const plan = data?.plan;
    return data?.version === 1 && typeof data.toolCallId === 'string' && data.toolCallId.length > 0 && data.toolCallId.length <= 500
        && PLAN_KEY.test(plan?.id || '') && ['image', 'video', 'tts'].includes(plan.kind) && typeof plan.modelId === 'string'
        && plan.parameters && typeof plan.parameters === 'object' && !Array.isArray(plan.parameters) ? data : null;
}
function branchPlans(branch) {
    const plans = new Map();
    for (const entry of branch) {
        const native = entry.type === 'custom' && entry.customType === MEDIA_PLAN_ENTRY ? mediaPlanRecord(entry.data) : null;
        const message = entry.type === 'message' ? entry.message : null;
        const legacy = message?.role === 'toolResult' && !message.isError && MEDIA_TOOLS.has(message.toolName) ? message.details?.plan : null;
        const plan = native?.plan || legacy;
        if (typeof plan?.id === 'string' && (native || !plans.has(plan.id))) plans.set(plan.id, plan);
    }
    return [...plans.values()].slice(-500);
}
function mediaPlanMessage(entry) {
    const data = entry?.type === 'custom' && entry.customType === MEDIA_PLAN_ENTRY ? mediaPlanRecord(entry.data) : null;
    return data ? { role: 'custom', customType: MEDIA_PLAN_ENTRY, display: false, content: [], details: data,
        timestamp: Date.parse(entry.timestamp) || 0 } : null;
}
function mediaPlanEntries(entries, leafId) {
    // Fail closed on absent/invalid leaves; never fall back to another branch.
    const byId = new Map(entries.map(entry => [entry.id, entry])), branch = [], seen = new Set();
    let entry = byId.get(leafId);
    while (entry && !seen.has(entry.id)) {
        seen.add(entry.id); branch.push(entry);
        entry = byId.get(entry.parentId);
    }
    return branch.reverse().filter(entry => mediaPlanMessage(entry)).slice(-500);
}
module.exports = { MEDIA_PLAN_ENTRY, PLAN_KEY, mediaPlanRecord, branchPlans, mediaPlanMessage, mediaPlanEntries };
