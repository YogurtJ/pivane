const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { safeFile } = require('./pi-native-service');
const { readProfileBinding } = require('./pi-profile-state');
const { readProjectBinding, UUID } = require('./pi-assistant-project-state');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { replaceFileSync } = require('./pi-win32-native');
const privateFiles = require('./pi-private-files');

const MAX_BYTES = 2 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const changed = () => fail('Assistant projects changed during read or save', 409);
const revision = raw => createHash('sha256').update(raw ?? '').digest('hex');
const projectRevision = record => record ? revision(JSON.stringify(record)) : null;

function validRecord(record) {
    return object(record) && typeof record.id === 'string' && UUID.test(record.id) && typeof record.name === 'string'
        && Boolean(record.name.trim()) && record.name.length <= 80 && typeof record.cwd === 'string'
        && path.isAbsolute(record.cwd) && typeof record.description === 'string' && record.description.length <= 500
        && typeof record.instructions === 'string' && Buffer.byteLength(record.instructions, 'utf8') <= 8192
        && Array.isArray(record.profileIds) && record.profileIds.every(id => typeof id === 'string' && UUID.test(id))
        && new Set(record.profileIds).size === record.profileIds.length && typeof record.archived === 'boolean'
        && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
        && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
}

function readProjectRegistry(file) {
    let fd, existed = false;
    try {
        const before = fs.lstatSync(file, { bigint: true });
        existed = true;
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES)) fail('Invalid assistant project registry');
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) changed();
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let size = 0, n;
        while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, size))) size += n;
        if (size > MAX_BYTES) fail('Assistant project registry is too large');
        if (size !== Number(opened.size) || stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true }))
            || stamp(opened) !== stamp(fs.lstatSync(file, { bigint: true }))
            || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity)) changed();
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        const state = JSON.parse(raw);
        if (!object(state) || state.version !== 1 || !Array.isArray(state.projects)
            || new Set(state.projects.map(p => p?.id)).size !== state.projects.length
            || state.projects.some(p => !validRecord(p))) fail('Assistant project registry is invalid');
        return { raw, state };
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (!existed) return { raw: null, state: { version: 1, projects: [] } };
            changed();
        }
        if (error instanceof SyntaxError || error instanceof TypeError && error.message.includes('encoded data')) fail('Assistant project registry contains invalid JSON or UTF-8');
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

class PiAssistantProjectRegistry {
    constructor(store, profiles) { this.store = store; this.profiles = profiles; }

    async paths(create = false) {
        const { getAgentDir } = await getSdk();
        const file = safeFile(getAgentDir(), ['pivane-profiles', 'assistant-projects.json'], create);
        const root = path.dirname(file);
        if (create) { privateFiles.privateDirectory(root); if (process.platform !== 'win32') fs.chmodSync(root, 0o700); }
        return { root, file };
    }

    async state() {
        const { file } = await this.paths();
        const data = readProjectRegistry(file);
        return { ...data, revision: revision(data.raw) };
    }

    async list(profileId) {
        if (profileId !== undefined && (typeof profileId !== 'string' || !UUID.test(profileId))) fail('Invalid profile ID');
        const { state, revision: current } = await this.state();
        return { version: 1, revision: current, projects: profileId === undefined ? state.projects
            : state.projects.filter(project => project.profileIds.includes(profileId)) };
    }

