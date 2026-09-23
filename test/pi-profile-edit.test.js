'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-profile-edit-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent;
const { PiProfileRegistry, normalizedMemory, profileRevision } = require('../server/pi-profile-registry');
const { mountProfileDocumentRoutes } = require('../server/pi-profile-documents');
const { mountProfileAvatarRoutes } = require('../server/pi-profile-avatar');
const { createMutationLock } = require('../server/profile-memory/mutation-lock');

function router() { const routes = new Map(); return { routes, get(route, fn) { routes.set(`GET ${route}`, fn); },
    put(route, fn) { routes.set(`PUT ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); } }; }
async function request(routes, method, route, { id, query = {}, body = {} } = {}) {
    const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
        status(code) { this.statusCode = code; return this; }, type(mime) { this.mime = mime; return this; },
        json(value) { this.data = value; return this; }, send(value) { this.data = value; return this; } };
    await routes.get(`${method} ${route}`)({ params: { id }, query, body }, res); return res;
}
function png(red = 255) {
    const crc = bytes => { let n = -1; for (const byte of bytes) { n ^= byte;
        for (let i = 0; i < 8; i++) n = n >>> 1 ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ -1) >>> 0; };
    const chunk = (type, data) => { const size = Buffer.alloc(4), tail = Buffer.alloc(4), raw = Buffer.concat([Buffer.from(type), data]);
        size.writeUInt32BE(data.length); tail.writeUInt32BE(crc(raw)); return Buffer.concat([size, raw, tail]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.from([0, red, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
test('profile limits isolate contexts; revisions, document CAS and avatar ownership', async t => {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    const basic = { name: 'One', description: '', soul: '', enabled: true, memory: { enabled: true, autoLearn: false } };
    const first = await profiles.save({ expectedRevision: (await profiles.state()).revision, profile: basic });
    const second = await profiles.save({ expectedRevision: first.revision, profile: { ...basic, name: 'Two', memory: {
        enabled: true, autoLearn: false, memoryCharLimit: 512, userCharLimit: 256 } } });
    assert.deepEqual(normalizedMemory(first.profile.memory), { memoryCharLimit: 16000, userCharLimit: 8000 });
    assert.deepEqual(normalizedMemory(second.profile.memory), { memoryCharLimit: 512, userCharLimit: 256 });
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { readProfileRuntime } = require('../server/pi-profile-runtime');
    const createBound = id => {
        const manager = SessionManager.create(cwd), file = manager.getSessionFile();
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
        const persisted = SessionManager.open(file, undefined, cwd);
        persisted.appendCustomEntry('pivane-agent-profile', { version: 1, sessionId: persisted.getSessionId(), profileId: id });
        return persisted;
    };
    for (const [profile, limit] of [[first.profile, 16000], [second.profile, 512]]) {
        const manager = createBound(profile.id), context = await profiles.context(manager, cwd);
        assert.equal(context.memory.memoryCharLimit, limit);
        assert.equal(readProfileRuntime(manager, cwd, agent, path.join(agent, 'sessions'), JSON.stringify(context)).context.memory.memoryCharLimit, limit);
        assert.equal(readProfileRuntime(manager, cwd, agent, path.join(agent, 'sessions'), JSON.stringify({ ...context,
            memory: { ...context.memory, memoryCharLimit: limit === 512 ? 16000 : 512 } })), null);
    }
    await assert.rejects(profiles.save({ expectedRevision: second.revision, profile: { ...second.profile,
        memory: { ...second.profile.memory, memoryCharLimit: Infinity } } }), /Invalid memoryCharLimit/);
    await assert.rejects(profiles.save({ expectedRevision: second.revision, profile: { ...first.profile,
        avatar: { kind: 'image', version: 'a'.repeat(64) } } }), /Image avatar must be uploaded/);
    const r = router(); mountProfileDocumentRoutes(r, { profiles, getAgentDir: async () => agent,
        bundlePath: process.env.PIVANE_TEST_HERMES_BUNDLE });
    mountProfileAvatarRoutes(r, { profiles, getAgentDir: async () => agent });
    const doc = '/profiles/:id/documents';
    const read = (id, target) => request(r.routes, 'GET', doc, { id, query: { target } });
    const write = (id, target, content, current) => request(r.routes, 'PUT', doc, { id, body: {
        target, content, expectedRevision: current.revision, expectedProfileRevision: current.profileRevision } });
    const empty = (await read(first.profile.id, 'user')).data;
    assert.equal(empty.status, 'ready'); assert.equal(empty.usage.limit, 8000);
    const initial = await write(first.profile.id, 'user', 'Synthetic user fact', empty);
    assert.equal(initial.statusCode, process.env.PIVANE_TEST_HERMES_BUNDLE ? 200 : 202, JSON.stringify(initial.data));
    assert.equal(initial.data.usage.used, 'Synthetic user fact'.length);
    assert.equal((await write(first.profile.id, 'user', 'Stale', empty)).statusCode, 409);
    assert.equal((await read(second.profile.id, 'user')).data.content, '');
    const memory = (await read(first.profile.id, 'memory')).data;
    if (process.env.PIVANE_TEST_HERMES_BUNDLE) {
        assert.equal(memory.status, 'ready');
        const before = await createMutationLock(path.join(agent, 'pivane-profiles', 'data', first.profile.id)).inspect(g => g);
        const result = await write(first.profile.id, 'memory', 'Fact 1\n§\nFact 2', memory);
        assert.equal(result.statusCode, 200, JSON.stringify(result.data));
        assert.equal((await createMutationLock(path.join(agent, 'pivane-profiles', 'data', first.profile.id)).run(undefined, () => 'should-not-write', before)).conflict, true,
            'stale autoLearn must lose after an editor write');
        assert.equal((await read(first.profile.id, 'memory')).data.usage.used, 'Fact 1\n§\nFact 2'.length);
    } else assert.equal(memory.status, 'unsupported');
    const over = await write(second.profile.id, 'user', 'x'.repeat(257), (await read(second.profile.id, 'user')).data);
    assert.equal(over.statusCode, 400);
    assert.equal((await read(second.profile.id, 'user')).data.content, '');
    const reduced = await profiles.save({ expectedRevision: second.revision, profile: { ...second.profile,
        memory: { ...second.profile.memory, userCharLimit: 256 } } });
    assert.equal((await write(second.profile.id, 'user', 'old', (await read(second.profile.id, 'user')).data)).statusCode,
        process.env.PIVANE_TEST_HERMES_BUNDLE ? 200 : 202);
    assert.ok(reduced.revision);
    const image = png(), upload = '/profiles/:id/avatar';
    const response = await request(r.routes, 'POST', upload, { id: first.profile.id,
        body: { expectedRevision: reduced.revision, dataUrl: `data:image/png;base64,${image.toString('base64')}` } });
    assert.equal(response.statusCode, 200, JSON.stringify(response.data));
    assert.equal(response.data.profile.avatar.version, createHash('sha256').update(image).digest('hex'));
    assert.equal((await request(r.routes, 'GET', upload, { id: first.profile.id, query: { version: response.data.profile.avatar.version } })).data.equals(image), true);
    assert.equal((await request(r.routes, 'GET', upload, { id: second.profile.id, query: { version: response.data.profile.avatar.version } })).statusCode, 404);
    if (process.platform !== 'win32') {
        const asset = path.join(agent, 'pivane-profiles', 'data', first.profile.id, `avatar-${response.data.profile.avatar.version}.png`);
        fs.renameSync(asset, asset + '.held'); fs.symlinkSync(asset + '.held', asset);
        try { assert.equal((await request(r.routes, 'GET', upload, { id: first.profile.id,
            query: { version: response.data.profile.avatar.version } })).statusCode, 409); }
        finally { fs.unlinkSync(asset); fs.renameSync(asset + '.held', asset); }
    }
    assert.equal((await request(r.routes, 'POST', upload, { id: first.profile.id,
        body: { expectedRevision: response.data.revision, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } })).statusCode, 400);
    assert.equal(profileRevision(response.data.profile), (await profiles.getProfile(first.profile.id)) && profileRevision(await profiles.getProfile(first.profile.id)));
    const previous = (await read(first.profile.id, 'user')).data;
    const narrowed = await profiles.save({ expectedRevision: response.data.revision,
        profile: { ...response.data.profile, memory: { ...response.data.profile.memory, userCharLimit: 256 } } });
    assert.equal((await write(first.profile.id, 'user', 'stale profile', previous)).statusCode, 409);
    const file = path.join(agent, 'pivane-profiles', 'data', first.profile.id, 'USER.md');
    fs.writeFileSync(file, 'X'.repeat(300));
    const overLimit = (await read(first.profile.id, 'user')).data;
    assert.equal(overLimit.status, 'ready');
    assert.deepEqual(overLimit.usage, { used: 300, limit: 256, unit: 'characters' });
    assert.equal((await write(first.profile.id, 'user', 'Y'.repeat(257), overLimit)).statusCode, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), 'X'.repeat(300), 'lowering a limit never truncates existing data');
    assert.ok(narrowed.revision);
    const dormant = await profiles.save({ expectedRevision: narrowed.revision, profile: { ...basic, name: 'Dormant',
        memory: { enabled: false, autoLearn: false } } });
    const dormantBefore = (await read(dormant.profile.id, 'user')).data;
    const privateFiles = require('../server/pi-private-files'), originalMode = privateFiles.privateFileMode;
    privateFiles.privateFileMode = filename => {
        if (filename === path.join(agent, 'pivane-profiles', 'data', dormant.profile.id, 'USER.md'))
            throw Error('synthetic post-publication check failure');
        return originalMode(filename);
    };
    let partial;
    try { partial = await write(dormant.profile.id, 'user', 'DormantFact', dormantBefore); }
    finally { privateFiles.privateFileMode = originalMode; }
    assert.equal(partial.statusCode, 503);
    assert.deepEqual([partial.data.documentSaved, partial.data.indexSynced], [true, false]);
    assert.equal((await read(dormant.profile.id, 'user')).data.content, 'DormantFact');
    const replacement = png(123), nextVersion = createHash('sha256').update(replacement).digest('hex');
    const nextFile = path.join(agent, 'pivane-profiles', 'data', first.profile.id, `avatar-${nextVersion}.png`);
    const uploadBody = { dataUrl: `data:image/png;base64,${replacement.toString('base64')}` };
    const stale = await request(r.routes, 'POST', upload, { id: first.profile.id,
        body: { ...uploadBody, expectedRevision: response.data.revision } });
    assert.equal(stale.statusCode, 409);
    assert.equal(fs.existsSync(nextFile), false, 'stale registry CAS cannot publish a private asset');
    let entered, release;
    const preparing = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const paused = router();
    profiles.nativeService = { busy: false };
    mountProfileAvatarRoutes(paused, { profiles, getAgentDir: async () => { entered(); await hold; return agent; } });
    const pending = request(paused.routes, 'POST', upload, { id: first.profile.id,
        body: { ...uploadBody, expectedRevision: (await profiles.state()).revision } });
    assert.equal(profiles.busy, true, 'avatar reserves activity before resolving the asset path');
    assert.equal(profiles.nativeService.busy, true);
    await preparing;
    let disposed = false;
    const shutdown = profiles.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    assert.equal(fs.existsSync(nextFile), false);
    release();
    const committed = await pending;
    assert.equal(committed.statusCode, 200, JSON.stringify(committed.data));
    await shutdown;
    assert.equal(disposed, true);
    assert.equal(fs.existsSync(nextFile), true);
    assert.equal(profiles.nativeService.busy, false);
});
