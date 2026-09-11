const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { applyPromptPrefix } = require('./media-profile');
const { MediaHttpExecutor } = require('./media-http-protocol');

const KINDS = new Set(['image', 'video', 'tts']);
const TYPES = new Set(['text', 'textarea', 'number', 'select', 'boolean', 'json']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const clone = value => JSON.parse(JSON.stringify(value));
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function validateDefinition(model) {
    if (!object(model) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/ -]{0,180}$/.test(model.id || '')) fail('Invalid media model ID');
    if (!KINDS.has(model.kind) || !['zimage', 'flux2', 'minimax-video', 'tts', 'http-json', 'http-provider', 'manual'].includes(model.adapter)) fail('Unsupported media adapter');
    for (const key of ['name', 'instructions', 'instructionsFile', 'documentationUrl']) {
        if (model[key] !== undefined && (typeof model[key] !== 'string' || model[key].length > (key === 'instructions' ? 64000 : 1000))) fail(`Invalid model ${key}`);
    }
    if (model.sourceImage && model.adapter !== 'minimax-video') fail('This adapter does not support a first-frame upload');
    if (!object(model.parameters) || Object.keys(model.parameters).length > 60) fail('A model requires at most 60 parameter definitions');
    for (const [key, field] of Object.entries(model.parameters)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(key) || RESERVED.has(key) || !object(field) || !TYPES.has(field.type)) fail('Invalid media parameter definition');
        if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 64000)) fail(`Invalid text limit: ${key}`);
        if (field.type === 'select' && (!Array.isArray(field.choices) || !field.choices.length || field.choices.length > 500
            || field.choices.some(choice => typeof (object(choice) ? choice.value : choice) !== 'string'))) fail(`Invalid choices: ${key}`);
        if (field.type === 'number') {
            for (const name of ['min', 'max', 'step']) if (field[name] !== undefined && !Number.isFinite(field[name])) fail(`Invalid ${name}: ${key}`);
            if (field.min > field.max || field.step <= 0) fail(`Invalid numeric range: ${key}`);
        }
    }
    if (model.adapter === 'http-json' && model.connection) {
        const connection = model.connection;
        if (connection.timeoutMs !== undefined && (!Number.isInteger(connection.timeoutMs) || connection.timeoutMs < 1000 || connection.timeoutMs > 600000)) fail('Invalid media timeout');
        const url = new URL(connection.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('Invalid media endpoint');
        if (connection.tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(connection.tokenEnv)) fail('Use an environment variable name for the API key');
        if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/wav', 'audio/mpeg'].includes(connection.mimeType)) fail('Unsupported output MIME type');
        const category = connection.mimeType.split('/')[0];
        if (category !== (model.kind === 'tts' ? 'audio' : model.kind)) fail('Output MIME type does not match media kind');
        if (!Array.isArray(connection.outputPath) || connection.outputPath.some(key => RESERVED.has(String(key)) || !['string', 'number'].includes(typeof key))) fail('Invalid output JSON path');
        if (connection.parameterKey && (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(connection.parameterKey) || RESERVED.has(connection.parameterKey))) fail('Invalid parameter envelope');
        if (connection.fixedBody !== undefined && !object(connection.fixedBody)) fail('Invalid fixed request body');
        if (connection.parameterKey && Object.hasOwn(connection.fixedBody || {}, connection.parameterKey)) fail('Fixed body conflicts with parameter envelope');
        if (!connection.parameterKey && Object.keys(connection.fixedBody || {}).some(key => Object.hasOwn(model.parameters, key))) fail('Fixed body conflicts with editable parameters');
    }
    return model;
}

