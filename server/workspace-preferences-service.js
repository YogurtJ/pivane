const privateFiles = require('./pi-private-files');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('node:crypto');

function auxiliaryRevision(document) {
    return createHash('sha256').update(JSON.stringify([document.sessionTitles || {}, document.mediaAgent || {}, document.mediaAgentRevision || 0,
        document.memoryModels || {}])).digest('hex');
}

const DEFAULT_MEDIA_AGENT = Object.freeze({
    provider: '',
    modelId: ''
});

const DEFAULT_MEDIA_CHAT_EXECUTION = Object.freeze({
    image: true,
    tts: true,
    video: false
});

function cleanReferencePart(value, label) {
    const text = String(value || '').trim();
    if (!text || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new Error(`${label} is invalid`);
    }
    return text;
}

function validateTitleSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['enabled', 'provider', 'modelId', 'expectedRevision'].includes(key))) throw new Error('标题设置参数无效');
    const patch = {};
    if (Object.hasOwn(input, 'enabled')) {
        if (typeof input.enabled !== 'boolean') throw new Error('自动标题设置需要 enabled 布尔值');
        patch.enabled = input.enabled;
    }
    if (Object.hasOwn(input, 'provider') || Object.hasOwn(input, 'modelId')) {
        if (typeof input.provider !== 'string' || typeof input.modelId !== 'string') throw new Error('标题模型需要同时指定供应商和模型');
        patch.provider = input.provider.trim(); patch.modelId = input.modelId.trim();
        if (Boolean(patch.provider) !== Boolean(patch.modelId)) throw new Error('标题模型需要同时指定供应商和模型');
        if (patch.provider) {
            cleanReferencePart(patch.provider, 'Provider ID'); cleanReferencePart(patch.modelId, 'Model ID');
        }
    }
    if (!Object.keys(patch).length || input.expectedRevision !== undefined
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) throw new Error('标题设置参数无效');
    return patch;
}

class WorkspacePreferencesService {
    constructor(options = {}) {
        const agentDir = options.agentDir
            || process.env.PI_CODING_AGENT_DIR
            || path.join(os.homedir(), '.pi', 'agent');
        this.filePath = options.filePath || require('./pivane-compat').dataFile(agentDir, 'pivane-workspace.json');
    }

