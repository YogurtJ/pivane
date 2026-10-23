const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskCatalog } = require('../server/pi-task-catalog');
const { AgentMessages } = require('../server/pi-agent-messages');
const { MESSAGE_OUT, MESSAGE_IN, messageIdFor, outboundMessage } = require('../server/pi-agent-message-format');
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
for (const deliveredCount of [2, 2000]) test(`${deliveredCount} completed outbound messages cannot hide later pending intents from cold recovery`, async t => {
    const f = fixture(t, { outboxPerSession: deliveredCount });
    const messages = [...Array.from({ length: deliveredCount }, (_, index) => `old-${index}`), 'pending-three'].map(requestId => outboundMessage({
        version: 1, messageId: messageIdFor('sender', requestId), requestId,
        from: { sessionId: 'sender', cwd: f.cwd, name: 'Sender' }, to: { sessionId: 'target', cwd: f.cwd, name: 'Target' },
        text: requestId, wake: false, hop: 0, wakeSuppressed: null, conversationId: messageIdFor('sender', requestId), replyTo: null, sentAt: new Date().toISOString()
    }));
    f.write('sender.jsonl', [f.header('sender'), ...messages.map(data => ({ type: 'custom', customType: MESSAGE_OUT, data }))]);
    f.write('target.jsonl', [f.header('target'), ...messages.slice(0, deliveredCount).map(message => ({ type: 'custom_message', customType: MESSAGE_IN, details: { messageId: message.messageId } }))]);
    const ready = await complete(f.catalog, f.cwd);
    assert.equal(ready.complete, true);
    const sender = f.catalog.threads(await f.catalog.project(f.cwd)).find(row => row.id === 'sender');
    assert.equal(sender.outbox.length, deliveredCount + 1, 'delivered routing identities must not occupy pending-message slots');
    assert.deepEqual(sender.outbox.filter(message => message.text !== undefined).map(message => message.requestId), ['pending-three']);
    await f.catalog.dispose();
    const cold = new TaskCatalog({ store: f.catalog.store, directory: () => f.directory, limits: { outboxPerSession: deliveredCount } });
    const source = { cwd: f.cwd, sessionId: 'sender' };
    const service = new AgentMessages({ catalog: cold, supervisor: { workers: new Map([['sender', source]]), getActiveWorker: () => null }, limits: { pumpMs: 1e9, recoveryMs: 0 } });
    t.after(async () => { await service.dispose(); await cold.dispose(); });
    await service.recover();
    assert.deepEqual([...service.queue.keys()], [messages.at(-1).messageId]);
    assert.equal((await service.lookup(source, { messageId: messages.at(-1).messageId })).status, 'waiting-for-recipient');
});

test('too many pending outbound intents fail explicitly instead of reporting a truncated complete catalog', async t => {
    const f = fixture(t, { outboxPerSession: 2 });
    const pending = Array.from({ length: 3 }, (_, index) => {
        const requestId = `pending-${index}`;
        return { type: 'custom', customType: MESSAGE_OUT, data: outboundMessage({ version: 1, messageId: messageIdFor('sender', requestId), requestId,
            from: { sessionId: 'sender', cwd: f.cwd }, to: { sessionId: 'target', cwd: f.cwd }, text: requestId, wake: false, hop: 0,
            conversationId: messageIdFor('sender', requestId), replyTo: null, sentAt: new Date().toISOString() }) };
    });
    f.write('sender.jsonl', [f.header('sender'), ...pending]);
    f.write('target.jsonl', [f.header('target')]);
    await assert.rejects(f.catalog.refresh(f.cwd), error => error.code === 'TASK_OUTBOX_LIMIT');
    assert.equal((await f.catalog.project(f.cwd)).complete, false);
    // Completing one message releases the pending budget without deleting any source record.
    fs.appendFileSync(path.join(f.directory, 'target.jsonl'), JSON.stringify({ type: 'custom_message', customType: MESSAGE_IN,
        details: { messageId: pending[0].data.messageId } }) + '\n');
    assert.equal((await complete(f.catalog, f.cwd)).complete, true);
    assert.equal(f.catalog.threads(await f.catalog.project(f.cwd)).find(row => row.id === 'sender').outbox.length, 3);
});

