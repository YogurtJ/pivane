const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-metadata-records-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_PROJECT_ROOTS = root;
const { getSdk } = require('../server/pi-session-store');
const { SessionMetadataCache } = require('../server/pi-session-metadata');
const io = require('../server/pi-file-io');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const header = id => JSON.stringify({ type: 'session', version: 3, cwd: root, id, timestamp: '2024-01-01T00:00:00.000Z' });
const message = content => JSON.stringify({ type: 'message', timestamp: '2024-01-02T00:00:00.000Z', message: { role: 'user', content } });
const normalized = rows => rows.map(({ allMessagesText, ...row }) => ({ ...row, created: +row.created, modified: +row.modified }));
const noFallback = () => assert.fail('unexpected native discovery');

function directory(name) {
    const dir = path.join(root, name); fs.mkdirSync(dir); return dir;
}

// The limit applies to complete JSON record characters, including its envelope,
// and is independent of the retained preview/cache byte budget.
function recordOfLength(length) {
    return message('x'.repeat(length - message('').length));
}

test('long records preserve SDK projection across CR/LF, split UTF-8 and EOF framing', async () => {
    const sdk = await getSdk(), dir = directory('framing');
    const contents = ['x'.repeat(2 * 1024 * 1024), '汉😀'.repeat(400000)];
    for (const [index, separator] of ['\n', '\r', '\r\n'].entries()) {
        fs.writeFileSync(path.join(dir, index + '.jsonl'), [header('framing-' + index), message('short preview'),
            message(contents[index % contents.length]), '{bad json', 'null', 'false', '0',
            JSON.stringify({ type: 'session_info', name: ' final ' })].join(separator));
    }
    const crlfHeader = header('split-crlf');
    fs.writeFileSync(path.join(dir, 'split-crlf.jsonl'), crlfHeader + ' '.repeat(65535 - crlfHeader.length)
        + '\r\n' + message('short preview'));
    fs.writeFileSync(path.join(dir, 'truncated-utf8.jsonl'), Buffer.concat([
        Buffer.from(header('truncated-utf8') + '\n' + message('short preview') + '\n'), Buffer.from([0xf0, 0x9f]),
    ]));
    const atLimit = path.join(dir, 'limit.jsonl');
    fs.writeFileSync(atLimit, header('limit') + '\n' + message('short preview') + '\n' + recordOfLength(8 * 1024 * 1024));
    const cache = new SessionMetadataCache();
    const rows = await cache.list(dir, sdk, noFallback);
    assert.deepEqual(normalized(rows), normalized(await sdk.SessionManager.list(root, dir)));
    assert.equal(rows.find(row => row.id === 'limit').messageCount, 2);
    for (const record of cache.files.values()) {
        assert.deepEqual(Object.keys(record).sort(), ['bytes', 'metadata', 'revision']);
        assert.equal(record.metadata.allMessagesText, undefined);
        assert.equal(record.metadata.entries, undefined);
        assert.equal(record.metadata.firstMessage, 'short preview');
    }
});

test('changed long file alone is parsed, in-flight lists share work, and parsing yields between records', async () => {
    const sdk = await getSdk(), dir = directory('changed');
    const changed = path.join(dir, 'long.jsonl');
    fs.writeFileSync(changed, [header('changed'), message('preview'), message('x'.repeat(2 * 1024 * 1024)),
        message('y'.repeat(2 * 1024 * 1024))].join('\n'));
    for (let index = 0; index < 20; index++) fs.writeFileSync(path.join(dir, index + '.jsonl'), header('other-' + index));
    const cache = new SessionMetadataCache();
    await cache.list(dir, sdk, noFallback);
    fs.appendFileSync(changed, '\n' + JSON.stringify({ type: 'session_info', name: 'changed' }));
    let ticks = 0, active = true, reads = 0;
    const heartbeat = () => { if (active) { ticks++; setImmediate(heartbeat); } };
    setImmediate(heartbeat);
    const parseTicks = [], read = cache.read.bind(cache);
    cache.read = (file, revision, parser) => read(file, revision, line => {
        reads++; parseTicks.push(ticks); return parser(line);
    });
    let rows;
    try {
        rows = await Promise.all(Array.from({ length: 12 }, () => cache.list(dir, sdk, noFallback)));
    } finally { active = false; }
    assert.equal(reads, 5, 'one changed body is parsed once for twelve concurrent callers');
    assert.ok(parseTicks[3] - parseTicks[2] >= 30, 'long-record decoding yields per 64 KiB before parsing the next record');
    assert.ok(rows.every(list => list[0] === rows[0][0]));
    assert.equal(rows[0].find(row => row.id === 'changed').name, 'changed');
    assert.deepEqual(normalized(rows[0]), normalized(await sdk.SessionManager.list(root, dir)));
    assert.equal(cache.pending.size, 0);
});

