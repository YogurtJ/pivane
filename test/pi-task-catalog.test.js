const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskCatalog } = require('../server/pi-task-catalog');
function fixture(t, limits = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-task-index-')));
    const cwd = path.join(root, 'project'), directory = path.join(root, 'sessions');
    fs.mkdirSync(cwd); fs.mkdirSync(directory);
    const store = { resolveProject(value) { assert.equal(fs.realpathSync.native(value), cwd); return cwd; } };
    const catalog = new TaskCatalog({ store, directory: () => directory, limits });
    t.after(async () => { await catalog.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const header = id => ({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() });
    const task = id => ({ type: 'custom', customType: 'pi5-agent-task', data: { version: 1, sessionId: id, requestId: 'stable', source: { cwd, sessionId: 'parent' }, depth: 1 } });
    const write = (name, entries) => { const file = path.join(directory, name); fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); return file; };
    return { root, cwd, directory, catalog, header, task, write };
}
async function complete(catalog, cwd) {
    for (let i = 0; i < 300; i++) { const value = await catalog.refresh(cwd); if (value.complete) return value; }
    throw new Error('Index did not finish');
}
test('large histories are indexed in resumable batches, unchanged bodies are not re-read, and legacy task metadata survives', async t => {
    const f = fixture(t, { batchBytes: 2 * 1024 * 1024, milliseconds: 1000 });
    f.write('parent.jsonl', [f.header('parent')]);
    const file = f.write('misleading-filename.jsonl', [f.header('actual-id'), f.task('actual-id')]);
    const fd = fs.openSync(file, 'a');
    const message = JSON.stringify({ type: 'message', id: 'irrelevant', message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] } }) + '\n';
    for (let i = 0; i < 66; i++) fs.writeSync(fd, message);
    fs.closeSync(fd);
    const first = await f.catalog.refresh(f.cwd);
    assert.equal(first.complete, false); assert.ok(first.coverage.bytesRead <= 2 * 1024 * 1024);
    const ready = await complete(f.catalog, f.cwd);
    assert.equal(ready.records.length, 1); assert.equal(ready.records[0].session.id, 'actual-id');
    const read = f.catalog.bytesRead;
    await f.catalog.refresh(f.cwd); assert.equal(f.catalog.bytesRead, read, 'warm lookups do not parse unchanged histories');
    f.write('parent.jsonl', [f.header('parent'), { type: 'session_info', name: 'Renamed source' }]);
    await complete(f.catalog, f.cwd);
    assert.ok(f.catalog.bytesRead - read < 1024, 'only the changed small file is read');
});
test('more than 2000 native sessions can be discovered without the old project cap', async t => {
    const f = fixture(t, { milliseconds: 1000 });
    for (let i = 0; i < 2001; i++) f.write(`${i}.jsonl`, [f.header(`id-${i}`)]);
    const ready = await complete(f.catalog, f.cwd);
    assert.equal(ready.coverage.checked, 2001); assert.equal(ready.records.length, 0);
});
test('partial writes, replacement, deletion, and duplicate identity never become false task absence', async t => {
    const f = fixture(t);
    const file = f.write('task.jsonl', [f.header('child'), f.task('child')]);
    await complete(f.catalog, f.cwd);
    fs.appendFileSync(file, '{"type":');
    await assert.rejects(f.catalog.refresh(f.cwd), error => error.code === 'TASK_INCOMPLETE');
    f.write('replacement', [f.header('other'), f.task('other')]); fs.renameSync(path.join(f.directory, 'replacement'), file);
    assert.equal((await complete(f.catalog, f.cwd)).records[0].session.id, 'other');
    f.write('duplicate.jsonl', [f.header('other')]);
    await assert.rejects(f.catalog.refresh(f.cwd), error => error.code === 'TASK_DUPLICATE_ID');
    fs.unlinkSync(path.join(f.directory, 'duplicate.jsonl')); fs.unlinkSync(file);
    assert.equal((await complete(f.catalog, f.cwd)).records.length, 0);
});
test('a session added during a batch leaves coverage incomplete until its task metadata is checked', async t => {
    const f = fixture(t); f.write('first.jsonl', [f.header('parent')]);
    const line = f.catalog.line.bind(f.catalog); let inserted = false;
    f.catalog.line = (...args) => {
        line(...args);
        if (!inserted) { inserted = true; f.write('late.jsonl', [f.header('late'), f.task('late')]); }
    };
    assert.equal((await f.catalog.refresh(f.cwd)).complete, false);
    assert.equal((await complete(f.catalog, f.cwd)).records[0].session.id, 'late');
});

test('original result reading preserves long Unicode replies across bounded pages', async t => {
    const f = fixture(t), text = 'Result 😀\n'.repeat(2000);
    f.write('child.jsonl', [f.header('child'), f.task('child'), { type: 'message', id: 'reply', parentId: null,
        message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'not returned' }], stopReason: 'stop' } }]);
    await complete(f.catalog, f.cwd);
    let offset = 0, actual = '';
    do { const page = await f.catalog.reply(f.cwd, 'child', 'reply', offset); assert.ok(page.text.length <= 8000); actual += page.text; offset = page.nextOffset; } while (offset !== null);
    assert.equal(actual, text);
    await assert.rejects(f.catalog.reply(f.cwd, 'child', 'missing'), error => error.code === 'TASK_RESULT_MISSING');
});

test('linked files are refused and a cold cache rebuild preserves native results and read markers', async t => {
    const f = fixture(t);
    f.write('parent.jsonl', [f.header('parent'), { type: 'custom_message', customType: 'pivane-agent-task-result', details: { deliveryId: 'receipt' } },
        { type: 'custom', customType: 'pivane-agent-task-read', data: { deliveryId: 'receipt' } }]);
    f.write('child.jsonl', [f.header('child'), f.task('child'), { type: 'custom', customType: 'pivane-agent-task-state',
        data: { version: 2, sessionId: 'child', status: 'settled', resultId: 'run-1', preview: 'Result', outcome: 'completed' } }]);
    const ready = await complete(f.catalog, f.cwd); assert.equal(ready.records[0].results[0].preview, 'Result');
    f.catalog.projects.clear();
    await complete(f.catalog, f.cwd);
    const source = await f.catalog.source(f.cwd, 'parent'); assert.ok(source.receipts.has('receipt')); assert.ok(source.read.has('receipt'));
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(f.directory, 'child.jsonl'), path.join(f.directory, 'linked.jsonl'));
        await assert.rejects(f.catalog.refresh(f.cwd), error => error.code === 'TASK_FILE');
    }
});