test('cold recovery indexes delivered bodies larger than the metadata budget without retaining those bodies', async t => {
    const f = fixture(t, { batchBytes: 8192, metadataBytes: 65536 });
    const make = index => {
        const requestId = `large-${index}`;
        return { type: 'custom', customType: MESSAGE_OUT, data: outboundMessage({ version: 1, messageId: messageIdFor('sender', requestId), requestId,
            from: { sessionId: 'sender', cwd: f.cwd }, to: { sessionId: 'target', cwd: f.cwd }, text: index === 40 ? 'still pending' : 'x'.repeat(4000),
            wake: false, hop: 0, conversationId: messageIdFor('sender', requestId), replyTo: null, sentAt: new Date().toISOString() }) };
    };
    const outbound = Array.from({ length: 41 }, (_, index) => make(index));
    f.write('a-sender.jsonl', [f.header('sender'), ...outbound]);
    f.write('z-target.jsonl', [f.header('target'), ...outbound.slice(0, 40).map(entry => ({ type: 'custom_message', customType: MESSAGE_IN, details: { messageId: entry.data.messageId } }))]);
    assert.ok(fs.statSync(path.join(f.directory, 'a-sender.jsonl')).size > f.catalog.limits.metadataBytes);
    assert.equal((await complete(f.catalog, f.cwd)).complete, true);
    const source = f.catalog.threads(await f.catalog.project(f.cwd)).find(row => row.id === 'sender');
    assert.equal(source.outbox.length, 41);
    assert.deepEqual(source.outbox.filter(message => message.text !== undefined).map(message => message.text), ['still pending']);
    assert.ok((await f.catalog.project(f.cwd)).metadataBytes <= f.catalog.limits.metadataBytes);
});

test('repeated metadata-budget failures discard derived state instead of accumulating it', async t => {
    const f = fixture(t, { batchBytes: 8192, metadataBytes: 8192 });
    const outbound = Array.from({ length: 8 }, (_, index) => {
        const requestId = `pending-large-${index}`;
        return { type: 'custom', customType: MESSAGE_OUT, data: outboundMessage({ version: 1, messageId: messageIdFor('sender', requestId), requestId,
            from: { sessionId: 'sender', cwd: f.cwd }, to: { sessionId: 'target', cwd: f.cwd }, text: 'x'.repeat(4000), wake: false, hop: 0,
            conversationId: messageIdFor('sender', requestId), replyTo: null, sentAt: new Date().toISOString() }) };
    });
    f.write('sender.jsonl', [f.header('sender'), ...outbound]); f.write('target.jsonl', [f.header('target')]);
    for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(f.catalog.refresh(f.cwd), error => error.code === 'TASK_METADATA_LIMIT');
        const project = await f.catalog.project(f.cwd);
        assert.equal(project.complete, false); assert.equal(project.files.size, 0); assert.equal(project.metadataBytes, 0);
        assert.equal(project.outboundRead, null);
    }
});