    readDocument() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw error;
        }
    }

    getSessionTitles() {
        const current = this.readDocument().sessionTitles || {};
        // Malformed dedicated references must never silently fall back to a thread's model.
        const reference = validateTitleSettings({ provider: current.provider ?? '', modelId: current.modelId ?? '' });
        return { enabled: current.enabled !== false, ...reference,
            revision: Number.isSafeInteger(current.revision) && current.revision >= 0 ? current.revision : 0 };
    }

    setSessionTitles(input) {
        const patch = validateTitleSettings(input);
        const current = this.getSessionTitles();
        if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
            throw Object.assign(new Error('标题设置已变化，请刷新后再保存'), { statusCode: 409 });
        }
        const document = this.readDocument();
        this.writeDocument({ ...document, sessionTitles: { ...document.sessionTitles, ...patch, revision: current.revision + 1 } });
        return this.getSessionTitles();
    }

    getMediaAgent() {
        const current = this.readDocument().mediaAgent || {};
        const reference = validateTitleSettings({ provider: current.provider ?? '', modelId: current.modelId ?? '' });
        return { provider: reference.provider, modelId: reference.modelId };
    }

    getMemoryModels() {
        const saved = this.readDocument().memoryModels || {};
        return Object.fromEntries(['memory-correction', 'memory-review', 'memory-extraction'].map(id => {
            const value = saved[id] || { provider: '', modelId: '' };
            const reference = validateTitleSettings({ provider: value.provider ?? '', modelId: value.modelId ?? '' });
            return [id, { provider: reference.provider, modelId: reference.modelId }];
        }));
    }

    getAuxiliaryModelsRevision() { return auxiliaryRevision(this.readDocument()); }

    setAuxiliaryModels(changes, expectedRevision) {
        const document = this.readDocument();
        if (auxiliaryRevision(document) !== expectedRevision) throw Object.assign(new Error('辅助模型设置已变化，请刷新后再保存'), { statusCode: 409 });
        if (changes.sessionTitles) {
            const patch = validateTitleSettings(changes.sessionTitles);
            document.sessionTitles = { ...document.sessionTitles, ...patch, revision: (document.sessionTitles?.revision || 0) + 1 };
        }
        if (changes.mediaAgent) {
            const reference = validateTitleSettings(changes.mediaAgent);
            document.mediaAgent = { ...document.mediaAgent, provider: reference.provider, modelId: reference.modelId };
            document.mediaAgentRevision = (document.mediaAgentRevision || 0) + 1;
        }
        if (changes.memoryModels) {
            document.memoryModels = { ...document.memoryModels };
            for (const [id, value] of Object.entries(changes.memoryModels)) {
                const reference = validateTitleSettings(value);
                document.memoryModels[id] = { ...document.memoryModels[id], provider: reference.provider, modelId: reference.modelId };
            }
        }
        this.writeDocument(document);
    }

    getModelFavorites() {
        const data = this.readDocument().modelFavorites || {};
        return { version: 1, revision: data.revision || 0, favorites: data.favorites || [] };
    }

    changeModelFavorites(input) {
        const invalid = () => { throw new Error('Invalid model favorites request'); };
        const reference = value => {
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider', 'modelId'].includes(key))
                || typeof value.provider !== 'string' || typeof value.modelId !== 'string'
                || !value.provider || value.provider.length > 300 || !value.modelId || value.modelId.length > 500
                || /[\u0000-\u001f\u007f]/.test(value.provider + value.modelId)) return invalid();
            return { provider: value.provider, modelId: value.modelId };
        };
        if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
        let models;
        if (input.action === 'set') {
            if (Object.keys(input).some(key => !['action', 'model', 'favorite'].includes(key)) || typeof input.favorite !== 'boolean') return invalid();
            models = [reference(input.model)];
        } else if (input.action === 'import') {
            if (Object.keys(input).some(key => !['action', 'models', 'migrationId'].includes(key))
                || typeof input.migrationId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.migrationId)
                || !Array.isArray(input.models) || input.models.length > 5000) return invalid();
            models = input.models.map(reference);
        } else return invalid();
        // Synchronous read/modify/atomic write: actions on different models compose,
        // without a browser replacing another device's complete list.
        const document = this.readDocument(), previous = document.modelFavorites || {};
        const key = model => JSON.stringify([model.provider, model.modelId]);
        const favorites = new Map((previous.favorites || []).map(model => [key(model), model]));
        const removed = new Set(previous.removed || []), imports = new Set(previous.imports || []);
        if (input.action === 'import' && imports.has(input.migrationId)) return this.getModelFavorites();
        for (const model of models) {
            const id = key(model);
            if (input.action === 'set' && !input.favorite) { favorites.delete(id); removed.add(id); }
            else if (input.action === 'set' || !removed.has(id)) { favorites.set(id, model); removed.delete(id); }
        }
        if (input.action === 'import') imports.add(input.migrationId);
        if (favorites.size > 5000 || removed.size > 5000 || imports.size > 1024) throw new Error('Model favorites storage limit reached');
        document.modelFavorites = { ...previous, version: 1, revision: (previous.revision || 0) + 1,
            favorites: [...favorites.values()], removed: [...removed], imports: [...imports] };
        this.writeDocument(document);
        return this.getModelFavorites();
    }

    getFileRoots(cwd) {
        const data = this.readDocument().fileRoots;
        if (data !== undefined && (!Array.isArray(data) || data.length > 256)) throw new Error('文件目录设置无效');
        const saved = (data || []).find(item => item?.cwd === cwd);
        if (saved && (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.roots)
            || saved.roots.length > 16 || saved.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096))) throw new Error('文件目录设置无效');
        return { revision: saved?.revision || 0, roots: [...(saved?.roots || [])] };
    }

    changeFileRoot(cwd, root, action, expectedRevision) {
        if (![cwd, root].every(value => typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096)
            || !['add', 'remove'].includes(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('文件目录参数无效');
        const current = this.getFileRoots(cwd);
        if (current.revision !== expectedRevision) throw Object.assign(new Error('关联目录已变化，请刷新后重试'), { status: 409, code: 'FILE_ROOTS_CHANGED' });
        const roots = current.roots.filter(value => value !== root && value !== cwd);
        if (action === 'add' && root !== cwd) roots.push(root);
        if (roots.length > 16) throw Object.assign(new Error('最多添加 16 个关联目录'), { status: 400, code: 'FILE_ROOTS_LIMIT' });
        // No await between revision validation and atomic save. Re-read other
        // preferences rather than replacing another feature's changes.
        const document = this.readDocument(), items = document.fileRoots || [];
        const previous = items.find(item => item?.cwd === cwd) || {};
        const next = items.filter(item => item?.cwd !== cwd);
        if (next.length >= 256) throw Object.assign(new Error('文件目录设置已达上限'), { status: 400, code: 'FILE_ROOTS_LIMIT' });
        next.push({ ...previous, cwd, roots, revision: current.revision + 1 });
        this.writeDocument({ ...document, fileRoots: next });
        return { revision: current.revision + 1, roots };
    }

    getPinnedProjects() {
        const pins = this.readDocument().pinnedProjects;
        return Array.isArray(pins) ? [...new Set(pins.filter(cwd => typeof cwd === 'string' && path.isAbsolute(cwd)))] : [];
    }

    setProjectPinned(cwd, pinned) {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof pinned !== 'boolean') {
            throw new Error('Project path and boolean pinned are required');
        }
        const pins = this.getPinnedProjects().filter(item => item !== cwd);
        if (pinned) pins.unshift(cwd);
        this.writeDocument({ ...this.readDocument(), version: 1, pinnedProjects: pins,
            hiddenProjects: pinned ? this.getHiddenProjects().filter(item => item !== cwd) : this.getHiddenProjects() });
        return pins;
    }

    getHiddenProjects() {
        const hidden = this.readDocument().hiddenProjects;
        return Array.isArray(hidden) ? [...new Set(hidden.filter(cwd => typeof cwd === 'string' && path.isAbsolute(cwd)))] : [];
    }

    setProjectHidden(cwd, hidden) {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof hidden !== 'boolean') {
            throw new Error('Project path and boolean hidden are required');
        }
        const document = this.readDocument();
        const projects = this.getHiddenProjects().filter(item => item !== cwd);
        if (hidden) projects.push(cwd);
        const archives = this.getArchives();
        const nextArchives = hidden && archives.projects.includes(cwd)
            ? { ...document.archives, ...archives, projects: archives.projects.filter(item => item !== cwd), revision: archives.revision + 1 }
            : document.archives;
        this.writeDocument({ ...document, hiddenProjects: projects,
            pinnedProjects: hidden ? this.getPinnedProjects().filter(item => item !== cwd) : this.getPinnedProjects(),
            ...(nextArchives !== undefined ? { archives: nextArchives } : {}) });
        return projects;
    }

    getArchives() {
        const data = this.readDocument().archives || {};
        const projects = Array.isArray(data.projects) ? [...new Set(data.projects.filter(cwd => typeof cwd === 'string' && path.isAbsolute(cwd)))] : [];
        const sessions = Array.isArray(data.sessions) ? data.sessions.filter(item => item && typeof item.cwd === 'string'
            && path.isAbsolute(item.cwd) && typeof item.sessionId === 'string' && item.sessionId.length > 0)
            .map(({ cwd, sessionId }) => ({ cwd, sessionId })) : [];
        return { revision: Number.isSafeInteger(data.revision) ? data.revision : 0, projects, sessions };
    }

    setArchived(cwd, sessionId, archived) {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof archived !== 'boolean'
            || sessionId !== null && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 300)) {
            throw new Error('Project, session and boolean archived are required');
        }
        const data = this.getArchives();
        if (sessionId === null) {
            data.projects = data.projects.filter(item => item !== cwd);
            if (archived) data.projects.push(cwd);
        } else {
            data.sessions = data.sessions.filter(item => item.cwd !== cwd || item.sessionId !== sessionId);
            if (archived) data.sessions.push({ cwd, sessionId });
        }
        data.revision++;
        const document = this.readDocument();
        this.writeDocument({ ...document, archives: { ...document.archives, ...data } });
        return data;
    }

    captureSessionReferences(source, target) {
        const document = this.readDocument();
        const matches = item => item?.sessionId === source.id && [source.cwd, target.cwd].includes(item.cwd);
        return { archives: (document.archives?.sessions || []).filter(matches),
            notices: (document.replyNotices || []).filter(matches),
            inheritedArchive: (document.archives?.projects || []).includes(source.cwd),
            targetHidden: this.getHiddenProjects().includes(target.cwd) };
    }

    moveSessionReferences(source, target, snapshot) {
        const document = this.readDocument();
        const matches = item => item?.sessionId === source.id && [source.cwd, target.cwd].includes(item.cwd);
        const archived = snapshot.inheritedArchive || snapshot.archives.some(item => item.cwd === source.cwd);
        const sessions = (document.archives?.sessions || []).filter(item => !matches(item));
        if (archived) sessions.push({ cwd: target.cwd, sessionId: source.id });
        const notices = (document.replyNotices || []).filter(item => !matches(item));
        notices.push(...snapshot.notices.filter(item => item.cwd === source.cwd).map(item => ({ ...item, cwd: target.cwd })));
        const hiddenProjects = this.getHiddenProjects().filter(cwd => cwd !== target.cwd);
        this.writeDocument({ ...document, hiddenProjects, archives: { ...document.archives, sessions,
            revision: (document.archives?.revision || 0) + 1 }, replyNotices: notices });
    }

    restoreSessionReferences(source, target, snapshot) {
        const document = this.readDocument();
        const matches = item => item?.sessionId === source.id && [source.cwd, target.cwd].includes(item.cwd);
        const hiddenProjects = this.getHiddenProjects().filter(cwd => cwd !== target.cwd);
        if (snapshot.targetHidden) hiddenProjects.push(target.cwd);
        this.writeDocument({ ...document, hiddenProjects, archives: { ...document.archives,
            sessions: [...(document.archives?.sessions || []).filter(item => !matches(item)), ...snapshot.archives],
            revision: (document.archives?.revision || 0) + 1 },
            replyNotices: [...(document.replyNotices || []).filter(item => !matches(item)), ...snapshot.notices] });
    }

    getReplyNotices() {
        const notices = this.readDocument().replyNotices;
        if (!Array.isArray(notices)) return [];
        return notices.filter(item => item && typeof item.cwd === 'string' && path.isAbsolute(item.cwd)
            && typeof item.sessionId === 'string' && typeof item.completionId === 'string'
            && typeof item.completedAt === 'string')
            .map(({ cwd, sessionId, completionId, completedAt, manual }) => ({ cwd, sessionId, completionId, completedAt,
                ...(manual === true ? { manual: true } : {}) }));
    }

    recordReplyNotice(notice) {
        const { cwd, sessionId, completionId, completedAt } = notice;
        const notices = this.getReplyNotices().filter(item => item.cwd !== cwd || item.sessionId !== sessionId);
        notices.push({ cwd, sessionId, completionId, completedAt, ...(notice.manual === true ? { manual: true } : {}) });
        this.writeDocument({ ...this.readDocument(), replyNotices: notices });
    }

    clearReplyNotice(cwd, sessionId, completionId) {
        const notices = this.getReplyNotices();
        const next = notices.filter(item => item.cwd !== cwd || item.sessionId !== sessionId
            || completionId !== undefined && item.completionId !== completionId);
        if (next.length !== notices.length) this.writeDocument({ ...this.readDocument(), replyNotices: next });
        return next;
    }

    setMediaAgent(input = {}, { expectedRevision } = {}) {
        const reference = validateTitleSettings({ provider: input.provider, modelId: input.modelId });
        const mediaAgent = { provider: reference.provider, modelId: reference.modelId };
        const current = this.readDocument();
        if (expectedRevision !== undefined && auxiliaryRevision(current) !== expectedRevision) throw Object.assign(new Error('辅助模型设置已变化，请刷新后再保存'), { statusCode: 409 });
        const document = { ...current, version: 1, mediaAgent: { ...current.mediaAgent, ...mediaAgent }, mediaAgentRevision: (current.mediaAgentRevision || 0) + 1 };
        this.writeDocument(document);
        return { ...mediaAgent };
    }

    getMediaChatExecution() {
        const current = this.readDocument().mediaChatExecution || {};
        return {
            image: typeof current.image === 'boolean' ? current.image : DEFAULT_MEDIA_CHAT_EXECUTION.image,
            tts: typeof current.tts === 'boolean' ? current.tts : DEFAULT_MEDIA_CHAT_EXECUTION.tts,
            video: typeof current.video === 'boolean' ? current.video : DEFAULT_MEDIA_CHAT_EXECUTION.video,
            revision: Number.isSafeInteger(current.revision) && current.revision >= 0 ? current.revision : 0
        };
    }

    setMediaChatExecution(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => !['image', 'tts', 'video', 'expectedRevision'].includes(key))) {
            throw Object.assign(new Error('聊天媒体执行策略参数无效'), { statusCode: 400 });
        }
        const patch = {};
        for (const kind of ['image', 'tts', 'video']) {
            if (!Object.hasOwn(input, kind)) continue;
            if (typeof input[kind] !== 'boolean') throw Object.assign(new Error('聊天媒体执行策略需要布尔值'), { statusCode: 400 });
            patch[kind] = input[kind];
        }
        if (!Object.keys(patch).length || input.expectedRevision !== undefined
            && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
            throw Object.assign(new Error('聊天媒体执行策略参数无效'), { statusCode: 400 });
        }
        const current = this.getMediaChatExecution();
        if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
            throw Object.assign(new Error('聊天媒体执行策略已变化，请刷新后再保存'), { statusCode: 409 });
        }
        const document = this.readDocument();
        this.writeDocument({ ...document, mediaChatExecution: { ...document.mediaChatExecution, ...patch, revision: current.revision + 1 } });
        return this.getMediaChatExecution();
    }

    writeDocument(document) {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        privateFiles.writePrivateFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`);
        fs.renameSync(tempPath, this.filePath);
    }
}

module.exports = {
    WorkspacePreferencesService,
    validateTitleSettings,
    DEFAULT_MEDIA_AGENT,
    DEFAULT_MEDIA_CHAT_EXECUTION
};
