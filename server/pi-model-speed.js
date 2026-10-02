// Speed capabilities belong to an exact provider/model/API connection. Unknown
// channels opt in explicitly through models.json; model names are never matched.
const fs = require('node:fs');
const path = require('node:path');
const APIS = new Set(['openai-responses', 'openai-completions', 'openai-codex-responses']);
const LEVELS = ['auto', 'standard', 'fast', 'ultrafast'];
const ENTRY = 'pivane-model-speed';
const OFFICIAL = {
    'gpt-5.4': { fast: { serviceTier: 'priority', costMultiplier: 2 } },
    'gpt-5.5': { fast: { serviceTier: 'priority', costMultiplier: 2.5 } },
    // Fast is 2x the corresponding Standard token rate; throughput is up to
    // 2.5x faster. Those are separate quantities (Sol promotion: Nov 21, 2026+).
    'gpt-5.6-sol': { fast: { serviceTier: 'priority', costMultiplier: 2 } },
    'gpt-5.6-terra': { fast: { serviceTier: 'priority', costMultiplier: 2 } },
    'gpt-5.6-luna': { fast: { serviceTier: 'priority', costMultiplier: 2 } },
    'gpt-6-sol': { fast: { serviceTier: 'fast', costMultiplier: 2 } },
    'gpt-6-luna': { fast: { serviceTier: 'fast', costMultiplier: 2 } },
    'gpt-6.1-sol': { fast: { serviceTier: 'fast', costMultiplier: 2 } },
    'gpt-6-astra': { fast: { serviceTier: 'fast', costMultiplier: 2 }, ultrafast: { serviceTier: 'ultrafast', costMultiplier: 6 } },
};
function readSpeedConfig(agentDir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
        const config = {};
        for (const [provider, value] of Object.entries(data.providers || {})) {
            for (const [id, model] of Object.entries(value.modelOverrides || {})) if (model?.pivaneSpeed) config[JSON.stringify([provider, id])] = model.pivaneSpeed;
            for (const model of value.models || []) if (model?.pivaneSpeed) config[JSON.stringify([provider, model.id])] = model.pivaneSpeed;
        }
        return config;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取模型速度配置，请检查 models.json'); }
}
function validateSpeed(value) {
    if (value === null) return;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['modes', 'defaultLevel'].includes(key))) throw new Error('速度配置格式无效');
    if (!value.modes || typeof value.modes !== 'object' || Array.isArray(value.modes)) throw new Error('速度档位必须是对象');
    for (const [level, mode] of Object.entries(value.modes)) {
        if (!['fast', 'ultrafast'].includes(level) || !mode || typeof mode !== 'object' || Array.isArray(mode)
            || Object.keys(mode).some(key => !['serviceTier', 'costMultiplier'].includes(key))
            || !(level === 'fast' ? ['fast', 'priority'] : ['ultrafast']).includes(mode.serviceTier)
            || typeof mode.costMultiplier !== 'number' || !Number.isFinite(mode.costMultiplier) || mode.costMultiplier < 1 || mode.costMultiplier > 100) throw new Error('速度档位或费用倍率无效');
    }
    if (!LEVELS.includes(value.defaultLevel || 'auto') || !Object.keys(value.modes).length && (value.defaultLevel || 'auto') !== 'auto'
        || ['fast', 'ultrafast'].includes(value.defaultLevel) && !value.modes[value.defaultLevel]) throw new Error('默认速度不在此模型支持范围内');
}
function officialModes(model) {
    if (model?.provider !== 'openai' || !['openai-responses', 'openai-completions'].includes(model.api)) return {};
    try { if (new URL(model.baseUrl).origin !== 'https://api.openai.com') return {}; } catch { return {}; }
    const modes = OFFICIAL[model.id] || {};
    return model.api === 'openai-completions' ? Object.fromEntries(Object.entries(modes).filter(([level]) => level !== 'ultrafast')) : modes;
}
function speedCapability(model, config = {}) {
    const local = config[JSON.stringify([model?.provider, model?.id])];
    let modes = {};
    if (APIS.has(model?.api)) {
        if (local) { validateSpeed(local); modes = local.modes; }
        else modes = officialModes(model);
    }
    return { levels: Object.keys(modes).length ? LEVELS.filter(level => ['auto', 'standard'].includes(level) || modes[level]) : [],
        modes, defaultLevel: local?.defaultLevel || 'auto' };
}
function requestTier(level, capability) {
    return level === 'standard' ? 'default' : capability.modes[level]?.serviceTier;
}
function tierMultiplier(tier, capability) {
    if (['default', 'auto', 'scale', undefined, null].includes(tier)) return 1;
    if (tier === 'flex') return 0.5;
    return Object.values(capability.modes).find(mode => mode.serviceTier === tier || ['fast', 'priority'].includes(tier) && ['fast', 'priority'].includes(mode.serviceTier))?.costMultiplier;
}
module.exports = { APIS, LEVELS, ENTRY, OFFICIAL, readSpeedConfig, validateSpeed, speedCapability, requestTier, tierMultiplier };
