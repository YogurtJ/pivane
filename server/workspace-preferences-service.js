const privateFiles = require('./pi-private-files');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

class WorkspacePreferencesService {
    constructor(options = {}) {
        const agentDir = options.agentDir
            || process.env.PI_CODING_AGENT_DIR
            || path.join(os.homedir(), '.pi', 'agent');
        this.filePath = options.filePath || path.join(agentDir, 'pi5-workspace.json');
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

    getMediaAgent() {
        const current = this.readDocument().mediaAgent || {};
        try {
            return {
                provider: cleanReferencePart(current.provider || DEFAULT_MEDIA_AGENT.provider, 'Provider ID'),
                modelId: cleanReferencePart(current.modelId || DEFAULT_MEDIA_AGENT.modelId, 'Model ID')
            };
        } catch {
            return { ...DEFAULT_MEDIA_AGENT };
        }
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

    setMediaAgent(input = {}) {
        const mediaAgent = {
            provider: cleanReferencePart(input.provider, 'Provider ID'),
            modelId: cleanReferencePart(input.modelId, 'Model ID')
        };
        const document = {
            ...this.readDocument(),
            version: 1,
            mediaAgent
        };
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
    DEFAULT_MEDIA_AGENT
};