function validateParameters(definitions, raw = {}) {
    if (!object(raw)) fail('Parameters must be an object');
    for (const key of Object.keys(raw)) if (!Object.hasOwn(definitions, key)) fail(`Unknown parameter: ${key}`);
    const result = {};
    for (const [key, field] of Object.entries(definitions)) {
        let value = Object.hasOwn(raw, key) ? raw[key] : field.default;
        if (value === undefined) {
            if (field.const !== undefined) value = field.const;
            else if (field.required) fail(`${field.label || key}: required`);
            else continue;
        }
        if (field.type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value) || field.integer && !Number.isInteger(value)
                || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max) fail(`${field.label || key}: invalid number or range`);
            const stepBase = field.min ?? 0;
            if (field.step && Math.abs((value - stepBase) / field.step - Math.round((value - stepBase) / field.step)) > 0.000001) fail(`${field.label || key}: expected increments of ${field.step} from ${stepBase}`);
        } else if (field.type === 'boolean') {
            if (typeof value !== 'boolean') fail(`${field.label || key}: expected boolean`);
        } else if (field.type === 'json') {
            if (!object(value) && !Array.isArray(value)) fail(`${field.label || key}: expected JSON object or array`);
            if (JSON.stringify(value).length > (field.maxLength || 12000)) fail(`${field.label || key}: JSON is too large`);
        } else {
            if (typeof value !== 'string' || value.length > (field.maxLength || 12000)) fail(`${field.label || key}: invalid text or length`);
            if (field.required && !value.trim()) fail(`${field.label || key}: required`);
            if (field.type === 'select' && !field.choices.some(choice => (object(choice) ? choice.value : choice) === value)) fail(`${field.label || key}: unsupported choice`);
        }
        if (field.const !== undefined && JSON.stringify(value) !== JSON.stringify(field.const)) fail(`${field.label || key}: fixed value`);
        result[key] = clone(value);
    }
    return result;
}

class MediaLabService {
    constructor(options) {
        Object.assign(this, options);
        this.tickets = new Map();
        this.inFlight = 0;
        this.now = options.now || Date.now;
        this.httpExecutor = options.httpExecutor || new MediaHttpExecutor({ fetch: options.fetch });
        for (const model of this.profile.models) validateDefinition(model);
    }

