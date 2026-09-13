const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-prompts-')));
const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json');
delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
fs.mkdirSync(agent);
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false }));
const { PiSessionStore } = require('../server/pi-session-store');
const { PiNativeService } = require('../server/pi-native-service');
const { PiSystemPromptService, readPrompt } = require('../server/pi-system-prompt-service');
const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');
const native = new PiNativeService(new PiSessionStore()), service = new PiSystemPromptService(native);
const save = async (scope, kind, content, revision) => service.save({ cwd, scope, kind, content, expectedRevision: revision ?? (await service.snapshot(cwd)).revision });
const trust = async decision => native.saveTrust({ cwd, decision, confirmed: true, expectedRevision: (await native.snapshot(cwd)).revision });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('prompt files preserve native scope, private backups and restore; stale global/project/trust writes reject', async () => {
    let snap = await service.snapshot(cwd);
    assert.equal(snap.files.global.append.content, null);
    await save('global', 'append', 'Global instructions\n');
    await assert.rejects(save('global', 'base', 'Old draft', snap.revision), /变化/);
    await assert.rejects(save('project', 'append', 'Project instructions'), /信任/);
    await trust(true);
    await save('project', 'append', 'Project instructions');
    snap = await service.snapshot(cwd);
    assert.equal(snap.selected.append.content, 'Project instructions');
    assert.equal(snap.files.global.append.content, 'Global instructions\n');
    await save('project', 'base', 'Project base');
    await assert.rejects(save('global', 'append', 'stale', snap.revision), /变化/);
    await save('project', 'append', null);
    assert.equal((await service.snapshot(cwd)).selected.append.scope, 'global');
    const backups = fs.readdirSync(path.join(cwd, '.pi/.web-backups'));
    assert.equal(backups.length, 1);
    const backup = path.join(cwd, '.pi/.web-backups', backups[0]);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'Project instructions');
    require('./private-file-helper.cjs').assertPrivateFile(backup);
    require('./private-file-helper.cjs').assertPrivateFile(path.join(agent, 'APPEND_SYSTEM.md'));
    snap = await service.snapshot(cwd); await trust(false);
    await assert.rejects(save('global', 'base', 'stale trust', snap.revision), /变化/);
    assert.equal((await service.snapshot(cwd)).selected.base.scope, 'default');
    await trust(true); await save('project', 'base', null);
});