test('record over compatibility budget still falls back, with and without a final delimiter', async () => {
    const sdk = await getSdk();
    for (const suffix of ['', '\r\n']) {
        const dir = directory('over-' + suffix.length);
        fs.writeFileSync(path.join(dir, 'long.jsonl'), header('over') + '\n' + message('preview') + '\n'
            + recordOfLength(8 * 1024 * 1024 + 1) + suffix);
        const cache = new SessionMetadataCache(); let fallbacks = 0;
        const fallback = () => { fallbacks++; return sdk.SessionManager.list(root, dir); };
        const shared = await Promise.all(Array.from({ length: 12 }, () => cache.list(dir, sdk, fallback)));
        const rows = shared[0];
        assert.equal(fallbacks, 1, 'over-budget native discovery also shares one in-flight scan');
        assert.ok(shared.every(list => list[0] === rows[0]));
        assert.deepEqual(normalized(rows), normalized(await sdk.SessionManager.list(root, dir)));
        assert.equal((await cache.list(dir, sdk, fallback))[0], rows[0]);
        assert.equal(fallbacks, 1);
    }
});

test('oversized first preview is returned unchanged but excluded from the retained cache', async () => {
    const sdk = await getSdk(), dir = directory('preview');
    const file = path.join(dir, 'long.jsonl');
    fs.writeFileSync(file, header('preview') + '\n' + message('汉'.repeat(600000)));
    const cache = new SessionMetadataCache();
    const rows = await cache.list(dir, sdk, noFallback);
    assert.deepEqual(normalized(rows), normalized(await sdk.SessionManager.list(root, dir)));
    assert.equal(cache.files.has(file), false);
    assert.equal(cache.bytes, 0);
});

test('long malformed shapes match native omission and Unicode separators retain conservative fallback', async () => {
    const sdk = await getSdk(), dir = directory('shapes');
    const cases = [message({ data: 'x'.repeat(2 * 1024 * 1024) }),
        JSON.stringify({ type: 'session_info', name: { data: 'x'.repeat(2 * 1024 * 1024) } }),
        message([{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }, null])];
    cases.forEach((line, index) => fs.writeFileSync(path.join(dir, index + '.jsonl'), header('bad-' + index) + '\n' + line));
    assert.deepEqual(await new SessionMetadataCache().list(dir, sdk, noFallback), []);
    assert.deepEqual(await sdk.SessionManager.list(root, dir), []);
    fs.writeFileSync(path.join(dir, 'unicode.jsonl'), header('unicode') + '\n' + message('x'.repeat(65500) + '\u2028汉\u2029'));
    let fallbacks = 0;
    const rows = await new SessionMetadataCache().list(dir, sdk, () => { fallbacks++; return sdk.SessionManager.list(root, dir); });
    assert.equal(fallbacks, 1);
    assert.deepEqual(normalized(rows), normalized(await sdk.SessionManager.list(root, dir)));
});

test('long-record reads reject permission changes, same-size rewrites and directory membership changes', async () => {
    const sdk = await getSdk();
    for (const change of ['permission', 'rewrite', 'member', 'identity']) {
        const dir = directory(change), file = path.join(dir, 'long.jsonl');
        fs.writeFileSync(file, header(change) + '\n' + message('preview') + '\n' + message('x'.repeat(2 * 1024 * 1024)));
        const cache = new SessionMetadataCache(); let mutated = false;
        const racing = { ...sdk, parseSessionEntries(line) {
            if (!mutated && line.length > 1024 * 1024) {
                mutated = true;
                if (change === 'permission') fs.chmodSync(file, 0o400);
                if (change === 'rewrite') {
                    const fd = fs.openSync(file, 'r+');
                    try { fs.writeSync(fd, Buffer.from('y'), 0, 1, fs.statSync(file).size - 4); }
                    finally { fs.closeSync(fd); }
                }
                if (change === 'member') fs.writeFileSync(path.join(dir, 'added.jsonl'), header('added'));
                if (change === 'identity') { fs.renameSync(file, file + '.old'); fs.copyFileSync(file + '.old', file); }
            }
            return sdk.parseSessionEntries(line);
        } };
        await assert.rejects(cache.list(dir, racing, noFallback), /Session file changed/);
        assert.equal(cache.pending.size, 0);
        if (change !== 'member') assert.equal(cache.files.has(file), false);
    }
});

