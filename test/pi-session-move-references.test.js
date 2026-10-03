const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanSessionReferences } = require('../server/pi-session-move-references');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-reference-scan-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const write = text => { const file = path.join(root, String(sequence++) + '.jsonl'); fs.writeFileSync(file, text); return file; };
const scan = async file => { const records = []; await scanSessionReferences(file, row => records.push(row)); return records; };
const reference = { cwd: '/synthetic/来源😀', sessionId: 'thread' };

test('projection follows root fields, ordering, escaped keys and duplicate keys without reading body strings as references', async () => {
    const header = { type: 'session', parentSession: '/synthetic/parent.jsonl' };
    const input = [JSON.stringify(header), JSON.stringify({ message: { content: JSON.stringify({ type: 'custom', data: { source: reference } }) }, type: 'message' }),
        JSON.stringify({ data: { ignored: 'x'.repeat(300000), source: reference }, customType: 'pivane-agent-task', type: 'custom' }),
        '{"type":"message","data":{"source":' + JSON.stringify(reference) + '},"type":"custom","customType":"pivane-agent-task"}',
        '{"ty\\u0070e":"custom","customType":"pivane-agent-message-out","details":{"from":' + JSON.stringify(reference) + '}}',
        '{"type":"custom","data":{"source":' + JSON.stringify(reference) + '},"data":null,"details":{"to":' + JSON.stringify(reference) + '}}'];
    const rows = await scan(write(input.join('\n')));
    assert.equal(rows[0].parentSession, header.parentSession);
    assert.equal(rows[1].type, 'message'); assert.equal(rows[1].data, undefined);
    assert.deepEqual(rows[2].data.source, reference); assert.equal(rows[2].data.ignored, undefined);
    assert.equal(rows[3].type, 'custom'); assert.deepEqual(rows[3].data.source, reference);
    assert.deepEqual(rows[4].details.from, reference); assert.equal(rows[5].data, null); assert.deepEqual(rows[5].details.to, reference);
});

test('chunk boundaries preserve UTF-8, escapes, scalar values and data/details fallback semantics', async () => {
    for (const padding of [262044, 262122, 262139]) {
        const values = [null, false, true, 0, -1, 1e-10, '', 'x', [], {}];
        const input = values.map(data => JSON.stringify({ padding: 'x'.repeat(padding), type: 'custom', data, details: { source: reference } })).join('\n');
        const rows = await scan(write(input));
        for (let i = 0; i < rows.length; i++) {
            assert.equal(Boolean(rows[i].data), Boolean(values[i]));
            assert.deepEqual(rows[i].details.source, reference);
        }
    }
});

test('invalid skipped bodies, invalid delimiters and truncated records are rejected', async () => {
    for (const text of [
        '{"type":"message","body":"bad\\q"}\n', '{"type":"message","body":[1,]}\n',
        '{"type":"message","body":{"x":1,}}\n', '{"type":"message","body":01}\n',
        '{"type":"message","body":1e}\n', '{"type":"message","body":"missing}\n',
        '{"type":"message"}{"type":"custom"}\n', '[{"type":"session"}]\n', '{"type":"message","body":tru}\n'
    ]) await assert.rejects(scan(write(text)), { code: 'SESSION_MOVE_SCAN_INVALID' });
});

test('read and selected metadata budgets fail explicitly, and changed opened files never return a usable proof', async () => {
    const file = write(JSON.stringify({ type: 'session' }) + '\n' + JSON.stringify({ type: 'message', body: 'x'.repeat(600000) }) + '\n');
    await assert.rejects(scanSessionReferences(file, () => {}, { bytes: 0, metadata: 0, maxBytes: 100, maxMetadata: 100 }), { code: 'SESSION_MOVE_SCAN_BUDGET' });
    await assert.rejects(scanSessionReferences(file, () => {}, { bytes: 0, metadata: 0, maxBytes: 1000000, maxMetadata: 1 }), { code: 'SESSION_MOVE_SCAN_BUDGET' });
    setImmediate(() => { fs.renameSync(file, file + '.old'); fs.writeFileSync(file, '{}\n'); });
    await assert.rejects(scan(file));
    const linked = path.join(root, 'linked.jsonl'); fs.symlinkSync(file, linked);
    await assert.rejects(scan(linked));
});