    // Called under the profile/native-settings reservation: no second operation may
    // change associations between validation and native session creation.
    async mutate(expectedRevision, update) {
        if (typeof expectedRevision !== 'string') fail('Expected revision is required');
        const { root, file } = await this.paths(true);
        const lock = path.join(root, 'assistant-projects.lock');
        let directoryFd;
        try {
            directoryFd = io.openReadSync(root);
            const parent = fs.fstatSync(directoryFd, { bigint: true }), identity = io.identity(directoryFd);
            const checkParent = () => {
                try {
                    const current = fs.lstatSync(root, { bigint: true }), opened = fs.fstatSync(directoryFd, { bigint: true });
                    if (!parent.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
                        || stamp(current) !== stamp(opened) || parent.dev !== current.dev || parent.ino !== current.ino
                        || parent.mode !== current.mode || descriptorPathSync(directoryFd) !== root
                        || fs.realpathSync.native(root) !== root || !io.sameIdentityAtPath(root, identity)) changed();
                } catch (error) { if (error.status) throw error; changed(); }
            };
            checkParent();
            try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('Assistant projects are being saved', 409); }
            try {
                checkParent();
                const { state, raw } = readProjectRegistry(file);
                if (revision(raw) !== expectedRevision) fail('Assistant projects changed; reload before saving', 409);
                const result = update(state);
                const text = JSON.stringify(state, null, 2) + '\n';
                if (Buffer.byteLength(text) > MAX_BYTES) fail('Assistant project registry is too large');
                const tmp = `${file}.${randomUUID()}.tmp`;
                try {
                    privateFiles.writePrivateFileSync(tmp, text, true);
                    checkParent();
                    if (readProjectRegistry(file).raw !== raw) changed();
                    replaceFileSync(tmp, file);
                    privateFiles.privateFileMode(file);
                    checkParent();
                    if (readProjectRegistry(file).raw !== text) changed();
                    if (process.platform !== 'win32') fs.fsyncSync(directoryFd);
                } finally { try { fs.unlinkSync(tmp); } catch {} }
                return { ...result, revision: revision(text) };
            } finally { checkParent(); fs.rmdirSync(lock); }
        } finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
    }

    save(input) {
        return this.profiles.reserve(async () => {
            if (!object(input?.project)) fail('Invalid assistant project');
            const proposed = input.project;
            const { state: profiles } = await this.profiles.state();
            const cwd = this.store.resolveProject(proposed.cwd);
            return this.mutate(input.expectedRevision, state => {
                const index = proposed.id === undefined ? -1 : state.projects.findIndex(p => p.id === proposed.id);
                if (proposed.id !== undefined && (typeof proposed.id !== 'string' || !UUID.test(proposed.id) || index < 0)) fail('Assistant project not found');
                const previous = state.projects[index];
                if (previous && previous.cwd !== cwd) fail('Assistant project cwd cannot change');
                const now = new Date().toISOString();
                const record = { ...previous, id: previous?.id || randomUUID(), name: proposed.name, cwd,
                    description: proposed.description, instructions: proposed.instructions, profileIds: proposed.profileIds,
                    archived: proposed.archived, createdAt: previous?.createdAt || now, updatedAt: now };
                if (!validRecord(record)) fail('Invalid assistant project');
                const newlyAssociated = record.profileIds.filter(id => !previous?.profileIds.includes(id));
                if (newlyAssociated.some(id => !profiles.profiles.some(p => p.id === id && p.enabled))) fail('Profile is not available');
                if (index < 0) state.projects.push(record); else state.projects[index] = record;
                return { ok: true, project: record, requiresReload: true };
            });
        });
    }

    describe(manager, cwd, state) {
        const binding = readProjectBinding(manager);
        if (!binding || binding.cwd !== cwd) return null;
        const project = state.projects.find(record => record.id === binding.projectId && record.cwd === cwd);
        return { id: binding.projectId, name: project?.name || '', cwd, available: Boolean(project) };
    }

    async createSession(cwdInput, name, options) {
        return this.profiles.reserve(async () => {
            const cwd = this.store.resolveProject(cwdInput);
            const { assistantProjectId, agentProfileId } = options;
            if (typeof assistantProjectId !== 'string' || !UUID.test(assistantProjectId)
                || typeof agentProfileId !== 'string' || !UUID.test(agentProfileId)) fail('Assistant project requires an explicit profile');
            const project = (await this.state()).state.projects.find(p => p.id === assistantProjectId);
            if (!project || project.archived || project.cwd !== cwd || !project.profileIds.includes(agentProfileId)) fail('Assistant project is not available');
            await this.profiles.select(cwd, agentProfileId);
            return this.store.createSession(cwd, name, options);
        });
    }

    async sessions(id, profileId) {
        if (typeof id !== 'string' || !UUID.test(id)) fail('Invalid assistant project ID');
        if (typeof profileId !== 'string' || !UUID.test(profileId)) fail('Profile ID is required');
        const project = (await this.state()).state.projects.find(p => p.id === id);
        if (!project) fail('Assistant project not found', 404);
        return (await this.store.listSessions(project.cwd)).filter(session => session.assistantProject?.id === id
            && session.agentProfile?.id === profileId);
    }

    async context(manager, cwd) {
        const binding = readProjectBinding(manager), profileBinding = readProfileBinding(manager);
        if (!binding || binding.cwd !== cwd || !manager.getSessionFile() || !profileBinding?.profileId) return null;
        const { state: profileState } = await this.profiles.state();
        if (!profileState.profiles.some(profile => profile.id === profileBinding.profileId && profile.enabled)) return null;
        const { state } = await this.state();
        const record = state.projects.find(p => p.id === binding.projectId && p.cwd === cwd);
        if (!record) return null;
        return { version: 1, projectId: record.id, sessionId: binding.sessionId, cwd,
            sessionPath: fs.realpathSync.native(manager.getSessionFile()), instructions: record.instructions,
            revision: projectRevision(record) };
    }
}

module.exports = { PiAssistantProjectRegistry, readProjectRegistry, projectRevision };
