const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { searchSessions, LIMITS } = require('../server/pi-session-search-worker');

function fixture(t, text, trailingLF = true) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-search-lines-')));
    const directory = path.join(root, 'sessions', 'project'); fs.mkdirSync(directory, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(directory, 'fixture.jsonl');
    const entries = [{ type: 'session', version: 3, id: 'fixture', cwd: root },
        { type: 'message', id: 'reply', message: { role: 'assistant', content: [{ type: 'text', text }] } }];
    fs.writeFileSync(file, entries.map(JSON.stringify).join('\n') + (trailingLF ? '\n' : ''));
    return { file, input: { root: path.join(root, 'sessions'), roots: [root], q: '唯一🙂命中' } };
}

test('search assembles multi-chunk UTF-8 lines once and preserves the final line without LF', t => {
    const text = '界🙂'.repeat(450000) + '\u2028唯一🙂命中\u2029tail';
    const { file, input } = fixture(t, text, false);
    const bytes = fs.statSync(file).size;
    let copied = 0;
    const concat = Buffer.concat;
    t.mock.method(Buffer, 'concat', function(parts, length) {
        copied += length ?? parts.reduce((total, part) => total + part.length, 0);
        return concat(parts, length);
    });
    const result = searchSessions(input);
    assert.equal(result.coverage.scannedFiles, 1); assert.equal(result.coverage.skippedFiles, 0);
    assert.equal(result.results.length, 1); assert.equal(result.results[0].entryId, 'reply');
    assert.equal(result.results[0].matchOffset, text.indexOf(input.q));
    assert.ok(result.results[0].snippet.includes(input.q));
    assert.ok(copied <= bytes, `assembled ${copied} bytes for a ${bytes}-byte file`);
});

test('line budget applies before assembling an oversized line and still excludes hidden projects', t => {
    const { file, input } = fixture(t, 'x'.repeat(200000) + '唯一🙂命中');
    let copied = 0;
    const concat = Buffer.concat;
    t.mock.method(Buffer, 'concat', function(parts, length) { copied += length || 0; return concat(parts, length); });
    const limited = searchSessions(input, { ...LIMITS, lineBytes: 100000 });
    assert.equal(limited.results.length, 0); assert.equal(limited.coverage.skippedFiles, 1);
    assert.equal(copied, 0, 'the over-budget line is refused without a full concatenation');
    const header = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    assert.equal(searchSessions({ ...input, hidden: [header.cwd] }).results.length, 0);
});
