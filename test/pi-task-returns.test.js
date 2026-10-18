const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskReturns, receiveTaskReturn } = require('../server/pi-task-returns');

test('result delivery waits for the source, never starts a worker, and recovers a lost acknowledgement without duplicates', async t => {
    const parent = { receipts: new Set(), read: new Set(), path: '/parent' };
    const child = { sourceMatches: true, session: { id: 'child', cwd: '/fixture', name: 'Task' },
        task: { requestId: 'one', source: { sessionId: 'parent' }, returnResults: true },
        results: [{ resultId: 'run', outcome: 'completed', completedAt: '2026-01-01', preview: 'Reported result' }] };
    let idle = false, calls = 0;
    const worker = { cwd: '/fixture', sessionId: 'parent', isIdle: () => idle, async taskReturn({ result }) {
        calls++; parent.receipts.add(result.deliveryId); throw new Error('Lost acknowledgement after persistence');
    } };
    const supervisor = { workers: new Map(), getActiveWorker: () => worker };
    const service = new TaskReturns({ catalog: { refresh: async () => ({ complete: true, records: [child] }), source: async () => parent }, supervisor, isSuspended: () => false });
    t.after(() => service.dispose());
    await service.pump(); assert.equal(calls, 0, 'closed source is not started');
    supervisor.workers.set('/parent', worker);
    await service.pump(); assert.equal(calls, 0, 'busy source is not interrupted');
    idle = true; await service.pump(); await service.pump(); assert.equal(calls, 1);
    child.results.push({ resultId: 'second-run', outcome: 'stopped', completedAt: '2026-01-02', preview: '' });
    await service.pump(); assert.equal(calls, 2, 'another real run has its own receipt');
    child.task.returnResults = undefined;
    assert.equal((await service.list('/fixture', 'parent')).results.length, 0, 'old tasks are not flooded into the new inbox');
});

test('managed receipt append is idle-only, deduplicated, Agent-origin, and does not trigger a turn', async t => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.inMemory('/fixture'); let idle = true, starts = 0, sends = 0;
    const ctx = { cwd: '/fixture', isIdle: () => idle, hasPendingMessages: () => false, sessionManager: manager };
    const pi = { sendMessage(message, options) { sends++; if (options.triggerTurn) starts++; manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
        appendEntry(type, data) { manager.appendCustomEntry(type, data); } };
    const result = { sourceSessionId: manager.getSessionId(), deliveryId: 'a'.repeat(64), session: { cwd: '/fixture', id: 'child', name: '<script>unsafe()</script>' }, requestId: 'one', preview: 'A result', status: 'completed' };
    idle = false; assert.throws(() => receiveTaskReturn(pi, ctx, { result }), /busy/); assert.equal(sends, 0);
    idle = true; receiveTaskReturn(pi, ctx, { result }); receiveTaskReturn(pi, ctx, { result, read: true });
    assert.equal(sends, 1); assert.equal(starts, 0);
    assert.equal(manager.getEntries().filter(e => e.customType === 'pivane-agent-task-read').length, 1);
    assert.match(manager.getEntries().find(e => e.customType === 'pivane-agent-task-result').content, /not a new user instruction/);
    assert.throws(() => receiveTaskReturn(pi, ctx, { result: { ...result, sourceSessionId: 'other' } }), /identity/);
    assert.throws(() => receiveTaskReturn(pi, ctx, { result: { ...result, session: { ...result.session, cwd: '/other' } } }), /identity/);
});

