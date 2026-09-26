'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const scope = require('./scope');
const { safeFile, safeDir, projectRoots, listMemories, listSkills, listExtendedMemories, profileMemoryCapability } = require('./management');
const { createMutationLock } = require('./mutation-lock');
const { documentIndex, pendingDocumentIndex, documentIndexSynced } = require('./document-index');
const { location, publish } = require('../pi-profile-documents');
const privateFiles = require('../pi-private-files');
const { replaceFileSync } = require('../pi-win32-native');
const { normalizedMemory } = require('../pi-profile-registry');

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ID = /^[a-f0-9-]{36}$/;
const HEX = /^[a-f0-9]{64}$/;
const REQUEST = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const CATEGORY = new Set(['fact', 'preference', 'correction', 'failure', 'procedure']);
const OPERATIONS = new Set(['create', 'update', 'delete', 'restore', 'enable', 'disable', 'undo']);
const MAX_LEDGER = 8 * 1024 * 1024;
const MAX_CONTENT = 65536;
// Version 2 journal bounds: the active receipt window is small and old receipts
// are compacted to digests, while request and tombstone identities stay valid
// far beyond the window so replay and anti-revival guarantees outlive it.
const RECEIPTS_WINDOW = 200;
const ARCHIVE_KEEP = 4000;
const REQUESTS_ACTIVE = 2048;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_KEEP = 320;
// Room left in the ledger budget for the pending file's next document and receipt.
const HISTORY_HEADROOM = 1024 * 1024;
const MAX_RECORDS = 16384;
const MAX_TOMBSTONES = 32768;
const MAX_SPENT = 32768;
const ledgerFile = root => path.join(root, '.pivane-knowledge.json');
const pendingFile = root => path.join(root, '.pivane-knowledge.pending');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

