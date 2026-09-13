if (require.main === module && require('./server/pi-server-entry').handoff(__dirname)) return;

const express = require('express');
const { WorkspaceAccessService } = require('./server/workspace-access-service');
const { exec, execFile } = require('child_process');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const { createPiAgentGateway } = require('./server/pi-agent-routes');
const { createTtsProviderService } = require('./server/tts-provider-service');
const { createMediaAgentService } = require('./server/media-agent-service');
const { WorkspacePreferencesService } = require('./server/workspace-preferences-service');
const { createMiniMaxVideoService, MINIMAX_VIDEO_MODELS, MINIMAX_VIDEO_RATIOS } = require('./server/minimax-video-service');
const { buildFlux2Workflow } = require('./server/flux2-workflow');
const { loadMediaProfile, applyPromptPrefix } = require('./server/media-profile');
const { MediaLabService } = require('./server/media-lab-service');
const { MediaProviderService } = require('./server/media-provider-service');
const { connectionSchema, validateConnectionDraft } = require('./server/media-connection-planner');
const { saveExternalMedia, mediaHistory, deleteMedia } = require('./server/media-lab-storage');

const app = express();
require('./server/pi-local-env').loadLocalEnv(path.join(__dirname, '.env'));
const maintenance = new (require('./server/pi-maintenance-client').MaintenanceClient)();
app.use((req, res, next) => maintenance.http(req, res, next));
const PORT = process.env.PORT || 3000;
const workspaceBaseUrlProvided = Boolean(process.env.PI_WORKSPACE_BASE_URL);
process.env.PI_WORKSPACE_BASE_URL ||= `http://127.0.0.1:${PORT}`;

const DEFAULT_COMFY_BASE_URL = String(process.env.COMFY_BASE_URL || '').replace(/\/+$/, '');
const FLUX2_COMFY_BASE_URL = String(process.env.FLUX2_COMFY_BASE_URL || '').replace(/\/+$/, '');
const FLUX2_FILES = {
    diffusionModel: process.env.FLUX2_DIFFUSION_MODEL || 'flux2_dev_fp8mixed.safetensors',
    textEncoder: process.env.FLUX2_TEXT_ENCODER || 'mistral_3_small_flux2_fp8.safetensors',
    vae: process.env.FLUX2_VAE || 'flux2-vae.safetensors'
};
const execFileAsync = promisify(execFile);

const mediaProfile = loadMediaProfile(__dirname);
const mediaDataRoot = path.resolve(process.env.PI_MEDIA_DATA_DIR || __dirname);
const GPU_EXEC = mediaProfile.gpuExec;
const workspacePreferencesService = new WorkspacePreferencesService();
const ttsProviderService = createTtsProviderService({ rootDir: __dirname, fetch, gpuExec: GPU_EXEC, configPath: mediaProfile.ttsConfigPath });
const imageSettings = mediaProfile.image;
const ZJY_ROOT = process.env.ZJY_ROOT || imageSettings.workerRoot || '';
const ZJY_LORA_KEY = path.join(ZJY_ROOT, imageSettings.keyFile || '.lora.key');
const ZJY_WORKER_PY = path.join(ZJY_ROOT, imageSettings.workerFile || 'worker.py');
const ZJY_WORKER_BOOT = path.join(ZJY_ROOT, imageSettings.bootFile || 'boot.sh');
const ZIMAGE_IDENTITY = imageSettings.identity || '';
const ZIMAGE_NEG = imageSettings.negative || '';
const RUNPOD_FALLBACK_MODELS = ['z-image-turbo', 'z-image-turbo (no lora)', 'flux-2-dev'];
const RUNPOD_DEFAULT_LORA = imageSettings.defaultLora || 'none';
const RUNPOD_DEFAULT_LORA_STRENGTH = imageSettings.defaultLoraStrength || 0;
const RUNPOD_PRESETS = imageSettings.presets || {};
const imageProfiles = Object.fromEntries(mediaProfile.models.filter(model => ['zimage','flux2'].includes(model.adapter)).map(model => [model.id, {
    name: model.name, engine: model.name, backend: model.adapter === 'flux2' ? 'comfyui' : 'gpu-zimage',
    configured: model.adapter === 'flux2' ? Boolean(FLUX2_COMFY_BASE_URL) : Boolean(GPU_EXEC && ZJY_ROOT),
    ...Object.fromEntries(Object.entries(model.parameters).map(([key, field]) => [key, field.default])),
    sampler: model.adapter === 'flux2' ? 'euler' : 'flowmatch', scheduler: model.adapter === 'flux2' ? 'flux2' : 'flow',
    supportsLora: model.adapter === 'zimage' && RUNPOD_DEFAULT_LORA !== 'none'
}]));
imageProfiles['z-image-turbo (no lora)'] = { ...imageProfiles['z-image-turbo'], supportsLora: false };
const minimaxVideoService = createMiniMaxVideoService({ rootDir: mediaDataRoot, fetch });
const mediaAgentService = createMediaAgentService({
    rootDir: __dirname, ttsProviderService, workspacePreferencesService,
    imageConfig: { models: RUNPOD_FALLBACK_MODELS, modelProfiles: imageProfiles, defaultModel: 'z-image-turbo',
        loras: RUNPOD_DEFAULT_LORA === 'none' ? [] : [RUNPOD_DEFAULT_LORA], defaultLora: RUNPOD_DEFAULT_LORA,
        defaultLoraStrength: RUNPOD_DEFAULT_LORA_STRENGTH, defaultNegative: ZIMAGE_NEG, presets: RUNPOD_PRESETS },
    videoConfig: { defaults: { models: MINIMAX_VIDEO_MODELS, ratios: MINIMAX_VIDEO_RATIOS, model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: 'adaptive' } }
});
const mediaProviderService = new MediaProviderService({ directory: mediaProfile.directory, fetch });
const mediaLabService = new MediaLabService({ profile: mediaProfile, fetch, videoService: minimaxVideoService,
    providerService: mediaProviderService,
    ttsService: ttsProviderService, fluxBaseUrl: FLUX2_COMFY_BASE_URL, generateImage, generateTts,
    saveExternal: input => saveExternalMedia(mediaDataRoot, input), history: kind => mediaHistory(mediaDataRoot, kind),
    deleteMedia: (kind, id) => deleteMedia(mediaDataRoot, kind, id) });
