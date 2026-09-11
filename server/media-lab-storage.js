const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STORE = {
    image: { file: 'generation_history.json', directory: 'images', urlKey: 'imageUrl' },
    video: { file: 'video_history.json', directory: 'videos', urlKey: 'videoUrl' },
    tts: { file: 'tts_history.json', directory: 'audio', urlKey: 'audioUrl' }
};
function storage(root, kind) {
    const config = STORE[kind];
    if (!config) throw Object.assign(new Error('Unknown media kind'), { statusCode: 400 });
    return { ...config, file: path.join(root, config.file), directory: path.join(root, 'public', config.directory), prefix: '/' + config.directory + '/' };
}
function read(file) {
    try {
        const items = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(items)) throw new Error('Invalid media history');
        return items;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw new Error('Media history cannot be read; existing data was not changed');
    }
}
function write(file, items) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        privateFiles.writePrivateFileSync(temporary, JSON.stringify(items, null, 2));
        fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function mediaHistory(root, kind) {
    const config = storage(root, kind);
    return read(config.file).filter(item => item && typeof item === 'object').map(item => {
        const filename = path.basename(item.filename || item[config.urlKey] || '');
        return { ...item, kind, url: filename ? config.prefix + encodeURIComponent(filename) : '' };
    }).filter(item => item.url).reverse();
}
function saveExternalMedia(root, { model, parameters, bytes, mimeType, taskId }) {
    const config = storage(root, model.kind);
    const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
    const history = read(config.file);
    fs.mkdirSync(config.directory, { recursive: true });
    const id = randomUUID();
    const filename = `lab_${id}.${extensions[mimeType]}`;
    const item = { id, filename, [config.urlKey]: config.prefix + filename, mimeType,
        model: model.remoteModel || model.id, labModelId: model.id, source: model.adapter === 'http-provider' ? 'media-lab-http' : 'media-lab-http-json', parameters,
        ...(model.providerId ? { provider: model.providerId, providerName: model.providerName } : {}), ...(taskId ? { taskId } : {}),
        prompt: parameters.prompt || '', text: parameters.text || (typeof parameters.input === 'string' ? parameters.input : ''), createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(config.directory, filename), bytes, { flag: 'wx' });
    write(config.file, [...history, item]);
    return { asset: { ...item, kind: model.kind, url: item[config.urlKey] } };
}
function deleteMedia(root, kind, id) {
    const config = storage(root, kind);
    const history = read(config.file);
    const item = history.find(entry => String(entry.id) === String(id));
    if (!item) throw Object.assign(new Error('Media item not found'), { statusCode: 404 });
    const filename = path.basename(item.filename || item[config.urlKey] || '');
    if (filename) {
        try { fs.unlinkSync(path.join(config.directory, filename)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    write(config.file, history.filter(entry => entry !== item));
    return { ok: true };
}
module.exports = { mediaHistory, saveExternalMedia, deleteMedia };
