const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { AsyncLocalStorage } = require('node:async_hooks');

const { windowsPath } = require('./pi-platform-path');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const sessionStamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
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
    if (!sdkPromise) sdkPromise = require('./workspace-network-transport').initializeSdkNetwork().then(() => import('@earendil-works/pi-coding-agent'));
    return sdkPromise;
}

function isWithin(root, candidate) {
    return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Hover metadata for the thread list: current-branch size, compaction state,
// latest reported context tokens and the model used most recently.
function sessionStats(manager) {
    try {
        const branch = manager.getBranch();
        let messages = 0, compactions = 0, model = null, contextTokens = null, afterCompaction = true;
        for (const entry of branch) {
            if (entry.type === 'message') messages++;
            else if (entry.type === 'compaction') compactions++;
        }
        for (let index = branch.length - 1; index >= 0; index--) {
            const entry = branch[index];
            if (entry.type === 'compaction') afterCompaction = false;
            const message = entry.type === 'message' ? entry.message : null;
            if (message?.role === 'assistant') {
                if (!model && typeof message.model === 'string' && message.model) model = { provider: String(message.provider || ''), id: message.model };
                const usage = message.usage;
                if (contextTokens === null && afterCompaction && usage && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
                    const total = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
                    if (total > 0) contextTokens = total;
                }
            } else if (!model && entry.type === 'model_change') model = { provider: String(entry.provider || ''), id: String(entry.modelId || '') };
            if (model && (contextTokens !== null || !afterCompaction)) break;
        }
        const context = compactions ? manager.buildContextEntries().filter(entry => entry.type === 'message').length : messages;
        return { messages, context, compactions, contextTokens, model: model?.id ? model : null };
    } catch { return null; }
}

class PiSessionStore {
    constructor() {
        // Concurrent reads share work; completed projections require fresh native proofs.
        this.sessionLists = new Map();
        this.sessionListCache = new Map();
        this.sessionMetadata = new (require('./pi-session-metadata').SessionMetadataCache)();
        this.sessionRows = new WeakMap();
        this.sessionReads = new AsyncLocalStorage();
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
        const sdk = await getSdk();
        const { SessionManager } = sdk;
        const root = path.join(sdk.getAgentDir(), 'sessions');
        let directories;
        try { directories = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() || entry.isSymbolicLink()); }
        catch { directories = []; }
        const sessions = [];
        for (const entry of directories) {
            const directory = path.join(root, entry.name);
            sessions.push(...await this.sessionMetadata.list(directory, sdk, () => SessionManager.listAll(directory)));
        }
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

    // Pi owns the parsing; pin the same native file identity around that parse.
    // A replaced path must not contribute a marker to a different list row.
    profileManager(session, SessionManager) {
        return this.sessionFileRead(session, SessionManager).manager();
    }

    sessionFileRead(session, SessionManager) {
        let fd;
        const listed = fs.lstatSync(session.path, { bigint: true });
        if (!listed.isFile() || listed.isSymbolicLink()) throw new Error('Session file changed');
        const file = fs.realpathSync.native(session.path);
        try {
            const before = fs.lstatSync(file, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink()) throw new Error('Session file changed');
            fd = io.openReadSync(file);
            const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
            if (sessionStamp(before) !== sessionStamp(opened) || sessionStamp(listed) !== sessionStamp(opened)
                || descriptorPathSync(fd) !== file) throw new Error('Session file changed');
            const manager = SessionManager.open(file);
            if (manager.getSessionId() !== session.id || manager.getCwd() !== session.cwd
                || sessionStamp(opened) !== sessionStamp(fs.fstatSync(fd, { bigint: true }))
                || sessionStamp(opened) !== sessionStamp(fs.lstatSync(file, { bigint: true }))
                || sessionStamp(opened) !== sessionStamp(fs.lstatSync(session.path, { bigint: true }))
                || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity)
                || fs.realpathSync.native(session.path) !== file) throw new Error('Session file changed');
            let parsed = manager;
            const validate = () => {
                if (!parsed) throw new Error('Session read expired');
                let check;
                try {
                    const listedNow = fs.lstatSync(session.path, { bigint: true });
                    if (!listedNow.isFile() || listedNow.isSymbolicLink() || fs.realpathSync.native(session.path) !== file)
                        throw new Error('Session file changed');
                    check = io.openReadSync(file);
                    const current = fs.fstatSync(check, { bigint: true });
                    if (!current.isFile() || sessionStamp(current) !== sessionStamp(opened)
                        || sessionStamp(listedNow) !== sessionStamp(opened)
                        || descriptorPathSync(check) !== file || io.identity(check) !== identity
                        || !io.sameIdentityAtPath(file, identity)
                        || sessionStamp(fs.lstatSync(file, { bigint: true })) !== sessionStamp(opened)
                        || sessionStamp(fs.lstatSync(session.path, { bigint: true })) !== sessionStamp(opened)
                        || sessionStamp(fs.fstatSync(check, { bigint: true })) !== sessionStamp(opened)
                        || descriptorPathSync(check) !== file || fs.realpathSync.native(session.path) !== file)
                        throw new Error('Session file changed');
                } finally { if (check !== undefined) fs.closeSync(check); }
            };
            return { manager() { validate(); return parsed; }, validate, close() { parsed = null; } };
        } finally { if (fd !== undefined) fs.closeSync(fd); }
    }

    async listSessions(input) {
        const cwd = this.resolveProject(input);
        const { SessionManager } = await getSdk();
        const profiles = this.profiles;
        const projects = this.projects;
        const profileSnapshot = profiles ? await profiles.state() : null;
        const projectSnapshot = projects ? await projects.state() : null;
        const revision = JSON.stringify([profileSnapshot?.revision, projectSnapshot?.revision]);
        let read = this.sessionLists.get(cwd);
        if (!read || read.revision !== revision || read.profiles !== profiles || read.projects !== projects) {
            read = { revision, profiles, projects };
            // Reserve before starting the read, and remove on success or failure.
            read.promise = Promise.resolve().then(async () => {
                const { sessionListRevision } = require('./pi-session-list-revision');
                // Pi's public factory resolves the native directory; an unflushed
                // manager has no session file on disk and is never appended to.
                const directory = SessionManager.create(cwd).getSessionDir();
                const sourceRevision = sessionListRevision(directory);
                const cached = this.sessionListCache.get(cwd);
                if (sourceRevision && cached?.sourceRevision === sourceRevision && cached.revision === revision
                    && cached.profiles === profiles && cached.projects === projects) return cached.result;
                this.sessionListCache.delete(cwd);
                const result = await this._listSessions(cwd, SessionManager, profiles, projects,
                    profileSnapshot?.state, projectSnapshot?.state, revision);
                if (sourceRevision && sourceRevision === sessionListRevision(directory)) {
                    if (this.sessionListCache.size >= 32) this.sessionListCache.delete(this.sessionListCache.keys().next().value);
                    this.sessionListCache.set(cwd, { sourceRevision, revision, profiles, projects, result });
                }
                return result;
            }).finally(() => {
                if (this.sessionLists.get(cwd) === read) this.sessionLists.delete(cwd);
            });
            this.sessionLists.set(cwd, read);
        }
        const result = await read.promise;
        this.resolveProject(cwd);
        return structuredClone(result);
    }

    async _nativeSessionMetadata(cwd, SessionManager) {
        const sdk = await getSdk();
        const directory = SessionManager.create(cwd).getSessionDir();
        // Native writers (including title/receipt appends) can invalidate a proof
        // between asynchronous metadata reads. Start a fresh, fully checked read;
        // never return the invalidated rows or retry any session mutation.
        for (let attempt = 0; ; attempt++) {
            try { return await this.sessionMetadata.list(directory, sdk, () => SessionManager.list(cwd)); }
            catch (error) {
                if (error.message !== 'Session file changed' || attempt >= 2) throw error;
            }
        }
    }

    async _listSessions(cwd, SessionManager, profiles, projects, profileState, projectState, revision) {
        const sessions = await this._nativeSessionMetadata(cwd, SessionManager);
        const result = [];
        for (const session of sessions) {
            const cached = this.sessionRows.get(session);
            if (cached && cached.revision === revision && cached.profiles === profiles && cached.projects === projects) {
                result.push(cached.item); continue;
            }
            const manager = profiles || projects ? this.profileManager(session, SessionManager) : null;
            const item = this._serializeSession(session, manager && profiles ? await profiles.describe(manager, profileState) : null,
                manager && projects ? projects.describe(manager, cwd, projectState) : null,
                manager ? require('./pi-profile-authoring').readProfileAuthoring(manager) : null);
            // The manager is already parsed for bindings; summarizing its current branch adds no extra file read.
            const stats = manager ? sessionStats(manager) : null;
            if (stats) item.stats = stats;
            this.sessionRows.set(session, { revision, profiles, projects, item });
            result.push(item);
        }
        return result.sort((a, b) => b.modified.localeCompare(a.modified));
    }

    async getSession(cwdInput, id) {
        return this.withSessionRead(cwdInput, id, session => session);
    }

    // A read is shared only inside this callback's async chain. Consumers must
    // call manager()/validate() after their awaits and before using parsed data.
    // Cleanup drops the body without validating: a newly started worker may
    // already have appended by the time the startup callback returns.
    async withSessionRead(cwdInput, id, action) {
        const cwd = this.resolveProject(cwdInput);
        await this.sessionMoves?.assertAvailable(cwd, id);
        const current = this.sessionReads.getStore();
        if (current?.active && current.session.cwd === cwd && current.session.id === id) {
            current.read.validate();
            return action(structuredClone(current.session), current.read);
        }
        const { SessionManager } = await getSdk();
        const candidate = (await this._nativeSessionMetadata(cwd, SessionManager)).find(item => item.id === id);
        if (!candidate) throw new Error('Session not found in this project');
        // One physical session must keep one supervisor key even through aliases.
        const canonical = fs.realpathSync.native(candidate.path);
        const read = this.sessionFileRead(candidate, SessionManager);
        try {
            const agentProfile = this.profiles ? await this.profiles.describe(read.manager()) : null;
            read.validate();
            const projectState = this.projects ? (await this.projects.state()).state : null;
            const manager = read.manager();
            const assistantProject = this.projects ? this.projects.describe(manager, cwd, projectState) : null;
            const session = { ...this._serializeSession(candidate, agentProfile, assistantProject), path: canonical,
                assistant: require('./pi-extension-assistant').assistantProfile(manager),
                profileAuthoring: require('./pi-profile-authoring').readProfileAuthoring(manager) };
            await this.sessionMoves?.assertAvailable(cwd, id);
            read.validate();
            const scope = { session, read, active: true };
            try {
                return await this.sessionReads.run(scope, () => action(structuredClone(session), read));
            } finally { scope.active = false; }
        } finally { read.close(); }
    }

    async createSession(cwdInput, name = '', { autoTitle = false, assistant = null, task = null, agentProfileId, inheritedProfileId,
        assistantProjectId, initializeSession } = {}) {
        if (initializeSession !== undefined && typeof initializeSession !== 'function') throw new Error('Session initializer must be a server function');
        const cwd = this.resolveProject(cwdInput);
        const selectedProfileId = inheritedProfileId !== undefined ? inheritedProfileId
            : assistant ? null : this.profiles ? await this.profiles.select(cwd, agentProfileId) : null;
        const { SessionManager } = await getSdk();
        const manager = SessionManager.create(cwd);
        const sessionPath = manager.getSessionFile();
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
        fs.writeFileSync(sessionPath, '', { flag: 'wx', mode: 0o600 });
        // Task text must never be written before the native session has private permissions.
        require('./pi-private-files').privateFileMode(sessionPath);

        // Opening an explicit empty file makes SessionManager write a valid header immediately.
        const persisted = SessionManager.open(sessionPath, undefined, cwd);
        if (this.profiles) persisted.appendCustomEntry(require('./pi-profile-state').PROFILE_ENTRY,
            { version: 1, sessionId: persisted.getSessionId(), profileId: selectedProfileId });
        if (assistantProjectId) persisted.appendCustomEntry(require('./pi-assistant-project-state').PROJECT_ENTRY,
            { version: 1, sessionId: persisted.getSessionId(), projectId: assistantProjectId, cwd });
        if (initializeSession) initializeSession(persisted);
        const cleanName = String(name || '').trim().slice(0, 120);
        if (cleanName) persisted.appendSessionInfo(cleanName);
        else if (autoTitle) persisted.appendCustomEntry('pivane-web-title', { version: 1, sessionId: persisted.getSessionId(), status: 'pending' });
        if (assistant) persisted.appendCustomEntry(require('./pi-extension-assistant').ASSISTANT_ENTRY,
            { ...assistant, version: 1, sessionId: persisted.getSessionId() });
        if (task) {
            const { TASK_ENTRY, TASK_MESSAGE } = require('./pi-agent-threads');
            const { message, ...metadata } = task;
            persisted.appendModelChange(task.model.provider, task.model.modelId);
            persisted.appendThinkingLevelChange(task.thinkingLevel);
            persisted.appendCustomEntry(TASK_ENTRY, { ...metadata, sessionId: persisted.getSessionId() });
            persisted.appendCustomMessageEntry(TASK_MESSAGE, message, true, { source: task.source });
        }
        require('./pi-private-files').privateFileMode(sessionPath);
        this.sessionLists.delete(cwd);
        return {
            assistant: assistant ? require('./pi-extension-assistant').assistantProfile(persisted) : null,
            profileAuthoring: require('./pi-profile-authoring').readProfileAuthoring(persisted),
            agentProfile: this.profiles ? await this.profiles.describe(persisted) : null,
            assistantProject: this.projects ? this.projects.describe(persisted, cwd, (await this.projects.state()).state) : null,
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
        const source = this.profileManager(session, SessionManager);
        const sourceStamp = sessionStamp(fs.lstatSync(session.path, { bigint: true }));
        const sourceBinding = require('./pi-profile-state').readProfileBinding(source);
        const groupBinding = require('./pi-assistant-project-state').readProjectBinding(source);
        const inheritedProfileId = sourceBinding?.profileId ?? null;
        if (source.getLeafId() !== snapshot.leafId) throw new Error('会话已变化，请刷新后重试');
        const entries = source.getEntries();
        const selected = entryId ? entries.find(entry => entry.id === entryId) : null;
        if (position === 'at' && !isReplyForkPoint(selected)) throw new Error('请选择已完成且没有待执行工具调用的回复');
        const draft = entryId && position === 'before' ? promptFromEntry(selected) : null;
        const targetId = selected ? position === 'at' ? selected.id : selected.parentId : snapshot.leafId;
        const branch = targetId ? activeBranch({ entries, leafId: targetId }) : [];
        let publishAccess;
        const guard = io.openReadSync(session.path);
        try {
            const identity = io.identity(guard);
            const unchanged = () => descriptorPathSync(guard) === session.path && io.sameIdentityAtPath(session.path, identity)
                && sessionStamp(fs.fstatSync(guard, { bigint: true })) === sourceStamp
                && sessionStamp(fs.lstatSync(session.path, { bigint: true })) === sourceStamp;
            if (!unchanged()) throw new Error('会话已变化，请刷新后重试');
            publishAccess = await require('./pi-session-fork-access').prepareForkAccess(this, session, branch, draft ? selected : null);
            if (!unchanged()) throw new Error('会话已变化，请刷新后重试');
        } finally { fs.closeSync(guard); }
        let result;
        if (branch.some(entry => entry.type === 'message' && entry.message.role === 'assistant')) {
            source.createBranchedSession(targetId);
            require('./profile-memory/learning-history').markFork(source);
            if (this.profiles) source.appendCustomEntry(require('./pi-profile-state').PROFILE_ENTRY,
                { version: 1, sessionId: source.getSessionId(), profileId: inheritedProfileId });
            if (groupBinding) source.appendCustomEntry(require('./pi-assistant-project-state').PROJECT_ENTRY,
                { version: 1, sessionId: source.getSessionId(), projectId: groupBinding.projectId, cwd: groupBinding.cwd });
            source.appendSessionInfo(`${session.name || '会话'} · 分叉`.slice(0, 120));
            publishAccess(source);
            this.sessionLists.delete(session.cwd);
            result = await this.getSession(session.cwd, source.getSessionId());
        } else if (branch.length) {
            // Native branching preserves IDs/references. Pi 0.99 persists when
            // the branch has user input; retain the older deferred-file fallback
            // only when the manager has not materialized its native file.
            source.createBranchedSession(targetId);
            require('./profile-memory/learning-history').markFork(source);
            if (this.profiles) source.appendCustomEntry(require('./pi-profile-state').PROFILE_ENTRY,
                { version: 1, sessionId: source.getSessionId(), profileId: inheritedProfileId });
            if (groupBinding) source.appendCustomEntry(require('./pi-assistant-project-state').PROJECT_ENTRY,
                { version: 1, sessionId: source.getSessionId(), projectId: groupBinding.projectId, cwd: groupBinding.cwd });
            source.appendSessionInfo(`${session.name || '会话'} · 分叉`.slice(0, 120));
            source.appendCustomEntry('pivane-web-fork-origin', { sessionId: session.id, entryId: targetId });
            if (!fs.existsSync(source.getSessionFile())) {
                const privateFiles = require('./pi-private-files');
                const temporary = fs.mkdtempSync(path.join(source.getSessionDir(), '.pivane-fork-'));
                try {
                    privateFiles.privateDirectory(temporary);
                    const output = path.join(temporary, 'branch.jsonl');
                    const { AgentSession } = await getSdk();
                    AgentSession.prototype.exportToJsonl.call({ sessionManager: source }, output);
                    privateFiles.privateFileMode(output);
                    fs.linkSync(output, source.getSessionFile());
                } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
            }
            // Exporting an empty native branch does not change the original
            // manager's persistence state. Reopen the materialized file before
            // appending the receipt marker through the public native API.
            publishAccess(this.profileManager({ cwd: session.cwd, id: source.getSessionId(), path: source.getSessionFile() }, SessionManager));
            this.sessionLists.delete(session.cwd);
            result = await this.getSession(session.cwd, source.getSessionId());
        } else {
            result = await this.createSession(session.cwd, `${session.name || '会话'} · 分叉`,
                { inheritedProfileId, assistantProjectId: groupBinding?.projectId });
            const empty = this.profileManager(result, SessionManager);
            empty.appendCustomEntry('pivane-web-fork-origin', { sessionId: session.id, entryId: targetId });
            publishAccess(empty);
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
        this.sessionLists.delete(session.cwd);
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
        } finally { this.sessionLists.delete(session.cwd); }
    }

    _serializeSession(session, agentProfile = null, assistantProject = null, profileAuthoring = null) {
        return {
            agentProfile,
            assistantProject,
            profileAuthoring,
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

module.exports = { PiSessionStore, getSdk, sessionStats };
