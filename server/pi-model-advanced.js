const boolean = { type: 'boolean' };
const compatSchema = Object.fromEntries(['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'supportsStrictMode', 'supportsStrictTools', 'supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsThinkingTokenBudget'].map(key => [key, boolean]));
Object.assign(compatSchema, {
    maxTokensField: { choices: ['max_tokens', 'max_completion_tokens'] },
    thinkingFormat: { choices: ['reasoning_effort', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template'] },
    thinkingTokenBudgetField: { choices: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'] }
});
const samplingSchema = {
    temperature: [0, 2], top_p: [0, 1], top_k: [0, 100000], min_p: [0, 1],
    presence_penalty: [-2, 2], frequency_penalty: [-2, 2], repetition_penalty: [0, 10], seed: [0, 2147483647]
};
const pick = (value, schema) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => Object.hasOwn(schema, key)));
function validateMap(value, schema, label) {
    if (value === null) return;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 50) throw new Error(label + '必须是对象');
    for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(schema, key)) throw new Error('不支持的' + label + '：' + key);
        if (item === null) continue;
        const rule = schema[key];
        if (Array.isArray(rule) ? typeof item !== 'number' || !Number.isFinite(item) || item < rule[0] || item > rule[1]
            : rule.choices ? !rule.choices.includes(item) : typeof item !== rule.type) throw new Error(label + '值无效：' + key);
    }
}
function validateCost(value) {
    if (value === null) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('价格必须是对象');
    for (const [key, price] of Object.entries(value)) {
        if (!['input', 'output', 'cacheRead', 'cacheWrite'].includes(key) || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 100000) throw new Error('价格字段或范围无效');
    }
}
function mergeFields(base, changes, keys) {
    const result = { ...base };
    if (changes === null) { for (const key of Object.keys(keys)) delete result[key]; }
    else for (const [key, value] of Object.entries(changes)) { if (value === null) delete result[key]; else result[key] = value; }
    return result;
}
module.exports = { compatSchema, samplingSchema, pick, validateMap, validateCost, mergeFields };
