const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { safeFile } = require('./pi-native-service');
const { openReadSync } = require('./pi-file-io');
const { replaceFileSync } = require('./pi-win32-native');
const privateFiles = require('./pi-private-files');
const { readProfileBinding } = require('./pi-profile-state');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-f0-9-]{36}$/;
const MAX_REGISTRY = 2 * 1024 * 1024;

function readRegistry(file) {
    let fd;
    try {
        fd = openReadSync(file);
        const stats = fs.fstatSync(fd);
        if (!stats.isFile() || stats.size > MAX_REGISTRY) throw fail('Profile registry is too large');
        const bytes = Buffer.alloc(stats.size + 1);
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stats.size) throw fail('Profile registry changed during read', 409);
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, stats.size));
        const state = JSON.parse(raw);
        if (!object(state) || state.version !== 1 || !Array.isArray(state.profiles) || state.profiles.length > 50
            || !object(state.defaults) || new Set(state.profiles.map(p => p?.id)).size !== state.profiles.length
            || state.profiles.some(p => !object(p) || !ID.test(p.id)
                || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80
                || typeof p.description !== 'string' || p.description.length > 500
                || typeof p.soul !== 'string' || Buffer.byteLength(p.soul, 'utf8') > 32 * 1024
                || typeof p.enabled !== 'boolean' || !object(p.memory) || !object(p.skills)
                || typeof p.memory.enabled !== 'boolean' || typeof p.memory.autoLearn !== 'boolean'
                || typeof p.skills.learnedEnabled !== 'boolean')) throw fail('Profile registry is invalid');
        return { raw, state };
    } catch (error) {
        if (error.code === 'ENOENT') return { raw: null, state: { version: 1, profiles: [], defaults: {} } };
        if (error instanceof SyntaxError) throw fail('Profile registry contains invalid JSON');
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateProfile(input, previous) {
    const memory = input?.memory ?? previous?.memory ?? {};
    const skills = input?.skills ?? previous?.skills ?? {};
    if (!object(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80
        || typeof input.description !== 'string' || input.description.length > 500
        || typeof input.soul !== 'string' || Buffer.byteLength(input.soul, 'utf8') > 32 * 1024
        || typeof input.enabled !== 'boolean' || !object(memory) || !object(skills)
        || memory.enabled !== undefined && typeof memory.enabled !== 'boolean'
        || memory.autoLearn !== undefined && typeof memory.autoLearn !== 'boolean'
        || skills.learnedEnabled !== undefined && typeof skills.learnedEnabled !== 'boolean'
        || input.id !== undefined && (typeof input.id !== 'string' || !ID.test(input.id))) throw fail('Invalid profile');
    return { name: input.name.trim(), description: input.description, soul: input.soul, enabled: input.enabled,
        memory: { enabled: memory.enabled ?? false, autoLearn: memory.autoLearn ?? false },
        skills: { learnedEnabled: skills.learnedEnabled ?? true } };
}

class PiProfileRegistry {
    constructor(store) { this.store = store; }

    async paths(create = false) {
        const { getAgentDir } = await getSdk();
        const agentDir = getAgentDir();
        const file = safeFile(agentDir, ['pivane-profiles', 'profiles.json'], create);
        const root = path.dirname(file);
        if (create) { privateFiles.privateDirectory(root); if (process.platform !== 'win32') fs.chmodSync(root, 0o700); }
        return { agentDir, root, file };
    }

    revision(raw) { return createHash('sha256').update(raw ?? '').digest('hex'); }

    async state() {
        const { file } = await this.paths();
        const data = readRegistry(file);
        return { ...data, revision: this.revision(data.raw) };
    }

    async list(cwdInput) {
        const cwd = cwdInput === undefined ? null : this.store.resolveProject(cwdInput);
        const { state, revision } = await this.state();
        return { version: 1, revision, profiles: state.profiles, cwd, defaultProfileId: cwd ? state.defaults[cwd] ?? null : null };
    }

    // Synchronous from revision comparison through replacement. The lock also
    // rejects another Pivane process using this native identity.
    async mutate(expectedRevision, update) {
        if (typeof expectedRevision !== 'string') throw fail('Expected revision is required');
        const { file, root } = await this.paths(true);
        const lock = path.join(root, 'profiles.lock');
        try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw fail('Profiles are being saved', 409); }
        try {
            const { state, raw } = readRegistry(file);
            if (this.revision(raw) !== expectedRevision) throw fail('Profiles changed; reload before saving', 409);
            const result = update(state);
            const text = JSON.stringify(state, null, 2) + '\n';
            if (Buffer.byteLength(text) > MAX_REGISTRY) throw fail('Profile registry is too large');
            const tmp = `${file}.${randomUUID()}.tmp`;
            try {
                privateFiles.writePrivateFileSync(tmp, text, true);
                if (readRegistry(file).raw !== raw) throw fail('Profiles changed during save', 409);
                replaceFileSync(tmp, file);
                privateFiles.privateFileMode(file);
            } finally { try { fs.unlinkSync(tmp); } catch {} }
            return { ...result, revision: this.revision(text) };
        } finally { fs.rmdirSync(lock); }
    }

    async save(input) {
        if (!object(input?.profile)) throw fail('Invalid profile');
        const existingId = input.profile.id;
        return this.mutate(input.expectedRevision, state => {
            const index = existingId === undefined ? -1 : state.profiles.findIndex(p => p.id === existingId);
            const previous = state.profiles[index];
            const profile = validateProfile(input.profile, previous);
            if (existingId !== undefined && index < 0) throw fail('Profile not found');
            if (index < 0 && state.profiles.length >= 50) throw fail('Profile limit reached');
            const now = new Date().toISOString();
            const record = { ...previous, ...profile, id: previous?.id || randomUUID(),
                createdAt: previous?.createdAt || now, updatedAt: now };
            if (index < 0) state.profiles.push(record); else state.profiles[index] = record;
            return { ok: true, profile: record, requiresReload: true };
        });
    }

    async saveDefault(input) {
        const cwd = this.store.resolveProject(input?.cwd);
        if (input.profileId !== null && (typeof input.profileId !== 'string' || !ID.test(input.profileId))) throw fail('Invalid profile ID');
        return this.mutate(input.expectedRevision, state => {
            if (input.profileId !== null && !state.profiles.some(p => p.id === input.profileId && p.enabled)) throw fail('Profile is not available');
            if (input.profileId === null) delete state.defaults[cwd]; else state.defaults[cwd] = input.profileId;
            return { ok: true, cwd, defaultProfileId: input.profileId };
        });
    }

    async select(cwd, requested) {
        if (requested !== undefined && requested !== null && (typeof requested !== 'string' || !ID.test(requested))) throw fail('Invalid profile ID');
        const { state } = await this.state();
        const id = requested === undefined ? state.defaults[cwd] ?? null : requested;
        if (id !== null && !state.profiles.some(p => p.id === id && p.enabled)) throw fail('Profile is not available');
        return id;
    }

    async describe(manager, knownState) {
        const binding = readProfileBinding(manager);
        if (!binding?.profileId) return null;
        const state = knownState ?? (await this.state()).state;
        const profile = state.profiles.find(p => p.id === binding.profileId);
        return { id: binding.profileId, name: profile?.name || '', enabled: Boolean(profile?.enabled), available: Boolean(profile?.enabled) };
    }

    async context(manager, cwd) {
        const binding = readProfileBinding(manager);
        if (!binding?.profileId || manager.getCwd() !== cwd || !manager.getSessionFile()) return null;
        const { state } = await this.state();
        const profile = state.profiles.find(p => p.id === binding.profileId && p.enabled);
        if (!profile) return null;
        const { root, agentDir } = await this.paths(true);
        const profileRoot = path.join(root, 'data', profile.id);
        safeFile(agentDir, ['pivane-profiles', 'data', profile.id, '.profile-root'], true);
        privateFiles.privateDirectory(profileRoot);
        if (process.platform !== 'win32') fs.chmodSync(profileRoot, 0o700);
        return { version: 1, profileId: profile.id, sessionId: binding.sessionId, cwd,
            profileRoot, sessionsRoot: path.join(fs.realpathSync.native(agentDir), 'sessions'),
            memory: { enabled: profile.memory.enabled, autoLearn: profile.memory.autoLearn },
            skills: { learnedEnabled: profile.skills.learnedEnabled } };
    }
}

module.exports = { PiProfileRegistry, readRegistry };
