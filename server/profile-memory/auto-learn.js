'use strict';

// Legacy runtime.json reviewModel is read for compatibility only. Learning
// models are selected in workspace preferences and never inherit this route.
function reviewModelConfig(raw) {
    try {
        const value = JSON.parse(raw || 'null');
        return value && typeof value.provider === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(value.provider)
            && typeof value.modelId === 'string' && value.modelId.length <= 200 && value.modelId.length > 0
            ? { provider: value.provider, modelId: value.modelId } : null;
    } catch { return null; }
}
module.exports = { reviewModelConfig };