function readJson(file, empty, versions = [1]) {
    const data = safeFile(file, MAX_LEDGER);
    if (!data) return empty;
    if (Buffer.byteLength(data.text) > MAX_LEDGER) throw fail('Knowledge metadata exceeds safety budget', 409);
    let parsed;
    try { parsed = JSON.parse(data.text); } catch { throw fail('Invalid knowledge metadata', 409); }
    if (!versions.includes(parsed?.version)) throw fail('Unsupported knowledge metadata', 409);
    return parsed;
}
// Version 1 stays readable and is upgraded in memory; the first write persists
// version 2 atomically. Sequence starts at the old receipt count so existing
// client revisions keep matching until the next mutation.
function migrateLedger(value) {
    const receipts = Array.isArray(value.receipts) ? value.receipts : [];
    const requests = {};
    for (const row of receipts) {
        if (row?.requestId && typeof row.id === 'string' && !requests[row.requestId])
            requests[row.requestId] = { h: row.inputHash || '', r: row.id, at: row.at || new Date(0).toISOString(), s: false };
    }
    return { version: 2, sequence: receipts.length, records: value.records || {}, receipts,
        archive: [], requests, tombstones: Object.keys(value.tombstones || {}), spent: [] };
}
const normalizeLedger = value => value.version === 1 ? migrateLedger(value) : value;
function ledger(root) {
    const raw = readJson(ledgerFile(root), { version: 1, records: {}, receipts: [], tombstones: {} }, [1, 2]);
    if (raw.version === 1 && (!raw.records || typeof raw.records !== 'object' || !raw.tombstones
        || typeof raw.tombstones !== 'object' || Array.isArray(raw.tombstones) || !Array.isArray(raw.receipts)))
        throw fail('Invalid knowledge metadata', 409);
    const value = normalizeLedger(raw);
    if (!value.records || !Array.isArray(value.receipts) || !Array.isArray(value.archive) || !value.requests
        || !Array.isArray(value.tombstones) || !Array.isArray(value.spent) || !Number.isSafeInteger(value.sequence)
        || value.receipts.length > RECEIPTS_WINDOW || value.archive.length > ARCHIVE_KEEP
        || Object.keys(value.records).length > MAX_RECORDS || Object.keys(value.requests).length > REQUESTS_ACTIVE
        || value.tombstones.length > MAX_TOMBSTONES || value.spent.length > MAX_SPENT)
        throw fail('Invalid knowledge metadata', 409);
    return value;
}
function save(file, value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_LEDGER) throw fail('Knowledge metadata exceeds safety budget', 409);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        privateFiles.writePrivateFileSync(tmp, text, true);
        replaceFileSync(tmp, file);
        privateFiles.privateFileMode(file);
        if (process.platform !== 'win32') {
            const fd = fs.openSync(path.dirname(file), 'r');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
    } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function remove(file) {
    fs.unlinkSync(file);
    if (process.platform !== 'win32') {
        const fd = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
}
function verifiedRoot(root) {
    if (!path.isAbsolute(root) || !safeDir(root) || path.resolve(root) !== root) throw fail('Unsafe profile root', 409);
    return root;
}
function projectDir(root, item) {
    if (item.scope !== 'project' || !HEX.test(item.projectKey)) throw fail('Project requires verified cwd', 409);
    return path.join(root, 'projects', item.projectKey);
}
function fileFor(root, item) {
    if (item.kind === 'memory') {
        if (item.scope === 'project' && item.target === 'project') return path.join(projectDir(root, item), 'MEMORY.md');
        if (item.scope !== 'profile' || !['memory', 'user'].includes(item.target)) throw fail('Legacy memory is read-only', 409);
        return path.join(root, item.target === 'user' ? 'USER.md' : 'MEMORY.md');
    }
    if (!NAME.test(item.name)) throw fail('Invalid skill name', 409);
    return path.join(item.scope === 'project' ? projectDir(root, item) : root, 'skills', item.name, 'SKILL.md');
}
function skillPath(root, item) {
    const file = fileFor(root, item), dir = path.dirname(path.dirname(file));
    if (safeDir(dir) && !safeDir(path.dirname(file)) && fs.existsSync(path.dirname(file))) throw fail('Unsafe skill directory', 409);
    return file;
}
function skillContent(name, description, content) {
    if (typeof description !== 'string' || description.length > 1000 || /[\r\n\0]/.test(description)) throw fail('Invalid skill description');
    if (typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT || /\0|\r/.test(content)) throw fail('Invalid skill content');
    const header = `---\nname: ${name}\ndescription: ${description}\n---\n`;
    const result = content.startsWith('---\n') ? content : `${header}${content.trim()}\n`;
    if (!result.startsWith(header) || Buffer.byteLength(result) > MAX_CONTENT) throw fail('Skill frontmatter must match name and description');
    return result;
}
function checkedInput(input, trusted = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || !keys(input, ['requestId', 'expectedRevision', 'operation', 'kind', 'itemId', 'itemRevision', 'receiptId', 'content', 'name', 'description', 'category', 'scope', 'projectKey', 'source', 'target', 'state']))
        throw fail('Invalid knowledge mutation');
    if (!REQUEST.test(input.requestId) || typeof input.expectedRevision !== 'string' || !HEX.test(input.expectedRevision)
        || !OPERATIONS.has(input.operation) || !['memory', 'skill'].includes(input.kind)) throw fail('Invalid knowledge mutation');
    const op = input.operation;
    if (op === 'create' ? own(input, 'itemId') || own(input, 'itemRevision') || own(input, 'receiptId')
        : op === 'undo' ? !REQUEST.test(input.receiptId) || own(input, 'itemId') || own(input, 'itemRevision')
            : !HEX.test(input.itemId) || !HEX.test(input.itemRevision) || own(input, 'receiptId')) throw fail('Invalid mutation identity');
    if (own(input, 'source') && !trusted) throw fail('Unverified source is not accepted');
    if (!trusted && (input.scope !== undefined && input.scope !== 'profile' || own(input, 'projectKey'))) throw fail('Project writes require verified cwd');
    if (trusted && (input.scope === 'project' ? !HEX.test(input.projectKey) : own(input, 'projectKey') || input.scope !== undefined && input.scope !== 'profile')) throw fail('Invalid project scope');
    if (op === 'create' || op === 'update') {
        if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > MAX_CONTENT || /\0|\r|\n§\n/.test(input.content))
            throw fail('Invalid knowledge content');
        if (input.kind === 'memory') {
            if (!CATEGORY.has(input.category) || input.name !== undefined || input.description !== undefined
                || input.target !== undefined && !['memory', 'user', 'project'].includes(input.target)
                || input.target === 'project' && input.scope !== 'project'
                || input.scope === 'project' && input.target !== undefined && input.target !== 'project') throw fail('Invalid memory fields');
        } else if (!NAME.test(input.name) || input.target !== undefined || input.category !== undefined)
            throw fail('Invalid skill fields');
    } else if (['content', 'name', 'description', 'category', 'target'].some(key => own(input, key))) throw fail('Unexpected mutation fields');
    if (input.state !== undefined && (!trusted || op !== 'create' || input.kind !== 'skill' || input.state !== 'draft'))
        throw fail('Only verified native proposals can create a skill draft');
    if (input.kind === 'memory' && ['enable', 'disable'].includes(op)) throw fail('Memory cannot be enabled or disabled');
    return input;
}
function physical(root, data, bundle) {
    const projects = projectRoots(root);
    const memories = listMemories(root, projects).items.map(item => ({ ...item,
        scope: item.target === 'project' ? 'project' : 'profile', revision: hash(item.content), state: 'active',
        category: item.target === 'failure' ? 'failure' : 'fact',
        ...(item.target === 'failure' || item.content.length > MAX_CONTENT ? { readOnly: true } : {}) }));
    const extended = listExtendedMemories(root, bundle);
    if (!extended) throw fail('Extended memory reader unavailable', 409);
    const documentKeys = new Set(memories.map(item => JSON.stringify([item.target, item.projectKey || null, item.content])));
    // A SQLite row has its own identity even when its content mirrors Markdown.
    const databaseItems = extended.items.map(item => ({ ...item, scope: item.projectKey ? 'project' : 'profile',
        revision: hash(JSON.stringify([item.target, item.projectKey || null, item.content, item.category || null])),
        state: 'active', category: item.category || (item.target === 'failure' ? 'failure' : 'fact'), readOnly: true,
        ...(documentKeys.has(JSON.stringify([item.target, item.projectKey || null, item.content])) ? { mirrored: true } : {}) }));
    const skills = listSkills(root, projects).items.map(item => {
        const { source, ...rest } = item;
        const file = safeFile(findSkillFile(root, projects, item.id));
        return { ...rest, revision: file?.revision, state: 'active',
            ...(file?.text.length > MAX_CONTENT ? { readOnly: true } : {}) };
    });
    const indexed = new Map([...memories, ...databaseItems, ...skills].map(item => [item.id, item]));
    for (const [id, record] of Object.entries(data.records)) {
        if (!HEX.test(id) || !['memory', 'skill'].includes(record.kind)) throw fail('Invalid knowledge record', 409);
        if (record.state === 'active') {
            const candidates = [...indexed.values()].filter(item => !item.readOnly && item.kind === record.kind && item.scope === record.scope
                && item.projectKey === record.projectKey
                && (item.kind === 'skill' ? item.name === record.name : item.target === record.target && item.content === record.content));
            if (candidates.length !== 1 || candidates[0].revision !== record.revision) throw fail('Managed knowledge changed outside the service', 409);
            indexed.delete(candidates[0].id);
            indexed.set(id, { ...candidates[0], ...publicRecord(record) });
        } else {
            if ([...indexed.values()].some(item => !item.readOnly && item.kind === record.kind && item.scope === record.scope
                && item.projectKey === record.projectKey
                && (item.kind === 'skill' ? item.name === record.name : item.target === record.target && item.content === record.content)))
                throw fail('Deleted knowledge reappeared outside the service', 409);
            indexed.set(id, publicRecord(record));
        }
    }
    return [...indexed.values()];
}
function findSkillFile(root, projects, id) {
    for (const dir of [path.join(root, 'skills'), ...projects.map(p => path.join(p, 'skills'))]) {
        if (!safeDir(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const folder = path.join(dir, entry.name);
            if (hash(path.join(folder, 'SKILL.md')) === id && safeDir(folder)) return path.join(folder, 'SKILL.md');
        }
    }
    throw fail('Skill disappeared during read', 409);
}
function publicRecord(record) {
    const { history, target, ...rest } = record;
    return { ...rest, ...(target ? { target } : {}) };
}
// The monotonic sequence keeps revisions stable while receipts rotate through
// the active window and the archive.
function revision(root, generation, data, items) {
    return hash(JSON.stringify([generation, data.sequence, items.map(item => [item.id, item.revision, item.state]).sort()]));
}
// Global document usage, measured like the write-time limit check (chunks joined by the separator).
function memoryUsage(root, memory) {
    const limits = normalizedMemory(memory);
    const chars = name => (safeDir(root) && safeFile(path.join(root, name))?.text || '').length;
    const failures = safeDir(root) ? safeFile(path.join(root, 'failures.md')) : null;
    return { memory: { chars: chars('MEMORY.md'), limit: limits.memoryCharLimit },
        user: { chars: chars('USER.md'), limit: limits.userCharLimit },
        ...(failures ? { failure: { chars: failures.text.length, readOnly: true } } : {}) };
}
const ORIGINS = new Set(['agent', 'learning']);
const LEARNING_REASONS = new Set(['correction', 'review', 'extraction', 'manual']);
function nativeOrigin(options) {
    if (options === undefined) return { origin: 'agent' };
    if (!options || typeof options !== 'object' || Array.isArray(options) || !keys(options, ['origin', 'reason']))
        throw fail('Invalid mutation origin');
    const origin = options.origin === undefined ? 'agent' : options.origin;
    if (!ORIGINS.has(origin) || options.reason !== undefined && (origin !== 'learning' || !LEARNING_REASONS.has(options.reason)))
        throw fail('Invalid mutation origin');
    return { origin, ...(options.reason !== undefined ? { reason: options.reason } : {}) };
}
function publicReceipt(value) {
    if (!value) return value;
    const { inputHash, ...rest } = value;
    return rest;
}
// A receipt is superseded once a later receipt (from any origin, e.g. a manual undo or
// delete) changed the same item; chat hints for it are then no longer actionable.
function recent(data, sessionId) {
    const latest = new Map();
    for (const row of data.receipts) if (row.itemId) latest.set(row.itemId, row.id);
    return data.receipts.filter(receipt => !sessionId || receipt.source?.sessionId === sessionId).slice(-30).reverse()
        .map(row => ({ ...publicReceipt(row), ...(row.itemId && latest.get(row.itemId) !== row.id ? { superseded: true } : {}) }));
}
// Receipt preview: the memory body after the change (the removed body on delete),
// or the skill name with the start of its description.
function receiptPreview(after) {
    if (after.kind === 'memory') return String(after.content || '').slice(0, 160);
    return after.description ? `${after.name} \u2014 ${after.description.slice(0, 120)}` : after.name;
}
function receipt(input, id, before, after, indexStatus, provenance, status = 'saved') {
    return { id: randomUUID(), requestId: input.requestId, operation: input.operation, kind: input.kind,
        itemId: id, status, at: new Date().toISOString(), summary: `${input.operation} ${input.kind}`,
        origin: provenance.origin, ...(provenance.reason ? { learningReason: provenance.reason } : {}),
        preview: receiptPreview(after), ...(after.kind === 'memory' && after.category ? { category: after.category } : {}),
        scope: after.scope, ...(after.projectKey ? { projectKey: after.projectKey } : {}),
        ...(input.source ? { source: input.source } : {}), ...(before ? { beforeRevision: before.revision } : {}),
        ...(after ? { afterRevision: after.revision } : {}), indexStatus,
        activation: after.state === 'draft' ? 'unknown' : input.kind === 'skill' ? 'reload-required' : 'next-turn', undoable: status === 'saved' };
}
const expiredRequest = entry => Date.now() - Date.parse(entry.at) > REQUEST_TTL_MS;
function replayReceipt(data, requestId, entry) {
    return data.receipts.find(row => row.id === entry.r) || data.archive.find(row => row.id === entry.r)
        || { id: entry.r, requestId, status: 'saved', at: entry.at, undoable: false };
}
function addSpent(data, requestId) {
    const value = hash(requestId);
    if (data.spent.includes(value)) return;
    if (data.spent.length >= MAX_SPENT) throw fail('Request expiry journal is full; reviewed migration required before writing', 409);
    data.spent.push(value);
}
function expireRequests(data) {
    for (const [requestId, entry] of Object.entries(data.requests)) {
        if (!entry.s && expiredRequest(entry)) {
            addSpent(data, requestId);
            delete data.requests[requestId];
        }
    }
}
function append(data, item, result, server) {
    if (item) {
        if (Array.isArray(item.history) && item.history.length > HISTORY_KEEP)
            item = { ...item, history: item.history.slice(-HISTORY_KEEP) };
        data.records[item.id] = item;
    }
    data.sequence++;
    data.receipts.push(result);
    while (data.receipts.length > RECEIPTS_WINDOW) {
        const dropped = data.receipts.shift();
        // Undo is only offered inside the active window, so its before-copy is no longer needed.
        dropHistory(data, dropped);
        // Archive digests keep identity and origin but not the preview text.
        data.archive.push({ id: dropped.id, requestId: dropped.requestId, operation: dropped.operation,
            kind: dropped.kind, itemId: dropped.itemId, status: dropped.status, at: dropped.at,
            ...(dropped.origin ? { origin: dropped.origin } : {}), undoable: false });
    }
    while (data.archive.length > ARCHIVE_KEEP) data.archive.shift();
    data.requests[result.requestId] = { h: result.inputHash, r: result.id, at: result.at, s: server };
    expireRequests(data);
    while (Object.keys(data.requests).length > REQUESTS_ACTIVE) {
        const evictable = Object.entries(data.requests).filter(([, entry]) => entry.s || expiredRequest(entry))
            .sort((left, right) => Date.parse(left[1].at) - Date.parse(right[1].at))[0];
        if (!evictable) break;
        // Server IDs are generated per call and never resubmitted by a client; only
        // client IDs need a permanent replay refusal after they leave the table.
        if (!evictable[1].s) addSpent(data, evictable[0]);
        delete data.requests[evictable[0]];
    }
    if (Object.keys(data.requests).length > REQUESTS_ACTIVE)
        throw fail('Knowledge request journal is full; reviewed migration required before writing', 409);
    fitHistoryBudget(data);
}
function dropHistory(data, receiptRow) {
    const history = data.records[receiptRow.itemId]?.history;
    if (!Array.isArray(history)) return 0;
    const index = history.findIndex(entry => entry.receiptId === receiptRow.id);
    if (index < 0) return 0;
    const [removed] = history.splice(index, 1);
    return Buffer.byteLength(JSON.stringify(removed));
}
// Before-copies may hold whole skill bodies. Keep the ledger (and the pending
// file, which also carries the next document) inside MAX_LEDGER by giving up the
// oldest undo copies first and saying so on their receipts.
function fitHistoryBudget(data) {
    const budget = MAX_LEDGER - HISTORY_HEADROOM;
    let size = Buffer.byteLength(JSON.stringify(data));
    for (const row of data.receipts) {
        if (size <= budget) break;
        if (!row.undoable) continue;
        size -= dropHistory(data, row);
        row.undoable = false;
    }
}
function copy(item) { return item ? { ...item, history: undefined } : null; }
function body(root, item) {
    if (item.state !== 'active') return item.content;
    if (item.kind === 'memory') return item.content;
    return safeFile(fileFor(root, item))?.text;
}
function addTombstone(data, value) {
    if (data.tombstones.includes(value)) return;
    if (data.tombstones.length >= MAX_TOMBSTONES) throw fail('Tombstone journal is full; reviewed migration required before writing', 409);
    data.tombstones.push(value);
}
function removeTombstone(data, value) {
    data.tombstones = data.tombstones.filter(entry => entry !== value);
}
function checkTombstone(data, content) {
    if (data.tombstones.includes(hash(content.trim()))) throw fail('Deleted or replaced memory cannot be relearned without explicit restore', 409);
}
function availableSkill(root, item) {
    const ownFile = skillPath(root, item);
    if (safeFile(ownFile) && hash(ownFile) !== item.id) throw fail('Profile skill name already exists', 409);
    const agent = path.dirname(path.dirname(path.dirname(root)));
    const installed = path.join(agent, 'skills', item.name);
    try { fs.lstatSync(installed); throw fail('Installed skill name is reserved', 409); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return ownFile;
}
function writeSkill(root, item, text, expected) {
    const file = availableSkill(root, item);
    const parent = path.dirname(file), skills = path.dirname(parent);
    privateFiles.privateDirectory(skills);
    if (!safeDir(skills)) throw fail('Unsafe skill root', 409);
    privateFiles.privateDirectory(parent);
    if (!safeDir(parent) || (safeFile(file)?.revision ?? null) !== expected) throw fail('Skill changed', 409);
    const tmp = path.join(parent, `.${randomUUID()}.tmp`);
    try {
        privateFiles.writePrivateFileSync(tmp, text, true);
        if ((safeFile(file)?.revision ?? null) !== expected || !safeDir(parent)) throw fail('Skill changed', 409);
        replaceFileSync(tmp, file);
        privateFiles.privateFileMode(file);
        if (safeFile(file)?.text !== text) throw fail('Skill publication uncertain', 503);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function removeSkill(root, item) {
    const file = fileFor(root, item);
    if (safeFile(file)?.revision !== item.revision) throw fail('Skill changed', 409);
    remove(file);
}

class ProfileKnowledgeService {
    constructor({ profiles, getAgentDir, bundlePath } = {}) {
        if (typeof profiles?.getProfile !== 'function' || typeof getAgentDir !== 'function') throw new TypeError('Expected profiles.getProfile and getAgentDir');
        this.profiles = profiles; this.getAgentDir = getAgentDir; this.bundlePath = bundlePath;
    }
    async context(profileId, writing = false) {
        if (!ID.test(profileId)) fail('Invalid profile id');
        const profile = await this.profiles.getProfile(profileId);
        if (!profile) return { profile: null };
        if (profile.id !== profileId) fail('Profile identity changed', 409);
        const agent = await this.getAgentDir();
        const root = location(agent, profileId, writing);
        if (fs.existsSync(root)) verifiedRoot(root);
        const bundle = await (typeof this.bundlePath === 'function' ? this.bundlePath() : this.bundlePath);
        return { profile, root, bundle, installed: profileMemoryCapability({ bundlePath: bundle }).installed };
    }
    async snapshot(profileId, options = {}) {
        if (!options || !keys(options, ['kind', 'query', 'offset', 'sessionId']) || options.kind !== undefined && !['memory', 'skill'].includes(options.kind)
            || options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 200)
            || options.sessionId !== undefined && (typeof options.sessionId !== 'string' || options.sessionId.length > 200)
            || options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > 100000)) fail('Invalid knowledge query');
        const ctx = await this.context(profileId);
        const base = { version: 1, profileId, status: 'missing', revision: null, items: [], receipts: [], hasMore: false,
            capabilities: { memory: false, skill: false, projectWrites: false, nativeProjectWrites: false,
                installedSkillsWrite: false, operations: [], skillNameMaxLength: 64, maxContentLength: MAX_CONTENT } };
        if (!ctx.profile) return base;
        if (!ctx.profile.enabled) return { ...base, status: 'disabled' };
        const capabilities = { memory: Boolean(ctx.installed && ctx.profile.memory?.enabled),
            skill: Boolean(ctx.profile.skills?.learnedEnabled), projectWrites: false,
            nativeProjectWrites: Boolean(ctx.installed && ctx.profile.memory?.enabled || ctx.profile.skills?.learnedEnabled), installedSkillsWrite: false,
            operations: ctx.installed && ctx.profile.memory?.enabled || ctx.profile.skills?.learnedEnabled
                ? [...OPERATIONS] : [], skillNameMaxLength: 64, maxContentLength: MAX_CONTENT };
        if (!fs.existsSync(ctx.root)) return { ...base, status: 'ready', revision: hash(JSON.stringify([0, 0, []])), capabilities,
            ...(capabilities.memory ? { usage: memoryUsage(ctx.root, ctx.profile.memory) } : {}) };
        if (!ctx.installed && fs.existsSync(path.join(ctx.root, 'sessions.db')))
            return { ...base, status: 'unsupported', capabilities };
        return createMutationLock(ctx.root).inspect(async generation => {
            const data = ledger(ctx.root);
            if (safeFile(pendingFile(ctx.root), MAX_LEDGER)) return { ...base, status: 'pending', receipts: recent(data, options.sessionId) };
            const items = physical(ctx.root, data, ctx.bundle);
            const query = (options.query || '').toLocaleLowerCase();
            // A search-index row that mirrors a listed Markdown entry is not a second memory; it
            // stays in the revision and remains readable by ID, but is not listed twice.
            const matches = items.filter(item => !item.mirrored && (!options.kind || item.kind === options.kind)
                && (!query || `${item.name || ''} ${item.content || ''} ${item.description || ''}`.toLocaleLowerCase().includes(query)));
            const offset = options.offset || 0;
            return { ...base, status: 'ready',
                revision: revision(ctx.root, generation, data, items), items: matches.slice(offset, offset + 50).map(item => {
                    const { content, ...listed } = item;
                    return item.kind === 'memory' ? { ...listed, content: content?.slice(0, 512) } : listed;
                }), receipts: recent(data, options.sessionId), hasMore: matches.length > offset + 50,
                ...(capabilities.memory ? { usage: memoryUsage(ctx.root, ctx.profile.memory) } : {}),
                capabilities: { ...capabilities, journal: { receipts: data.receipts.length, receiptsWindow: RECEIPTS_WINDOW,
                    archivedReceipts: data.archive.length, requests: Object.keys(data.requests).length,
                    requestsLimit: REQUESTS_ACTIVE, expiredRequests: data.spent.length,
                    tombstones: data.tombstones.length, tombstonesLimit: MAX_TOMBSTONES, requestValidityDays: 7 } } };
        });
    }
    async getItem(profileId, itemId) {
        if (!HEX.test(itemId)) fail('Invalid item id');
        const ctx = await this.context(profileId);
        if (!ctx.profile || !fs.existsSync(ctx.root)) return { version: 1, status: 'missing' };
        if (!ctx.profile.enabled) return { version: 1, status: 'disabled' };
        if (!ctx.installed && fs.existsSync(path.join(ctx.root, 'sessions.db')))
            return { version: 1, status: 'unsupported' };
        return createMutationLock(ctx.root).inspect(() => {
            if (safeFile(pendingFile(ctx.root), MAX_LEDGER)) return { version: 1, status: 'pending' };
            const item = physical(ctx.root, ledger(ctx.root), ctx.bundle).find(row => row.id === itemId);
            const content = item && body(ctx.root, item);
            return { version: 1, status: item ? 'ready' : 'missing', ...(item ? { item: {
                ...item, content: content?.slice(0, MAX_CONTENT),
                ...(content?.length > MAX_CONTENT ? { truncated: true, readOnly: true } : {}),
            } } : {}) };
        });
    }
    async mutate(profileId, raw) {
        return this.#mutateValidated(profileId, checkedInput(raw), undefined, undefined, { origin: 'manual' });
    }
    // Internal-only provenance. The HTTP route calls mutate(), which rejects source and projectKey.
    // The origin comes only from the server-side options argument, never from raw input.
    async mutateFromNative(profileId, raw, native, options) {
        const provenance = nativeOrigin(options);
        if (!native || !keys(native, ['sessionPath', 'sessionId', 'entryId', 'cwd'])
            || !['sessionPath', 'sessionId', 'entryId', 'cwd'].every(key => typeof native[key] === 'string'
                && native[key].length > 0 && native[key].length <= (key === 'cwd' || key === 'sessionPath' ? 4096 : 200)))
            throw fail('Invalid native source');
        const ctx = await this.context(profileId);
        if (!ctx.profile) throw fail('Profile not found', 404);
        const agent = await this.getAgentDir();
        // Streaming source proof: header, unique current-ID binding and the claimed
        // entry on the current leaf branch, rechecked immediately before publication.
        const context = { sessionsRoot: path.join(agent, 'sessions'), profileId,
            sessionId: native.sessionId, cwd: native.cwd };
        const verify = () => {
            let proof;
            try { proof = scope.sourceProof(native.sessionPath, context, native.entryId); }
            catch (error) {
                if (error?.code === 'SOURCE_PROOF_LIMIT') fail(error.message, 413);
                throw error;
            }
            if (!proof) fail('Native source changed or is not bound to this profile', 409);
        };
        verify();
        const projectKey = hash(native.cwd);
        if (raw?.scope === 'project' && (raw.projectKey !== undefined && raw.projectKey !== projectKey))
            throw fail('Project key does not match native cwd', 409);
        const input = checkedInput({ ...raw, ...(raw.scope === 'project' ? { projectKey } : {}),
            source: { sessionId: native.sessionId, entryId: native.entryId } }, true);
        return this.#mutateValidated(profileId, input, verify, native.cwd, provenance);
    }
    async #mutateValidated(profileId, input, verifySource, projectCwd, provenance) {
        const ctx = await this.context(profileId, true);
        if (!ctx.profile) fail('Profile not found', 404);
        if (!ctx.profile.enabled || input.kind === 'memory' && (!ctx.profile.memory?.enabled || !ctx.installed)
            || input.kind === 'skill' && !ctx.profile.skills?.learnedEnabled) fail('Knowledge is disabled or unavailable', 409);
        const work = async () => {
            const lock = createMutationLock(ctx.root);
            const result = await lock.transact(undefined, async (generation, reserve) => {
                const data = ledger(ctx.root);
                const pending = readJson(pendingFile(ctx.root), null);
                let unpublishedRetry = false;
                if (pending) {
                    if (pending.requestId !== input.requestId || pending.receipt?.inputHash !== hash(JSON.stringify(input)))
                        fail('Knowledge publication needs repair', 409);
                    if (!['memory', 'skill'].includes(pending.kind) || !pending.nextLedger?.records
                        || !pending.receipt || !HEX.test(pending.after || '') && pending.after !== null)
                        fail('Invalid pending publication', 409);
                    const nextItem = pending.nextLedger.records[pending.receipt.itemId];
                    if (!nextItem || nextItem.kind !== pending.kind || nextItem.projectKey !== pending.projectKey
                        || pending.kind === 'memory' && (!['memory', 'user', 'project'].includes(pending.target)
                            || typeof pending.next !== 'string' || hash(pending.next) !== pending.after))
                        fail('Invalid pending publication', 409);
                    const file = fileFor(ctx.root, nextItem);
                    const current = safeFile(file);
                    if ((current?.revision ?? null) === pending.after) {
                        if (pending.kind === 'memory') {
                            const dir = path.dirname(file);
                            const index = await documentIndex(dir, pending.target === 'project' ? 'memory' : pending.target,
                                ctx.bundle, current, pending.next, { databaseRoot: ctx.root, project: pending.projectCwd || null });
                            try { index.sync(); } finally { index.close(); }
                        }
                        await reserve();
                        save(ledgerFile(ctx.root), normalizeLedger(pending.nextLedger));
                        remove(pendingFile(ctx.root));
                        return { replay: pending.receipt };
                    }
                    if ((current?.revision ?? null) !== pending.before) fail('Knowledge publication changed unexpectedly', 409);
                    if (pending.kind === 'memory') {
                        const dir = path.dirname(file);
                        const index = await documentIndex(dir, pending.target === 'project' ? 'memory' : pending.target,
                            ctx.bundle, current, pending.next, { databaseRoot: ctx.root, project: pending.projectCwd || null });
                        index.close();
                    }
                    remove(pendingFile(ctx.root));
                    unpublishedRetry = true;
                }
                const inputHash = hash(JSON.stringify(input));
                const existing = data.requests[input.requestId];
                if (existing) {
                    // Client request IDs have an explicit validity window; after it
                    // passes the ID is rejected as expired and never re-executed.
                    if (!existing.s && expiredRequest(existing)) {
                        addSpent(data, input.requestId);
                        delete data.requests[input.requestId];
                        fail('Request ID expired; re-execution is not allowed', 409);
                    }
                    if (existing.h !== inputHash) fail('Request ID already used', 409);
                    return { replay: replayReceipt(data, input.requestId, existing) };
                }
                if (data.spent.includes(hash(input.requestId))) fail('Request ID expired; re-execution is not allowed', 409);
                if (safeFile(pendingFile(ctx.root), MAX_LEDGER)) fail('Knowledge publication needs repair', 409);
                const items = physical(ctx.root, data, ctx.bundle);
                if (!unpublishedRetry && revision(ctx.root, generation, data, items) !== input.expectedRevision) fail('Knowledge revision changed', 409);
                const original = input.operation === 'undo'
                    ? data.receipts.find(row => row.id === input.receiptId && row.kind === input.kind)
                    : null;
                if (input.operation === 'undo' && (!original || !original.undoable)) fail('Receipt is not undoable', 409);
                let before = (input.operation === 'create' ? null : items.find(item => item.id === (original?.itemId || input.itemId)));
                if (before?.kind === 'skill' && before.state === 'active') before = { ...before, content: body(ctx.root, before) };
                if (input.operation !== 'create' && (!before || before.kind !== input.kind || before.readOnly
                    || input.operation !== 'undo' && before.revision !== input.itemRevision)) fail('Item revision changed or is read-only', 409);
                if (before?.scope === 'project' && (!verifySource || before.projectKey !== input.projectKey)) fail('Project writes require verified cwd', 409);
                if (input.operation === 'undo' && before.revision !== original.afterRevision) fail('Undo target changed', 409);
                if (input.operation === 'restore' && before.state !== 'deleted' || input.operation === 'enable' && !['disabled', 'draft'].includes(before.state)
                    || input.operation === 'disable' && before.state !== 'active'
                    || input.operation === 'delete' && before.state === 'deleted'
                    || input.operation === 'update' && before.state !== 'active') fail('Item state changed', 409);
                if (['enable', 'disable'].includes(input.operation) && input.kind !== 'skill') fail('Invalid operation');
                if (input.operation === 'undo' && !data.records[before.id]) fail('Legacy item has no undo history', 409);
                const target = input.kind === 'memory' ? (before?.target || input.target || (input.scope === 'project' ? 'project' : 'memory')) : undefined;
                if (input.kind === 'memory' && !['memory', 'user', 'project'].includes(target)
                    || target === 'project' && (!verifySource || input.scope !== 'project')) fail('Legacy memory is read-only', 409);
                let content, state, category, name, description;
                if (input.operation === 'undo') {
                    const historic = data.records[before.id]?.history?.find(row => row.receiptId === original.id);
                    if (!historic) fail('Undo history unavailable', 409);
                    ({ content, state, category, name, description } = historic.before || {
                        state: 'deleted', content: before.content, category: before.category,
                        name: before.name, description: before.description });
                } else {
                    content = ['create', 'update'].includes(input.operation) ? input.content.trim() : before?.content;
                    state = input.operation === 'delete' ? 'deleted' : input.operation === 'disable' ? 'disabled'
                        : input.operation === 'create' && input.state === 'draft' ? 'draft' : 'active';
                    category = input.category || before?.category;
                    name = input.name || before?.name;
                    description = input.description ?? before?.description;
                }
                if (input.kind === 'memory' && state === 'active' && !['restore', 'undo'].includes(input.operation)) checkTombstone(data, content);
                if (input.kind === 'skill' && state === 'active') {
                    content = ['create', 'update'].includes(input.operation) || before?.state === 'draft'
                        ? skillContent(name, description || '', content) : content;
                    if (typeof content !== 'string') fail('Skill history is unavailable', 409);
                }
                const itemScope = before?.scope || input.scope || 'profile';
                const projectKey = before?.projectKey || input.projectKey;
                const folder = itemScope === 'project' ? projectDir(ctx.root, { scope: itemScope, projectKey }) : ctx.root;
                if (itemScope === 'project') {
                    privateFiles.privateDirectory(path.dirname(folder));
                    privateFiles.privateDirectory(folder);
                    if (!safeDir(folder)) fail('Unsafe project directory', 409);
                }
                const id = before?.id || (input.kind === 'skill' ? hash(path.join(folder, 'skills', name, 'SKILL.md'))
                    : hash(`${path.join(folder, target === 'user' ? 'USER.md' : 'MEMORY.md')}\0${items.filter(row => !row.readOnly && row.kind === 'memory' && row.target === target && row.scope === itemScope && row.projectKey === projectKey && row.state === 'active').length}\0${content}`));
                if (!before && items.some(row => row.id === id || input.kind === 'memory' && row.kind === 'memory'
                    && row.state === 'active' && row.content === content && row.target === target
                    && row.scope === itemScope && row.projectKey === projectKey))
                    fail('Knowledge already exists', 409);
                if (input.kind === 'skill' && before && name !== before.name) fail('Skill name is immutable', 409);
                const after = { id, kind: input.kind, scope: itemScope, ...(projectKey ? { projectKey } : {}),
                    ...(target ? { target } : {}), ...(name ? { name } : {}),
                    ...(description !== undefined ? { description } : {}), ...(category ? { category } : {}),
                    ...(input.source ? { source: input.source } : {}), content,
                    revision: hash(`${state}\0${content || ''}`), state, updatedAt: new Date().toISOString() };
                if (input.kind === 'memory' && state === 'active') after.revision = hash(content);
                if (input.kind === 'skill' && state === 'active') after.revision = hash(content);
                if (input.kind === 'skill' && state === 'active') availableSkill(ctx.root, after);
                const history = [...(data.records[id]?.history || [])];
                const changed = { ...after, history };
                const record = { ...receipt(input, id, before, after, input.kind === 'memory' ? 'ready' : 'not-applicable', provenance),
                    inputHash: hash(JSON.stringify(input)) };
                history.push({ receiptId: record.id, before: copy(before) });
                if (input.kind === 'memory' && before?.content && (before.content !== content || state === 'deleted'))
                    addTombstone(data, hash(before.content));
                if (input.kind === 'memory' && state === 'active' && ['restore', 'undo'].includes(input.operation))
                    removeTombstone(data, hash(content));
                append(data, changed, record, Boolean(verifySource));
                if (input.kind === 'memory') {
                    const file = fileFor(ctx.root, after), dir = path.dirname(file);
                    if (itemScope === 'project') {
                        privateFiles.privateDirectory(path.dirname(dir));
                        privateFiles.privateDirectory(dir);
                        if (!safeDir(dir)) fail('Unsafe project directory', 409);
                    }
                    const previous = safeFile(file);
                    const chunks = previous?.text ? previous.text.split('\n§\n') : [];
                    if (before?.state === 'active') {
                        const index = chunks.findIndex(part => part.trim() === before.content);
                        if (index < 0 || chunks.filter(part => part.trim() === before.content).length !== 1) fail('Memory document changed', 409);
                        chunks.splice(index, 1);
                    }
                    if (state === 'active') chunks.push(content);
                    const next = chunks.join('\n§\n');
                    const limit = normalizedMemory(ctx.profile.memory)[target === 'user' ? 'userCharLimit' : 'memoryCharLimit'];
                    if (next.length > limit) throw Object.assign(new Error('Memory document limit exceeded'), { status: 409,
                        code: 'memory-full', details: { target, chars: (previous?.text || '').length, limit, needed: next.length } });
                    if (pendingDocumentIndex(dir, target === 'project' ? 'memory' : target)
                        || !await documentIndexSynced(dir, target === 'project' ? 'memory' : target, ctx.bundle,
                            previous?.text || '', { databaseRoot: ctx.root, project: itemScope === 'project' ? projectCwd : null }))
                        fail('Document index needs repair', 409);
                    const index = await documentIndex(dir, target === 'project' ? 'memory' : target, ctx.bundle,
                        previous, next, { databaseRoot: ctx.root, project: itemScope === 'project' ? projectCwd : null });
                    try {
                        verifySource?.();
                        await reserve();
                        save(pendingFile(ctx.root), { version: 1, requestId: input.requestId, kind: 'memory', target,
                            projectKey, projectCwd: itemScope === 'project' ? projectCwd : null,
                            before: previous?.revision ?? null, after: hash(next), next, nextLedger: data, receipt: record });
                        index.mark();
                        publish(dir, target === 'project' ? 'memory' : target, next, previous?.revision);
                        index.sync();
                    } finally { index.close(); }
                } else {
                    verifySource?.();
                    await reserve();
                    const file = fileFor(ctx.root, after), previous = safeFile(file);
                    save(pendingFile(ctx.root), { version: 1, requestId: input.requestId, kind: 'skill',
                        projectKey, before: previous?.revision ?? null, after: state === 'active' ? hash(content) : null,
                        nextLedger: data, receipt: record });
                    if (state === 'active') writeSkill(ctx.root, after, content, before?.state === 'active' ? before.revision : null);
                    else if (before?.state === 'active') removeSkill(ctx.root, before);
                }
                save(ledgerFile(ctx.root), data);
                remove(pendingFile(ctx.root));
                return { receipt: record, item: publicRecord(changed) };
            });
            if (result.replay) return { version: 1, status: result.replay.status, revision: (await this.snapshot(profileId)).revision,
                receipt: publicReceipt(result.replay) };
            const current = await this.snapshot(profileId);
            return { version: 1, status: 'saved', revision: current.revision, item: result.item, receipt: publicReceipt(result.receipt) };
        };
        return typeof this.profiles.reserve === 'function' ? this.profiles.reserve(work) : work();
    }
}

function mountProfileKnowledgeRoutes(router, deps = {}) {
    const service = deps.service || new ProfileKnowledgeService(deps);
    const handle = callback => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { return res.json(await callback(req)); }
        catch (error) {
            if (!error.status) return res.status(500).json({ error: 'Profile knowledge unavailable' });
            return res.status(error.status).json({ error: error.message,
                ...(typeof error.code === 'string' ? { code: error.code } : {}),
                ...(error.details && typeof error.details === 'object' ? { details: error.details } : {}) });
        }
    };
    router.get('/profiles/:id/knowledge', handle(req => {
        const options = { ...req.query };
        if (options.offset !== undefined) {
            if (typeof options.offset !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(options.offset)
                || Number(options.offset) > 100000) throw fail('Invalid knowledge offset');
            options.offset = Number(options.offset);
        }
        return service.snapshot(req.params.id, options);
    }));
    router.get('/profiles/:id/knowledge/items/:itemId', handle(req => service.getItem(req.params.id, req.params.itemId)));
    router.post('/profiles/:id/knowledge/mutations', handle(req => service.mutate(req.params.id, req.body)));
    return service;
}
module.exports = { ProfileKnowledgeService, mountProfileKnowledgeRoutes };
