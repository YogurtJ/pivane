const fs = require('fs');
const path = require('path');

const MODELS = Object.freeze([
    { id: 'MiniMax-H3', name: 'MiniMax H3', resolutions: ['768P', '2K'], minDuration: 4, maxDuration: 15 },
    { id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max', resolutions: ['480P', '768P'], minDuration: 5, maxDuration: 15 }
]);
const RATIOS = Object.freeze(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

function clampInt(value, fallback, min, max) {
    const number = Number(value);
    return Math.max(min, Math.min(max, Math.round(Number.isFinite(number) ? number : fallback)));
}

function safeTaskId(value) {
    const text = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(text)) throw new Error('MiniMax returned an invalid task ID');
    return text;
}

class MiniMaxVideoService {
    constructor(options = {}) {
        this.rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
        this.fetch = options.fetch || globalThis.fetch;
        this.baseUrl = String(options.baseUrl || process.env.MINIMAX_VIDEO_BASE_URL || 'https://api.minimax.io').replace(/\/+$/, '');
        const requestedDefaultModel = String(options.defaultModel || process.env.MINIMAX_VIDEO_MODEL || 'MiniMax-H3');
        this.defaultModel = MODELS.some(item => item.id === requestedDefaultModel) ? requestedDefaultModel : 'MiniMax-H3';
        this.historyFile = options.historyFile || path.join(this.rootDir, 'video_history.json');
        this.videosDir = options.videosDir || path.join(this.rootDir, 'public', 'videos');
        this.imagesDir = options.imagesDir || path.join(this.rootDir, 'public', 'images');
        this.apiKeyResolver = options.apiKeyResolver || null;
        this.pollIntervalMs = Number(options.pollIntervalMs || process.env.MINIMAX_VIDEO_POLL_MS || 5000);
        this.timeoutMs = Number(options.timeoutMs || process.env.MINIMAX_VIDEO_TIMEOUT_MS || 1800000);
    }

    async getApiKey() {
        const environmentKey = String(process.env.MINIMAX_VIDEO_API_KEY || process.env.MINIMAX_API_KEY || '').trim();
        if (environmentKey) return environmentKey;
        if (this.apiKeyResolver) return String(await this.apiKeyResolver() || '').trim();
        try {
            const { ModelRuntime } = await require('./pi-session-store').getSdk();
            const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(30000) });
            const result = await runtime.getAuth('minimax', { signal: AbortSignal.timeout(10000) });
            return String(result?.auth?.apiKey || '').trim();
        } catch {
            return '';
        }
    }

    async getConfig() {
        return {
            ok: true,
            provider: 'minimax',
            providerName: 'MiniMax',
            configured: Boolean(await this.getApiKey()),
            engine: 'MiniMax H3',
            models: MODELS,
            defaultModel: this.defaultModel,
            resolutions: ['480P', '768P', '2K'],
            defaultResolution: '768P',
            ratios: RATIOS,
            defaultRatio: 'adaptive',
            defaultDuration: 5,
            promptMaxCharacters: 7000,
            sourceImageOptional: true,
            sourceImageMaxBytes: 20 * 1024 * 1024,
            documentationUrl: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create'
        };
    }

    loadHistory() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    saveHistory(history) {
        fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
    }

    getHistory() {
        return this.loadHistory().slice().reverse();
    }

    parseImageData(value) {
        const raw = String(value || '');
        if (!raw) return null;
        const match = raw.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
        if (!match) throw new Error('首帧必须是 PNG、JPG 或 WEBP 图片');
        const encoded = match[2].replace(/\s/g, '');
        const size = Buffer.from(encoded, 'base64').length;
        if (!size || size > 20 * 1024 * 1024) throw new Error('首帧图片必须小于 20MB');
        return `data:${match[1].replace('image/jpg', 'image/jpeg')};base64,${encoded}`;
    }

    resolveSourceImage(input) {
        const dataUrl = this.parseImageData(input.imageData);
        if (dataUrl) return { dataUrl, historyUrl: '' };
        const imageUrl = String(input.imageUrl || input.sourceImageUrl || '').trim();
        if (!imageUrl) return null;
        if (!imageUrl.startsWith('/images/')) throw new Error('首帧图片地址不受支持');
        const filename = decodeURIComponent(imageUrl.slice('/images/'.length));
        if (!filename || filename !== path.basename(filename) || !/\.(png|jpe?g|webp)$/i.test(filename)) throw new Error('首帧图片地址不受支持');
        const filePath = path.join(this.imagesDir, filename);
        if (!fs.existsSync(filePath)) throw new Error('图库首帧不存在');
        const actualPath = fs.realpathSync(filePath);
        if (path.dirname(actualPath) !== fs.realpathSync(this.imagesDir)) throw new Error('首帧图片地址不受支持');
        const stat = fs.statSync(actualPath);
        if (!stat.isFile() || !stat.size || stat.size > 20 * 1024 * 1024) throw new Error('首帧图片必须小于 20MB');
        const bytes = fs.readFileSync(actualPath);
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('首帧图片必须小于 20MB');
        const extension = path.extname(filename).toLowerCase();
        const mime = extension === '.webp' ? 'image/webp' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
        return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, historyUrl: imageUrl };
    }

    normalizeRequest(input = {}) {
        const requestedModel = String(input.model || this.defaultModel);
        const model = MODELS.find(item => item.id === requestedModel) || MODELS.find(item => item.id === this.defaultModel) || MODELS[0];
        const prompt = String(input.prompt || '').replace(/\r\n/g, '\n').trim().slice(0, 7000);
        if (!prompt) throw new Error('请先填写视频提示词');
        const sourceImage = this.resolveSourceImage(input);
        const duration = clampInt(input.duration, 5, model.minDuration, model.maxDuration);
        const resolution = model.resolutions.includes(String(input.resolution || ''))
            ? String(input.resolution)
            : model.resolutions.includes('768P') ? '768P' : model.resolutions[0];
        let ratio = RATIOS.includes(String(input.ratio || '')) ? String(input.ratio) : 'adaptive';
        if (sourceImage) ratio = 'adaptive';
        else if (ratio === 'adaptive') ratio = '16:9';
        return { model, prompt, sourceImage, duration, resolution, ratio };
    }

    async requestJson(requestPath, options = {}) {
        const apiKey = options.apiKey || await this.getApiKey();
        if (!apiKey) throw new Error('MiniMax API Key 未配置；请在设置 > Provider 中配置 MiniMax');
        const response = await this.fetch(`${this.baseUrl}${requestPath}`, {
            method: options.method || 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                ...(options.body ? { 'Content-Type': 'application/json' } : {})
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(options.timeoutMs || 90000)
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch {}
        if (!response.ok) {
            const message = data?.error?.message || data?.base_resp?.status_msg || text || `HTTP ${response.status}`;
            throw new Error(`MiniMax H3 请求失败：${String(message).slice(0, 800)}`);
        }
        return data;
    }

    async waitForTask(taskId, apiKey) {
        const started = Date.now();
        while (Date.now() - started < this.timeoutMs) {
            const data = await this.requestJson(`/v2/query/video_generation/${encodeURIComponent(taskId)}`, { apiKey });
            const task = data?.task;
            if (!task) throw new Error('MiniMax H3 查询响应缺少 task');
            if (task.status === 'succeeded') {
                if (!task.content?.url) throw new Error('MiniMax H3 任务成功但没有视频地址');
                return task;
            }
            if (task.status === 'failed' || task.status === 'cancelled') {
                throw new Error(task.error?.message || `MiniMax H3 任务${task.status}`);
            }
            await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
        throw new Error('等待 MiniMax H3 视频超时；任务可能仍在服务端运行');
    }

    async downloadVideo(url) {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:') throw new Error('MiniMax H3 返回了不安全的视频地址');
        const response = await this.fetch(parsed, { signal: AbortSignal.timeout(300000) });
        if (!response.ok) throw new Error(`下载 MiniMax H3 视频失败：HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length') || 0);
        if (declared > 200 * 1024 * 1024) throw new Error('MiniMax H3 视频超过 200MB');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 200 * 1024 * 1024) throw new Error('MiniMax H3 视频文件为空或超过 200MB');
        return bytes;
    }

    async generate(input = {}) {
        const request = this.normalizeRequest(input);
        const apiKey = await this.getApiKey();
        if (!apiKey) throw new Error('MiniMax API Key 未配置；请在设置 > Provider 中配置 MiniMax');
        const content = [{ type: 'text', text: request.prompt }];
        if (request.sourceImage) {
            content.push({ type: 'image_url', image_url: { url: request.sourceImage.dataUrl }, role: 'first_frame' });
        }
        const created = await this.requestJson('/v2/video_generation', {
            method: 'POST',
            apiKey,
            body: {
                model: request.model.id,
                content,
                resolution: request.resolution,
                duration: request.duration,
                ratio: request.ratio
            }
        });
        const taskId = safeTaskId(created.task_id);
        const task = await this.waitForTask(taskId, apiKey);
        const bytes = await this.downloadVideo(task.content.url);
        fs.mkdirSync(this.videosDir, { recursive: true });
        const timestamp = Date.now();
        const localName = `minimax_h3_${timestamp}_${taskId}.mp4`;
        fs.writeFileSync(path.join(this.videosDir, localName), bytes);
        const item = {
            id: timestamp,
            filename: localName,
            videoUrl: `/videos/${localName}`,
            mimeType: 'video/mp4',
            provider: 'minimax',
            model: task.model || request.model.id,
            engine: 'MiniMax H3',
            prompt: request.prompt,
            resolution: task.resolution || request.resolution,
            duration: task.duration || request.duration,
            ratio: task.ratio || request.ratio,
            sourceImageUrl: request.sourceImage?.historyUrl || '',
            hasSourceImage: Boolean(request.sourceImage),
            source: 'minimax-h3-v2',
            taskId,
            usage: task.usage || null,
            createdAt: new Date().toISOString()
        };
        const history = this.loadHistory();
        history.push(item);
        this.saveHistory(history.slice(-120));
        return { ok: true, taskId, video: item };
    }
}

function createMiniMaxVideoService(options) {
    return new MiniMaxVideoService(options);
}

module.exports = {
    MiniMaxVideoService,
    createMiniMaxVideoService,
    MINIMAX_VIDEO_MODELS: MODELS,
    MINIMAX_VIDEO_RATIOS: RATIOS
};