function catalogFixture(t) {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { TaskCatalog } = require('../server/pi-task-catalog');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-task-returns-')));
    const cwd = path.join(root, 'project'), directory = path.join(root, 'sessions');
    fs.mkdirSync(cwd); fs.mkdirSync(directory);
    const catalog = new TaskCatalog({ store: { resolveProject: value => { assert.equal(value, cwd); return cwd; } }, directory: () => directory });
    const header = id => ({ type: 'session', version: 3, id, cwd });
    const write = (id, entries) => fs.writeFileSync(path.join(directory, `${id}.jsonl`), [header(id), ...entries].map(e => JSON.stringify(e)).join('\n') + '\n');
    const append = (id, entry) => fs.appendFileSync(path.join(directory, `${id}.jsonl`), JSON.stringify(entry) + '\n');
    const child = (id, source, runs) => write(id, [
        { type: 'custom', customType: 'pivane-agent-task', data: { version: 1, sessionId: id, requestId: id, source: { cwd, sessionId: source }, returnResults: true } },
        ...Array.from({ length: runs }, (_, i) => ({ type: 'custom', customType: 'pivane-agent-task-state', data: { version: 2, sessionId: id,
            status: 'settled', resultId: `run-${i}`, outcome: 'completed', completedAt: `2026-01-${String(i + 1).padStart(2, '0')}`, preview: 'result' } }))]);
    t.after(async () => { await catalog.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    return { cwd, catalog, write, append, child };
}

test('one pump shares a verified inventory across 20 workers and 200 native files, while public refresh stays fresh', async t => {
    const f = catalogFixture(t), workers = new Map();
    for (let i = 0; i < 200; i++) f.write(`source-${i}`, []);
    for (let i = 0; i < 20; i++) workers.set(i, { cwd: f.cwd, sessionId: `source-${i}`, isIdle: () => true, taskReturn: () => assert.fail('no pending results') });
    assert.equal((await f.catalog.refresh(f.cwd)).complete, true);
    const scan = f.catalog.scan.bind(f.catalog), readBatch = f.catalog.readBatch.bind(f.catalog);
    let scans = 0, descriptorVerifications = 0;
    f.catalog.scan = async (...args) => { scans++; return scan(...args); };
    f.catalog.readBatch = (...args) => { descriptorVerifications++; return readBatch(...args); };
    const service = new TaskReturns({ catalog: f.catalog, supervisor: { workers }, isSuspended: () => false });
    t.after(() => service.dispose());
    await service.pump();
    assert.equal(scans, 1); assert.equal(descriptorVerifications, 200);
    t.diagnostic(JSON.stringify({ worktree: process.cwd(), workers: 20, files: 200, scans, descriptorVerifications, previousScans: 20, previousDescriptorVerifications: 4000 }));
    f.child('late-child', 'source-0', 1);
    assert.equal((await service.list(f.cwd, 'source-0')).results.length, 1, 'a pump snapshot never serves later lookups');
    assert.equal((await f.catalog.refresh(f.cwd)).records[0].task.requestId, 'late-child', 'creation deduplication gets a newly verified inventory');
});

test('multiple receipt writes reverify inventory, discover intervening tasks, and keep the five-delivery budget', async t => {
    const f = catalogFixture(t); f.write('parent', []); f.child('child', 'parent', 6);
    let calls = 0;
    const delivered = new Set();
    const worker = { cwd: f.cwd, sessionId: 'parent', isIdle: () => true, async taskReturn({ result }) {
        assert.equal(delivered.has(result.deliveryId), false, 'new list excludes every persisted receipt');
        delivered.add(result.deliveryId); calls++;
        f.append('parent', { type: 'custom_message', customType: 'pivane-agent-task-result', details: result });
        if (calls === 1) f.child('late', 'parent', 1);
    } };
    const service = new TaskReturns({ catalog: f.catalog, supervisor: { workers: new Map([['parent', worker]]) }, isSuspended: () => false });
    t.after(() => service.dispose());
    await service.pump(); assert.equal(calls, 5);
    await service.pump(); assert.equal(calls, 7);
    await service.pump(); assert.equal(calls, 7);
    assert.equal((await service.list(f.cwd, 'parent')).results.filter(r => r.delivered).length, 7);
});

test('late failed acknowledgement remains busy until settled, invalidates shared inventory, and never replays a persisted receipt', async t => {
    const f = catalogFixture(t); f.write('parent', []); f.write('other', []); f.child('child', 'parent', 1);
    let rejectDelivery, started;
    const entered = new Promise(resolve => { started = resolve; });
    let calls = 0, otherChecked = false;
    const worker = { cwd: f.cwd, sessionId: 'parent', isIdle: () => true, taskReturn({ result }) {
        calls++; f.append('parent', { type: 'custom_message', customType: 'pivane-agent-task-result', details: result });
        started(); return new Promise((resolve, reject) => { rejectDelivery = reject; });
    } };
    const other = { cwd: f.cwd, sessionId: 'other', isIdle: () => { otherChecked = true; return true; } };
    const service = new TaskReturns({ catalog: f.catalog, supervisor: { workers: new Map([['parent', worker], ['other', other]]) }, isSuspended: () => false });
    t.after(() => service.dispose());
    const scan = f.catalog.scan.bind(f.catalog); let scans = 0;
    f.catalog.scan = async (...args) => { scans++; return scan(...args); };
    const flight = service.pump(); await entered;
    assert.equal(service.busy, true); assert.equal(otherChecked, false);
    const duplicatePump = service.pump();
    rejectDelivery(new Error('late acknowledgement lost')); await Promise.all([flight, duplicatePump]);
    assert.equal(otherChecked, true); assert.equal(scans, 2, 'the next worker revalidates after an uncertain write');
    await service.pump(); assert.equal(calls, 1);
    assert.equal(service.busy, false);
});

test('maintenance stops further deliveries and disposal awaits an in-flight native return', async t => {
    const f = catalogFixture(t); f.write('parent', []); f.child('child', 'parent', 2);
    let suspended = false, finish, entered;
    const started = new Promise(resolve => { entered = resolve; }); let calls = 0;
    const worker = { cwd: f.cwd, sessionId: 'parent', isIdle: () => true, taskReturn() {
        calls++; entered(); return new Promise(resolve => { finish = resolve; });
    } };
    const service = new TaskReturns({ catalog: f.catalog, supervisor: { workers: new Map([['parent', worker]]) }, isSuspended: () => suspended });
    const flight = service.pump(); await started; suspended = true;
    let disposed = false; const disposal = service.dispose().then(() => { disposed = true; });
    await Promise.resolve(); assert.equal(disposed, false); assert.equal(service.busy, true);
    finish(); await Promise.all([flight, disposal]);
    assert.equal(calls, 1); assert.equal(service.busy, false);
});

test('pump revalidates nonadjacent projects and delivers A2 once after A1, B..I exceeds the catalog budget', async t => {
    for (const count of [2, 9]) {
        await t.test(`${count} projects with a nonadjacent A2`, async t => {
            const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
            const { TaskCatalog } = require('../server/pi-task-catalog');
            const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-task-return-projects-')));
            const projects = Array.from({ length: count }, (_, i) => {
                const cwd = path.join(root, String.fromCharCode(65 + i)), directory = path.join(root, `sessions-${i}`);
                fs.mkdirSync(cwd); fs.mkdirSync(directory);
                const write = (id, entries = []) => fs.writeFileSync(path.join(directory, `${id}.jsonl`),
                    [{ type: 'session', version: 3, id, cwd }, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n');
                write('source');
                return { cwd, directory, write };
            });
            const catalog = new TaskCatalog({ store: { resolveProject: value => { assert.ok(projects.some(p => p.cwd === value)); return value; } },
                directory: cwd => projects.find(p => p.cwd === cwd).directory });
            t.after(async () => { await catalog.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
            const a = projects[0]; a.write('A2');
            a.write('child', [
                { type: 'custom', customType: 'pivane-agent-task', data: { version: 1, sessionId: 'child', requestId: 'task',
                    source: { cwd: a.cwd, sessionId: 'A2' }, returnResults: true } },
                { type: 'custom', customType: 'pivane-agent-task-state', data: { version: 2, sessionId: 'child', status: 'settled', resultId: 'run', outcome: 'completed' } }
            ]);
            const project = catalog.project.bind(catalog), refresh = catalog.refresh.bind(catalog);
            let uses = 0, refreshes = 0, maxCatalogProjects = 0;
            catalog.project = async (...args) => { const value = await project(...args); value.used = ++uses; return value; };
            catalog.refresh = async (...args) => { refreshes++; const value = await refresh(...args); maxCatalogProjects = Math.max(maxCatalogProjects, catalog.projects.size); return value; };
            const workers = new Map(projects.map(p => [p.cwd, { cwd: p.cwd, sessionId: 'source', isIdle: () => true,
                taskReturn: () => assert.fail('only A2 owns the task') }]));
            let deliveries = 0;
            workers.set('A2', { cwd: a.cwd, sessionId: 'A2', isIdle: () => true, async taskReturn({ result }) {
                deliveries++;
                fs.appendFileSync(path.join(a.directory, 'A2.jsonl'), JSON.stringify({ type: 'custom_message', customType: 'pivane-agent-task-result', details: result }) + '\n');
            } });
            const service = new TaskReturns({ catalog, supervisor: { workers }, isSuspended: () => false });
            t.after(() => service.dispose());
            await service.pump();
            assert.equal(deliveries, 1, 'A2 refreshes after the intervening projects, even when A was evicted');
            assert.equal(refreshes, count + 2, 'every cwd switch refreshes; one extra refresh verifies the receipt');
            await service.pump();
            assert.equal(deliveries, 1, 'a second full pump neither misses nor duplicates A2');
            assert.equal(refreshes, 2 * count + 3, 'even below the catalog limit, nonadjacent snapshots are not retained');
            assert.ok(maxCatalogProjects <= catalog.limits.projects);
            t.diagnostic(JSON.stringify({ worktree: process.cwd(), projectCount: count, rounds: 2, deliveries, refreshes,
                maxCatalogProjects, snapshotPolicy: 'one adjacent project; discard before every cwd switch' }));
        });
    }
});
