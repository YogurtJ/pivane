const { createHash } = require('node:crypto');
const { validateParameters } = require('./media-lab-service');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// A separate preference, sharing the lab catalog and validation, never storing reply text.
class PiReplyTtsService {
    constructor(lab, preferences) { this.lab = lab; this.preferences = preferences; }

    textFields(model) {
        return Object.entries(model.parameters).filter(([key, field]) =>
            ['text', 'textarea'].includes(field.type) && field.const === undefined
            && (model.adapter !== 'tts' || key === 'text')).map(([key]) => key);
    }

    revision(models) {
        return createHash('sha256').update(JSON.stringify([models, this.preferences.readDocument().replyTts || null])).digest('hex');
    }

    async snapshot() {
        const { models } = await this.lab.catalog('tts');
        const choices = models.map(model => ({ ...model, textFields: this.textFields(model) })).filter(model => model.textFields.length);
        const stored = this.preferences.readDocument().replyTts;
        let defaults = null, warning = '';
        if (object(stored)) {
            const model = choices.find(item => item.id === stored.modelId);
            try {
                if (!model || !model.textFields.includes(stored.textParameter)) fail('默认朗读模型或文本字段已不可用，请重新选择并保存。');
                const definitions = Object.fromEntries(Object.entries(model.parameters).filter(([key]) => key !== stored.textParameter));
                defaults = { modelId: model.id, textParameter: stored.textParameter, parameters: validateParameters(definitions, stored.parameters) };
            } catch { warning = '默认朗读配置已失效，请重新选择模型和参数并保存。'; }
        }
        return { models: choices, defaults, warning, revision: this.revision(choices), hasSavedDefaults: Boolean(stored) };
    }

    async save(input) {
        if (!object(input) || Object.keys(input).some(key => !['modelId', 'textParameter', 'parameters', 'expectedRevision'].includes(key))) fail('Invalid reply speech preference');
        if (JSON.stringify(input).length > 64000) fail('朗读默认参数过大。');
        const snapshot = await this.snapshot();
        if (typeof input.expectedRevision !== 'string' || input.expectedRevision !== snapshot.revision) fail('朗读配置已变化，请重新打开后保存。', 409);
        const model = snapshot.models.find(item => item.id === input.modelId);
        if (!model || !model.textFields.includes(input.textParameter)) fail('请选择可用的语音模型和文本字段。');
        if (!object(input.parameters) || Object.hasOwn(input.parameters, input.textParameter)) fail('默认配置不能包含朗读正文。');
        const definitions = Object.fromEntries(Object.entries(model.parameters).filter(([key]) => key !== input.textParameter));
        const parameters = validateParameters(definitions, input.parameters);
        // Existing native adapter rules remain authoritative; no ticket or generation is created.
        const resolved = await this.lab.validate({ modelId: model.id, parameters: { ...parameters, [input.textParameter]: 'a' } });
        const latest = await this.snapshot();
        if (latest.revision !== snapshot.revision || this.revision(latest.models) !== snapshot.revision) fail('朗读配置已变化，请重新打开后保存。', 409);
        delete resolved.parameters[input.textParameter];
        const defaults = { modelId: model.id, textParameter: input.textParameter, parameters: resolved.parameters };
        this.preferences.writeDocument({ ...this.preferences.readDocument(), replyTts: defaults });
        return { defaults, revision: this.revision(latest.models) };
    }
}
module.exports = { PiReplyTtsService };