test('located pending-body reads revalidate native identity and discard a change between header and body', async t => {
    const f = fixture(t);
    const requestId = 'located', messageId = messageIdFor('sender', requestId);
    const file = f.write('sender.jsonl', [f.header('sender'), { type: 'custom', customType: MESSAGE_OUT, data: outboundMessage({ version: 1, messageId, requestId,
        from: { sessionId: 'sender', cwd: f.cwd }, to: { sessionId: 'target', cwd: f.cwd }, text: 'pending body', wake: false, hop: 0,
        conversationId: messageId, replyTo: null, sentAt: new Date().toISOString() }) }]);
    f.write('target.jsonl', [f.header('target')]);
    const readBatch = f.catalog.readBatch.bind(f.catalog); let changed = false;
    f.catalog.readBatch = (...args) => {
        const bytes = readBatch(...args);
        if (args[1].selectOutboundId && !changed) {
            changed = true; fs.appendFileSync(file, JSON.stringify({ type: 'session_info', name: 'changed during body read' }) + '\n');
        }
        return bytes;
    };
    assert.equal((await complete(f.catalog, f.cwd)).complete, true); assert.equal(changed, true);
    const source = f.catalog.threads(await f.catalog.project(f.cwd)).find(row => row.id === 'sender');
    assert.equal(source.name, 'changed during body read'); assert.equal(source.outbox[0].text, 'pending body');
});