test('descriptor permission failure never becomes a cached empty native result', async () => {
    const sdk = await getSdk(), dir = directory('denied');
    const file = path.join(dir, 'long.jsonl');
    fs.writeFileSync(file, header('denied') + '\n' + message('x'.repeat(2 * 1024 * 1024)));
    const cache = new SessionMetadataCache(), original = io.openReadSync;
    // Inject after the proof so this behaves identically under privileged test
    // users that can read mode-000 files. No actual permission bypass is assumed.
    const read = cache.read.bind(cache);
    cache.read = async (...args) => {
        io.openReadSync = target => {
            if (target === file) { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; }
            return original(target);
        };
        try { return await read(...args); } finally { io.openReadSync = original; }
    };
    await assert.rejects(cache.list(dir, sdk, noFallback), { code: 'EACCES' });
    assert.equal(cache.files.size, 0);
    assert.equal(cache.pending.size, 0);
});

test('long header visibility and session_info titles match native raw-line parsing for BOM and NBSP edges', async () => {
    const sdk = await getSdk();
    const padding = 'x'.repeat(2 * 1024 * 1024);
    for (const [name, character] of [['bom', '\uFEFF'], ['nbsp', '\u00A0']]) {
        for (const edge of ['prefix', 'suffix']) {
            const wrap = line => edge === 'prefix' ? ' \t' + character + line + '\t ' : '\t ' + line + character + ' \t';
            for (const kind of ['header', 'title']) {
                const dir = directory('raw-edges-' + name + '-' + edge + '-' + kind);
                const file = path.join(dir, 'long.jsonl');
                const longHeader = JSON.stringify({ ...JSON.parse(header('invalid-header')), padding });
                const longTitle = JSON.stringify({ type: 'session_info', name: 'after', padding });
                fs.writeFileSync(file, kind === 'header'
                    ? wrap(longHeader) + '\n' + message('preview')
                    : header('valid-header') + '\n' + JSON.stringify({ type: 'session_info', name: 'before' }) + '\n' + wrap(longTitle));
                const native = await sdk.SessionManager.list(root, dir);
                if (kind === 'header') assert.equal(native.length, 0, 'native list rejects the raw long header');
                else assert.equal(native[0].name, 'before', 'native list ignores the raw invalid title line');
                const cache = new SessionMetadataCache(); let fallbacks = 0;
                const fallback = () => { fallbacks++; return sdk.SessionManager.list(root, dir); };
                const rows = await cache.list(dir, sdk, fallback);
                assert.deepEqual(normalized(rows), normalized(native), name + ' ' + edge + ' ' + kind);
                assert.equal(fallbacks, 1, 'non-JSON outer whitespace must retain native discovery');
                assert.deepEqual(normalized(await cache.list(dir, sdk, fallback)), normalized(native));
                assert.equal(fallbacks, 1, 'native omission/title metadata is cached against its proven revision');
            }
        }
    }
});

test('legal JSON whitespace, internal BOM/NBSP and whitespace-only lines retain native projection without fallback', async () => {
    const sdk = await getSdk(), dir = directory('allowed-whitespace');
    const padding = 'x'.repeat(2 * 1024 * 1024);
    const blank = ' \t\uFEFF\u00A0\u000B\u000C\u1680\u2000\u202F\u205F\u3000'.repeat(100000);
    const longHeader = JSON.stringify({ ...JSON.parse(header('allowed')), padding });
    const longTitle = JSON.stringify({ type: 'session_info', name: 'inside\uFEFFtitle\u00A0text', padding });
    fs.writeFileSync(path.join(dir, 'allowed.jsonl'), [blank, ' \t' + longHeader + '\t ', '\t  ', blank,
        ' \t' + message('inside\uFEFFmessage\u00A0text') + '\t ', '\t ' + longTitle + ' \t', blank].join('\r\n'));
    const rows = await new SessionMetadataCache().list(dir, sdk, noFallback);
    const native = await sdk.SessionManager.list(root, dir);
    assert.deepEqual(normalized(rows), normalized(native));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'allowed');
    assert.equal(rows[0].name, 'inside\uFEFFtitle\u00A0text');
    assert.equal(rows[0].firstMessage, 'inside\uFEFFmessage\u00A0text');
    assert.equal(rows[0].messageCount, 1);
});
