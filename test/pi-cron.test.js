const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-cron-')));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = root;
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); process.env.PI_OFFLINE = '1';
delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR); const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const deadline = async fn => {
    for (let i = 0; i < 400; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Fixture timed out');
};
test('Scheduled tasks wake one native worker, restore models, keep silence, deduplicate and enforce budgets', { timeout: 120000 }, async () => {
    const calls = [];
    const provider = http.createServer(async (req, res) => {
        let body = ''; for await (const part of req) body += part;
        const input = JSON.parse(body); calls.push(input);
        const text = JSON.stringify(input.messages);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        if (text.includes('SILENT_FIXTURE')) {
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls.length}`, type: 'function', function: { name: 'cron_silent', arguments: JSON.stringify({ reason: 'Nothing useful to send' }) } }] }); chunk({}, 'tool_calls');
        } else if (text.includes('LOOP_FIXTURE')) {
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: path.join(cwd, 'note.txt') }) } }] }); chunk({}, 'tool_calls');
        } else { chunk({ role: 'assistant', content: 'Scheduled greeting fixture' }); chunk({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'normal', defaultThinkingLevel: 'off', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: ['normal', 'scheduled'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } })) } } }));
    const access = new WorkspaceAccessService({ envToken: () => 'synthetic' });
    const gateway = createPiAgentGateway({ accessService: access });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = `http://127.0.0.1:${server.address().port}`;
    const service = gateway.cron;
    const baseJob = target => ({ id: randomUUID(), name: 'Morning', prompt: 'GREETING_FIXTURE', enabled: false, mode: 'text', target,
        schedule: { kind: 'cron', expression: '30 10 * * *', timeZone: 'Asia/Shanghai' }, model: { provider: 'fixture', modelId: 'scheduled', thinkingLevel: 'off' },
        budget: { maxRunsPerDay: 3, maxTokensPerDay: 200000, maxCostPerDay: null } });
    try {
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        const api = process.env.PI_WORKSPACE_INTERNAL_ORIGIN + '/api/pi/cron';
        assert.equal((await fetch(api)).status, 401);
        assert.equal((await fetch(api, { headers: { Authorization: 'Bearer synthetic' } })).status, 200);
        const session = await gateway.store.createSession(cwd, 'Scheduled target');
        const job = await service.save(baseJob({ kind: 'thread', cwd, sessionId: session.id }));
        assert.equal(gateway.supervisor.getActiveWorker(session.path), undefined);
        const id = randomUUID(), submitted = await service.action(job.id, { action: 'run', revision: job.revision, requestId: id });
        assert.equal((await service.action(job.id, { action: 'run', revision: job.revision, requestId: id })).id, submitted.id);
        const result = await deadline(async () => { await service.tick(); const r = service.db.run(submitted.id); return r.status === 'completed' && r; });
        assert.equal(calls.length, 1); assert.equal(calls[0].model, 'scheduled');
        assert.deepEqual(calls[0].tools.map(tool => tool.function.name), ['cron_silent']);
        const worker = gateway.supervisor.getActiveWorker(session.path);
        assert.equal((await fetch(api, { headers: { Authorization: `Bearer ${worker.navigationToken}` } })).status, 401, 'worker credential cannot manage schedules');
        assert.equal((await worker.request('get_state')).model.id, 'normal');
        assert.equal(worker.cronRun, null); assert.equal(gateway.supervisor.workers.size, 1);
        assert.ok(result.replyEntryId);
        const entries = SessionManager.open(session.path).getEntries();
        assert.equal(entries.filter(e => e.customType === 'pivane-cron-message').length, 1);
        assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user').length, 0);
        const silentSession = await gateway.store.createSession(cwd, 'Silent target');
        const silentJob = await service.save({ ...baseJob({ kind: 'thread', cwd, sessionId: silentSession.id }), prompt: 'SILENT_FIXTURE' });
        const silentRun = await service.action(silentJob.id, { action: 'run', revision: silentJob.revision, requestId: randomUUID() });
        await deadline(async () => { await service.tick(); return service.db.run(silentRun.id).status === 'silent'; });
        assert.equal(calls.length, 2, 'silent tool terminates without a follow-up model call');
        const manual = await service.action(job.id, { action: 'run', revision: job.revision, requestId: randomUUID() });
        await assert.rejects(() => service.action(job.id, { action: 'run', revision: job.revision, requestId: randomUUID() }), /unfinished/);
        await service.action(job.id, { action: 'stop', revision: job.revision, runId: manual.id });
        service.db.setMeta('limits', { maxRunsPerDay: 1, maxTokensPerDay: 400000, maxCostPerDay: null });
        const denied = await service.action(job.id, { action: 'run', revision: job.revision, requestId: randomUUID() });
        await service.tick(); assert.equal(service.db.run(denied.id).status, 'failed'); assert.equal(calls.length, 2);
        service.db.setMeta('limits', { maxRunsPerDay: 40, maxTokensPerDay: 400000, maxCostPerDay: null });
        const activeSession = await gateway.store.createSession(cwd, 'User already active');
        SessionManager.open(activeSession.path).appendMessage({ role: 'user', content: 'I am here today.', timestamp: Date.now() });
        const activeJob = await service.save({ ...baseJob({ kind: 'thread', cwd, sessionId: activeSession.id }), condition: { kind: 'no-user-since', time: '00:00' } });
        const activeRun = await service.action(activeJob.id, { action: 'run', revision: activeJob.revision, requestId: randomUUID() });
        await deadline(async () => { await service.tick(); return service.db.run(activeRun.id).status === 'skipped'; });
        assert.equal(calls.length, 2, 'activity condition skips before calling the model');
        fs.writeFileSync(path.join(cwd, 'note.txt'), 'Synthetic bounded work.');
        const loopSession = await gateway.store.createSession(cwd, 'Bounded work');
        const loopJob = await service.save({ ...baseJob({ kind: 'thread', cwd, sessionId: loopSession.id }), prompt: 'LOOP_FIXTURE', mode: 'work',
            execution: { maxCalls: 2, maxTokens: 32000, maxDurationSeconds: 30 } });
        const loopRun = await service.action(loopJob.id, { action: 'run', revision: loopJob.revision, requestId: randomUUID() });
        await deadline(async () => { await service.tick(); return service.db.run(loopRun.id).status === 'stopped'; });
        assert.equal(calls.length, 4, 'model-call limit ends a tool loop');
        const before = await gateway.store.profiles.list();
        const profile = await gateway.store.profiles.save({ expectedRevision: before.revision, profile: { name: 'Example', description: '', soul: '', enabled: true } });
        const home = await service.home(profile.profile.id, { revision: 0, requestId: randomUUID(), cwd, create: true });
        assert.equal(home.status, 'ready');
        assert.equal((await gateway.store.getSession(cwd, home.sessionId)).agentProfile.id, profile.profile.id);
        await assert.rejects(() => service.home(profile.profile.id, { revision: home.revision, cwd, sessionId: session.id }), /belonging/);
        await service.removing(await gateway.store.getSession(cwd, home.sessionId));
        assert.equal(service.db.home(profile.profile.id).status, 'missing');
    } finally {
        await gateway.dispose(); access.dispose(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => provider.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
    }
});