mediaAgentService.mediaLabService = mediaLabService;

const workspaceAccess = new WorkspaceAccessService({
    publicFiles: ['/', '/index.html', '/pi-mermaid-frame.html', '/site.webmanifest', ...fs.readdirSync(path.join(__dirname, 'public'))
        .filter(name => /\.(?:css|js)$/.test(name)).map(name => '/' + name)],
    publicPrefixes: ['/brand/', '/vendor/marked/', '/vendor/dompurify/', '/vendor/highlight/', '/vendor/katex-0.18.7/'],
});
workspaceAccess.publicFiles.add('/vendor/mermaid-11.17.2.min.js');
workspaceAccess.publicFiles.add('/vendor/mermaid-LICENSE.txt');
process.env.PI_WORKSPACE_INTERNAL_TOKEN = workspaceAccess.internalToken;
workspaceAccess.mount(app);
app.use(express.json({ limit: '32mb' }));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules', 'marked', 'lib')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, 'node_modules', 'dompurify', 'dist')));
app.use('/vendor/highlight', express.static(path.join(__dirname, 'node_modules', '@highlightjs', 'cdn-assets')));
for (const directory of ['images', 'videos', 'audio']) {
    app.use('/' + directory, express.static(path.join(mediaDataRoot, 'public', directory), { fallthrough: false }));
}
app.use((req, res, next) => {
    let pathname;
    try { pathname = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
    if (/\.bak(?:[-.]|$)|\.tmp$|~$/i.test(pathname)) return res.sendStatus(404);
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/media-agent/capabilities/:kind', async (req, res) => {
    try {
        res.json({ ...mediaAgentService.getCapabilities(req.params.kind), lab: await mediaLabService.catalog(req.params.kind === 'all' ? undefined : req.params.kind) });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.post('/api/media-agent/validate', async (req, res) => {
    try {
        const kind = String(req.body?.kind || '');
        res.json({ ok: true, plan: req.body?.plan?.modelId ? await mediaLabService.plan(req.body.plan) : mediaAgentService.validatePlan(kind, req.body?.plan, req.body?.current) });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

app.get('/api/media-agent/connection-schema', (req, res) => res.json(connectionSchema()));
app.post('/api/media-agent/connection/validate', (req, res) => {
    try { res.json({ ok: true, draft: validateConnectionDraft(req.body?.draft, req.body?.current) }); }
    catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});

const piAgentGateway = createPiAgentGateway({ mediaAgentService, workspacePreferencesService, mediaLabService, accessService: workspaceAccess, maintenance });
piAgentGateway.mount(app);

// Ensure directories exist
const audioDir = path.join(mediaDataRoot, 'public', 'audio');
const imagesDir = path.join(mediaDataRoot, 'public', 'images');
const videosDir = path.join(mediaDataRoot, 'public', 'videos');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
const PI_GENERATED_IMAGES_DIR = path.join(process.env.HOME || '/home/pi', 'Desktop', 'Generated_Images');

// Prompts storage
const PROMPTS_FILE = path.join(mediaDataRoot, 'prompts.json');
function loadPrompts() {
    try {
        return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
    } catch {
        return [];
    }
}
function savePrompts(prompts) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

// Generation history storage
const HISTORY_FILE = path.join(mediaDataRoot, 'generation_history.json');
const TTS_HISTORY_FILE = path.join(mediaDataRoot, 'tts_history.json');
const VIDEO_HISTORY_FILE = path.join(mediaDataRoot, 'video_history.json');
function loadHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {
        return [];
    }
}
function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function loadTTSHistory() {
    try {
        const history = JSON.parse(fs.readFileSync(TTS_HISTORY_FILE, 'utf8'));
        return Array.isArray(history) ? history : [];
    } catch {
        return [];
    }
}

function saveTTSHistory(history) {
    fs.writeFileSync(TTS_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function loadVideoHistory() {
    try {
        const history = JSON.parse(fs.readFileSync(VIDEO_HISTORY_FILE, 'utf8'));
        return Array.isArray(history) ? history : [];
    } catch {
        return [];
    }
}

function saveVideoHistory(history) {
    fs.writeFileSync(VIDEO_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function textPreview(text, length = 90) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    return compact.length > length ? `${compact.slice(0, length)}...` : compact;
}

function getAudioMeta(filename) {
    const safeName = path.basename(filename || '');
    const filePath = path.join(audioDir, safeName);
    if (!safeName || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return {
        filename: safeName,
        audioUrl: `/audio/${safeName}`,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString()
    };
}

function isRicherTTSItem(candidate, current) {
    if (!current) return true;
    const candidateScore = [
        candidate.provider,
        candidate.text,
        candidate.model && candidate.model !== 'unknown',
        candidate.voice && candidate.voice !== 'unknown',
        candidate.language,
        candidate.speed,
        candidate.options && Object.keys(candidate.options).length,
        !candidate.imported
    ].filter(Boolean).length;
    const currentScore = [
        current.provider,
        current.text,
        current.model && current.model !== 'unknown',
        current.voice && current.voice !== 'unknown',
        current.language,
        current.speed,
        current.options && Object.keys(current.options).length,
        !current.imported
    ].filter(Boolean).length;
    return candidateScore > currentScore;
}

function dedupeTTSHistory(history) {
    const byFilename = new Map();
    const noFilename = [];

    for (const item of history) {
        if (!item || !item.filename) {
            if (item) noFilename.push(item);
            continue;
        }
        const existing = byFilename.get(item.filename);
        byFilename.set(item.filename, isRicherTTSItem(item, existing) ? item : existing);
    }

    return [...noFilename, ...byFilename.values()]
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function syncExistingTTSAudio(history) {
    history = dedupeTTSHistory(history);
    const seen = new Set(history.map(item => item.filename).filter(Boolean));
    let changed = false;
    const files = fs.readdirSync(audioDir)
        .filter(name => /^(?:minimax_tts_|tts_).+\.(?:mp3|wav|ogg|m4a)$/i.test(name))
        .sort();

    for (const filename of files) {
        if (seen.has(filename)) continue;
        const meta = getAudioMeta(filename);
        if (!meta) continue;
        history.push({
            id: `imported_${filename.replace(/[^a-zA-Z0-9]/g, '_')}`,
            text: '',
            textPreview: '已存在音频（生成时尚未记录文本）',
            model: 'unknown',
            voice: 'unknown',
            speed: null,
            mimeType: path.extname(filename).toLowerCase() === '.wav' ? 'audio/wav' : 'audio/mpeg',
            imported: true,
            ...meta
        });
        changed = true;
    }

    if (changed) history = dedupeTTSHistory(history);
    if (changed) saveTTSHistory(history);
    return history;
}

function appendTTSHistory(item) {
    const history = dedupeTTSHistory(loadTTSHistory());
    history.push(item);
    const trimmed = dedupeTTSHistory(history).slice(-300);
    saveTTSHistory(trimmed);
    return item;
}

function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
    } catch (error) {
        console.error(`Failed to delete file ${filePath}:`, error.message);
    }
    return false;
}

// Get generation history
app.get('/api/history', (req, res) => {
    const history = loadHistory();
    // Return most recent first
    res.json(history.reverse());
});

app.delete('/api/history/:id', (req, res) => {
    const targetId = Number(req.params.id);
    const history = loadHistory();
    const item = history.find(entry => Number(entry.id) === targetId);

    if (!item) {
        return res.status(404).json({ error: 'History item not found' });
    }

    const filename = item.filename || path.basename(item.imageUrl || '');
    const removedFiles = {
        publicImage: safeUnlink(path.join(imagesDir, filename)),
        piGeneratedImage: safeUnlink(path.join(PI_GENERATED_IMAGES_DIR, filename))
    };

    saveHistory(history.filter(entry => Number(entry.id) !== targetId));

    res.json({
        ok: true,
        removedId: targetId,
        filename,
        removedFiles
    });
});

function gpuPushFile(localPath, remotePath) {
    const script = path.join(ZJY_ROOT, imageSettings.pushFile || 'push_to_gpu.py');
    return new Promise((resolve, reject) => {
        execFile('python3', [script, localPath, remotePath], {
            timeout: 180000,
            maxBuffer: 8 * 1024 * 1024
        }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(String(stderr || stdout || err.message).slice(0, 800)));
                return;
            }
            resolve(String(stdout || ''));
        });
    });
}

function gpuExec(cmd, options = {}) {
    const timeout = options.timeout || 60000;
    return new Promise((resolve, reject) => {
        const bridge = require('./server/media-bridge-process').bridgeProcess(GPU_EXEC, [cmd]);
        const child = execFile(bridge.executable, bridge.args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const raw = Buffer.concat([
                    Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr || '')),
                    Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''))
                ]);
                const utf = raw.toString('utf8');
                const looksGarbled = /\uFFFD/.test(utf) || (raw.includes(0xC3) && raw.includes(0xFC));
                const detail = looksGarbled ? `GPU exec failed (${err.code || err.message})` : utf;
                reject(new Error((detail || err.message).slice(0, 800)));
                return;
            }
            resolve(String(stdout || ''));
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(options.input || '');
    });
}

function ensurePromptIdentity(prompt) {
    return applyPromptPrefix(prompt, ZIMAGE_IDENTITY);
}

async function zimageReady() {
    try {
        const out = await gpuExec('cat /dev/shm/.z/worker.ready', { timeout: 20000 });
        const data = JSON.parse(out);
        const age = Date.now() / 1000 - Number(data.ts || 0);
        if (data.status && age < 90) return data;
        return null;
    } catch {
        return null;
    }
}

async function ensureZimageWorker() {
    if (!GPU_EXEC || !ZJY_ROOT) throw new Error('Image worker is not configured');
    const ready = await zimageReady();
    if (ready && (ready.status === 'ready' || ready.status === 'busy' || ready.status === 'loading')) {
        return ready;
    }
    if (!fs.existsSync(ZJY_LORA_KEY) || !fs.existsSync(ZJY_WORKER_PY) || !fs.existsSync(ZJY_WORKER_BOOT)) {
        throw new Error('本地 Z-Image 资产不完整（缺 LoRA key 或 worker 脚本）');
    }
    await gpuExec('mkdir -p /dev/shm/.z/jobs /dev/shm/.z/out /dev/shm/.z/tmp /dev/shm/.z/hf /dev/shm/.z/torch');
    await gpuPushFile(ZJY_WORKER_PY, '/dev/shm/.z/' + path.basename(imageSettings.remoteWorkerFile || 'worker.py'));
    await gpuPushFile(ZJY_WORKER_BOOT, '/dev/shm/.z/boot.sh');
    await gpuExec('chmod +x /dev/shm/.z/boot.sh');
    const data = fs.readFileSync(ZJY_LORA_KEY, 'utf8').trim();
    await gpuExec('cat > /dev/shm/.z/.k', { input: data });
    await gpuExec('bash /dev/shm/.z/boot.sh /dev/shm/.z/.k', { timeout: 180000 });

    const started = Date.now();
    while (Date.now() - started < 180000) {
        const now = await zimageReady();
        if (now && now.status === 'ready') return now;
        if (now && now.status === 'busy') return now;
        await new Promise(r => setTimeout(r, 2000));
    }
    let logTail = '';
    try { logTail = await gpuExec('tail -c 600 /dev/shm/.z/worker.log'); } catch {}
    throw new Error('Z-Image worker 启动超时。' + (logTail ? ` 日志：${logTail}` : ' 请确认 GPU0 显存够（vLLM 需在 0.55）。'));
}

async function submitZimageJob(job) {
    const id = String(job.id);
    const remote = `/dev/shm/.z/jobs/${id}.json`;
    await gpuExec(`cat > ${remote}`, { timeout: 30000, input: JSON.stringify(job) });
    const started = Date.now();
    while (Date.now() - started < 240000) {
        try {
            const done = await gpuExec(`cat /dev/shm/.z/jobs/${id}.done.json`, { timeout: 20000 });
            return JSON.parse(done);
        } catch {
            await new Promise(r => setTimeout(r, 1500));
        }
    }
    throw new Error('等待 Z-Image 生成超时');
}

async function pullGpuPng(remotePath) {
    if (!/^\/dev\/shm\/\.z\/out\/[A-Za-z0-9_-]+\.png$/.test(remotePath)) throw new Error('Invalid GPU output path');
    const b64 = await gpuExec(`base64 -w0 ${remotePath}`, { timeout: 60000 });
    return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
}

function cleanComfyBaseUrl(value) {
    try {
        const url = new URL(String(value || DEFAULT_COMFY_BASE_URL));
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('ComfyUI 地址必须是 http 或 https');
        }
        return url.origin;
    } catch (error) {
        throw new Error(`ComfyUI 地址不正确：${error.message}`);
    }
}

function clampRunPodNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

function clampRunPodInt(value, min, max, fallback, snap = 1) {
    const num = Math.floor(clampRunPodNumber(value, min, max, fallback));
    return Math.max(min, Math.min(max, Math.round(num / snap) * snap));
}

function clampRunPodOffsetInt(value, min, max, fallback, step) {
    const num = Math.floor(clampRunPodNumber(value, min, max, fallback));
    return Math.max(min, Math.min(max, min + Math.round((num - min) / step) * step));
}

function safeComfyFilename(value) {
    return String(value || 'image.png').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'image.png';
}

async function comfyRequest(baseUrl, requestPath, options = {}) {
    const args = [
        '-sS',
        '--fail-with-body',
        '--max-time',
        String(options.timeout || 240),
        '--retry',
        options.method && options.method !== 'GET' ? '0' : '5',
        '--retry-all-errors',
        '--retry-delay',
        '1'
    ];

    if (options.method) args.push('-X', options.method);
    for (const header of options.headers || []) args.push('-H', header);
    if (options.body) args.push('--data-binary', options.body);
    args.push(`${baseUrl}${requestPath}`);

    try {
        const { stdout } = await execFileAsync('curl', args, {
            encoding: options.binary ? 'buffer' : 'utf8',
            maxBuffer: 120 * 1024 * 1024
        });
        return stdout;
    } catch (error) {
        const detailSource = error.stdout || error.stderr || error.message;
        const detail = Buffer.isBuffer(detailSource)
            ? detailSource.toString('utf8').slice(0, 600)
            : String(detailSource || error.message).slice(0, 600);
        throw new Error(`连不上 ComfyUI：${baseUrl}。请确认 RunPod Pod 还开着，并且填的是 8188 的代理地址。原始错误：${detail}`);
    }
}

async function comfyJson(baseUrl, requestPath, options = {}) {
    const text = await comfyRequest(baseUrl, requestPath, options);
    return JSON.parse(text);
}

async function waitForComfyImage(baseUrl, promptId, timeoutMs = 1800000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const history = await comfyJson(baseUrl, `/history/${promptId}`, { timeout: 30 });
        const item = history[promptId];
        const image = item?.outputs?.['9']?.images?.[0];
        if (image) return { image, history: item };

        const failed = item?.status?.completed && item?.status?.status_str && item.status.status_str !== 'success';
        if (failed) {
            throw new Error(`生成失败：${item.status.status_str}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('等待 Flux 2 Dev 生成超时：ComfyUI 可能仍在排队或代理已断开');
}

async function generateFlux2Image(body) {
    const requestedBaseUrl = String(body.baseUrl || FLUX2_COMFY_BASE_URL || '').trim();
    if (!requestedBaseUrl || requestedBaseUrl.startsWith('gpu://')) {
        throw new Error('Flux 2 Dev 尚未配置 ComfyUI 地址');
    }
    const baseUrl = cleanComfyBaseUrl(requestedBaseUrl);
    const info = await comfyJson(baseUrl, '/object_info', { timeout: 90 });
    const required = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'FluxGuidance', 'SamplerCustomAdvanced', 'SaveImage', 'VAEDecode', 'KSamplerSelect', 'BasicGuider', 'RandomNoise'];
    const weights = [
        [info?.UNETLoader?.input?.required?.unet_name?.[0], FLUX2_FILES.diffusionModel],
        [info?.CLIPLoader?.input?.required?.clip_name?.[0], FLUX2_FILES.textEncoder],
        [info?.VAELoader?.input?.required?.vae_name?.[0], FLUX2_FILES.vae]
    ];
    if (required.some(node => !info?.[node]) || weights.some(([files, name]) => !Array.isArray(files) || !files.includes(name))) {
        throw new Error('Flux 2 Dev ComfyUI nodes or weights are missing; generation was not submitted');
    }
    const { seed, settings, workflow } = buildFlux2Workflow(body, FLUX2_FILES);
    const queued = await comfyJson(baseUrl, '/prompt', {
        method: 'POST',
        headers: ['Content-Type: application/json'],
        body: JSON.stringify({ prompt: workflow, client_id: `pi5-flux2-${Date.now()}` }),
        timeout: 90
    });
    if (queued.node_errors && Object.keys(queued.node_errors).length) {
        const details = JSON.stringify(queued.node_errors).slice(0, 1200);
        throw new Error(`Flux 2 Dev 工作流节点错误：${details}`);
    }
    const promptId = String(queued.prompt_id || '');
    if (!promptId) throw new Error('ComfyUI 没有返回 Flux 2 Dev prompt_id');
    const { image } = await waitForComfyImage(baseUrl, promptId);
    const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || '',
        type: image.type || 'output'
    });
    const bytes = Buffer.from(await comfyRequest(baseUrl, `/view?${params}`, { binary: true, timeout: 300 }));
    if (!bytes.length || bytes.length > 120 * 1024 * 1024) throw new Error('Flux 2 Dev 输出为空或超过 120MB');
    const timestamp = Date.now();
    const outputName = safeComfyFilename(image.filename || 'flux2.png');
    const extension = /\.(png|jpg|jpeg|webp)$/i.test(outputName) ? path.extname(outputName) : '.png';
    const localName = `flux2_${timestamp}_${promptId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}${extension}`;
    fs.writeFileSync(path.join(imagesDir, localName), bytes);
    const item = {
        id: timestamp,
        filename: localName,
        imageUrl: `/images/${localName}`,
        prompt: settings.prompt,
        negative: '',
        model: settings.model,
        engine: settings.engine,
        width: settings.width,
        height: settings.height,
        steps: settings.steps,
        cfgScale: settings.cfg,
        sampler: settings.sampler,
        scheduler: settings.scheduler,
        seed,
        loras: [],
        source: 'runpod-comfyui-flux2',
        promptId,
        runpodBaseUrl: baseUrl,
        comfyImage: { filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' },
        createdAt: new Date().toISOString()
    };
    const history = loadHistory();
    history.push(item);
    saveHistory(history);
    return { ok: true, promptId, seed, image: item };
}

app.get('/api/runpod/config', (req, res) => {
    res.json({
        defaultBaseUrl: 'gpu://z-image-turbo',
        engine: 'Z-Image-Turbo / Flux 2 Dev',
        fallbackModels: RUNPOD_FALLBACK_MODELS,
        modelProfiles: imageProfiles,
        flux2BaseUrl: FLUX2_COMFY_BASE_URL,
        defaultModel: RUNPOD_FALLBACK_MODELS[0],
        defaultLora: RUNPOD_DEFAULT_LORA,
        defaultLoraStrength: RUNPOD_DEFAULT_LORA_STRENGTH,
        defaultLoraEnabled: RUNPOD_DEFAULT_LORA !== 'none',
        defaultPreset: imageSettings.defaultPreset || '',
        identityPrefix: ZIMAGE_IDENTITY,
        presets: RUNPOD_PRESETS,
        samplers: ['flowmatch'],
        schedulers: ['flow'],
        sizes: [
            { label: '人像 480×832', width: 480, height: 832 },
            { label: '横图 832×480', width: 832, height: 480 },
            { label: '方图 768×768', width: 768, height: 768 }
        ]
    });
});

app.get('/api/runpod/health', async (req, res) => {
    try {
        const requestedModel = String(req.query.model || 'z-image-turbo');
        if (requestedModel === 'flux-2-dev') {
            const requestedBaseUrl = String(req.query.baseUrl || FLUX2_COMFY_BASE_URL || '').trim();
            if (!requestedBaseUrl || requestedBaseUrl.startsWith('gpu://')) {
                return res.json({
                    ok: false,
                    engine: 'Flux 2 Dev FP8 (ComfyUI)',
                    error: '尚未配置 Flux 2 Dev ComfyUI 地址',
                    requiredFiles: Object.values(FLUX2_FILES)
                });
            }
            const baseUrl = cleanComfyBaseUrl(requestedBaseUrl);
            const info = await comfyJson(baseUrl, '/object_info', { timeout: 90 });
            const requiredNodes = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'FluxGuidance', 'SamplerCustomAdvanced', 'SaveImage', 'VAEDecode', 'KSamplerSelect', 'BasicGuider', 'RandomNoise'];
            const missingNodes = requiredNodes.filter(name => !info?.[name]);
            const unets = info?.UNETLoader?.input?.required?.unet_name?.[0] || [];
            const textEncoders = info?.CLIPLoader?.input?.required?.clip_name?.[0] || [];
            const vaes = info?.VAELoader?.input?.required?.vae_name?.[0] || [];
            const missingModels = [
                unets.includes(FLUX2_FILES.diffusionModel) ? null : FLUX2_FILES.diffusionModel,
                textEncoders.includes(FLUX2_FILES.textEncoder) ? null : FLUX2_FILES.textEncoder,
                vaes.includes(FLUX2_FILES.vae) ? null : FLUX2_FILES.vae
            ].filter(Boolean);
            return res.json({
                ok: missingNodes.length === 0 && missingModels.length === 0,
                engine: 'Flux 2 Dev FP8 (ComfyUI)',
                baseUrl,
                missingNodes,
                missingModels,
                requiredFiles: Object.values(FLUX2_FILES)
            });
        }
        const ready = await zimageReady();
        if (ready && ready.status === 'ready') {
            return res.json({
                ok: true,
                engine: 'Z-Image-Turbo',
                status: ready.status,
                stats: { devices: [{ name: 'GPU0 A100 · Z-Image worker 就绪' }] }
            });
        }
        if (ready && ready.status === 'loading') {
            return res.json({
                ok: true,
                engine: 'Z-Image-Turbo',
                status: 'loading',
                stats: { devices: [{ name: '正在加载 31G 底座…约 40s' }] }
            });
        }
        if (ready && ready.status === 'busy') {
            return res.json({
                ok: true,
                engine: 'Z-Image-Turbo',
                status: 'busy',
                stats: { devices: [{ name: '正在出图' }] }
            });
        }
        res.json({
            ok: false,
            engine: 'Z-Image-Turbo',
            error: 'worker 未启动。点一次生成会自动拉起（需 GPU0 有约 30G 余量，vLLM 0.55）。'
        });
    } catch (error) {
        res.status(502).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/api/runpod/models', async (req, res) => {
    res.json({ ok: true, models: RUNPOD_FALLBACK_MODELS, engine: 'Z-Image-Turbo / Flux 2 Dev' });
});

app.get('/api/runpod/loras', async (req, res) => {
    res.json({ ok: true, loras: [RUNPOD_DEFAULT_LORA], engine: 'Z-Image-Turbo' });
});

app.get('/api/video/config', async (req, res) => {
    try {
        res.json(await minimaxVideoService.getConfig());
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/api/video/health', async (req, res) => {
    try {
        const config = await minimaxVideoService.getConfig();
        res.json({
            ok: config.configured,
            configured: config.configured,
            provider: config.provider,
            engine: config.engine,
            model: config.defaultModel,
            error: config.configured ? undefined : 'MiniMax API Key 未配置；请在设置 > Provider 中配置 MiniMax'
        });
    } catch (error) {
        res.status(502).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/api/video/history', (req, res) => {
    res.json(minimaxVideoService.getHistory());
});

app.post('/api/video/generate', async (req, res) => {
    try {
        res.json(await minimaxVideoService.generate(req.body || {}));
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/api/runpod/video/config', (req, res) => res.status(410).json({ error: 'Wan2.2 已停用；请使用 /api/video/config' }));
app.get('/api/runpod/video/health', (req, res) => res.status(410).json({ error: 'Wan2.2 已停用；请使用 /api/video/health' }));
app.get('/api/runpod/video/history', (req, res) => res.redirect(307, '/api/video/history'));
app.post('/api/runpod/video/generate', (req, res) => res.status(410).json({ error: 'Wan2.2 已停用；请使用 MiniMax H3' }));

app.use('/api/legacy/runpod/video', (req, res) => res.status(410).json({ error: 'Wan2.2 runtime 已永久停用' }));

async function generateImage(body = {}) {
        const model = String(body.model || 'z-image-turbo');
        if (!RUNPOD_FALLBACK_MODELS.includes(model)) throw new Error('不支持的图像模型');
        if (model === 'flux-2-dev') {
            return generateFlux2Image(body);
        }
        const prompt = ensurePromptIdentity(body.prompt);
        if (!prompt) throw new Error('请先写正向提示词');
        const width = clampRunPodInt(body.width, 256, 1536, 480, 16);
        const height = clampRunPodInt(body.height, 256, 1536, 832, 16);
        const steps = clampRunPodInt(body.steps, 4, 60, 28);
        const cfg = 1.0;
        const loraName = String(body.loraName || RUNPOD_DEFAULT_LORA).trim();
        const loraEnabled = body.loraEnabled !== false && loraName !== 'none' && !/no lora/i.test(model);
        const loraStrength = clampRunPodNumber(
            body.loraStrength,
            0, 1.5,
            loraEnabled ? RUNPOD_DEFAULT_LORA_STRENGTH : 0
        );
        let seed = Number(body.seed);
        if (!Number.isFinite(seed) || seed < 0) seed = Math.floor(Math.random() * 1e9);
        seed = Math.floor(seed);

        await ensureZimageWorker();
        const jobId = `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const result = await submitZimageJob({
            id: jobId,
            prompt,
            w: width,
            h: height,
            steps,
            seed,
            lora_enabled: loraEnabled,
            lora_weight: loraStrength
        });
        if (!result.ok) throw new Error(result.error || 'Z-Image 生成失败');

        const bytes = await pullGpuPng(result.png);
        const timestamp = Date.now();
        const localName = `zimage_${timestamp}_${jobId}.png`;
        fs.writeFileSync(path.join(imagesDir, localName), bytes);
        try { await gpuExec(`rm -f /dev/shm/.z/out/${jobId}.png /dev/shm/.z/jobs/${jobId}.done.json`); } catch {}

        const usedSeed = result.seed ?? seed;
        const usedW = result.w ?? width;
        const usedH = result.h ?? height;
        const item = {
            id: timestamp,
            filename: localName,
            imageUrl: `/images/${localName}`,
            prompt,
            negative: String(body.negative || ZIMAGE_NEG),
            model: loraEnabled ? 'z-image-turbo + ' + RUNPOD_DEFAULT_LORA : 'z-image-turbo',
            width: usedW,
            height: usedH,
            steps: result.steps ?? steps,
            cfgScale: cfg,
            sampler: 'flowmatch',
            scheduler: 'flow',
            seed: usedSeed,
            loras: loraEnabled ? [{ name: RUNPOD_DEFAULT_LORA, strength: loraStrength }] : [],
            source: 'gpu-zimage',
            promptId: jobId,
            createdAt: new Date().toISOString()
        };
        const history = loadHistory();
        history.push(item);
        saveHistory(history);
        return { ok: true, promptId: jobId, seed: usedSeed, image: item };
}

app.post('/api/runpod/generate', async (req, res) => {
    try { res.json(await generateImage(req.body)); }
    catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/sd', (req, res) => res.status(410).json({ error: 'Legacy shell-based SD generation has been retired' }));
app.get('/api/models/sd', (req, res) => res.json([]));
app.get('/api/models/lora', (req, res) => res.json([]));

async function generateTts(body = {}) {
    const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
    const result = await ttsProviderService.synthesize({ ...body, text });
        const timestamp = Date.now();
        const providerSlug = result.provider.replace(/[^a-zA-Z0-9_-]/g, '_');
        const outputName = `tts_${providerSlug}_${timestamp}_${Math.random().toString(36).slice(2, 8)}.${result.extension}`;
        const localAudioPath = path.join(audioDir, outputName);
        fs.writeFileSync(localAudioPath, result.audio);
        const meta = getAudioMeta(outputName);
        const historyItem = appendTTSHistory({
            id: `tts_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
            text,
            textPreview: textPreview(text),
            provider: result.provider,
            providerName: result.providerName,
            model: result.model,
            voice: result.voice,
            voiceName: result.voiceName,
            language: result.language,
            languageName: result.languageName,
            speed: result.speed,
            options: result.options,
            mimeType: result.mimeType,
            warning: result.warning || null,
            extraInfo: result.extraInfo || null,
            ...meta
        });

        return {
            audioUrl: meta.audioUrl,
            mimeType: result.mimeType,
            provider: result.provider,
            providerName: result.providerName,
            model: result.model,
            voice: result.voice,
            voiceName: result.voiceName,
            language: result.language,
            languageName: result.languageName,
            warning: result.warning,
            extraInfo: result.extraInfo || null,
            historyItem
        };
}

app.post('/api/tts', async (req, res) => {
    try { res.json(await generateTts(req.body)); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.get('/api/voices', (req, res) => {
    try {
        res.json(ttsProviderService.listVoices(req.query.provider, req.query.model));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/tts/config', (req, res) => {
    res.json(ttsProviderService.getPublicConfig());
});

app.get('/api/tts/providers/:providerId/docs', (req, res) => {
    try {
        res.type('text/markdown').send(ttsProviderService.getDocumentation(req.params.providerId));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

app.get('/api/tts/history', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 120, 1), 300);
    const history = syncExistingTTSAudio(loadTTSHistory())
        .filter(item => item && item.audioUrl && item.filename)
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, limit);
    res.json(history);
});

app.delete('/api/tts/history/:id', (req, res) => {
    const history = loadTTSHistory();
    const target = history.find(item => item.id === req.params.id);
    if (!target) {
        return res.status(404).json({ error: 'History item not found' });
    }

    const filtered = history.filter(item => item.id !== req.params.id);
    saveTTSHistory(filtered);

    if (target.filename) {
        safeUnlink(path.join(audioDir, path.basename(target.filename)));
    }

    res.json({ success: true });
});

// Prompts Management API
app.get('/api/prompts', (req, res) => {
    res.json(loadPrompts());
});

app.post('/api/prompts', (req, res) => {
    const { name, prompt, tags = [] } = req.body;
    if (!name || !prompt) {
        return res.status(400).json({ error: 'Name and prompt are required' });
    }
    const prompts = loadPrompts();
    const newPrompt = {
        id: Date.now().toString(),
        name,
        prompt,
        tags,
        createdAt: new Date().toISOString()
    };
    prompts.push(newPrompt);
    savePrompts(prompts);
    res.json(newPrompt);
});

app.delete('/api/prompts/:id', (req, res) => {
    const prompts = loadPrompts();
    const filtered = prompts.filter(p => p.id !== req.params.id);
    savePrompts(filtered);
    res.json({ success: true });
});

const httpServer = app.listen(PORT, process.env.HOST, () => {
    const address = httpServer.address();
    const localHost = ['::', '0.0.0.0'].includes(address.address) ? '127.0.0.1' : address.address;
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = `http://${localHost.includes(':') ? `[${localHost}]` : localHost}:${address.port}`;
    if (!workspaceBaseUrlProvided) process.env.PI_WORKSPACE_BASE_URL = process.env.PI_WORKSPACE_INTERNAL_ORIGIN;
    console.log(`Pivane backend running at http://localhost:${httpServer.address().port}`);
    if (maintenance.managed) {
        const base = process.env.PI_MANAGED_BASE || __dirname;
        const agent = path.resolve((process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent')).replace(/^~(?=$|[\\/])/, os.homedir()));
        const backupInputs = [agent, piAgentGateway.deferred.filePath, mediaProfile.directory, path.join(base, '.env'),
            ...['generation_history.json', 'video_history.json', 'tts_history.json', 'prompts.json', 'public/images', 'public/videos', 'public/audio'].map(p => path.join(mediaDataRoot, p)),
            ...(process.env.PI_CODING_AGENT_SESSION_DIR ? [path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR)] : [])].filter(Boolean).map(p => path.resolve(p));
        process.send({ type: 'maintenance-ready', nonce: maintenance.nonce, backupInputs, port: address.port });
    }
});
piAgentGateway.attachWebSocket(httpServer);

const shutdown = require('./server/pi-process-shutdown').registerProcessShutdown(async () => {
    httpServer.close();
    try { await piAgentGateway.dispose(); }
    finally { await require('./server/pi-rpc-client').shutdownRpcProcesses(); workspaceAccess.dispose(); }
});
if (maintenance.managed) {
    process.on('message', message => {
        if (message?.nonce !== maintenance.nonce) return;
        maintenance.receive(message);
        if (message.type === 'maintenance-shutdown') { maintenance.locked = true; void shutdown(); }
    });
    process.on('disconnect', () => { maintenance.locked = true; void shutdown(); });
}