    async models() {
        const models = clone(this.profile.models);
        for (const model of models) {
            model.instructions = require('./media-lab-models').modelInstructions(model, this.profile.directory);
            model.configured = model.adapter === 'manual' ? false : model.adapter === 'zimage'
                ? Boolean(this.profile.gpuExec && this.profile.image.workerRoot && fs.existsSync(this.profile.image.workerRoot))
                : model.adapter === 'flux2' ? Boolean(this.fluxBaseUrl)
                    : model.adapter === 'http-json' ? Boolean(model.connection?.url && (!model.connection.tokenEnv || process.env[model.connection.tokenEnv])) : false;
            if (model.adapter === 'zimage') {
                const image = this.profile.image;
                model.parameters.negative.default = image.negative || '';
                if (image.defaultLora && image.defaultLora !== 'none') {
                    Object.assign(model.parameters, {
                        loraEnabled: { type: 'boolean', label: 'LoRA', default: true },
                        loraName: { type: 'select', label: 'LoRA 模型', choices: [image.defaultLora, 'none'], default: image.defaultLora },
                        loraStrength: { type: 'number', label: 'LoRA 权重', min: 0, max: 1.5, default: image.defaultLoraStrength }
                    });
                }
                model.presets = Object.entries(image.presets || {}).map(([id, preset]) => ({
                    id, name: preset.label || id,
                    parameters: Object.fromEntries(Object.entries(preset).filter(([key]) => Object.hasOwn(model.parameters, key)))
                }));
                const preset = model.presets.find(item => item.id === image.defaultPreset);
                if (preset) for (const [key, value] of Object.entries(preset.parameters)) model.parameters[key].default = value;
            }
        }
        const video = await this.videoService.getConfig();
        for (const model of video.models) models.push({
            id: model.id, name: model.name, kind: 'video', adapter: 'minimax-video', configured: video.configured,
            instructions: 'Describe content, motion and camera movement. An optional first frame forces adaptive aspect ratio. This is a paid asynchronous request; a local timeout does not cancel the remote task.',
            documentationUrl: video.documentationUrl, sourceImage: true,
            parameters: {
                prompt: { type: 'textarea', label: '提示词', required: true, maxLength: video.promptMaxCharacters },
                resolution: { type: 'select', label: '分辨率', choices: model.resolutions, default: model.resolutions.includes(video.defaultResolution) ? video.defaultResolution : model.resolutions[0] },
                duration: { type: 'number', label: '时长（秒）', min: model.minDuration, max: model.maxDuration, integer: true, default: video.defaultDuration },
                ratio: { type: 'select', label: '画幅', choices: video.ratios, default: '16:9' }
            }
        });
        const tts = this.ttsService.getPublicConfig();
        for (const provider of tts.providers) for (const model of provider.models) {
            const defaultVoice = model.voices.find(voice => voice.id === model.defaultVoice) || model.voices[0];
            const parameters = {
                text: { type: 'textarea', label: '合成文本', required: true, maxLength: model.maxCharacters },
                voice: { type: 'select', label: '音色', choices: model.voices.map(voice => ({ value: voice.id, label: voice.name })), default: defaultVoice.id },
                language: { type: 'select', label: '语言', choices: model.languages.map(language => ({ value: language.id, label: language.name })), default: model.defaultLanguage },
                speed: { type: 'number', label: '语速', min: 0.5, max: 2, default: 1 }
            };
            for (const control of model.controls || []) parameters[`option_${control.id}`] = {
                ...control, required: control.optional === false,
                default: defaultVoice.options?.[control.id] ?? control.default ?? (control.type === 'number' ? control.min : '')
            };
            models.push({ id: `tts:${provider.id}:${model.id}`, name: `${provider.name} / ${model.name}`, kind: 'tts',
                adapter: 'tts', provider: provider.id, nativeModel: model.id, configured: provider.configured,
                preferred: provider.id === tts.defaultProvider, parameters, instructions: provider.description,
                documentationUrl: provider.documentationUrl,
                voiceDefaults: Object.fromEntries(model.voices.map(voice => [voice.id, voice.options || {}])) });
        }
        if (this.providerService) models.push(...await this.providerService.catalogModels());
        if (new Set(models.map(model => model.id)).size !== models.length) fail('Duplicate media model ID');
        for (const model of models) validateDefinition(model);
        return models;
    }

    publicModel(model) {
        const { id, name, kind, adapter, configured, parameters, presets, instructions, documentationUrl, sourceImage, voiceDefaults, preferred } = model;
        return { id, name, kind, adapter, configured, parameters, presets, instructions, documentationUrl, sourceImage, voiceDefaults, preferred,
            managed: model.adapter === 'http-provider', providerId: model.providerId, providerName: model.providerName,
            executable: adapter !== 'manual' && configured,
            reviewRequired: true };
    }

    async catalog(kind) {
        if (kind && !KINDS.has(kind)) fail('Unknown media kind');
        return { version: 1, privateProfile: this.profile.privateProfile, mediaConnections: Boolean(this.providerService),
            models: (await this.models()).filter(model => (!kind || model.kind === kind)
                && !['zimage', 'flux2', 'minimax-video'].includes(model.adapter)).map(model => this.publicModel(model)) };
    }

