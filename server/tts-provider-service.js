const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');

const MAX_GPU_OUTPUT_BYTES = 128 * 1024 * 1024;

function serviceError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function cleanBaseUrl(value, fallback) {
    return String(value || fallback).replace(/\/+$/, '');
}

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMultipartPayload(fields) {
    let boundary;
    do {
        boundary = `pivanebreeze${randomBytes(12).toString('hex')}`;
    } while (Object.values(fields).some(value => String(value).includes(boundary)));

    const chunks = [];
    for (const [name, rawValue] of Object.entries(fields)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid multipart field name: ${name}`);
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`, 'utf8'));
        chunks.push(Buffer.from(String(rawValue), 'utf8'));
        chunks.push(Buffer.from('\r\n', 'ascii'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'ascii'));
    return { boundary, body: Buffer.concat(chunks) };
}

function pcm16MonoToWav(pcm, sampleRate) {
    if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2 !== 0) {
        throw serviceError('Breeze TTS returned invalid PCM audio', 502);
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
        throw serviceError('Breeze TTS returned an invalid sample rate', 502);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function validateRegistry(registry) {
    if (!registry || registry.version !== 1 || !Array.isArray(registry.providers)) {
        throw new Error('TTS provider config must use version 1 and contain a providers array');
    }
    const providerIds = new Set();
    for (const provider of registry.providers) {
        if (!provider.id || providerIds.has(provider.id)) throw new Error(`Invalid or duplicate TTS provider id: ${provider.id || ''}`);
        providerIds.add(provider.id);
        if (!['breeze-gpu', 'qwen3-gpu', 'minimax'].includes(provider.adapter)) throw new Error(`Unsupported TTS adapter: ${provider.adapter}`);
        if (!Array.isArray(provider.models) || !provider.models.length) throw new Error(`TTS provider ${provider.id} has no models`);
        const modelIds = new Set();
        for (const model of provider.models) {
            if (!model.id || modelIds.has(model.id)) throw new Error(`Invalid or duplicate model id in ${provider.id}`);
            modelIds.add(model.id);
            if (!Array.isArray(model.voices) || !model.voices.length) throw new Error(`TTS model ${model.id} has no voices`);
            if (!Array.isArray(model.languages) || !model.languages.length) throw new Error(`TTS model ${model.id} has no languages`);
            model.controls = Array.isArray(model.controls) ? model.controls : [];
            const controlIds = new Set();
            for (const control of model.controls) {
                if (!control.id || controlIds.has(control.id)) throw new Error(`Invalid or duplicate control id in ${model.id}`);
                controlIds.add(control.id);
                if (!['text', 'textarea', 'number'].includes(control.type)) throw new Error(`Unsupported TTS control type: ${control.type}`);
                if (control.type === 'number') {
                    const min = Number(control.min);
                    const max = Number(control.max);
                    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
                        throw new Error(`Invalid numeric control range for ${control.id}`);
                    }
                }
            }
        }
    }
    if (registry.providers.length && !providerIds.has(registry.defaultProvider)) throw new Error('TTS defaultProvider is not present in providers');
    return registry;
}

function runProcess(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            finish(serviceError(`TTS command timed out after ${options.timeoutMs} ms`, 504));
        }, options.timeoutMs || 60000);

        function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(result);
        }

        child.on('error', error => finish(serviceError(`Cannot start TTS command: ${error.message}`)));
        child.stdout.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > (options.maxOutputBytes || MAX_GPU_OUTPUT_BYTES)) {
                child.kill('SIGKILL');
                finish(serviceError('TTS command returned too much data', 502));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes <= 64 * 1024) stderr.push(chunk);
        });
        child.on('close', code => {
            const output = Buffer.concat(stdout);
            const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
            if (code !== 0) {
                finish(serviceError((errorOutput || `TTS command exited with code ${code}`).slice(0, 1200), 502));
                return;
            }
            finish(null, { stdout: output, stderr: errorOutput });
        });

        if (options.input) child.stdin.end(options.input);
        else child.stdin.end();
    });
}

function speedInstruction(speed) {
    if (speed <= 0.75) return '请使用明显偏慢的语速，吐字清楚并保持自然。';
    if (speed < 0.95) return '请使用稍慢的语速，吐字清楚并保持自然。';
    if (speed >= 1.5) return '请使用明显偏快但仍然清晰的语速。';
    if (speed > 1.05) return '请使用稍快的语速，保持清晰自然。';
    return '';
}

function codePointLength(value) {
    return Array.from(String(value || '')).length;
}

