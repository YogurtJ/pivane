const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { MediaProviderCredentials } = require('./media-provider-credentials');
const { validateDefinition } = require('./media-lab-service');
const { validateHttp, renderTemplate, endpoint, authHeaders, readJson, keys, fail } = require('./media-http-protocol');
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) fail('ID must use letters, numbers, dot, underscore or hyphen'); return value; };
function text(value, label, maximum = 200) { if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`Invalid ${label}`); return value.trim(); }
function baseUrl(value) {
    if (typeof value !== 'string' || value.length > 2000) fail('Invalid provider base URL');
    let url; try { url = new URL(value); } catch { fail('Invalid provider base URL'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Provider URL must be HTTP(S), without credentials, query or fragment');
    return url.href.replace(/\/+$/, '');
}
function normalizeProvider(raw) {
    keys(raw, ['id','name','baseUrl','auth','probePath','modelsPath','downloadOrigins'], 'media provider');
    keys(raw.auth, ['mode','header','prefix'], 'provider authentication');
    if (!['none','bearer','header'].includes(raw.auth.mode)) fail('Unsupported authentication mode');
    const auth = { mode: raw.auth.mode };
    if (auth.mode === 'header') {
        const header = text(raw.auth.header, 'credential header', 80);
        if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header) || ['host','cookie','content-length','transfer-encoding','connection','proxy-authorization'].includes(header.toLowerCase())) fail('Invalid credential header');
        const prefix = raw.auth.prefix || '';
        if (typeof prefix !== 'string' || prefix.length > 40 || /[^\x20-\x7E]/.test(prefix)) fail('Invalid credential prefix');
        Object.assign(auth, { header, prefix });
    }
    const provider = { id: id(raw.id), name: text(raw.name, 'provider name'), baseUrl: baseUrl(raw.baseUrl), auth,
        probePath: raw.probePath ?? '/models', modelsPath: raw.modelsPath ?? '/models', downloadOrigins: [] };
    endpoint(provider.baseUrl, provider.probePath);
    if (provider.modelsPath) endpoint(provider.baseUrl, provider.modelsPath);
    if (!Array.isArray(raw.downloadOrigins || []) || (raw.downloadOrigins || []).length > 20) fail('At most 20 download origins are allowed');
    provider.downloadOrigins = [...new Set((raw.downloadOrigins || []).map(value => {
        const normalized = baseUrl(value), origin = new URL(normalized).origin;
        if (normalized !== origin) fail('Download allowlist entries must be origins without paths');
        return origin;
    }))];
    return provider;
}
function normalizeModel(raw) {
    keys(raw, ['id','name','kind','remoteModel','parameters','instructions','http'], 'media model');
    const model = { id: raw.id ? id(raw.id) : randomUUID(), name: text(raw.name, 'model name'), kind: raw.kind,
        remoteModel: text(raw.remoteModel, 'remote model ID', 500), parameters: clone(raw.parameters || {}), instructions: raw.instructions || '' };
    validateDefinition({ ...model, adapter: 'manual' });
    if (!Object.keys(model.parameters).length) fail('Define at least one editable parameter');
    if (JSON.stringify(model).length > 64000) fail('Model definition is too large');
    model.http = validateHttp(raw.http, model.parameters, model.kind);
    return model;
}
class MediaProviderService {
    constructor(options = {}) {
        this.directory = options.directory;
        this.file = path.join(this.directory, 'connections.json');
        this.credentials = options.credentials || new MediaProviderCredentials();
        this.fetch = options.fetch || require('node-fetch');
        this.clean = options.clean ?? process.env.PI_MEDIA_PROFILE === 'clean';
        this.busy = false; this.active = 0; this.epoch = 0;
    }
    read() {
        let content = '{"version":1,"providers":[]}';
        if (!this.clean && fs.existsSync(this.file)) {
            if (fs.statSync(this.file).size > 2 * 1024 * 1024) fail('Media connection configuration is too large', 500);
            content = fs.readFileSync(this.file, 'utf8');
        }
        let document;
        try { document = JSON.parse(content); } catch { fail('Media connection configuration cannot be read; no data was changed', 500); }
        if (document.version !== 1 || !Array.isArray(document.providers) || document.providers.length > 40) fail('Invalid media connection configuration', 500);
        let count = 0; const providerIds = new Set();
        for (const provider of document.providers) {
            const { models, credentialOrigin, ...fields } = provider;
            normalizeProvider(fields);
            if (providerIds.has(provider.id) || !Array.isArray(models)) fail('Invalid provider model collection', 500);
            providerIds.add(provider.id); const modelIds = new Set();
            for (const model of models) { id(model.id); normalizeModel(model); if (modelIds.has(model.id)) fail('Duplicate media model ID', 500); modelIds.add(model.id); count++; }
            if (credentialOrigin !== undefined && typeof credentialOrigin !== 'string') fail('Invalid credential binding', 500);
        }
        if (count > 60) fail('At most 60 managed media models are supported', 500);
        return { document, revision: createHash('sha256').update(content).update(String(this.epoch)).digest('hex') };
    }
    write(document) {
        const content = JSON.stringify(document, null, 2) + '\n';
        if (Buffer.byteLength(content) > 2 * 1024 * 1024) fail('Media connection configuration exceeds 2MiB');
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (fs.existsSync(this.file)) {
            const backup = `${this.file}.bak-${Date.now()}-${randomUUID()}`;
            privateFiles.writePrivateFileSync(backup, fs.readFileSync(this.file));
        }
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try { privateFiles.writePrivateFileSync(temporary, content); fs.renameSync(temporary, this.file); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    async mutate(input, task) {
        if (this.clean) fail('Clean preview does not save media connections');
        if (input.confirmed !== true) fail('Explicit configuration confirmation is required');
        if (this.busy || this.active) fail('Media connections are being used or changed; finish the current operation first', 409);
        const state = this.read();
        if (input.expectedRevision !== state.revision) fail('Connection settings changed; reload before saving', 409);
        this.busy = true; this.epoch++;
        try {
            await task(state.document);
            state.document.updatedAt = new Date().toISOString(); state.document.changeId = randomUUID();
            this.write(state.document);
        } finally { this.busy = false; }
        return this.snapshot();
    }
    find(document, providerId) { const provider = document.providers.find(item => item.id === providerId); if (!provider) fail('Media provider not found', 404); return provider; }
    async snapshot() {
        const state = this.read(), stored = await this.credentials.list();
        return { revision: state.revision, providers: state.document.providers.map(({ credentialOrigin, ...provider }) => ({ ...clone(provider),
            keyConfigured: stored.has(provider.id) && credentialOrigin === new URL(provider.baseUrl).origin,
            keyNeedsRebind: stored.has(provider.id) && credentialOrigin !== new URL(provider.baseUrl).origin
        })) };
    }
    saveProvider(input) {
        const provider = normalizeProvider(input.provider);
        return this.mutate(input, document => {
            const index = document.providers.findIndex(item => item.id === provider.id);
            if (input.create === true && index >= 0) fail('Media provider ID already exists', 409);
            if (index < 0 && document.providers.length >= 40) fail('Too many media providers');
            const next = { ...provider, models: index >= 0 ? document.providers[index].models : [], ...(index >= 0 && document.providers[index].credentialOrigin ? { credentialOrigin: document.providers[index].credentialOrigin } : {}) };
            if (index < 0) document.providers.push(next); else document.providers[index] = next;
        });
    }
    setKey(providerId, input) {
        const key = text(input.apiKey, 'API Key', 32768);
        if (/[\r\n\0]/.test(key)) fail('API Key must be a single line');
        return this.mutate(input, async document => {
            const provider = this.find(document, providerId);
            await this.credentials.save(providerId, key);
            provider.credentialOrigin = new URL(provider.baseUrl).origin;
        });
    }
    removeKey(providerId, input) {
        return this.mutate(input, async document => { const provider = this.find(document, providerId); await this.credentials.remove(providerId); delete provider.credentialOrigin; });
    }
    removeProvider(providerId, input) {
        return this.mutate(input, async document => {
            const provider = this.find(document, providerId);
            if (provider.models.length && input.removeModels !== true) fail('Remove the provider models first or explicitly include them', 409);
            await this.credentials.remove(providerId);
            document.providers = document.providers.filter(item => item !== provider);
        });
    }
    async saveModel(providerId, input) {
        const model = normalizeModel(input.model);
        const snapshot = await this.mutate(input, document => {
            const provider = this.find(document, providerId);
            const index = provider.models.findIndex(item => item.id === model.id);
            if (index < 0 && document.providers.reduce((sum, item) => sum + item.models.length, 0) >= 60) fail('Too many media models');
            if (index < 0) provider.models.push(model); else provider.models[index] = model;
        });
        return { ...snapshot, modelId: `media:${providerId}:${model.id}` };
    }
    removeModel(providerId, modelId, input) {
        return this.mutate(input, document => {
            const provider = this.find(document, providerId);
            if (!provider.models.some(item => item.id === modelId)) fail('Media model not found', 404);
            provider.models = provider.models.filter(item => item.id !== modelId);
        });
    }
    async catalogModels() {
        const snapshot = await this.snapshot();
        return snapshot.providers.flatMap(provider => provider.models.map(model => ({
            ...clone(model), id: `media:${provider.id}:${model.id}`, managedModelId: model.id, providerId: provider.id,
            name: `${provider.name} / ${model.name}`, providerName: provider.name, adapter: 'http-provider',
            configured: provider.auth.mode === 'none' || provider.keyConfigured, configurationRevision: snapshot.revision,
            connectionSummary: { provider: provider.name, baseUrl: provider.baseUrl, path: model.http.path, response: model.http.response.type, asynchronous: Boolean(model.http.poll), downloadOrigins: [new URL(provider.baseUrl).origin, ...provider.downloadOrigins] }
        })));
    }
    async key(provider) {
        if (provider.auth.mode === 'none') return '';
        if (provider.credentialOrigin !== new URL(provider.baseUrl).origin) fail('Save a Key for this provider origin before using it', 503);
        const key = await this.credentials.get(provider.id); if (!key) fail('Media provider API Key is missing', 503); return key;
    }
    async withExecution(snapshot, operation) {
        if (this.busy) fail('Media connection is being changed; review again after it finishes', 409);
        const state = this.read();
        if (snapshot.configurationRevision !== state.revision) fail('Media connection changed after review; review parameters again', 409);
        const provider = this.find(state.document, snapshot.providerId);
        const model = provider.models.find(item => item.id === snapshot.managedModelId);
        if (!model) fail('Media model no longer exists', 409);
        this.active++;
        try { return await operation({ provider, key: await this.key(provider), model }); }
        finally { this.active--; }
    }
    async probe(providerId, listModels = false) {
        if (this.busy) fail('Media connection is being changed', 409);
        const { document } = this.read(), provider = this.find(document, providerId);
        if (listModels && !provider.modelsPath) fail('No model-list endpoint is configured');
        this.active++;
        try {
            let response;
            try { response = await this.fetch(endpoint(provider.baseUrl, listModels ? provider.modelsPath : provider.probePath), {
                method: 'GET', headers: authHeaders(provider, await this.key(provider)), redirect: 'error', size: 1024 * 1024, signal: AbortSignal.timeout(15000)
            }); } catch (error) { if (error.statusCode) throw error; fail('Provider connection failed or timed out', 502); }
            if (!response.ok) { response.body?.destroy?.(); return { ok: false, httpStatus: response.status, message: response.status === 401 || response.status === 403 ? '服务可达，但拒绝了当前 Key。' : '服务返回错误；请检查 GET 路径，或手动填写模型 ID。', models: [] }; }
            if (!listModels) { response.body?.destroy?.(); return { ok: true, httpStatus: response.status, message: 'GET 连接测试通过；未提交生成，也未验证生成权限。' }; }
            const data = await readJson(response, 1024 * 1024);
            const items = Array.isArray(data) ? data : data.data || data.models;
            if (!Array.isArray(items)) fail('Model-list response must be an array or contain data/models; enter the model ID manually', 502);
            const models = items.slice(0, 500).map(item => typeof item === 'string' ? { id: item, name: item } : { id: item?.id || item?.name, name: item?.name || item?.id })
                .filter(item => typeof item.id === 'string' && item.id.length <= 500 && typeof item.name === 'string' && item.name.length <= 500);
            return { ok: true, httpStatus: response.status, models, message: '已读取模型列表；请选择适用于当前媒体协议的模型。' };
        } finally { this.active--; }
    }
    requestPreview(model, parameters) {
        return model.adapter === 'http-provider' ? { ...model.connectionSummary,
            url: endpoint(model.connectionSummary.baseUrl, model.http.path, { model: model.remoteModel, parameters }).href,
            body: renderTemplate(model.http.body, parameters, model.remoteModel) } : undefined;
    }
}
module.exports = { MediaProviderService, normalizeProvider, normalizeModel };
