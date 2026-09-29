const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-session-cache-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { SessionMetadataCache } = require('../server/pi-session-metadata');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const strip = rows => rows.map(({ allMessagesText, ...row }) => ({ ...row, created: row.created.getTime(), modified: row.modified.getTime() }));

function fixture(directory, name, entries, separator = '\n') {
    const file = path.join(directory, name + '.jsonl');
    fs.writeFileSync(file, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join(separator));
    return file;
}
const header = (cwd, id) => ({ type: 'session', version: 3, cwd, id, timestamp: '2024-01-01T00:00:00.000Z' });
const message = (role, content, timestamp = 1705000000000) => ({ type: 'message', id: 'm', parentId: null,
    timestamp: '2024-01-02T00:00:00.000Z', message: { role, content, timestamp } });

test('metadata adapter matches native list: malformed shapes, headers, clears, activities and line framing', async () => {
    const sdk = await getSdk();
    const directory = path.join(root, 'parity'); fs.mkdirSync(directory);
    const cases = [
        [header(root, 'normal'), message('user', 'first message text'), message('assistant', [{ type: 'text', text: 'reply' }]), { type: 'session_info', name: ' title ' }, { type: 'session_info', name: '' }],
        ['bad json', null, false, 0, header(root, 'skip'), message('toolResult', 'tool', 1800000000000), message('user', [{ type: 'image' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' }])],
        [true, header(root, 'invalid')],
        [42, header(root, 'invalid')],
        [[], header(root, 'invalid')],
        [{ type: 'message' }, header(root, 'invalid')],
        [header(root, 'null-message'), { type: 'message', message: null }],
        [header(root, 'invalid-content'), message('user', {})],
        [header(root, 'invalid-title'), { type: 'session_info', name: 42 }],
        [{ ...header(root, 'invalid-time'), timestamp: 'not a date', version: 1 }, message('custom', 'ignored')],
        [{ ...header(root, 'historic'), version: 1 }, message('user', 'historic')],
        [header(root, 'empty')],
        [header(root, 'timestamp-fallback'), { ...message('user', 'entry time'), message: { role: 'user', content: 'entry time' } }],
        [header(root, 'cr'), message('assistant', 'reply only'), { type: 'session_info', name: 'latest' }],
    ];
    cases.forEach((entries, index) => fixture(directory, String(index), entries, index === cases.length - 1 ? '\r' : '\n'));
    const cache = new SessionMetadataCache();
    const native = await sdk.SessionManager.listAll(directory);
    assert.deepEqual(strip(await cache.list(directory, sdk, () => assert.fail('unexpected fallback'))), strip(native));
    assert.deepEqual(strip(await cache.list(directory, sdk, () => assert.fail('unexpected fallback'))), strip(native));
    fixture(directory, 'unicode', [header(root, 'unicode'), message('user', 'one\u2028two\u2029three')]);
    let fallback = 0;
    const unicode = await cache.list(directory, sdk, () => { fallback++; return sdk.SessionManager.listAll(directory); });
    assert.equal(fallback, 1, 'unrepresentable native framing retains native discovery');
    assert.deepEqual(strip(unicode), strip(await sdk.SessionManager.listAll(directory)));
});

test('unchanged/one-file metadata and project aggregation avoid unrelated body reads; membership and replacement are fresh', async t => {
    const sdk = await getSdk();
    const store = new PiSessionStore();
    const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
    const sessions = [];
    for (let i = 0; i < 12; i++) sessions.push(await store.createSession(cwd, 'name-' + i));
    let parses = 0;
    const original = store.sessionMetadata.read.bind(store.sessionMetadata);
    store.sessionMetadata.read = (file, revision, parser) => original(file, revision, line => { parses++; return parser(line); });
    await store.listSessions(cwd); assert.ok(parses > 12);
    parses = 0; await store.listSessions(cwd); assert.equal(parses, 0);
    await store.listProjects(); assert.equal(parses, 0);
    await store.getSession(cwd, sessions[0].id); assert.equal(parses, 0, 'target manager only; metadata does not parse unrelated bodies');
    sdk.SessionManager.open(sessions[0].path).appendSessionInfo('changed');
    const rows = await store.listSessions(cwd);
    assert.equal(rows.find(row => row.id === sessions[0].id).name, 'changed');
    assert.ok(parses > 0 && parses < 10, `only changed file parsed (${parses} lines)`);
    fs.unlinkSync(sessions[1].path);
    assert.equal((await store.listSessions(cwd)).length, 11);
    const replacement = sessions[2].path + '.replacement';
    fs.writeFileSync(replacement, fs.readFileSync(sessions[2].path));
    const oldTimes = fs.statSync(sessions[2].path); fs.utimesSync(replacement, oldTimes.atime, oldTimes.mtime);
    fs.renameSync(replacement, sessions[2].path);
    parses = 0; await store.listSessions(cwd); assert.ok(parses > 0, 'same bytes and mtime replacement requires parsing');
    const extra = await store.createSession(cwd, 'new');
    assert.equal((await store.listSessions(cwd)).length, 12);
    assert.equal((await store.getSession(cwd, extra.id)).id, extra.id);
    await assert.rejects(store.getSession(cwd, 'missing'), /not found/);
    // Same IDs retain native list order (modified time, then descending filename).
    const duplicate = path.join(path.dirname(extra.path), 'zzz-duplicate.jsonl');
    fs.copyFileSync(extra.path, duplicate);
    const expected = (await sdk.SessionManager.list(cwd)).find(row => row.id === extra.id);
    assert.equal((await store.getSession(cwd, extra.id)).path, expected.path);
    t.diagnostic('deterministic metadata body parses: unchanged=0; project aggregation after session discovery=0; warm getSession=0; one-file change=one file');
});

test('registry revisions and branch markers refresh only changed-file projections', async () => {
    const sdk = await getSdk(); const store = new PiSessionStore();
    const cwd = path.join(root, 'bindings'); fs.mkdirSync(cwd);
    const a = await store.createSession(cwd, 'a'); await store.createSession(cwd, 'b');
    let revision = 1, descriptions = 0;
    store.profiles = { state: async () => ({ revision, state: { revision } }), describe: async (manager, state) => {
        descriptions++; return { revision: state.revision, markers: manager.getEntries().filter(e => e.type === 'custom').length };
    } };
    await store.listSessions(cwd); assert.equal(descriptions, 2);
    const manager = sdk.SessionManager.open(a.path); manager.appendCustomEntry('synthetic', { value: 1 });
    const rows = await store.listSessions(cwd); assert.equal(descriptions, 3);
    assert.equal(rows.find(row => row.id === a.id).agentProfile.markers, 1);
    revision++; await store.listSessions(cwd); assert.equal(descriptions, 5);
});

test('descriptor identity races and membership changes fail without caching stale metadata', async () => {
    const sdk = await getSdk(); const directory = path.join(root, 'races'); fs.mkdirSync(directory);
    const file = fixture(directory, 'one', [header(root, 'race'), message('user', 'one')]);
    const cache = new SessionMetadataCache(); let changed = false;
    const racingSdk = { ...sdk, parseSessionEntries(line) {
        if (!changed) { changed = true; fs.renameSync(file, file + '.old'); fixture(directory, 'one', [header(root, 'new')]); }
        return sdk.parseSessionEntries(line);
    } };
    await assert.rejects(cache.list(directory, racingSdk, () => assert.fail('fallback')), /changed/);
    assert.equal(cache.files.size, 0);
    assert.equal((await cache.list(directory, sdk, () => assert.fail('fallback')))[0].id, 'new');
    const original = cache.read.bind(cache); let added = false;
    cache.read = (...args) => { const row = original(...args); if (!added) { added = true; fixture(directory, 'two', [header(root, 'two')]); } return row; };
    await assert.rejects(cache.list(directory, sdk, () => assert.fail('fallback')), /changed/);
    assert.equal((await cache.list(directory, sdk, () => assert.fail('fallback'))).length, 2);
});

test('large changed-file parsing yields to unrelated event-loop work', async t => {
    const sdk = await getSdk(), cwd = path.join(root, 'heartbeat'); fs.mkdirSync(cwd);
    const directory = sdk.SessionManager.create(cwd).getSessionDir();
    const file = fixture(directory, 'large', [header(cwd, 'heartbeat'),
        ...Array.from({ length: 3072 }, () => message('user', 'x'.repeat(4096)))]);
    const cache = new SessionMetadataCache();
    let ticks = 0, parsingTicks = 0, last = performance.now(), maxGap = 0, active = true;
    const heartbeat = () => {
        if (!active) return;
        const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
        setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    let firstParseTick;
    const measured = { ...sdk, parseSessionEntries(line) {
        if (firstParseTick === undefined) firstParseTick = ticks;
        parsingTicks = ticks - firstParseTick;
        return sdk.parseSessionEntries(line);
    } };
    const start = performance.now();
    try {
        const rows = await cache.list(directory, measured, () => assert.fail('unexpected fallback'));
        assert.equal(rows[0].messageCount, 3072);
        assert.ok(parsingTicks > 10, 'projection must yield during parsing, not just during file reads');
    } finally { active = false; }
    t.diagnostic(JSON.stringify({ fileMiB: +(fs.statSync(file).size / 1048576).toFixed(1), elapsedMs: +(performance.now() - start).toFixed(1), parsingTicks, maxHeartbeatGapMs: +maxGap.toFixed(1) }));
});

test('synthetic native/cache before-after benchmark (no timing assertion)', async t => {
    const sdk = await getSdk(); const cwd = path.join(root, 'benchmark'); fs.mkdirSync(cwd);
    const directory = sdk.SessionManager.create(cwd).getSessionDir();
    for (let i = 0; i < 24; i++) fixture(directory, String(i), [header(cwd, 'bench-' + i), ...Array.from({ length: 80 }, (_, n) => message(n % 2 ? 'assistant' : 'user', 'x'.repeat(4096)))]);
    const cache = new SessionMetadataCache();
    const run = async action => { const start = performance.now(); await action(); return +(performance.now() - start).toFixed(1); };
    const baseline = await run(() => sdk.SessionManager.list(cwd));
    const cold = await run(() => cache.list(directory, sdk, () => sdk.SessionManager.list(cwd)));
    const unchanged = await run(() => cache.list(directory, sdk, () => sdk.SessionManager.list(cwd)));
    fs.appendFileSync(path.join(directory, '0.jsonl'), '\n' + JSON.stringify({ type: 'session_info', name: 'changed' }));
    const oneFile = await run(() => cache.list(directory, sdk, () => sdk.SessionManager.list(cwd)));
    t.diagnostic(JSON.stringify({ files: 24, approximateMiB: 7.5, nativeMs: baseline, coldMs: cold, unchangedMs: unchanged, oneFileMs: oneFile }));
});