function splitTextForSpeech(text, maxCharacters) {
    const characters = Array.from(String(text || '').trim());
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error('Invalid TTS chunk size');
    if (characters.length <= maxCharacters) return [characters.join('')];

    const chunks = [];
    const preferredBreak = /[。！？!?；;，,、：:\n]/u;
    let start = 0;
    while (start < characters.length) {
        let end = Math.min(start + maxCharacters, characters.length);
        if (end < characters.length) {
            const minimumBreak = start + Math.floor(maxCharacters * 0.55);
            for (let index = end - 1; index >= minimumBreak; index -= 1) {
                if (preferredBreak.test(characters[index])) {
                    end = index + 1;
                    break;
                }
            }
        }
        const chunk = characters.slice(start, end).join('').trim();
        if (chunk) chunks.push(chunk);
        start = end;
        while (start < characters.length && /\s/u.test(characters[start])) start += 1;
    }
    return chunks;
}

class TtsProviderService {
    constructor(options = {}) {
        this.rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
        this.configPath = path.resolve(options.configPath || path.join(this.rootDir, 'config', 'tts-providers.json'));
        this.fetch = options.fetch;
        this.gpuExec = options.gpuExec ?? process.env.GPU_EXEC ?? '';
        this.registry = this.loadRegistry();
    }

