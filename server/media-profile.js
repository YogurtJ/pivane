const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadMediaProfile(rootDir, env = process.env) {
    const clean = env.PI_MEDIA_PROFILE === 'clean';
    const directory = path.resolve(env.PI_MEDIA_CONFIG_DIR || path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'media-lab'));
    const publicConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'media-lab.json'), 'utf8'));
    const localPath = path.join(directory, 'profile.json');
    const local = !clean && fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : { version: 1 };
    if (publicConfig.version !== 1 || local.version !== 1) throw new Error('Unsupported media profile version');
    const models = new Map((publicConfig.models || []).map(model => [model.id, model]));
    for (const model of local.models || []) models.set(model.id, model);
    const ttsPath = path.join(directory, 'tts-providers.json');
    if (typeof env.ZJY_ROOT === 'string' && env.ZJY_ROOT) local.image = { ...local.image, workerRoot: env.ZJY_ROOT };
    return {
        image: { ...publicConfig.image, ...local.image },
        models: [...models.values()].filter(model => model.enabled !== false),
        gpuExec: env.GPU_EXEC || local.gpuExec || '',
        ttsConfigPath: !clean && fs.existsSync(ttsPath) ? ttsPath : path.join(rootDir, 'config', 'tts-providers.json'),
        privateProfile: !clean && fs.existsSync(localPath),
        directory
    };
}

function applyPromptPrefix(prompt, prefix) {
    const text = String(prompt || '').trim();
    const identity = String(prefix || '').trim();
    if (!text || !identity || text.toLowerCase().includes(identity.toLowerCase())) return text;
    const trigger = identity.split(',')[0].trim();
    if (trigger && text.toLowerCase().startsWith(trigger.toLowerCase() + ',')) {
        return identity + text.slice(trigger.length);
    }
    return `${identity}, ${text}`;
}

module.exports = { loadMediaProfile, applyPromptPrefix };