test('prompt editing rejects arbitrary files, encodings, budgets, links and concurrent writes', async t => {
    for (const content of ['', '  ', 'x'.repeat(65537), '\0', '\ud800', 42]) await assert.rejects(save('global', 'append', content));
    await assert.rejects(service.save({ cwd, scope: 'global', kind: '../auth', content: 'x', expectedRevision: 'x' }));
    await assert.rejects(service.save({ cwd, scope: 'global', kind: ['append'], content: 'x', expectedRevision: (await service.snapshot(cwd)).revision }), /类型/);
    await assert.rejects(service.snapshot(path.parse(root).root));
    const file = path.join(agent, 'SYSTEM.md');
    fs.writeFileSync(file, Buffer.from([0xff])); await assert.rejects(service.snapshot(cwd), /UTF-8/); fs.unlinkSync(file);
    fs.mkdirSync(file); await assert.rejects(service.snapshot(cwd), /普通/); fs.rmdirSync(file);
    try { fs.symlinkSync(path.join(agent, 'APPEND_SYSTEM.md'), file); }
    catch (e) { if (process.platform !== 'win32') throw e; t.diagnostic('Symlink creation unavailable under this Windows identity'); }
    if (fs.existsSync(file)) { await assert.rejects(service.snapshot(cwd), /普通/); fs.unlinkSync(file); }
    native.busy = true; await assert.rejects(save('global', 'base', 'x'), /正在保存/); native.busy = false;
    const snap = await service.snapshot(cwd);
    const results = await Promise.allSettled([save('global', 'base', 'A', snap.revision), save('global', 'base', 'B', snap.revision)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await save('global', 'base', null);
    fs.writeFileSync(file, '\ufeffBOM preserved');
    assert.equal(readPrompt(file).content, '\ufeffBOM preserved');
    await save('global', 'base', null);
});

test('prompt REST preserves authentication, Origin, no-store and zero worker startup', async () => {
    const { once } = require('node:events');
    process.env.PI_WEB_TOKEN = 'prompt-fixture-token';
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway();
    const app = require('express')(); app.use(require('express').json({ limit: '1mb' })); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/pi`, endpoint = base + '/settings/system-prompts';
    const headers = { Authorization: 'Bearer prompt-fixture-token', 'Content-Type': 'application/json' };
    try {
        assert.equal((await fetch(endpoint + '?cwd=' + encodeURIComponent(cwd))).status, 401);
        assert.equal((await fetch(endpoint + '?cwd=' + encodeURIComponent(cwd), { headers: { ...headers, Origin: 'http://other.invalid' } })).status, 403);
        const response = await fetch(endpoint + '?cwd=' + encodeURIComponent(cwd), { headers });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const snapshot = await response.json();
        const body = JSON.stringify({ cwd, scope: 'global', kind: 'append', content: 'HTTP_PROMPT', expectedRevision: snapshot.revision });
        assert.equal((await fetch(endpoint, { method: 'PUT', body, headers: { ...headers, Origin: 'http://other.invalid' } })).status, 403);
        assert.equal((await fetch(endpoint, { method: 'PUT', body, headers })).status, 200);
        assert.equal((await fetch(endpoint, { method: 'PUT', body, headers })).status, 409);
        assert.equal(gateway.supervisor.workers.size, 0);
        assert.equal((await (await fetch(base + '/status', { headers })).json()).systemPrompts, true);
    } finally { delete process.env.PI_WEB_TOKEN; await gateway.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('runtime snapshot and explicit reload follow actual native prompts without model calls or history writes', { timeout: 90000 }, async () => {
    await trust(true);
    await save('global', 'base', 'GLOBAL_BASE');
    await save('global', 'append', 'GLOBAL_APPEND');
    await save('project', 'append', 'PROJECT_APPEND\u2028one\u2029two');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'PRIVATE_CONTEXT_SENTINEL');
    const supervisor = new PiAgentSupervisor();
    try {
        const session = await new PiSessionStore().createSession(cwd, 'Synthetic prompt test');
        const worker = await supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        const events = []; worker.subscribe(e => events.push(e));
        const entriesBefore = await worker.request('get_entries');
        let raw = await worker.getNativeResources(true);
        assert.equal(raw.customPrompt, 'GLOBAL_BASE');
        assert.equal(raw.appendSystemPrompt, 'PROJECT_APPEND\u2028one\u2029two');
        assert.match(raw.body, /PRIVATE_CONTEXT_SENTINEL/);
        assert.doesNotMatch(raw.body, /GLOBAL_APPEND/);
        assert.equal((await service.inspect(raw)).matchesSavedFiles, true);
        assert.doesNotMatch(JSON.stringify(await worker.getNativeResources()), /PRIVATE_CONTEXT_SENTINEL|PROJECT_APPEND/);
        await save('project', 'append', 'NEW_PROJECT_APPEND');
        raw = await worker.getNativeResources(true);
        assert.match(raw.appendSystemPrompt, /^PROJECT_APPEND/);
        assert.equal((await service.inspect(raw)).matchesSavedFiles, false);
        await worker.reloadResources();
        raw = await worker.getNativeResources(true);
        assert.equal(raw.appendSystemPrompt, 'NEW_PROJECT_APPEND');
        assert.equal((await service.inspect(raw)).matchesSavedFiles, true);
        assert.deepEqual(await worker.request('get_entries'), entriesBefore);
        worker.client.emit('event', { type: 'extension_ui_request', method: 'notify', message: JSON.stringify({ pi5Resources: 'late', data: { body: 'LATE_PRIVATE_PROMPT' } }) });
        assert.doesNotMatch(JSON.stringify(events), /PRIVATE_CONTEXT_SENTINEL|NEW_PROJECT_APPEND|LATE_PRIVATE_PROMPT|pi5Resources/);
        worker.operation = Symbol(); await assert.rejects(worker.getNativeResources(true), /操作/); worker.operation = null;
        worker.resourceResults.set('test-reserved', null); await assert.rejects(worker.reloadResources(), /资源/); worker.resourceResults.delete('test-reserved');
        assert.equal(supervisor.workers.size, 1);
        await worker.dispose();
        const overridden = await supervisor.createEphemeralWorker(cwd, { extraArgs: ['--system-prompt', 'CLI_BASE'] });
        const inspected = await service.inspect(await overridden.getNativeResources(true));
        assert.equal(inspected.customPrompt, 'CLI_BASE'); assert.equal(inspected.configured.base.matchesLoaded, false);
        assert.equal(inspected.matchesSavedFiles, false);
    } finally { await supervisor.dispose(); }
});
