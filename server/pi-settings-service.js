const privateFiles = require('./pi-private-files');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { WorkspacePreferencesService } = require('./workspace-preferences-service');
const { PiProviderLoginService, literal } = require('./pi-provider-login-service');
const { createHash } = require('node:crypto');
const aiPromise = import('@earendil-works/pi-ai');
const THINKING_MAP_KEYS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function cleanModelId(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u0020\u007f]/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error('Invalid model ID');
    return value;
}

function thinkingMap(value) {
    if (value === null) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Thinking map must be an object');
    const result = {};
    for (const [key, mapping] of Object.entries(value)) {
        if (!THINKING_MAP_KEYS.includes(key) || (mapping !== null && (typeof mapping !== 'string' || !mapping.trim() || mapping.length > 100 || /[\u0000-\u001f]/.test(mapping)))) throw new Error('Invalid thinking level mapping');
        result[key] = mapping;
    }
    return result;
}

const execFileAsync = promisify(execFile);
const CUSTOM_APIS = new Set([
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai'
]);

function getSdk() {
    return require('./pi-session-store').getSdk();
}

function cleanId(value, label) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) {
        throw new Error(`${label} must use letters, numbers, dot, underscore, or hyphen`);
    }
    return id;
}

function cleanUrl(value, required = true) {
    const raw = String(value || '').trim();
    if (!raw && !required) return undefined;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Provider base URL is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Provider URL must use http or https');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Provider URL must not contain credentials, query parameters, or a fragment');
    return raw.replace(/\/+$/, '');
}

function numberInRange(value, fallback, min, max) {
    const number = Number(value ?? fallback);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`Numeric value must be between ${min} and ${max}`);
    }
    return Math.floor(number);
}

function modelSummary(model, availableSet) {
    return {
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        api: model.api,
        reasoning: Boolean(model.reasoning),
        input: Array.isArray(model.input) ? model.input : ['text'],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        available: availableSet.has(`${model.provider}\u0000${model.id}`),
        cost: model.cost || null
    };
}

function assistantText(message) {
    if (!Array.isArray(message?.content)) return '';
    return message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
}

class PiSettingsService {
    constructor(options = {}) {
        this.cwdFallback = options.cwd || process.cwd();
        this.loginService = new PiProviderLoginService(() => this.createModelRuntime());
        this.mutating = false;
        this.workspacePreferencesService = options.workspacePreferencesService || new WorkspacePreferencesService(options.workspacePreferencesOptions);
    }

    async paths() {
        const { getAgentDir } = await getSdk();
        const agentDir = getAgentDir();
        return {
            agentDir,
            modelsPath: path.join(agentDir, 'models.json'),
            skillsDir: path.join(agentDir, 'skills')
        };
    }

    async createModelRuntime() {
        const { ModelRuntime } = await getSdk();
        return ModelRuntime.create({
            allowModelNetwork: false,
            signal: AbortSignal.timeout(30000)
        });
    }

