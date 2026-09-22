// Read only the bundled upstream official-provider catalog. Never load user credentials,
// contact a provider, strip model suffixes, or infer a model from a display name.
const sources = {
    openai: 'https://openai.com/api/pricing/',
    google: 'https://ai.google.dev/gemini-api/docs/pricing',
    xai: 'https://docs.x.ai/developers/models',
    anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing'
};
async function officialPrices() {
    const factories = await Promise.all([
        import('@earendil-works/pi-ai/providers/openai'), import('@earendil-works/pi-ai/providers/google'),
        import('@earendil-works/pi-ai/providers/xai'), import('@earendil-works/pi-ai/providers/anthropic')
    ]);
    const catalog = new Map();
    const { createHash } = require('node:crypto');
    for (const [index, provider] of Object.keys(sources).entries()) {
        for (const model of factories[index][`${provider}Provider`]().getModels()) {
            const key = model.id;
            const entry = { provider, model: key, rates: model.cost, source: sources[provider],
                version: createHash('sha256').update(JSON.stringify(model.cost)).digest('hex') };
            if (catalog.has(key) && JSON.stringify(catalog.get(key)?.rates) !== JSON.stringify(entry.rates)) catalog.set(key, null);
            else if (!catalog.has(key)) catalog.set(key, entry);
        }
    }
    return catalog;
}
function estimateCost(row, catalog) {
    if (!row.usage || (row.cost !== null && row.cost > 0)) return { cost: row.cost, pricing: null };
    const price = catalog.get(row.model);
    if (!price || row.usage.cacheWrite1h === null || !(price.rates.input > 0 || price.rates.output > 0)) return { cost: row.cost, pricing: null };
    const input = row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;
    let rates = price.rates, threshold = -1;
    for (const tier of price.rates.tiers || []) if (input > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
        rates = { ...price.rates, ...tier }; threshold = tier.inputTokensAbove;
    }
    const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
    if (!fields.every(key => Number.isFinite(rates[key]) && rates[key] >= 0)) return { cost: row.cost, pricing: null };
    // A missing cache-write price must not turn a billable write into a free operation.
    if (row.usage.cacheWrite > 0 && rates.cacheWrite === 0) return { cost: row.cost, pricing: null };
    const longWrite = row.usage.cacheWrite1h || 0;
    const cost = fields.reduce((sum, key) => sum + row.usage[key] * rates[key] / 1e6, 0)
        + longWrite * (rates.input * 2 - rates.cacheWrite) / 1e6;
    return { cost, pricing: { ...price, appliedRates: rates, basis: 'official-catalog-estimate' } };
}
module.exports = { officialPrices, estimateCost };
