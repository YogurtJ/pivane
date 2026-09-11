const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { scanUsage, LIMITS } = require('../server/pi-usage-worker');
const { usageQuery, PiUsageService } = require('../server/pi-usage-service');
const { descriptorPathSync } = require('../server/pi-file-descriptor');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-test-')));
process.env.PI_CODING_AGENT_DIR = path.join(temp, 'agent');
process.env.PI_PROJECT_ROOTS = path.join(temp, 'projects');
process.env.PI_WEB_DEFERRED_FILE = path.join(temp, 'deferred.json');
process.env.PI_OFFLINE = '1';
const root = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
const project = path.join(process.env.PI_PROJECT_ROOTS, 'a'), other = path.join(process.env.PI_PROJECT_ROOTS, 'b');
fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(other, { recursive: true });
const filter = { from: '2026-09-01', to: '2026-09-09', timeZone: 'Asia/Shanghai' };
const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, cost: { total: .2 } };
const message = (id, timestamp = '2026-09-08T16:00:00.000Z') => ({ type: 'message', id, parentId: null, timestamp,
    message: { role: 'assistant', provider: 'fixture', model: 'test', timestamp: Date.parse(timestamp), usage, content: [{ type: 'text', text: 'PRIVATE_TEXT\u2028\u2029' }] } });
