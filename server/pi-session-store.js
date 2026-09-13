const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { windowsPath } = require('./pi-platform-path');
const execFileAsync = promisify(execFile);
let sdkPromise;
const privateAgentDirectories = new Set();

function getSdk() {
    if (process.platform === 'win32') {
        const directory = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(require('node:os').homedir(), '.pi', 'agent'));
        if (!privateAgentDirectories.has(directory)) {
            require('./pi-private-files').privateDirectory(directory);
            privateAgentDirectories.add(directory);
        }
    }
    if (!sdkPromise) sdkPromise = import('@earendil-works/pi-coding-agent');
    return sdkPromise;
}

function isWithin(root, candidate) {
    return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

class PiSessionStore {
    constructor() {
        const defaults = process.platform === 'win32'
            ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
            : ['/'];
        const configured = String(process.env.PI_PROJECT_ROOTS || defaults.join(path.delimiter))
            .split(path.delimiter)
            .map(value => value.trim())
            .filter(Boolean);
        this.roots = configured
            .map(root => {
                try {
                    return fs.realpathSync.native(windowsPath(root));
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }

    defaultProject() {
        for (const candidate of [require('os').homedir(), process.cwd(), ...this.roots]) {
            try { const resolved = this.resolveProject(candidate); fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK); return resolved; } catch {}
        }
        return null;
    }

    resolveProject(input) {
        const raw = windowsPath(String(input || '').trim());
        if (!raw || !path.isAbsolute(raw)) throw new Error('Project path must be absolute');

        let resolved;
        try {
            resolved = fs.realpathSync.native(raw);
        } catch {
            throw new Error('Project directory does not exist');
        }
        if (!fs.statSync(resolved).isDirectory()) throw new Error('Project path is not a directory');
        if (!this.roots.some(root => isWithin(root, resolved))) {
            throw new Error(`Project path is outside allowed roots: ${this.roots.join(', ')}`);
        }
        try { fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK); }
        catch { throw new Error('Project directory is not accessible to the server user'); }
        return resolved;
    }

    async listProjects() {
        const { SessionManager } = await getSdk();
        const sessions = await SessionManager.listAll();
        const projects = new Map();

        for (const session of sessions) {
            if (!session.cwd || !path.isAbsolute(session.cwd)) continue;
            let cwd;
            try {
                cwd = this.resolveProject(session.cwd);
            } catch {
                continue;
            }
            const current = projects.get(cwd) || {
                cwd,
                name: path.basename(cwd) || cwd,
                sessionCount: 0,
                modified: null
            };
            current.sessionCount += 1;
            if (!current.modified || session.modified > current.modified) current.modified = session.modified;
            projects.set(cwd, current);
        }

        return [...projects.values()]
            .map(project => ({
                ...project,
                modified: project.modified ? project.modified.toISOString() : null
            }))
            .sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')));
    }

    async listDirectories(input) {
        if (!input) {
            return {
                current: null,
                parent: null,
                directories: this.roots.map(root => ({ name: root, path: root }))
            };
        }

        const current = this.resolveProject(input);
        const parentCandidate = path.dirname(current);
        const parent = parentCandidate !== current && this.roots.some(candidate => isWithin(candidate, parentCandidate)) ? parentCandidate : null;
        const directories = fs.readdirSync(current, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .slice(0, 300)
            .map(entry => ({ name: entry.name, path: path.join(current, entry.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return { current, parent, directories };
    }

    async listSessions(input) {
        const cwd = this.resolveProject(input);
        const { SessionManager } = await getSdk();
        const sessions = await SessionManager.list(cwd);
        return sessions
            .map(session => this._serializeSession(session))
            .sort((a, b) => b.modified.localeCompare(a.modified));
    }

    async getSession(cwdInput, id) {
        const sessions = await this.listSessions(cwdInput);
        const session = sessions.find(item => item.id === id);
        if (!session) throw new Error('Session not found in this project');
        // One physical session must keep one supervisor key even when the OS accepts a case/symlink alias.
        return { ...session, path: fs.realpathSync.native(session.path) };
    }

    async createSession(cwdInput, name = '', { autoTitle = false } = {}) {
        const cwd = this.resolveProject(cwdInput);
        const { SessionManager } = await getSdk();
        const manager = SessionManager.create(cwd);
        const sessionPath = manager.getSessionFile();
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        fs.writeFileSync(sessionPath, '', { flag: 'wx' });

        // Opening an explicit empty file makes SessionManager write a valid header immediately.
        const persisted = SessionManager.open(sessionPath, undefined, cwd);
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName) persisted.appendSessionInfo(cleanName);
        else if (autoTitle) persisted.appendCustomEntry('pi5-web-title', { version: 1, sessionId: persisted.getSessionId(), status: 'pending' });
        return {
            id: persisted.getSessionId(),
            path: fs.realpathSync.native(sessionPath),
            cwd,
            name: persisted.getSessionName() || '',
            firstMessage: '',
            messageCount: 0,
            created: new Date().toISOString(),
            modified: new Date().toISOString()
        };
    }

    async forkSession(session, snapshot, entryId, position = 'before') {
        if (!['before', 'at'].includes(position)) throw new Error('分叉位置无效');
        if (entryId !== undefined && (typeof entryId !== 'string' || !entryId)) throw new Error('分叉消息无效');
        const { SessionManager } = await getSdk();
        const { activeBranch, promptFromEntry, isReplyForkPoint } = require('./pi-message-payload');
        const source = SessionManager.open(session.path);
        if (source.getLeafId() !== snapshot.leafId) throw new Error('会话已变化，请刷新后重试');
        const selected = entryId ? snapshot.entries.find(entry => entry.id === entryId) : null;
        if (position === 'at' && !isReplyForkPoint(selected)) throw new Error('请选择已完成且没有待执行工具调用的回复');
        const draft = entryId && position === 'before' ? promptFromEntry(selected) : null;
        const targetId = selected ? position === 'at' ? selected.id : selected.parentId : snapshot.leafId;
        const branch = targetId ? activeBranch({ entries: snapshot.entries, leafId: targetId }) : [];
        let result;
        if (branch.some(entry => entry.type === 'message' && entry.message.role === 'assistant')) {
            source.createBranchedSession(targetId);
            source.appendSessionInfo(`${session.name || '会话'} · 分叉`.slice(0, 120));
            result = await this.getSession(session.cwd, source.getSessionId());
        } else {
            // Native branch files are deferred before an assistant exists. Use the Web empty-header path.
            result = await this.createSession(session.cwd, `${session.name || '会话'} · 分叉`);
            const fresh = SessionManager.open(result.path);
            for (const entry of branch) {
                if (entry.type === 'message') fresh.appendMessage(entry.message);
                else if (entry.type === 'model_change') fresh.appendModelChange(entry.provider, entry.modelId);
                else if (entry.type === 'thinking_level_change') fresh.appendThinkingLevelChange(entry.thinkingLevel);
                else if (entry.type === 'custom') fresh.appendCustomEntry(entry.customType, entry.data);
                else if (entry.type === 'custom_message') fresh.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
            }
            fresh.appendCustomEntry('pi5-web-fork-origin', { sessionId: session.id, entryId: targetId });
        }
        require('./pi-private-files').privateFileMode(result.path);
        return { session: result, draft };
    }

    async renameSession(cwdInput, id, name, activeWorker) {
        const cleanName = String(name || '').trim().slice(0, 120);
        if (!cleanName) throw new Error('Session name is required');
        const session = await this.getSession(cwdInput, id);
        if (activeWorker) {
            await activeWorker.request('set_session_name', { name: cleanName });
        } else {
            const { SessionManager } = await getSdk();
            SessionManager.open(session.path).appendSessionInfo(cleanName);
        }
        return { ...session, name: cleanName, modified: new Date().toISOString() };
    }

    async deleteSession(cwdInput, id) {
        const session = await this.getSession(cwdInput, id);
        try {
            await execFileAsync('gio', ['trash', session.path], { timeout: 10000 });
            return { id, trashed: true };
        } catch {
            fs.unlinkSync(session.path);
            return { id, trashed: false };
        }
    }

    _serializeSession(session) {
        return {
            id: session.id,
            path: session.path,
            cwd: session.cwd,
            name: session.name || '',
            firstMessage: session.firstMessage || '',
            messageCount: session.messageCount || 0,
            created: session.created.toISOString(),
            modified: session.modified.toISOString()
        };
    }
}

module.exports = { PiSessionStore, getSdk };