test('large histories are indexed in resumable batches, unchanged bodies are not re-read, and legacy task metadata survives', async t => {
    const f = fixture(t, { batchBytes: 2 * 1024 * 1024, milliseconds: 1000, refreshMilliseconds: 0 });
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
test('a growing caller larger than 8 MiB becomes complete on every refresh, including rewrites', async t => {
    const f = fixture(t);
    const file = f.write('source.jsonl', [f.header('parent')]);
    const padding = JSON.stringify({ type: 'custom', customType: 'fixture-padding', data: 'x'.repeat(1024 * 1024) }) + '\n';
    fs.appendFileSync(file, padding.repeat(13));
    for (let call = 0; call < 3; call++) {
        fs.appendFileSync(file, JSON.stringify({ type: 'session_info', name: `call-${call}` }) + '\n');
        const snapshot = await f.catalog.refresh(f.cwd);
        assert.equal(snapshot.complete, true, 'no background retry or quiet interval is needed');
        assert.equal((await f.catalog.source(f.cwd, 'parent')).name, `call-${call}`);
    }
    // Growing length alone must not authorize reuse of old metadata.
    const bytes = fs.readFileSync(file, 'utf8').replace('"id":"parent"', '"id":"edited"');
    fs.writeFileSync(file, bytes + JSON.stringify({ type: 'session_info', name: 'rewritten' }) + '\n');
    assert.equal((await f.catalog.refresh(f.cwd)).complete, true);
    await assert.rejects(f.catalog.source(f.cwd, 'parent'), error => error.code === 'TASK_SOURCE');
    assert.equal((await f.catalog.source(f.cwd, 'edited')).name, 'rewritten');
});

test('a change during a batch is re-read within the refresh budget', async t => {
    const f = fixture(t);
    const file = f.write('source.jsonl', [f.header('parent')]);
    const line = f.catalog.line.bind(f.catalog); let changed = false;
    f.catalog.line = (...args) => {
        line(...args);
        if (!changed) {
            changed = true;
            fs.appendFileSync(file, JSON.stringify({ type: 'session_info', name: 'appended during read' }) + '\n');
        }
    };
    assert.equal((await f.catalog.refresh(f.cwd)).complete, true);
    assert.equal((await f.catalog.source(f.cwd, 'parent')).name, 'appended during read');
});

test('multi-batch refresh shares its flight and stops for maintenance between batches', async t => {
    const f = fixture(t, { batchBytes: 64 });
    f.write('source.jsonl', [f.header('parent'), { type: 'session_info', name: 'x'.repeat(1000) }]);
    let paused = false, scans = 0;
    const scan = f.catalog.scan.bind(f.catalog);
    f.catalog.suspended = () => paused;
    f.catalog.scan = async project => { scans++; await scan(project); paused = true; };
    const outcomes = await Promise.allSettled([f.catalog.refresh(f.cwd), f.catalog.refresh(f.cwd)]);
    assert.equal(scans, 1, 'concurrent refreshes share one scan flight');
    for (const outcome of outcomes) { assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.code, 'TASK_SUSPENDED'); }
    assert.equal(f.catalog.busy, false);
    assert.equal((await f.catalog.project(f.cwd)).complete, false);
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
test('a session added during a batch stays incomplete even when directory timestamps do not change', async t => {
    const f = fixture(t, { refreshMilliseconds: 0 }); f.write('first.jsonl', [f.header('parent')]);
    // Model filesystems whose directory size and timestamps cannot distinguish
    // two additions in one clock tick. File identity checks remain real.
    const directoryStat = fs.lstatSync(f.directory, { bigint: true }), lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => file === f.directory ? directoryStat : lstat(file, ...args));
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

test('reply pagination pays one prefix scan to locate, then reads only the verified header and selected entry', async t => {
    const f = fixture(t), text = '中文😀'.repeat(20000);
    const reply = { type: 'message', id: 'reply', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'private' }] } };
    const file = f.write('child.jsonl', [f.header('child'), f.task('child'),
        { type: 'custom', customType: 'padding', data: 'x'.repeat(16 * 1024 * 1024) }, reply]);
    await complete(f.catalog, f.cwd);
    const before = f.catalog.bytesRead, readSync = fs.readSync, headerBytes = fs.readFileSync(file).indexOf(10) + 1;
    assert.equal(f.catalog.replyLocations.size, 0, 'discovery does not select reply positions');
    let bytesRead = 0, firstReadBytes = 0;
    t.mock.method(fs, 'readSync', (...args) => { const count = readSync(...args); bytesRead += count; return count; });
    let actual = '', offset = 0, pages = 0;
    do {
        const page = await f.catalog.reply(f.cwd, 'child', 'reply', offset);
        actual += page.text; offset = page.nextOffset; pages++;
        if (pages === 1) firstReadBytes = bytesRead;
    } while (offset !== null);
    assert.equal(actual, text); assert.equal(pages, 10);
    const entryBytes = Buffer.byteLength(JSON.stringify(reply) + '\n'), fileBytes = fs.statSync(file).size;
    assert.equal(firstReadBytes, fileBytes, 'first read locates using the original bounded scan');
    assert.equal(bytesRead - firstReadBytes, 9 * (headerBytes + entryBytes), 'subsequent pages read only header and selected entry');
    assert.equal(f.catalog.bytesRead - before, bytesRead);
    assert.ok(bytesRead < fileBytes * 1.15);
    t.diagnostic(JSON.stringify({ worktree: process.cwd(), pages, fileBytes, firstReadBytes, subsequentPageBytes: headerBytes + entryBytes,
        subsequentPagesBytes: bytesRead - firstReadBytes, bytesRead, previousPrefixBytes: fileBytes * pages }));
});

test('reply offsets are disposable and bounded, including lines spanning scan batches', async t => {
    const f = fixture(t, { replyLocationBytes: 512, batchBytes: 127, refreshMilliseconds: 0 });
    const replies = Array.from({ length: 12 }, (_, i) => ({ type: 'message', id: `reply-${i}`, message: { role: 'assistant', content: `第${i}😀`.repeat(300) } }));
    const file = f.write('child.jsonl', [f.header('child'), f.task('child'), ...replies]);
    await complete(f.catalog, f.cwd);
    assert.equal(f.catalog.replyLocations.size, 0);
    const before = f.catalog.bytesRead;
    assert.equal((await f.catalog.reply(f.cwd, 'child', 'reply-11')).text, replies[11].message.content);
    assert.equal(f.catalog.bytesRead - before, fs.statSync(file).size, 'first read locates the last entry across batches');
    const located = f.catalog.bytesRead;
    assert.equal((await f.catalog.reply(f.cwd, 'child', 'reply-11')).text, replies[11].message.content);
    assert.equal(f.catalog.bytesRead - located, fs.readFileSync(file).indexOf(10) + 1 + Buffer.byteLength(JSON.stringify(replies[11]) + '\n'));
    for (let i = 0; i < replies.length; i++) {
        await f.catalog.reply(f.cwd, 'child', `reply-${i}`);
        assert.ok(f.catalog.replyLocationBytes <= 512); assert.ok(f.catalog.replyLocations.size < replies.length);
    }
    f.catalog.replyLocations.clear(); f.catalog.replyLocationBytes = 0;
    assert.equal((await f.catalog.reply(f.cwd, 'child', 'reply-0')).text, replies[0].message.content, 'evicted hints fall back to scanning native bytes');
});

test('reply ranges reject append, truncation, rewrite, and replacement after verified discovery', async t => {
    for (const mutation of ['append', 'truncate', 'rewrite', 'replace']) {
        await t.test(mutation, async t => {
            const f = fixture(t);
            const entries = [f.header('child'), f.task('child'), { type: 'message', id: 'reply', message: { role: 'assistant', content: 'original' } }];
            const file = f.write('child.jsonl', entries);
            await complete(f.catalog, f.cwd);
            await f.catalog.reply(f.cwd, 'child', 'reply');
            if (mutation === 'append') fs.appendFileSync(file, '{}\n');
            if (mutation === 'truncate') fs.truncateSync(file, 20);
            if (mutation === 'rewrite') {
                fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('original', 'modified'));
                // Some filesystems coalesce immediate same-size writes into one
                // timestamp tick. Give this revision a deterministic new mtime.
                fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
            }
            if (mutation === 'replace') fs.renameSync(f.write('new', entries), file);
            await assert.rejects(f.catalog.reply(f.cwd, 'child', 'reply'), error => error.code === 'TASK_CHANGED');
        });
    }
});