    async getModelSnapshot() {
        const runtime = await this.createModelRuntime();
        const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(10000) });
        const storedByProvider = new Map(credentials.map(item => [item.providerId, item.type]));
        const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(20000) });
        const availableSet = new Set(available.map(model => `${model.provider}\u0000${model.id}`));
        const { getSupportedThinkingLevels } = await aiPromise;
        const models = runtime.getModels().map(model => ({ ...modelSummary(model, availableSet),
            thinkingLevels: getSupportedThinkingLevels(model), thinkingLevelMap: model.thinkingLevelMap || {} }));
        const modelCounts = new Map();
        for (const model of models) modelCounts.set(model.provider, (modelCounts.get(model.provider) || 0) + 1);

        const providers = runtime.getProviders().map(provider => {
            const status = runtime.getProviderAuthStatus(provider.id);
            return {
                id: provider.id,
                name: provider.name || provider.id,
                configured: Boolean(status.configured),
                authSource: status.source || null,
                authLabel: status.label || null,
                storedCredential: storedByProvider.get(provider.id) || null,
                authMethods: {
                    apiKey: Boolean(provider.auth?.apiKey),
                    apiKeyLogin: Boolean(provider.auth?.apiKey?.login),
                    apiKeyName: provider.auth?.apiKey?.name || null,
                    oauth: Boolean(provider.auth?.oauth),
                    oauthName: provider.auth?.oauth?.name || null,
                    oauthLabel: provider.auth?.oauth?.loginLabel || null,
                    subscription: Boolean(provider.auth?.oauth?.isSubscription)
                },
                modelCount: modelCounts.get(provider.id) || 0
            };
        });

        const { SettingsManager, getAgentDir } = await getSdk();
        const settings = SettingsManager.create(this.cwdFallback, getAgentDir());
        return {
            providerLogin: true,
            modelThinking: true,
            modelAdvanced: true,
            thinkingMapKeys: THINKING_MAP_KEYS,
            revision: await this.configRevision(),
            providers,
            models,
            preferences: {
                defaultProvider: settings.getDefaultProvider() || '',
                defaultModel: settings.getDefaultModel() || '',
                enabledModels: settings.getEnabledModels() || [],
                defaultThinkingLevel: settings.getGlobalSettings().defaultThinkingLevel || null,
                modelThinkingLevels: settings.getGlobalSettings().modelThinkingLevels || {},
                mediaAgent: this.workspacePreferencesService.getMediaAgent()
            },
            customProviders: await this.listCustomProviders()
        };
    }

    async saveApiKey(providerIdInput, apiKeyInput) {
        const providerId = cleanId(providerIdInput, 'Provider ID');
        const apiKey = String(apiKeyInput || '').trim();
        if (!apiKey || apiKey.length > 32768) throw new Error('API key is required');
        const runtime = await this.createModelRuntime();
        const provider = runtime.getProvider(providerId);
        if (!provider) throw new Error('Provider not found');
        if (!provider.auth?.apiKey?.login) throw new Error('This provider does not support API key login through Pi');
        let supplied = false;
        const notifications = [];
        await runtime.login(providerId, 'api_key', {
            signal: AbortSignal.timeout(60000),
            prompt: async prompt => {
                if (!supplied && (prompt.type === 'secret' || prompt.type === 'text' || prompt.type === 'manual_code')) {
                    supplied = true;
                    return literal(apiKey);
                }
                throw new Error(`Provider requires additional interactive setup: ${prompt.message}`);
            },
            notify: event => {
                if (event.type === 'progress' || event.type === 'info') notifications.push(event.message);
            }
        });
        return { ok: true, providerId, notifications, requiresRuntimeRestart: true };
    }

    async logout(providerIdInput) {
        const providerId = cleanId(providerIdInput, 'Provider ID');
        const runtime = await this.createModelRuntime();
        if (!runtime.getProvider(providerId)) throw new Error('Provider not found');
        await runtime.logout(providerId, { signal: AbortSignal.timeout(30000) });
        const status = runtime.getProviderAuthStatus(providerId);
        return {
            ok: true,
            providerId,
            stillConfigured: Boolean(status.configured),
            authSource: status.source || null,
            requiresRuntimeRestart: true
        };
    }

    async refreshModels() {
        const runtime = await this.createModelRuntime();
        const result = await runtime.refresh({
            allowNetwork: true,
            force: true,
            signal: AbortSignal.timeout(60000)
        });
        return {
            ok: true,
            aborted: Boolean(result.aborted),
            errors: [...(result.errors || new Map()).entries()].map(([provider, error]) => ({
                provider,
                error: error instanceof Error ? error.message : String(error)
            })),
            requiresRuntimeRestart: true
        };
    }

    async setModelPreferences(input) {
        const { SettingsManager, getAgentDir } = await getSdk();
        const provider = cleanId(input.defaultProvider, 'Provider ID');
        const model = cleanModelId(input.defaultModel);
        const runtime = await this.createModelRuntime();
        if (!runtime.getModel(provider, model)) throw new Error('Model not found');
        const settings = SettingsManager.create(this.cwdFallback, getAgentDir());
        settings.setDefaultModelAndProvider(provider, model);
        if (Array.isArray(input.enabledModels)) {
            const patterns = input.enabledModels.map(value => String(value).trim()).filter(Boolean).slice(0, 200);
            settings.setEnabledModels(patterns.length ? patterns : undefined);
        }
        await settings.flush();
        const errors = settings.drainErrors();
        if (errors.length) throw errors[0].error;
        return { ok: true, defaultProvider: provider, defaultModel: model, requiresRuntimeRestart: true };
    }

    async setMediaAgentModel(input) {
        const provider = String(input.provider || '').trim();
        const modelId = String(input.modelId || '').trim();
        if (!provider || !modelId || provider.length > 300 || modelId.length > 300) {
            throw new Error('Provider and model are required');
        }
        const runtime = await this.createModelRuntime();
        const available = await runtime.getAvailable(provider, { signal: AbortSignal.timeout(20000) });
        const model = available.find(item => item.provider === provider && item.id === modelId);
        if (!model) throw new Error('Media Agent model is not authenticated or available');
        const preference = this.workspacePreferencesService.setMediaAgent({ provider, modelId });
        return { ok: true, mediaAgent: preference, requiresRuntimeRestart: false };
    }

    async testModel(input) {
        const provider = cleanId(input.provider, 'Provider ID');
        const modelId = cleanModelId(input.modelId);
        const prompt = String(input.prompt || 'Reply with exactly: OK').trim().slice(0, 2000);
        const runtime = await this.createModelRuntime();
        const model = runtime.getModel(provider, modelId);
        if (!model) throw new Error('Model not found');
        const startedAt = Date.now();
        const response = await runtime.completeSimple(model, {
            messages: [{ role: 'user', content: prompt, timestamp: Date.now() }]
        }, {
            maxTokens: 64,
            signal: AbortSignal.timeout(90000),
            sessionId: `pi-web-model-test-${Date.now()}`
        });
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            throw new Error(response.errorMessage || `Model test ${response.stopReason}`);
        }
        return {
            ok: true,
            provider,
            modelId,
            text: assistantText(response),
            latencyMs: Date.now() - startedAt,
            usage: response.usage || null,
            stopReason: response.stopReason
        };
    }

    readModelsFile(modelsPath) {
        if (!fs.existsSync(modelsPath)) return { providers: {} };
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
        } catch {
            throw new Error('models.json is invalid JSON; check the local configuration file');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('models.json root must be an object');
        if (!parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) parsed.providers = {};
        return parsed;
    }

    async writeModelsFile(data) {
        const { modelsPath, agentDir } = await this.paths();
        fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        if (fs.existsSync(modelsPath)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            privateFiles.writePrivateFileSync(`${modelsPath}.bak-web-${stamp}`, fs.readFileSync(modelsPath));
        }
        const temporary = `${modelsPath}.tmp-${process.pid}-${Date.now()}`;
        privateFiles.writePrivateFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
        fs.renameSync(temporary, modelsPath);
    }

    async listCustomProviders() {
        const { modelsPath } = await this.paths();
        const data = this.readModelsFile(modelsPath);
        return Object.entries(data.providers).map(([id, config]) => ({
            id,
            baseUrl: (() => { try { const url = new URL(config.baseUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href.replace(/\/$/, ''); } catch { return ''; } })(),
            api: config.api || '',
            authHeader: Boolean(config.authHeader),
            hasApiKeyConfig: config.apiKey !== undefined,
            apiKeySource: typeof config.apiKey === 'string' && config.apiKey.startsWith('$')
                ? 'environment'
                : typeof config.apiKey === 'string' && config.apiKey.startsWith('!')
                    ? 'command'
                    : config.apiKey !== undefined ? 'inline' : null,
            modelCount: Array.isArray(config.models) ? config.models.length : 0,
            models: (Array.isArray(config.models) ? config.models : []).map(model => ({
                id: model.id,
                name: model.name || model.id,
                api: model.api || config.api || '',
                reasoning: Boolean(model.reasoning),
                thinkingLevelMap: model.thinkingLevelMap || {},
                input: Array.isArray(model.input) ? model.input : ['text'],
                contextWindow: model.contextWindow || 128000,
                maxTokens: model.maxTokens || 16384
            }))
        })).sort((a, b) => a.id.localeCompare(b.id));
    }

    async upsertCustomProvider(input) {
        const id = cleanId(input.id, 'Provider ID');
        const api = String(input.api || '').trim();
        if (!CUSTOM_APIS.has(api)) throw new Error('Unsupported custom provider API');
        const baseUrl = cleanUrl(input.baseUrl, true);
        const { modelsPath } = await this.paths();
        const data = this.readModelsFile(modelsPath);
        const current = data.providers[id] && typeof data.providers[id] === 'object' ? data.providers[id] : {};
        data.providers[id] = {
            ...current,
            baseUrl,
            api,
            authHeader: Boolean(input.authHeader),
            models: Array.isArray(current.models) ? current.models : []
        };
        await this.writeModelsFile(data);
        return { ok: true, providerId: id, requiresRuntimeRestart: true };
    }

    async deleteCustomProvider(providerIdInput) {
        const providerId = cleanId(providerIdInput, 'Provider ID');
        const { modelsPath } = await this.paths();
        const data = this.readModelsFile(modelsPath);
        if (!Object.prototype.hasOwnProperty.call(data.providers, providerId)) throw new Error('Custom provider not found');
        const { ModelRuntime } = await getSdk();
        const builtins = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, signal: AbortSignal.timeout(30000) });
        if (!builtins.getProvider(providerId)) {
            const runtime = await this.createModelRuntime();
            if (runtime.getProvider(providerId)) await runtime.logout(providerId, { signal: AbortSignal.timeout(30000) });
        }
        delete data.providers[providerId];
        await this.writeModelsFile(data);
        return { ok: true, providerId, requiresRuntimeRestart: true };
    }

    async upsertCustomModel(providerIdInput, input) {
        const providerId = cleanId(providerIdInput, 'Provider ID');
        const id = cleanModelId(input.id);
        const { modelsPath } = await this.paths();
        const data = this.readModelsFile(modelsPath);
        const provider = data.providers[providerId];
        if (!provider || typeof provider !== 'object') throw new Error('Custom provider not found');
        const models = Array.isArray(provider.models) ? provider.models : [];
        const index = models.findIndex(model => model.id === id);
        const current = index >= 0 ? models[index] : {};
        const model = {
            ...current,
            id,
            name: String(input.name || id).trim().slice(0, 200) || id,
            reasoning: Boolean(input.reasoning),
            input: input.imageInput ? ['text', 'image'] : ['text'],
            contextWindow: numberInRange(input.contextWindow, 128000, 1024, 4000000),
            maxTokens: numberInRange(input.maxTokens, 16384, 1, 1000000),
            cost: current.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        };
        if (Object.hasOwn(input, 'thinkingLevelMap')) {
            const map = thinkingMap(input.thinkingLevelMap);
            if (map === undefined) delete model.thinkingLevelMap;
            else model.thinkingLevelMap = map;
            const { getSupportedThinkingLevels } = await aiPromise;
            if (!getSupportedThinkingLevels(model).length) throw new Error('At least one thinking level must remain supported');
        }
        if (input.api) {
            const api = String(input.api).trim();
            if (!CUSTOM_APIS.has(api)) throw new Error('Unsupported model API');
            model.api = api;
        } else if (Object.hasOwn(input, 'api')) {
            delete model.api;
        }
        if (index >= 0) models[index] = model;
        else models.push(model);
        provider.models = models;
        await this.writeModelsFile(data);
        return { ok: true, providerId, modelId: id, requiresRuntimeRestart: true };
    }

    async deleteCustomModel(providerIdInput, modelIdInput) {
        const providerId = cleanId(providerIdInput, 'Provider ID');
        const modelId = cleanModelId(modelIdInput);
        const { modelsPath } = await this.paths();
        const data = this.readModelsFile(modelsPath);
        const provider = data.providers[providerId];
        if (!provider || !Array.isArray(provider.models)) throw new Error('Custom provider not found');
        const filtered = provider.models.filter(model => model.id !== modelId);
        if (filtered.length === provider.models.length) throw new Error('Custom model not found');
        provider.models = filtered;
        await this.writeModelsFile(data);
        return { ok: true, providerId, modelId, requiresRuntimeRestart: true };
    }

    async getModelAdvanced(input) {
        const { compatSchema, samplingSchema, pick } = require('./pi-model-advanced');
        const provider = cleanId(input.provider, 'Provider ID'), modelId = cleanModelId(input.modelId);
        const revision = await this.configRevision();
        const runtime = await this.createModelRuntime();
        const model = runtime.getModel(provider, modelId);
        if (!model) throw new Error('模型不存在');
        const { modelsPath } = await this.paths();
        const config = this.readModelsFile(modelsPath).providers[provider] || {};
        const local = config.models?.find(m => m.id === modelId) || config.modelOverrides?.[modelId] || {};
        if (revision !== await this.configRevision()) throw Object.assign(new Error('模型配置已变化，请重新读取'), { statusCode: 409 });
        return { provider, modelId, revision, compatSchema, samplingSchema,
            compat: pick(local.compat, compatSchema), samplingParams: pick(local.samplingParams, samplingSchema),
            cost: local.cost ? { input: local.cost.input, output: local.cost.output, cacheRead: local.cost.cacheRead, cacheWrite: local.cost.cacheWrite } : {},
            effectiveCost: model.cost || null, effectiveCompat: pick(model.compat, compatSchema),
            api: model.api, hasPricingTiers: Boolean(model.cost?.tiers?.length),
            samplingSupported: ['openai-completions', 'openai-responses', 'azure-openai-responses'].includes(model.api) };
    }

    async saveModelAdvanced(input) {
        const { compatSchema, samplingSchema, validateMap, validateCost, mergeFields } = require('./pi-model-advanced');
        const provider = cleanId(input.provider, 'Provider ID'), modelId = cleanModelId(input.modelId);
        if (Object.hasOwn(input, 'compat')) validateMap(input.compat, compatSchema, '兼容参数');
        if (Object.hasOwn(input, 'samplingParams')) validateMap(input.samplingParams, samplingSchema, '采样参数');
        if (Object.hasOwn(input, 'cost')) validateCost(input.cost);
        const runtime = await this.createModelRuntime();
        const model = runtime.getModel(provider, modelId);
        if (!model) throw new Error('模型不存在');
        if (input.samplingParams && Object.keys(input.samplingParams).length && !['openai-completions', 'openai-responses', 'azure-openai-responses'].includes(model.api)) throw new Error('此 API 不支持这些采样参数');
        const { modelsPath } = await this.paths();
        if (input.expectedRevision !== await this.configRevision()) throw Object.assign(new Error('模型配置已变化，请刷新后再保存'), { statusCode: 409 });
        const data = this.readModelsFile(modelsPath);
        const config = data.providers[provider] ||= {};
        let local = config.models?.find(m => m.id === modelId);
        if (!local) local = (config.modelOverrides ||= {})[modelId] ||= {};
        for (const [key, schema] of [['compat', compatSchema], ['samplingParams', samplingSchema]]) {
            if (!Object.hasOwn(input, key)) continue;
            local[key] = mergeFields(local[key], input[key], schema);
            if (!Object.keys(local[key]).length) delete local[key];
        }
        if (Object.hasOwn(input, 'cost')) {
            if (input.cost === null) delete local.cost;
            else local.cost = { ...(local.id ? model.cost : {}), ...local.cost, ...input.cost };
        }
        await this.writeModelsFile(data);
        return { ok: true, requiresRuntimeRestart: true };
    }

    async configRevision() {
        const { modelsPath, agentDir } = await this.paths();
        const hash = createHash('sha256');
        for (const file of [modelsPath, path.join(agentDir, 'settings.json')]) {
            hash.update(fs.existsSync(file) ? fs.readFileSync(file) : ''); hash.update('\u0000');
        }
        return hash.digest('hex');
    }

    async saveModelThinking(input) {
        const providerId = cleanId(input.provider, 'Provider ID');
        const modelId = cleanModelId(input.modelId);
        const revision = await this.configRevision();
        if (input.expectedRevision !== revision) throw Object.assign(new Error('配置已变化，请刷新后再保存'), { statusCode: 409 });
        const runtime = await this.createModelRuntime();
        const model = runtime.getModel(providerId, modelId);
        if (!model) throw new Error('Model not found');
        const { getSupportedThinkingLevels } = await aiPromise;
        const { SettingsManager, getAgentDir } = await getSdk();
        const { modelsPath } = await this.paths();
        const data = this.readModelsFile(modelsPath);
        const config = data.providers[providerId] || {};
        const custom = config.models?.find(item => item.id === modelId);
        const target = custom || { ...(config.modelOverrides?.[modelId] || {}) };
        const changingMap = Object.hasOwn(input, 'thinkingLevelMap');
        let effective = model;
        if (changingMap) {
            const map = thinkingMap(input.thinkingLevelMap);
            if (map === undefined) delete target.thinkingLevelMap;
            else target.thinkingLevelMap = map;
            // For native models, an omitted map restores the provider's own definition.
            const { ModelRuntime } = await getSdk();
            const base = custom ? undefined : (await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, signal: AbortSignal.timeout(30000) })).getModel(providerId, modelId);
            effective = { ...model, thinkingLevelMap: custom ? map : { ...base?.thinkingLevelMap, ...map } };
        }
        const levels = getSupportedThinkingLevels(effective);
        if (!levels.length) throw new Error('至少保留一个可用的思考等级');
        const settings = SettingsManager.create(this.cwdFallback, getAgentDir());
        const level = input.defaultThinkingLevel;
        if (level !== undefined && level !== null && !levels.includes(level)) throw new Error('默认思考等级不在此模型支持范围内');
        const existing = settings.getGlobalSettings().modelThinkingLevels?.[`${providerId}/${modelId}`];
        if (level === undefined && existing && !levels.includes(existing)) throw new Error('请同时调整或清除不再支持的默认思考等级');
        if (await this.configRevision() !== revision) throw Object.assign(new Error('配置已变化，请刷新后再保存'), { statusCode: 409 });
        if (changingMap) {
            if (!custom) {
                config.modelOverrides = { ...(config.modelOverrides || {}), [modelId]: target };
            }
            data.providers[providerId] = config;
            await this.writeModelsFile(data);
        }
        if (level === null) settings.removeModelThinkingLevel(providerId, modelId);
        else if (level !== undefined) settings.setModelThinkingLevel(providerId, modelId, level);
        await settings.flush();
        const errors = settings.drainErrors();
        if (errors.length) throw new Error('思考配置可能已部分保存，请刷新检查后再修改');
        return { ok: true, requiresRuntimeRestart: true };
    }

    async createResourceContext(cwdInput) {
        const { SettingsManager, DefaultPackageManager, ProjectTrustStore, getAgentDir } = await getSdk();
        const cwd = String(cwdInput || this.cwdFallback);
        const agentDir = getAgentDir();
        const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
        const override = process.env.PI_WEB_APPROVE_PROJECTS === 'true' ? true : process.env.PI_WEB_APPROVE_PROJECTS === 'false' ? false : null;
        const projectTrusted = override ?? new ProjectTrustStore(agentDir).get(cwd) ?? (global.getDefaultProjectTrust() === 'always');
        const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
        const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
        return { cwd, agentDir, settings, packageManager };
    }

    async getResourceSnapshot(cwdInput) {
        const { loadSkills } = await getSdk();
        const context = await this.createResourceContext(cwdInput);
        const resolved = await context.packageManager.resolve(async () => 'skip');
        const enabledSkillPaths = resolved.skills.filter(item => item.enabled).map(item => item.path);
        const skills = loadSkills({
            cwd: context.cwd,
            agentDir: context.agentDir,
            skillPaths: enabledSkillPaths,
            includeDefaults: false
        });
        const configured = context.packageManager.listConfiguredPackages();
        const skillResourceByPath = new Map(resolved.skills.map(item => [path.resolve(item.path), item]));
        return {
            packages: configured.map(item => ({
                source: item.source,
                scope: item.scope,
                filtered: item.filtered,
                installed: Boolean(item.installedPath),
                installedPath: item.installedPath || null
            })),
            resources: {
                extensions: resolved.extensions.map(item => this.resourceSummary(item)),
                skills: resolved.skills.map(item => this.resourceSummary(item)),
                prompts: resolved.prompts.map(item => this.resourceSummary(item)),
                themes: resolved.themes.map(item => this.resourceSummary(item))
            },
            skills: skills.skills.map(skill => {
                const resource = skillResourceByPath.get(path.resolve(skill.filePath));
                return {
                    name: skill.name,
                    description: skill.description,
                    filePath: skill.filePath,
                    source: resource?.metadata?.source || skill.sourceInfo?.source || 'unknown',
                    scope: resource?.metadata?.scope || skill.sourceInfo?.scope || 'user',
                    disableModelInvocation: Boolean(skill.disableModelInvocation),
                    manageable: this.isManagedUserSkill(skill.filePath, context.agentDir)
                };
            }),
            diagnostics: skills.diagnostics.map(item => ({
                path: item.path || null,
                message: item.message,
                severity: item.severity || 'warning'
            })),
            settings: {
                skillPaths: context.settings.getSkillPaths(),
                extensionPaths: context.settings.getExtensionPaths(),
                enableSkillCommands: context.settings.getEnableSkillCommands()
            }
        };
    }

    resourceSummary(item) {
        return {
            path: item.path,
            enabled: item.enabled,
            source: item.metadata?.source || 'unknown',
            scope: item.metadata?.scope || 'user',
            origin: item.metadata?.origin || 'top-level'
        };
    }

    async packageAction(input) {
        const action = String(input.action || '');
        const source = String(input.source || '').trim();
        if (!['install', 'remove', 'update'].includes(action)) throw new Error('Unsupported package action');
        if (!source || source.length > 1000 || source.startsWith('-')) throw new Error('Package source is invalid');
        const context = await this.createResourceContext(input.cwd);
        const progress = [];
        context.packageManager.setProgressCallback(event => {
            progress.push({ action: event.action, source: event.source, message: event.message || '', type: event.type });
        });
        if (action === 'install') await context.packageManager.installAndPersist(source, { local: false });
        if (action === 'remove') await context.packageManager.removeAndPersist(source, { local: false });
        if (action === 'update') await context.packageManager.update(source);
        return { ok: true, action, source, progress, requiresRuntimeRestart: true };
    }

    async setSkillCommands(enabled, cwdInput) {
        const context = await this.createResourceContext(cwdInput);
        context.settings.setEnableSkillCommands(Boolean(enabled));
        await context.settings.flush();
        const errors = context.settings.drainErrors();
        if (errors.length) throw errors[0].error;
        return { ok: true, enabled: Boolean(enabled), requiresRuntimeRestart: true };
    }

    isManagedUserSkill(filePath, agentDir) {
        const root = path.resolve(agentDir, 'skills');
        const resolved = path.resolve(filePath);
        return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    }

    async createSkill(input) {
        const name = String(input.name || '').trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
            throw new Error('Skill name must be lowercase letters, numbers, and single hyphens');
        }
        const description = String(input.description || '').trim();
        if (!description || description.length > 1024) throw new Error('Skill description is required and must be at most 1024 characters');
        const body = String(input.body || '').trim();
        if (!body || body.length > 200000) throw new Error('Skill instructions are required');
        const { skillsDir } = await this.paths();
        const skillDir = path.join(skillsDir, name);
        const skillPath = path.join(skillDir, 'SKILL.md');
        if (fs.existsSync(skillPath) && !input.overwrite) throw new Error('Skill already exists');
        fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
        const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
        const temporary = `${skillPath}.tmp-${process.pid}-${Date.now()}`;
        privateFiles.writePrivateFileSync(temporary, content);
        fs.renameSync(temporary, skillPath);
        return { ok: true, name, filePath: skillPath, requiresRuntimeRestart: true };
    }

    async deleteSkill(nameInput) {
        const name = String(nameInput || '').trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid skill name');
        const { skillsDir } = await this.paths();
        const skillDir = path.join(skillsDir, name);
        const skillPath = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillPath)) throw new Error('Managed user skill not found');
        try {
            await execFileAsync('gio', ['trash', skillDir], { timeout: 10000 });
        } catch {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
        return { ok: true, name, requiresRuntimeRestart: true };
    }
}

// Serialize settings mutations in this service; do not let a pending login race logout or model edits.
for (const method of ['saveApiKey', 'logout', 'upsertCustomProvider', 'deleteCustomProvider', 'upsertCustomModel', 'deleteCustomModel', 'setModelPreferences', 'saveModelThinking', 'saveModelAdvanced', 'packageAction', 'createSkill', 'deleteSkill', 'setSkillCommands']) {
    const operation = PiSettingsService.prototype[method];
    PiSettingsService.prototype[method] = async function (...args) {
        this.loginService.assertIdle();
        if (this.mutating || this.nativeService?.busy) throw Object.assign(new Error('设置正在保存，请稍后再试'), { statusCode: 409 });
        this.mutating = true;
        try { return await operation.apply(this, args); } finally { this.mutating = false; }
    };
}
module.exports = { PiSettingsService, cleanId, cleanUrl, cleanModelId };
