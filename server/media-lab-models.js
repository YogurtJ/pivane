const privateFiles = require('./pi-private-files');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateDefinition } = require('./media-lab-service');

function modelInstructions(model, directory) {
    if (!model.instructionsFile) return model.instructions || '';
    if (path.isAbsolute(model.instructionsFile) || path.extname(model.instructionsFile) !== '.md') throw new Error('Model instructions must be a relative Markdown file');
    const root = fs.realpathSync(directory);
    const file = fs.realpathSync(path.resolve(root, model.instructionsFile));
    if (!file.startsWith(root + path.sep) || fs.statSync(file).size > 32000) throw new Error('Model instructions are outside the configuration directory or too large');
    return [model.instructions || '', fs.readFileSync(file, 'utf8')].filter(Boolean).join('\n\n');
}

function installMediaModel(profile, input) {
    if (process.env.PI_MEDIA_PROFILE === 'clean') throw new Error('Clean preview ignores local configuration; use a normal independent instance to save models');
    if (input.confirmed !== true) throw new Error('Explicit configuration confirmation is required');
    const model = validateDefinition(input.model);
    if (!['http-json', 'manual'].includes(model.adapter)) throw new Error('Web model registration supports manual plans and HTTP JSON adapters');
    if (JSON.stringify(model).length > 64000) throw new Error('Model definition is too large');
    if (profile.models.some(item => item.id === model.id)) throw new Error('Model ID already exists; use a new ID or edit the local configuration file');
    if (profile.models.length >= 60) throw new Error('Too many media models');
    const directory = profile.directory;
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    modelInstructions(model, directory);
    const file = path.join(directory, 'profile.json');
    let document = { version: 1, models: [] };
    if (fs.existsSync(file)) {
        document = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (document.version !== 1 || document.models !== undefined && !Array.isArray(document.models)) throw new Error('Invalid local profile; no configuration was changed');
    }
    if ((document.models || []).some(item => item.id === model.id)) throw new Error('Model ID already exists in local configuration');
    const next = { ...document, models: [...(document.models || []), model] };
    if (fs.existsSync(file)) privateFiles.writePrivateFileSync(`${file}.bak-${Date.now()}`, fs.readFileSync(file));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        privateFiles.writePrivateFileSync(temporary, JSON.stringify(next, null, 2) + '\n');
        fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    profile.models.push(JSON.parse(JSON.stringify(model)));
    profile.privateProfile = true;
    return { ok: true, modelId: model.id };
}
module.exports = { installMediaModel, modelInstructions };