    loadRegistry() {
        const registry = validateRegistry(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
        const minimax = registry.providers.find(provider => provider.adapter === 'minimax');
        if (minimax) {
            const model = minimax.models[0];
            if (process.env.MINIMAX_TTS_MODEL) model.id = process.env.MINIMAX_TTS_MODEL;
            if (process.env.MINIMAX_TTS_VOICE) {
                model.defaultVoice = process.env.MINIMAX_TTS_VOICE;
                if (!model.voices.some(voice => voice.id === model.defaultVoice)) {
                    model.voices.unshift({ id: model.defaultVoice, name: model.defaultVoice });
                }
            }
        }
        return registry;
    }

    getProvider(providerId) {
        return this.registry.providers.find(provider => provider.id === providerId && provider.enabled !== false) || null;
    }

    isConfigured(provider) {
        if (provider.adapter === 'breeze-gpu' || provider.adapter === 'qwen3-gpu') {
            try {
                fs.accessSync(this.gpuExec, fs.constants.X_OK);
                return true;
            } catch {
                return false;
            }
        }
        if (provider.adapter === 'minimax') return Boolean(this.getMiniMaxApiKey());
        return false;
    }

    getPublicConfig() {
        const providers = this.registry.providers
            .filter(provider => provider.enabled !== false)
            .map(provider => ({
                id: provider.id,
                name: provider.name,
                description: provider.description || '',
                configured: this.isConfigured(provider),
                documentationUrl: `/api/tts/providers/${encodeURIComponent(provider.id)}/docs`,
                models: clone(provider.models)
            }));
        const defaultProvider = providers.some(provider => provider.id === this.registry.defaultProvider && provider.configured)
            ? this.registry.defaultProvider
            : (providers.find(provider => provider.configured)?.id || this.registry.defaultProvider);
        const selectedProvider = providers.find(provider => provider.id === defaultProvider) || providers[0];
        const selectedModel = selectedProvider && selectedProvider.models[0];
        return {
            version: this.registry.version,
            defaultRevision: this.registry.defaultRevision || '',
            configured: providers.some(provider => provider.configured),
            defaultProvider,
            providers,
            defaultModel: selectedModel?.id || '',
            defaultVoice: selectedModel?.defaultVoice || '',
            maxCharacters: selectedModel?.maxCharacters || 10000
        };
    }

    listVoices(providerId, modelId) {
        const provider = this.getProvider(providerId || this.registry.defaultProvider);
        if (!provider) throw serviceError('Unknown TTS provider', 404);
        const requestedModelId = String(modelId || '').trim();
        const model = requestedModelId
            ? provider.models.find(item => item.id === requestedModelId)
            : provider.models[0];
        if (!model) throw serviceError('Unknown TTS model', 404);
        return clone(model.voices);
    }

    getDocumentation(providerId) {
        const provider = this.getProvider(providerId);
        if (!provider || !provider.documentation) throw serviceError('TTS provider documentation not found', 404);
        const docsRoot = path.resolve(this.rootDir, 'docs', 'tts-providers');
        const documentationPath = path.resolve(this.rootDir, provider.documentation);
        if (documentationPath !== docsRoot && !documentationPath.startsWith(`${docsRoot}${path.sep}`)) {
            throw serviceError('Invalid TTS provider documentation path', 500);
        }
        try {
            return fs.readFileSync(documentationPath, 'utf8');
        } catch {
            throw serviceError('TTS provider documentation not found', 404);
        }
    }

    resolveRequest(input = {}) {
        const provider = this.getProvider(String(input.provider || this.registry.defaultProvider));
        if (!provider) throw serviceError('Unknown TTS provider', 400);
        if (!this.isConfigured(provider)) throw serviceError(`${provider.name} is not configured`, 503);
        const requestedModelId = String(input.model || '').trim();
        const model = requestedModelId
            ? provider.models.find(item => item.id === requestedModelId)
            : provider.models[0];
        if (!model) throw serviceError(`Unsupported model for ${provider.name}`, 400);
        const text = String(input.text || '').replace(/\r\n/g, '\n').trim();
        if (!text) throw serviceError('Text is required', 400);
        if (text.length > model.maxCharacters) {
            throw serviceError(`Text is too long for ${model.name}. Maximum: ${model.maxCharacters} characters.`, 400);
        }
        const voiceId = String(input.voice || model.defaultVoice || '').trim().toLowerCase();
        const voice = model.voices.find(item => item.id.toLowerCase() === voiceId);
        if (!voice) throw serviceError(`Unsupported voice for ${model.name}`, 400);
        const languageId = String(input.language || model.defaultLanguage || '').trim().toLowerCase();
        const language = model.languages.find(item => item.id.toLowerCase() === languageId);
        if (!language) throw serviceError(`Unsupported language for ${model.name}`, 400);
        const rawOptions = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
        const voiceOptions = voice.options && typeof voice.options === 'object' && !Array.isArray(voice.options) ? voice.options : {};
        const providerOptions = {};
        for (const control of model.controls) {
            const hasRawValue = Object.prototype.hasOwnProperty.call(rawOptions, control.id);
            const rawValue = hasRawValue
                ? rawOptions[control.id]
                : (Object.prototype.hasOwnProperty.call(voiceOptions, control.id) ? voiceOptions[control.id] : control.default);
            if (control.type === 'text' || control.type === 'textarea') {
                const value = String(rawValue ?? '').trim();
                if (!value && control.optional === false) throw serviceError(`${control.label} is required`, 400);
                if (value.length > (control.maxLength || 500)) throw serviceError(`${control.label} is too long`, 400);
                providerOptions[control.id] = value;
                continue;
            }
            if (control.type === 'number') {
                const value = Number(rawValue);
                const min = Number(control.min);
                const max = Number(control.max);
                if (!Number.isFinite(value) || value < min || value > max || (control.integer && !Number.isInteger(value))) {
                    throw serviceError(`${control.label} must be ${control.integer ? 'an integer' : 'a number'} between ${min} and ${max}`, 400);
                }
                providerOptions[control.id] = value;
            }
        }
        return {
            provider,
            model,
            text,
            voice,
            language,
            speed: clampNumber(input.speed, 1, 0.5, 2),
            options: providerOptions
        };
    }

    async synthesize(input) {
        const request = this.resolveRequest(input);
        if (request.provider.adapter === 'breeze-gpu') return this.requestBreezeSpeech(request);
        if (request.provider.adapter === 'qwen3-gpu') return this.requestQwen3Speech(request);
        if (request.provider.adapter === 'minimax') return this.requestMiniMaxSpeech(request);
        throw serviceError('Unsupported TTS provider adapter', 500);
    }

    async gpu(command, options = {}) {
        const bridge = require('./media-bridge-process').bridgeProcess(this.gpuExec, [command]);
        return runProcess(bridge.executable, bridge.args, options);
    }

    async ensureBreezeService(provider) {
        const settings = provider.settings || {};
        const healthUrl = process.env.BREEZE_TTS_HEALTH_URL || settings.healthUrl;
        const healthCommand = `curl -fsS --max-time 3 ${healthUrl}`;
        try {
            const result = await this.gpu(healthCommand, { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
            return JSON.parse(result.stdout.toString('utf8'));
        } catch {}

        const startScript = process.env.BREEZE_TTS_START_SCRIPT || settings.startScript || `${settings.remoteRoot}/start.sh`;
        await this.gpu(startScript, { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
        const deadline = Date.now() + Number(settings.startupTimeoutMs || 240000);
        let lastError = 'service did not answer';
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                const result = await this.gpu(healthCommand, { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
                return JSON.parse(result.stdout.toString('utf8'));
            } catch (error) {
                lastError = error.message;
            }
        }
        throw serviceError(`Breeze TTS startup timed out: ${lastError}`, 504);
    }

    async requestBreezeSpeech(request) {
        const health = await this.ensureBreezeService(request.provider);
        const settings = request.provider.settings || {};
        const speechUrl = process.env.BREEZE_TTS_SPEECH_URL || settings.speechUrl;
        const speedPrompt = speedInstruction(request.speed);
        const baseInstruction = request.options.instruction;
        const instruction = [baseInstruction, speedPrompt].filter(Boolean).join(' ');
        const cfgScale = request.options.cfgScale;
        const seed = request.options.seed;
        const maximumCombinedCharacters = Number(settings.maxCombinedCharacters || 200);
        const availableTextCharacters = maximumCombinedCharacters - codePointLength(instruction);
        if (availableTextCharacters < 24) {
            throw serviceError('Breeze TTS instruction is too long for the fast runtime. Shorten the instruction.', 400);
        }
        const maximumChunkCharacters = Math.min(
            Number(settings.maxChunkCharacters || 120),
            availableTextCharacters
        );
        const chunks = splitTextForSpeech(request.text, maximumChunkCharacters);
        const sampleRate = Number(health.sample_rate || settings.sampleRate || 24000);
        const chunkPauseMs = Math.max(0, Math.min(1000, Number(settings.chunkPauseMs || 160)));
        const pause = Buffer.alloc(Math.round(sampleRate * chunkPauseMs / 1000) * 2);
        const pcmParts = [];
        const startedAt = Date.now();

        for (let index = 0; index < chunks.length; index += 1) {
            const multipart = createMultipartPayload({
                text: chunks[index],
                instruction,
                cfg_scale: cfgScale,
                seed
            });
            const command = `set -o pipefail; curl -fsS --max-time 600 -H Content-Type:multipart/form-data\\;boundary=${multipart.boundary} --data-binary @- ${speechUrl} | base64 -w0`;
            const result = await this.gpu(command, {
                input: multipart.body,
                timeoutMs: Number(settings.requestTimeoutMs || 700000)
            });
            const pcm = Buffer.from(result.stdout.toString('ascii').replace(/\s+/g, ''), 'base64');
            if (pcm.length < 2 || pcm.length % 2 !== 0) {
                throw serviceError(`Breeze TTS returned invalid PCM audio for chunk ${index + 1}`, 502);
            }
            if (index > 0 && pause.length) pcmParts.push(pause);
            pcmParts.push(pcm);
        }

        const generationSeconds = (Date.now() - startedAt) / 1000;
        const combinedPcm = Buffer.concat(pcmParts);
        const audio = pcm16MonoToWav(combinedPcm, sampleRate);
        const audioDurationSeconds = combinedPcm.length / (sampleRate * 2);
        const rtf = generationSeconds / audioDurationSeconds;
        const effectiveOptions = { instruction: baseInstruction, cfgScale, seed };
        return {
            audio,
            extension: 'wav',
            mimeType: 'audio/wav',
            provider: request.provider.id,
            providerName: request.provider.name,
            model: request.model.id,
            voice: request.voice.id,
            voiceName: request.voice.name,
            language: request.language.id,
            languageName: request.language.name,
            speed: request.speed,
            options: effectiveOptions,
            warning: chunks.length > 1 ? `长文本已自动分为 ${chunks.length} 段合成。` : null,
            extraInfo: {
                instruction,
                cfgScale,
                seed,
                sampleRate,
                fastMode: Boolean(settings.fastMode),
                chunkCount: chunks.length,
                maximumChunkCharacters,
                chunkPauseMs: chunks.length > 1 ? chunkPauseMs : 0,
                chunkCharacters: chunks.map(codePointLength),
                generationSeconds: Number(generationSeconds.toFixed(2)),
                audioDurationSeconds: Number(audioDurationSeconds.toFixed(2)),
                rtf: Number(rtf.toFixed(3)),
                realtimeMultiple: Number((1 / rtf).toFixed(3))
            }
        };
    }

    async ensureQwen3Service(provider) {
        const settings = provider.settings || {};
        const healthUrl = process.env.QWEN3_TTS_HEALTH_URL || settings.healthUrl;
        const healthCommand = `curl -fsS --max-time 3 ${healthUrl}`;
        try {
            const result = await this.gpu(healthCommand, { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
            return JSON.parse(result.stdout.toString('utf8'));
        } catch {}

        const session = process.env.QWEN3_TTS_SERVICE_SESSION || settings.serviceSession;
        const remoteRoot = process.env.QWEN3_TTS_REMOTE_ROOT || settings.remoteRoot;
        const startCommand = `tmux has-session -t ${session} 2>/dev/null || tmux new-session -d -s ${session} ${remoteRoot}/run.sh`;
        await this.gpu(startCommand, { timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
        const deadline = Date.now() + Number(settings.startupTimeoutMs || 240000);
        let lastError = 'service did not answer';
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                const result = await this.gpu(healthCommand, { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
                return JSON.parse(result.stdout.toString('utf8'));
            } catch (error) {
                lastError = error.message;
            }
        }
        throw serviceError(`Qwen3-TTS startup timed out: ${lastError}`, 504);
    }

    async requestQwen3Speech(request) {
        await this.ensureQwen3Service(request.provider);
        const settings = request.provider.settings || {};
        const speechUrl = process.env.QWEN3_TTS_SPEECH_URL || settings.speechUrl;
        const speedPrompt = speedInstruction(request.speed);
        const customInstruction = request.options.instruct || '';
        const instruction = customInstruction.length > 450
            ? customInstruction
            : [customInstruction, speedPrompt].filter(Boolean).join(' ');
        const payload = Buffer.from(JSON.stringify({
            text: request.text,
            language: request.language.id,
            speaker: request.voice.id,
            instruct: instruction
        }), 'utf8');
        const command = `set -o pipefail; curl -fsS --max-time 600 -H Content-Type:application/json --data-binary @- ${speechUrl} | base64 -w0`;
        const result = await this.gpu(command, {
            input: payload,
            timeoutMs: Number(settings.requestTimeoutMs || 700000)
        });
        const audio = Buffer.from(result.stdout.toString('ascii').replace(/\s+/g, ''), 'base64');
        if (audio.length < 44 || audio.subarray(0, 4).toString('ascii') !== 'RIFF') {
            throw serviceError('Qwen3-TTS returned an invalid WAV file', 502);
        }
        return {
            audio,
            extension: 'wav',
            mimeType: 'audio/wav',
            provider: request.provider.id,
            providerName: request.provider.name,
            model: request.model.id,
            voice: request.voice.id,
            voiceName: request.voice.name,
            language: request.language.id,
            languageName: request.language.name,
            speed: request.speed,
            options: request.options,
            warning: null,
            extraInfo: instruction ? { instruction } : null
        };
    }

    getMiniMaxApiKey() {
        return process.env.MINIMAX_API_KEY || process.env.MIMIMAX_API_KEY || '';
    }

    decodeMiniMaxAudio(data) {
        if (data?.data?.audio) return Buffer.from(data.data.audio, 'hex');
        if (data?.audio) return Buffer.from(data.audio, 'hex');
        return null;
    }

    async fetchMiniMax(payload, allowRetry = true) {
        if (!this.fetch) throw serviceError('TTS fetch implementation is unavailable');
        const baseUrl = cleanBaseUrl(process.env.MINIMAX_TTS_BASE_URL, 'https://mimimax.cn/v1');
        const response = await this.fetch(`${baseUrl}/audio/speech`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.getMiniMaxApiKey()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        const contentType = response.headers.get('content-type') || '';
        const raw = await response.buffer();
        if (response.ok && contentType.includes('audio/')) {
            return { audio: raw, mimeType: contentType.split(';')[0], warning: null };
        }
        let data = null;
        try { data = JSON.parse(raw.toString('utf8')); } catch {}
        const providerError = data?.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0;
        if (response.ok && !providerError) {
            const decoded = this.decodeMiniMaxAudio(data);
            if (decoded) return { audio: decoded, mimeType: 'audio/mpeg', warning: null, extraInfo: data.extra_info || null };
        }
        if (allowRetry && payload.speed !== undefined) {
            const retry = await this.fetchMiniMax({ model: payload.model, input: payload.input, voice: payload.voice }, false);
            retry.warning = 'MiniMax 未接受语速参数，已自动使用默认语速重试。';
            return retry;
        }
        const message = data?.error || data?.base_resp?.status_msg || raw.toString('utf8') || 'MiniMax TTS failed';
        throw serviceError(message, response.ok ? 502 : response.status);
    }

    async requestMiniMaxSpeech(request) {
        const result = await this.fetchMiniMax({
            model: request.model.id,
            input: request.text,
            voice: request.voice.id,
            speed: request.speed,
            response_format: 'mp3'
        });
        return {
            ...result,
            extension: result.mimeType === 'audio/wav' ? 'wav' : 'mp3',
            provider: request.provider.id,
            providerName: request.provider.name,
            model: request.model.id,
            voice: request.voice.id,
            voiceName: request.voice.name,
            language: request.language.id,
            languageName: request.language.name,
            speed: request.speed,
            options: request.options
        };
    }
}

function createTtsProviderService(options) {
    return new TtsProviderService(options);
}

module.exports = {
    TtsProviderService,
    createTtsProviderService,
    validateRegistry
};