    async validate(input = {}) {
        const model = (await this.models()).find(item => item.id === input.modelId);
        if (!model) fail('Media model is unavailable');
        const parameters = validateParameters(model.parameters, input.parameters);
        const warnings = [];
        let source = null;
        if (input.source && (input.source.imageData || input.source.imageUrl)) {
            if (!model.sourceImage) fail('This model does not accept a first frame');
            source = this.videoService.resolveSourceImage(input.source);
            if (parameters.ratio !== 'adaptive') warnings.push('首帧已选择，画幅调整为 adaptive。');
            parameters.ratio = 'adaptive';
        } else if (model.adapter === 'minimax-video' && parameters.ratio === 'adaptive') {
            parameters.ratio = '16:9';
            warnings.push('未选择首帧，画幅调整为 16:9。');
        }
        if (model.adapter === 'zimage') {
            const prompt = applyPromptPrefix(parameters.prompt, this.profile.image.identity);
            if (prompt !== parameters.prompt) warnings.push('已加入本地配置的提示词前缀，请核对完整提示词。');
            parameters.prompt = prompt;
            if (parameters.prompt.length > model.parameters.prompt.maxLength) fail('Prompt including local prefix is too long');
            if (parameters.negative) warnings.push('此 worker 不使用负面提示词；该字段仅随历史保存。');
        }
        let payload = { ...parameters, model: model.nativeModel || model.id };
        if (model.adapter === 'tts') {
            const options = Object.fromEntries(Object.entries(parameters).filter(([key]) => key.startsWith('option_')).map(([key, value]) => [key.slice(7), value]));
            payload = { provider: model.provider, model: model.nativeModel, text: parameters.text, voice: parameters.voice, language: parameters.language, speed: parameters.speed, options };
            if (model.configured) {
                const resolved = this.ttsService.resolveRequest(payload);
                payload = { ...payload, text: resolved.text, voice: resolved.voice.id, language: resolved.language.id, speed: resolved.speed, options: resolved.options };
                Object.assign(parameters, { text: resolved.text, voice: resolved.voice.id, language: resolved.language.id, speed: resolved.speed });
                for (const [key, value] of Object.entries(resolved.options)) parameters[`option_${key}`] = value;
            }
        }
        if (source) payload.imageData = source.dataUrl;
        if (!model.configured) warnings.push(model.adapter === 'manual' ? '仅规划：尚无执行适配器，可导出参数清单。' : '后端未配置：可以编辑清单，不能提交生成。');
        if (['http-json','http-provider'].includes(model.adapter)) warnings.push('外部服务仍可能有额外约束；费用以服务方账单为准。');
        return { model, parameters, payload, source, warnings };
    }

    async plan(input) {
        const resolved = await this.validate(input);
        return { version: 1, id: `plan-${randomUUID()}`, kind: resolved.model.kind,
            modelId: resolved.model.id, summary: String(input.summary || resolved.model.name).slice(0, 500),
            parameters: resolved.parameters, jobs: [resolved.parameters], warnings: resolved.warnings,
            execution: { mode: 'manual', count: 1 }, createdAt: new Date(this.now()).toISOString() };
    }

    async review(input) {
        for (const [id, ticket] of this.tickets) if (ticket.expiresAt < this.now() && ticket.status !== 'running') this.tickets.delete(id);
        if (this.tickets.size >= 100) fail('Too many pending media reviews', 429);
        const resolved = await this.validate(input);
        const request = this.providerService?.requestPreview(resolved.model, resolved.parameters);
        if (this.tickets.size >= 100 || [...this.tickets.values()].reduce((total, ticket) => total + (ticket.retainedBytes || 0), 0)
            + Buffer.byteLength(JSON.stringify(resolved.payload)) > 64 * 1024 * 1024) fail('Pending media reviews exceed the memory limit', 429);
        const id = randomUUID();
        const expiresAt = this.now() + 10 * 60 * 1000;
        this.tickets.set(id, { ...resolved, retainedBytes: Buffer.byteLength(JSON.stringify(resolved.payload)), status: 'reviewed', expiresAt });
        return { ticket: id, expiresAt, model: this.publicModel(resolved.model), parameters: resolved.parameters,
            request,
            source: resolved.source ? { selected: true, imageUrl: resolved.source.historyUrl || '', bytes: Buffer.byteLength(resolved.source.dataUrl) } : null,
            warnings: resolved.warnings, execution: { mode: 'manual', count: 1 }, cost: '费用由所选后端决定；当前无法提供可靠报价。' };
    }

