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
test('ledger refuses symlinks and corrupt storage instead of returning a zero report', async t => {
    const f = fixture(t); fs.mkdirSync(path.dirname(f.input.ledgerPath));
    fs.symlinkSync(f.file, f.input.ledgerPath);
    await assert.rejects(runLedger(f.input), /Unsafe usage ledger/);
    fs.unlinkSync(f.input.ledgerPath); fs.writeFileSync(f.input.ledgerPath, 'not a sqlite database');
    await assert.rejects(runLedger(f.input));
});