test('reply changes after decoding fail, and concurrent reads reserve the existing maintenance budget', async t => {
    const f = fixture(t);
    const file = f.write('child.jsonl', [f.header('child'), f.task('child'), { type: 'message', id: 'reply', message: { role: 'assistant', content: 'answer' } }]);
    await complete(f.catalog, f.cwd);
    const line = f.catalog.line.bind(f.catalog); let changed = false;
    f.catalog.line = (...args) => {
        line(...args);
        if (!changed && args[1].selectedText !== undefined) { changed = true; setImmediate(() => fs.appendFileSync(file, '{}\n')); }
    };
    const one = f.catalog.reply(f.cwd, 'child', 'reply'), two = f.catalog.reply(f.cwd, 'child', 'reply');
    assert.equal(f.catalog.busy, true);
    await assert.rejects(f.catalog.reply(f.cwd, 'child', 'reply'), /busy/);
    for (const outcome of await Promise.allSettled([one, two])) {
        assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.code, 'TASK_CHANGED');
    }
    assert.equal(f.catalog.busy, false);
    assert.equal(f.catalog.replyLocations.size, 0, 'failed final proof never publishes a selected location');
    await complete(f.catalog, f.cwd);
    f.catalog.suspended = () => true;
    await assert.rejects(f.catalog.reply(f.cwd, 'child', 'reply'), error => error.code === 'TASK_RESULT_LIMIT');
});

test('located replies still decode the native header and match the requested session even when stat revisions collide', async t => {
    const f = fixture(t);
    const file = f.write('child.jsonl', [f.header('child'), f.task('child'), { type: 'message', id: 'reply', message: { role: 'assistant', content: 'answer' } }]);
    await complete(f.catalog, f.cwd);
    await f.catalog.reply(f.cwd, 'child', 'reply');
    const stat = fs.statSync(file, { bigint: true }), fstat = fs.fstatSync, lstat = fs.lstatSync;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"id":"child"', '"id":"other"'));
    // Model an equal-size overwrite within one timestamp tick. Header semantics
    // are independently checked; they must not be inferred from a location hint.
    t.mock.method(fs, 'fstatSync', (fd, ...args) => { const now = fstat(fd, ...args); return now.ino === stat.ino ? stat : now; });
    t.mock.method(fs, 'lstatSync', (filename, ...args) => filename === file ? stat : lstat(filename, ...args));
    await assert.rejects(f.catalog.reply(f.cwd, 'child', 'reply'), error => error.code === 'TASK_RESULT_MISSING');
});