    async execute(id) {
        const ticket = this.tickets.get(id);
        if (!ticket) fail('Review not found; review parameters again', 404);
        if (ticket.status === 'done') return ticket.result;
        if (ticket.status !== 'reviewed') fail(ticket.status === 'running' ? 'This request is already running' : 'Previous submission failed or is uncertain; check history before making a new request', 409);
        if (ticket.expiresAt < this.now()) fail('Review expired; review parameters again', 409);
        if (!ticket.model.configured || ticket.model.adapter === 'manual') fail('Media backend is not configured for execution', 503);
        if (this.inFlight >= 2) fail('Media execution slots are busy', 429);
        // Consume before awaiting: duplicate requests cannot incur a second generation.
        ticket.status = 'running';
        this.inFlight++;
        try {
            const { model, payload } = ticket;
            let result;
            if (model.adapter === 'http-provider') {
                result = await this.providerService.withExecution(model, async ({ provider, key, model: definition }) => {
                    const output = await this.httpExecutor.execute({ provider, key, model: definition, parameters: ticket.parameters,
                        progress: progress => { ticket.progress = { ...progress, updatedAt: new Date(this.now()).toISOString() }; } });
                    return this.saveExternal({ model, parameters: ticket.parameters, ...output });
                });
            } else if (model.adapter === 'http-json') result = await this.executeHttp(model, ticket.parameters);
            else if (model.adapter === 'minimax-video') result = await this.videoService.generate(payload);
            else if (model.adapter === 'tts') result = await this.generateTts(payload);
            else result = await this.generateImage(payload);
            ticket.result = { ok: true, kind: model.kind, modelId: model.id, result };
            ticket.status = 'done';
            return ticket.result;
        } catch (error) {
            ticket.status = 'uncertain';
            if (error.taskId) ticket.progress = { ...ticket.progress, taskId: error.taskId };
            throw error;
        } finally {
            this.inFlight--;
            delete ticket.payload;
            delete ticket.source;
            delete ticket.parameters;
            ticket.retainedBytes = 0;
            ticket.expiresAt = this.now() + 30 * 60 * 1000;
        }
    }

    executionStatus(id) {
        const ticket = this.tickets.get(id);
        if (!ticket) fail('Media ticket is unavailable', 404);
        return { status: ticket.status, progress: ticket.progress || null };
    }

    async executeHttp(model, parameters) {
        const connection = model.connection;
        const token = connection.tokenEnv ? process.env[connection.tokenEnv] : '';
        if (connection.tokenEnv && !token) fail('Media API credential is unavailable', 503);
        const body = connection.parameterKey ? { [connection.parameterKey]: parameters, ...connection.fixedBody } : { ...parameters, ...connection.fixedBody };
        if (!connection.parameterKey && Object.keys(connection.fixedBody || {}).some(key => Object.hasOwn(parameters, key))) fail('Fixed request fields conflict with editable parameters');
        let response;
        try {
            response = await this.fetch(connection.url, {
                method: 'POST', redirect: 'error', size: 90 * 1024 * 1024,
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(connection.timeoutMs || 180000, 600000))
            });
        } catch { fail('External media request failed or timed out; check provider before resubmitting', 502); }
        if (!response.ok) fail(`External media provider returned HTTP ${response.status}`, 502);
        let data;
        try { data = await response.json(); } catch { fail('External media provider returned invalid JSON', 502); }
        for (const key of connection.outputPath) data = data?.[key];
        if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0 || data.length > 90 * 1024 * 1024) fail('External media output is not bounded base64', 502);
        const bytes = Buffer.from(data, 'base64');
        if (!bytes.length || bytes.length > 64 * 1024 * 1024) fail('External media output is empty or too large', 502);
        const mime = connection.mimeType;
        const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
            : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                : mime === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
                    : mime === 'audio/wav' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
                        : mime === 'video/mp4' ? bytes.toString('ascii', 4, 8) === 'ftyp'
                            : bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224;
        if (!valid) fail('External media output does not match its MIME type', 502);
        return this.saveExternal({ model, parameters, bytes, mimeType: mime });
    }
}

module.exports = { MediaLabService, validateDefinition, validateParameters };