function save(name, cwd, rows, created = '2026-09-01T00:00:00Z') {
    const folder = path.join(root, name); fs.mkdirSync(folder, { recursive: true });
    const filename = path.join(folder, `${name}.jsonl`);
    fs.writeFileSync(filename, [{ type: 'session', version: 3, id: name, timestamp: created, cwd }, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
    return filename;
}
const run = limits => scanUsage({ root, roots: [process.env.PI_PROJECT_ROOTS], filter }, limits);
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('usage aggregates all branches and summaries once, deduplicates native copies and omits retainedTail/body', () => {
    const old = message('shared'), second = message('branch');
    save('original', project, [old, second, { type: 'compaction', id: 'summary', timestamp: old.timestamp, usage, summary: 'PRIVATE_SUMMARY', retainedTail: [old.message] },
        { type: 'message', id: 'tool', timestamp: old.timestamp, message: { role: 'toolResult', usage, content: [] } }]);
    save('copy', other, [{ ...old, parentId: 'changed-by-export' }, message('new')], '2026-09-09T00:00:00Z');
    const value = run();
    assert.equal(scanUsage({ root, roots: [path.parse(project).root], filter }).total.total, value.total.total, 'filesystem root includes nested projects');
    assert.equal(value.total.total, 460 * 5); assert.equal(value.total.cost, 1);
    assert.equal(value.coverage.duplicates, 1); assert.equal(value.models.length, 2);
    assert.equal(value.daily.at(-1).total, 460 * 5); assert.equal(value.daily.at(-2).total, 0);
    assert.equal(value.projects.find(row => row.cwd === other).total, 460);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_TEXT|PRIVATE_SUMMARY|retainedTail|\.jsonl/);
    const narrower = scanUsage({ root, roots: [process.env.PI_PROJECT_ROOTS], filter: { ...filter, to: '2026-09-08' } });
    assert.equal(narrower.total.total, 0);
});
test('unknown/zero usage and cost remain distinguishable; same short ID with different payload is not removed', () => {
    const missing = message('missing'); delete missing.message.usage;
    const zero = message('zero'); zero.message.usage = { ...usage, cost: { total: 0 } };
    const noCost = message('noCost'); noCost.message.usage = { ...usage }; delete noCost.message.usage.cost;
    const collision = message('shared'); collision.message.content = [{ type: 'text', text: 'different' }];
    save('quality', project, [missing, zero, noCost, collision]);
    const value = run();
    assert.equal(value.total.missingUsage, 1); assert.equal(value.total.zeroCost, 1); assert.equal(value.total.missingCost, 1);
    assert.equal(value.total.records, 9); assert.equal(value.partial, true);
});
test('bounded scanner rejects malformed/large/nonregular/symlink/outside files and never modifies history', () => {
    const bad = save('bad', project, [message('bad')]); fs.appendFileSync(bad, '{broken\n');
    const external = save('outside', os.tmpdir(), [message('outside')]);
    fs.symlinkSync(external, path.join(root, 'bad', 'link.jsonl'));
    const before = fs.readFileSync(bad);
    const value = run(); assert.ok(value.coverage.skippedFiles >= 2); assert.equal(value.coverage.excludedProjects, 1);
    assert.equal(value.total.records, 9); assert.deepEqual(fs.readFileSync(bad), before);
    const limited = run({ ...LIMITS, files: 1 }); assert.equal(limited.coverage.limited, true);
    const tiny = run({ ...LIMITS, fileBytes: 10 }); assert.equal(tiny.total.total, 0); assert.ok(tiny.coverage.skippedFiles > 0);
});
test('scanner discards a file changed during reading and preserves its bytes', () => {
    const filename = save('race', project, [message('race')]);
    const actualRead = fs.readSync;
    let changed = false;
    try {
        fs.readSync = (...args) => {
            const count = actualRead(...args);
            if (!changed && descriptorPathSync(args[0]) === filename) {
                changed = true; fs.appendFileSync(filename, '\n');
            }
            return count;
        };
        const value = run(); assert.equal(changed, true); assert.equal(value.total.records, 9);
        assert.ok(value.coverage.skippedFiles >= 3);
    } finally { fs.readSync = actualRead; fs.unlinkSync(filename); }
});
test('surviving copies remain countable after original deletion', () => {
    const old = path.join(root, 'original', 'original.jsonl'), bytes = fs.readFileSync(old);
    try {
        fs.unlinkSync(old);
        const value = run(); assert.equal(value.coverage.duplicates, 0);
        assert.equal(value.projects.find(row => row.cwd === other).total, 920);
    } finally { fs.writeFileSync(old, bytes); }
});
test('date filters reject invalid dates, reversed/excessive ranges, unknown fields and invalid timezones', () => {
    assert.deepEqual(usageQuery(filter), filter);
    for (const query of [{ ...filter, from: '2026-02-30' }, { ...filter, to: '2025-01-01' }, { ...filter, to: '2029-01-01' },
        { ...filter, from: [] }, { ...filter, timeZone: '../bad' }, { ...filter, cwd: project }]) assert.throws(() => usageQuery(query));
});
test('native SessionManager fork/branch preserves dedup identity without reading/mutating another worker', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const native = SessionManager.create(project);
    native.appendMessage({ role: 'user', content: 'fixture', timestamp: Date.now() });
    native.appendMessage({ ...message('native').message, model: 'native-test' });
    const source = native.getSessionFile(), before = fs.readFileSync(source);
    const fork = SessionManager.forkFrom(source, other);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const value = scanUsage({ root, roots: [process.env.PI_PROJECT_ROOTS], filter: { from: date, to: date, timeZone: 'Asia/Shanghai' } });
    assert.equal(value.models.find(row => row.model === 'native-test').records, 1);
    assert.deepEqual(fs.readFileSync(source), before);
    fs.unlinkSync(source); fs.unlinkSync(fork.getSessionFile());
});
test('service shares in-flight queries, bounds concurrent scans and uses worker without model requests', async () => {
    const { PiSessionStore } = require('../server/pi-session-store');
    const service = new PiUsageService(new PiSessionStore());
    const a = service.report(filter), b = service.report(filter);
    await assert.rejects(service.report({ ...filter, to: '2026-09-08' }), error => error.statusCode === 429);
    assert.deepEqual(await a, await b); assert.equal(service.pending, null);
    assert.equal((await service.report(filter)).coverage.duplicates, 1);
});
test('usage HTTP route requires auth/origin, returns no-store aggregates and starts no RPC workers', async t => {
    process.env.PI_WEB_TOKEN = 'usage-fixture';
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway({ deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.PI_WEB_TOKEN; });
    const base = `http://127.0.0.1:${server.address().port}`, url = `${base}/api/pi/settings/usage?${new URLSearchParams(filter)}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer usage-fixture', Origin: 'https://outside.test' } })).status, 403);
    const headers = { Authorization: 'Bearer usage-fixture', Origin: base };
    const response = await fetch(url, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).total.records, 9);
    assert.equal((await fetch(url + '&bad=1', { headers })).status, 400);
    assert.equal((await (await fetch(base + '/api/pi/status', { headers })).json()).usageStats, true);
    assert.equal(gateway.supervisor.workers.size, 0); assert.equal(gateway.supervisor.ephemeralWorkers.size, 0);
});