test('duplicate reply IDs preserve the original batch choice through discovery, other reads, eviction and rebuild', async t => {
    for (const acrossBatches of [true, false]) {
        await t.test(acrossBatches ? 'duplicates across 8 MiB batches select FIRST' : 'duplicates in one 64 KiB block select SECOND', async t => {
            const f = fixture(t, { milliseconds: 10000 });
            const first = 'FIRST' + 'a'.repeat(acrossBatches ? 31995 : 11995);
            const second = 'SECOND' + 'b'.repeat(acrossBatches ? 31994 : 11994);
            const message = (id, content, role = 'assistant') => ({ type: 'message', id, message: { role, content } });
            const entries = [f.header('child'), f.task('child'), message('same', first)];
            if (acrossBatches) entries.push(message('padding', 'x'.repeat(9 * 1024 * 1024), 'toolResult'));
            entries.push(message('same', second), message('other', 'OTHER'));
            const file = f.write('child.jsonl', entries), expected = acrossBatches ? first : second;
            if (!acrossBatches) assert.ok(fs.statSync(file).size < 65536, 'duplicates share one read block');
            await complete(f.catalog, f.cwd);
            assert.equal(f.catalog.replyLocations.size, 0, 'normal discovery makes no reply selection');
            const key = JSON.stringify([file, 'same']);
            const page = await f.catalog.reply(f.cwd, 'child', 'same');
            assert.equal(page.text, expected.slice(0, 8000)); assert.equal(page.totalCharacters, expected.length);
            const chosen = { ...f.catalog.replyLocations.get(key) };
            assert.ok(chosen.length > 0);
            f.catalog.projects.clear(); await complete(f.catalog, f.cwd);
            assert.deepEqual(f.catalog.replyLocations.get(key), chosen, 'full inventory rebuild does not overwrite the selected position');
            assert.equal((await f.catalog.reply(f.cwd, 'child', 'same', page.nextOffset)).text, expected.slice(8000, 16000));
            assert.equal((await f.catalog.reply(f.cwd, 'child', 'other')).text, 'OTHER');
            assert.deepEqual(f.catalog.replyLocations.get(key), chosen, 'scanning for another entry does not select same');
            assert.equal((await f.catalog.reply(f.cwd, 'child', 'same')).text, expected.slice(0, 8000));
            // Force one hint to fit and two to exceed the budget independently
            // of temporary-path length and platform-specific identity size.
            const evictionBudget = Math.max(...[...f.catalog.replyLocations.values()].map(location => location.bytes));
            f.catalog.limits.replyLocationBytes = evictionBudget;
            await f.catalog.reply(f.cwd, 'child', 'other');
            assert.equal(f.catalog.replyLocations.has(key), false, 'another selected entry evicts the bounded hint');
            assert.ok(f.catalog.replyLocationBytes <= evictionBudget);
            f.catalog.projects.clear(); await complete(f.catalog, f.cwd);
            const resumed = await f.catalog.reply(f.cwd, 'child', 'same', 8000);
            assert.equal(resumed.text, expected.slice(8000, 16000)); assert.equal(resumed.totalCharacters, expected.length);
            assert.equal(resumed.nextOffset, expected.length > 16000 ? 16000 : null);
            let actual = expected.slice(0, 8000) + resumed.text, offset = resumed.nextOffset;
            while (offset !== null) {
                const next = await f.catalog.reply(f.cwd, 'child', 'same', offset);
                actual += next.text; offset = next.nextOffset;
            }
            assert.equal(actual, expected, 'pages never switch to the other duplicate');
        });
    }
});
