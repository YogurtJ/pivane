const { createHash, randomUUID } = require('node:crypto');
const { endpoint, readJson, authHeaders } = require('./media-http-protocol');
const MAX_AUDIO = 7_500_000;
const MAX_TEXT = 65_536;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Audio protocols are distinct from Pi's text completion APIs. Offer only known
// protocols on configured providers, and obtain credentials through ModelRuntime.
function transcriptionModels(models, available) {
    const configured = new Set(available.map(model => model.provider));
    const found = new Map();
    for (const model of models) {
        if (!configured.has(model.provider)) continue;
        let url;
        try { url = new URL(model.baseUrl); } catch { continue; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) continue;
        const baseUrl = url.href.replace(/\/+$/, '');
        const mimo = url.protocol === 'https:' && ['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com', 'token-plan-ams.xiaomimimo.com'].includes(url.hostname);
        const remoteModels = mimo ? ['mimo-v2.5-asr'] : /^(whisper-1|gpt-4o(?:-mini)?-transcribe(?:-[\w-]+)?)$/.test(model.id) ? [model.id]
            : url.origin === 'https://api.openai.com' && model.provider === 'openai' ? ['whisper-1', 'gpt-4o-mini-transcribe'] : [];
        for (const remoteModel of remoteModels) {
            const id = JSON.stringify([model.provider, remoteModel]);
            found.set(id, { id, provider: model.provider, modelId: remoteModel, name: `${model.provider} / ${remoteModel}`,
                protocol: mimo ? 'mimo' : 'openai', baseUrl });
        }
    }
    return [...found.values()].sort((a, b) => Number(b.protocol === 'mimo') - Number(a.protocol === 'mimo') || a.name.localeCompare(b.name));
}
function audioBytes(audio) {
    if (!audio || !['wav', 'mp3'].includes(audio.format) || typeof audio.data !== 'string'
        || !audio.data || audio.data.length > 10_000_000 || audio.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(audio.data)) fail('录音格式无效，仅支持 WAV / MP3，最大 7.5MB');
    const bytes = Buffer.from(audio.data, 'base64');
    if (bytes.toString('base64') !== audio.data) fail('录音格式无效，仅支持 WAV / MP3，最大 7.5MB');
    if (bytes.length < 12 || bytes.length > MAX_AUDIO) fail('录音大小无效，最大 7.5MB');
    const wav = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
    const mp3 = bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (audio.format === 'wav' ? !wav : !mp3) fail('录音内容与文件格式不符');
    return bytes;
}
function multipart(model, audio, bytes, language) {
    const boundary = `pivane-${randomUUID()}`;
    const fields = { model, response_format: 'json', ...(language === 'auto' ? {} : { language }) };
    const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${audio.format}"\r\nContent-Type: ${audio.format === 'wav' ? 'audio/wav' : 'audio/mpeg'}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}
class PiTranscriptionService {
    constructor({ createModelRuntime, providerService, fetch = require('./workspace-network-transport').networkFetch, timeoutMs = 180000, blocked = () => false }) {
        this.createModelRuntime = createModelRuntime; this.providerService = providerService; this.fetch = fetch; this.timeoutMs = timeoutMs; this.blocked = blocked;
        this.jobs = new Map(); this.closed = false; this.inspecting = 0;
    }
    get active() { return this.inspecting + [...this.jobs.values()].filter(job => job.pending).length; }
    async catalog() {
        if (this.closed) fail('语音转录服务正在关闭', 503);
        this.inspecting++;
        try {
            let models = [], nativeCatalogUnavailable = false;
            try {
                const runtime = await this.createModelRuntime();
                const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(20000) });
                models = transcriptionModels(runtime.getModels(), available);
            } catch {
                if (!this.providerService) fail('无法读取语音模型，请检查供应商与认证配置', 503);
                nativeCatalogUnavailable = true;
            }
            if (this.providerService) {
                const snapshot = await this.providerService.snapshot();
                for (const definition of snapshot.transcriptionModels) {
                    const provider = snapshot.providers.find(item => item.id === definition.providerId);
                    if (!provider || provider.auth.mode !== 'none' && !provider.keyConfigured) continue;
                    models.push({ id: `asr:${provider.id}:${definition.id}`, provider: provider.id, modelId: definition.remoteModel,
                        name: `${provider.name} / ${definition.name}`, protocol: definition.protocol, baseUrl: provider.baseUrl,
                        managedModelId: definition.id, configurationRevision: snapshot.revision });
                }
            }
            const revision = createHash('sha256').update(JSON.stringify(models)).digest('hex');
            return { revision, models, maximumBytes: MAX_AUDIO, maximumSeconds: 120, nativeCatalogUnavailable };
        } catch (error) {
            if (error.statusCode) throw error;
            fail('无法读取语音模型，请检查供应商与认证配置', 503);
        } finally { this.inspecting--; }
    }
    async configuration() {
        if (this.closed || !this.providerService) fail('转录模型配置暂不可用', 503);
        this.inspecting++;
        try {
            const snapshot = await this.providerService.snapshot();
            const catalog = await this.catalog();
            if (snapshot.revision !== this.providerService.read().revision) fail('语音配置已变化，请刷新后再编辑', 409);
            return { ...snapshot, availableModels: catalog.models, nativeCatalogUnavailable: catalog.nativeCatalogUnavailable };
        } finally { this.inspecting--; }
    }
    saveModel(input) {
        if (this.closed || this.blocked()) fail('配置正在变更或服务正在关闭，请稍后保存', 409);
        if (!this.providerService) fail('转录模型配置暂不可用', 503);
        return this.providerService.saveTranscriptionModel(input);
    }
    removeModel(id, input) {
        if (this.closed || this.blocked()) fail('配置正在变更或服务正在关闭，请稍后修改', 409);
        if (!this.providerService) fail('转录模型配置暂不可用', 503);
        return this.providerService.removeTranscriptionModel(id, input);
    }
    transcribe(input) {
        if (this.closed || this.blocked()) fail('配置正在变更或服务正在关闭，请稍后转录', 409);
        if (!input || input.confirmed !== true || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)
            || typeof input.modelId !== 'string' || typeof input.revision !== 'string' || !['auto', 'zh', 'en'].includes(input.language)
            || Object.keys(input).some(key => !['confirmed', 'requestId', 'modelId', 'revision', 'audio', 'language', 'cwd'].includes(key))) fail('语音转录请求无效');
        const bytes = audioBytes(input.audio);
        const digest = createHash('sha256').update(JSON.stringify([input.modelId, input.revision, input.language, input.audio.format])).update(bytes).digest('hex');
        // A repeated browser request must never create a second billable upload.
        const existing = this.jobs.get(input.requestId);
        if (existing) {
            if (existing.digest !== digest) fail('转录请求标识已用于其他录音', 409);
            return existing.promise;
        }
        for (const [id, job] of this.jobs) if (!job.pending && Date.now() - job.endedAt > 15 * 60_000) this.jobs.delete(id);
        if (this.jobs.size >= 32 || [...this.jobs.values()].filter(job => job.pending).length >= 2) fail('语音转录繁忙，请稍后再试', 429);
        const job = { digest, pending: true };
        this.jobs.set(input.requestId, job); // Reserve before any await, including auth/catalog lookup.
        job.promise = this.execute(input, bytes).finally(() => { job.pending = false; job.endedAt = Date.now(); });
        return job.promise;
    }
    async execute(input, bytes) {
        const catalog = await this.catalog();
        if (input.revision !== catalog.revision) fail('语音模型配置已变化，请重新选择模型', 409);
        const model = catalog.models.find(model => model.id === input.modelId);
        if (!model) fail('请选择已配置且支持的语音转录模型', 409);
        if (model.managedModelId) {
            return this.providerService.withTranscription(model, ({ provider, key }) => this.upload(input, bytes, model, authHeaders(provider, key)));
        }
        let auth;
        try {
            const runtime = await this.createModelRuntime();
            auth = await runtime.getAuth(model.provider, { signal: AbortSignal.timeout(10000) });
        } catch { fail('无法读取语音模型认证', 503); }
        if (!auth?.auth?.apiKey) fail('语音模型需要已配置的 API Key', 503);
        const headers = model.protocol === 'mimo' ? { 'api-key': auth.auth.apiKey } : { Authorization: `Bearer ${auth.auth.apiKey}` };
        return this.upload(input, bytes, model, headers);
    }
    async upload(input, bytes, model, headers) {
        if (this.closed || this.blocked()) fail('配置正在变更或服务正在关闭，录音未上传', 409);
        const mimo = model.protocol === 'mimo';
        const request = mimo ? { type: 'application/json', body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { format: input.audio.format, data: input.audio.data } }] }], asr_options: { language: input.language }, stream: false }) }
            : multipart(model.modelId, input.audio, bytes, input.language);
        const signal = AbortSignal.timeout(this.timeoutMs);
        try {
            const response = await this.fetch(endpoint(model.baseUrl, mimo ? '/chat/completions' : '/audio/transcriptions'), {
                method: 'POST', headers: { 'Content-Type': request.type, ...headers },
                body: request.body, redirect: 'error', size: 1024 * 1024, signal
            });
            if (!response.ok) { response.body?.destroy?.(); fail(`语音服务返回 HTTP ${response.status}；未自动重试`, 502); }
            const result = await readJson(response, 1024 * 1024);
            const choice = result.choices?.[0];
            const text = mimo ? choice?.finish_reason === 'stop' && choice.message?.content : result.text;
            if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) fail('语音服务未返回完整有效的文字；未自动重试', 502);
            return { text: text.trim(), model: { provider: model.provider, id: model.modelId } };
        } catch (error) {
            if (error.statusCode) throw error;
            fail('转录请求失败或超时，服务可能已收到录音；未自动重试', 502);
        }
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); this.jobs.clear(); }
}
function mountTranscriptionRoutes(router, service, store) {
    const respond = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await handler(req)); }
        catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '语音转录失败；未自动重试' }); }
    };
    router.get('/composer/transcription/settings', respond(() => service.configuration()));
    router.post('/composer/transcription/models', respond(req => service.saveModel(req.body)));
    router.delete('/composer/transcription/models/:id', respond(req => service.removeModel(req.params.id, req.body)));
    router.get('/composer/transcription', respond(() => service.catalog()));
    router.post('/composer/transcription', respond(req => {
        store.resolveProject(req.body?.cwd);
        return service.transcribe(req.body);
    }));
}
module.exports = { PiTranscriptionService, transcriptionModels, audioBytes, multipart, mountTranscriptionRoutes, MAX_AUDIO };
