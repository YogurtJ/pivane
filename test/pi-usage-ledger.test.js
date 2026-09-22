const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageLedger, runLedger } = require('../server/pi-usage-ledger');
const { officialPrices, estimateCost } = require('../server/pi-usage-pricing');
const { LIMITS } = require('../server/pi-usage-worker');
function fixture(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'sessions'), project = path.join(base, 'project');
    fs.mkdirSync(project); fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    const file = path.join(root, 'a', 'a.jsonl');
    const header = { type: 'session', id: 'a', version: 3, cwd: project, timestamp: '2026-01-01T00:00:00Z' };
    const message = (id, timestamp = '2026-09-20T23:30:00Z') => ({ type: 'message', id, timestamp,
        message: { role: 'assistant', model: 'gpt-5.6-sol', provider: 'custom', usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, cost: { total: 0 } },
            content: [{ type: 'text', text: 'PRIVATE_BODY' }] } });
    fs.writeFileSync(file, [header, message('one')].map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = { root, roots: [base], ledgerPath: path.join(base, 'ledger', 'ledger.sqlite'),
        filter: { from: '2026-09-01', to: '2026-09-30', timeZone: 'Asia/Shanghai' } };
    return { base, root, project, file, header, message, input };
}
test('durable daily/weekly/monthly totals survive deletion, restart, new timezone and copied imports', async t => {
    const f = fixture(t), before = fs.readFileSync(f.file);
    const first = await runLedger(f.input);
    assert.equal(first.total.records, 1); assert.equal(first.total.estimatedRecords, 1);
    assert.equal(first.total.cost, .0062); assert.equal(first.total.recordedCost, 0);
    assert.equal(first.daily.find(row => row.date === '2026-09-21').total, 1600);
    assert.equal(first.weekly.find(row => row.date === '2026-09-21').total, 1600);
    assert.equal(first.monthly[0].total, 1600);
    assert.deepEqual(fs.readFileSync(f.file), before);
    const second = await runLedger(f.input);
    assert.equal(second.coverage.scannedFiles, 0); assert.equal(second.coverage.cachedFiles, 1);
    fs.unlinkSync(f.file);
    const deleted = await runLedger(f.input); assert.deepEqual(deleted.total, first.total);
    const utc = await runLedger({ ...f.input, filter: { ...f.input.filter, timeZone: 'UTC' } });
    assert.equal(utc.daily.find(row => row.date === '2026-09-20').total, 1600);
    fs.writeFileSync(f.file, before);
    fs.mkdirSync(path.join(f.root, 'b')); fs.writeFileSync(path.join(f.root, 'b', 'copy.jsonl'), before);
    assert.deepEqual((await runLedger(f.input)).total, first.total);
    const ledger = new UsageLedger(f.input.ledgerPath);
    try {
        const fact = ledger.db.prepare('SELECT data FROM facts').get().data;
        assert.doesNotMatch(fact, /PRIVATE_BODY|content|summary/);
        assert.equal(JSON.parse(fact).pricing.appliedRates.input, 4);
    } finally { ledger.close(); }
});
test('append ingests only new facts; transaction rollback cannot double book and roots stay isolated', async t => {
    const f = fixture(t); await runLedger(f.input);
    fs.appendFileSync(f.file, JSON.stringify(f.message('two')) + '\n');
    const ledger = new UsageLedger(f.input.ledgerPath), catalog = await officialPrices();
    const original = ledger.saveDay;
    try {
        ledger.saveDay = () => { throw new Error('simulated disk failure'); };
        assert.throws(() => ledger.sync(f.input, catalog), /simulated/);
        assert.equal(ledger.db.prepare('SELECT count(*) AS n FROM facts').get().n, 1);
        ledger.saveDay = original;
        ledger.sync(f.input, catalog);
        assert.equal(ledger.report(f.input.filter, f.input.roots, {}).total.records, 2);
        assert.equal(ledger.report(f.input.filter, [path.join(f.base, 'elsewhere')], {}).total.records, 0);
    } finally { ledger.close(); }
    assert.equal((await runLedger(f.input)).total.records, 2);
});
test('bounded ingestion progresses past cached files and refuses unsafe deletion checkpoints', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'a', 'b.jsonl'), [f.header, f.message('two')].map(row => JSON.stringify(row)).join('\n') + '\n');
    const limited = { ...f.input, limits: { ...LIMITS, files: 1 } };
    assert.equal((await runLedger(limited)).coverage.limited, true);
    assert.equal((await runLedger(limited)).total.records, 2);
    fs.appendFileSync(f.file, '{broken');
    await assert.rejects(runLedger({ ...f.input, onlyFile: f.file }), /尚未完整入账/);
    assert.equal((await runLedger(f.input)).partial, true);
    fs.unlinkSync(f.file);
    await assert.rejects(runLedger({ ...f.input, onlyFile: f.file }), /尚未完整入账/);
});
test('exact official IDs, long-context tiers, zero prices and recorded charges remain distinguishable', async () => {
    const catalog = await officialPrices();
    const base = { model: 'gpt-5.6-sol', usage: { input: 272000, output: 1000, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
    assert.equal(estimateCost(base, catalog).pricing.appliedRates.input, 4);
    assert.equal(estimateCost({ ...base, usage: { ...base.usage, cacheRead: 1 } }, catalog).pricing.appliedRates.input, 8);
    assert.equal(estimateCost({ ...base, model: 'gpt-5.6' }, catalog).pricing, null);
    assert.equal(estimateCost({ ...base, model: 'grok-4.6-build' }, catalog).pricing, null);
    assert.deepEqual(estimateCost({ ...base, cost: 5 }, catalog), { cost: 5, pricing: null });
    assert.equal(estimateCost({ ...base, model: 'gemini-3.8-flash', usage: { ...base.usage, cacheWrite: 10 } }, catalog).pricing, null);
    const rates = { input: 4, output: 20, cacheRead: .4, cacheWrite: 5 };
    const cacheRow = { ...base, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000000, cacheWrite1h: 1000000 } };
    assert.equal(estimateCost(cacheRow, new Map([[base.model, { rates }]])).cost, 8);
    assert.equal(estimateCost(base, new Map([[base.model, { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]])).pricing, null);
});
test('append checkpoints verify old bytes but only parse the new suffix, including renamed sessions', async t => {
    const f = fixture(t);
    fs.appendFileSync(f.file, JSON.stringify({ type: 'message', id: 'large', timestamp: '2026-09-20T23:30:00Z',
        message: { role: 'user', content: 'x'.repeat(2 * 1024 * 1024) } }) + '\n');
    await runLedger(f.input);
    const oldBytes = fs.statSync(f.file).size;
    const suffix = [f.message('two'), { type: 'session_info', name: 'Renamed' }].map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.appendFileSync(f.file, suffix);
    const value = await runLedger({ ...f.input, limits: { ...LIMITS, entries: 2, records: 1 } });
    assert.equal(value.partial, false); assert.equal(value.total.records, 2);
    assert.equal(value.coverage.appendedFiles, 1);
    assert.equal(value.coverage.parsedBytes, Buffer.byteLength(suffix));
    assert.equal(value.coverage.verifiedBytes, oldBytes);
    assert.equal(value.sessions[0].name, 'Renamed');
    const again = await runLedger(f.input);
    assert.equal(again.coverage.parsedBytes, 0); assert.equal(again.coverage.verifiedBytes, 0);
});
test('prefix edits plus growth, same-size rewrites, truncation and replaced files cannot bypass reconciliation', async t => {
    const f = fixture(t); await runLedger(f.input);
    const original = fs.readFileSync(f.file, 'utf8');
    fs.writeFileSync(f.file, original.replace('"one"', '"ONE"') + JSON.stringify(f.message('two')) + '\n');
    let value = await runLedger(f.input);
    assert.equal(value.coverage.appendedFiles, 0); assert.equal(value.total.records, 3);
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('"two"', '"TWO"'));
    value = await runLedger(f.input); assert.equal(value.total.records, 4); assert.equal(value.coverage.appendedFiles, 0);
    fs.writeFileSync(f.file, original); value = await runLedger(f.input);
    assert.equal(value.total.records, 4); assert.equal(value.coverage.appendedFiles, 0);
    const replacement = f.file + '.replacement';
    fs.writeFileSync(replacement, original + JSON.stringify(f.message('three')) + '\n'); fs.renameSync(replacement, f.file);
    value = await runLedger(f.input); assert.equal(value.total.records, 5); assert.equal(value.coverage.appendedFiles, 0);
});
test('incomplete append, missing newline, old schema and checkpoint rollback retain all accounting', async t => {
    const f = fixture(t); await runLedger(f.input);
    const suffix = JSON.stringify(f.message('two')) + '\n';
    fs.appendFileSync(f.file, suffix.slice(0, -5));
    assert.equal((await runLedger(f.input)).partial, true);
    await assert.rejects(runLedger({ ...f.input, onlyFile: f.file }), /尚未完整入账/);
    fs.appendFileSync(f.file, suffix.slice(-5));
    assert.equal((await runLedger(f.input)).total.records, 2);
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').trimEnd());
    await runLedger(f.input);
    fs.appendFileSync(f.file, '\n' + JSON.stringify(f.message('three')) + '\n');
    const value = await runLedger(f.input); assert.equal(value.total.records, 3); assert.equal(value.coverage.appendedFiles, 0);
    const ledger = new UsageLedger(f.input.ledgerPath);
    ledger.db.exec('DROP TABLE checkpoints'); ledger.close();
    const upgraded = await runLedger(f.input);
    assert.deepEqual(upgraded.total, value.total); assert.equal(upgraded.coverage.scannedFiles, 1);
    assert.equal((await runLedger(f.input)).coverage.cachedFiles, 1);
});
test('a file changing during prefix verification does not advance its cursor or totals', async t => {
    const f = fixture(t); await runLedger(f.input);
    fs.appendFileSync(f.file, JSON.stringify(f.message('two')) + '\n');
    const read = fs.readSync; let changed = false;
    const { descriptorPathSync } = require('../server/pi-file-descriptor');
    const mocked = t.mock.method(fs, 'readSync', (...args) => {
        const result = read(...args);
        if (!changed && descriptorPathSync(args[0]) === f.file) { changed = true; fs.appendFileSync(f.file, '\n'); }
        return result;
    });
    const during = await runLedger(f.input); assert.equal(changed, true);
    assert.equal(during.partial, true); assert.equal(during.total.records, 1);
    mocked.mock.restore();
    const after = await runLedger(f.input); assert.equal(after.partial, false); assert.equal(after.total.records, 2);
});
test('background usage sync runs every five minutes and disposal clears it', async t => {
    const { PiUsageService } = require('../server/pi-usage-service');
    const timer = { unref() {} }; let interval, cleared;
    t.mock.method(global, 'setInterval', (callback, milliseconds) => { interval = milliseconds; return timer; });
    t.mock.method(global, 'clearInterval', value => { cleared = value; });
    const service = new PiUsageService({ roots: [] }); service.start();
    assert.equal(interval, 300000); await service.dispose(); assert.equal(cleared, timer);
});
test('ledger refuses symlinks and corrupt storage instead of returning a zero report', async t => {
    const f = fixture(t); fs.mkdirSync(path.dirname(f.input.ledgerPath));
    fs.symlinkSync(f.file, f.input.ledgerPath);
    await assert.rejects(runLedger(f.input), /Unsafe usage ledger/);
    fs.unlinkSync(f.input.ledgerPath); fs.writeFileSync(f.input.ledgerPath, 'not a sqlite database');
    await assert.rejects(runLedger(f.input));
});
