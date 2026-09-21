const privateFiles = require('./pi-private-files');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('node:crypto');

function auxiliaryRevision(document) {
    return createHash('sha256').update(JSON.stringify([document.sessionTitles || {}, document.mediaAgent || {}, document.mediaAgentRevision || 0])).digest('hex');
}

const DEFAULT_MEDIA_AGENT = Object.freeze({
    provider: '',
    modelId: ''
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
        this.writeDocument(document);
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
        const projects = this.getHiddenProjects().filter(item => item !== cwd);
        if (hidden) projects.push(cwd);
        this.writeDocument({ ...this.readDocument(), hiddenProjects: projects,
            pinnedProjects: hidden ? this.getPinnedProjects().filter(item => item !== cwd) : this.getPinnedProjects() });
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
    DEFAULT_MEDIA_AGENT
};
