'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scope = require('../server/profile-memory/scope');

const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('A native fork inherits its own marker while copied parent markers cannot bind an import', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-memory-fork-'));
    const priorAgent = process.env.PI_CODING_AGENT_DIR, priorRoots = process.env.PI_PROJECT_ROOTS;
    t.after(() => { fs.rmSync(base, { recursive: true, force: true });
        if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
        if (priorRoots === undefined) delete process.env.PI_PROJECT_ROOTS; else process.env.PI_PROJECT_ROOTS = priorRoots; });
    const agentDir = path.join(base, 'agent'), cwd = path.join(base, 'project');
    fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_PROJECT_ROOTS = base;
    const store = new (require('../server/pi-session-store').PiSessionStore)();
    store.profiles = { select: async () => profileId, describe: async () => ({ id: profileId }), state: async () => ({ state: {} }) };
    const original = await store.createSession(cwd, 'Synthetic source', { agentProfileId: profileId });
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(original.path);
    const userId = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'synthetic procedure' }], timestamp: Date.now() });
    const assistantId = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }],
        api: 'openai-completions', provider: 'synthetic', model: 'synthetic', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    assert.ok(userId && assistantId);
    const fork = await store.forkSession(original, { entries: manager.getEntries(), leafId: manager.getLeafId() }, assistantId, 'at');
    const child = SessionManager.open(fork.session.path);
    const ctx = { version: 1, profileId, sessionId: child.getSessionId(), cwd,
        profileRoot: path.join(agentDir, 'pivane-profiles', 'data', profileId), sessionsRoot: path.join(agentDir, 'sessions'),
        memory: { enabled: true, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } };
    const parsed = scope.parseContext(JSON.stringify(ctx));
    assert.ok(parsed);
    assert.equal(child.getEntries().filter(entry => entry.customType === 'pivane-agent-profile').length, 2);
    assert.equal(scope.binding(child.getEntries(), child.getSessionId()).profileId, profileId);
    assert.equal(scope.snapshot(fork.session.path, parsed)?.header.id, child.getSessionId());
    assert.equal(scope.eligibleManager(child, parsed, cwd), true);
    const imported = path.join(path.dirname(fork.session.path), 'copied.jsonl');
    const copiedHeader = { ...child.getHeader(), id: 'copied-foreign-session' };
    const lines = fs.readFileSync(fork.session.path, 'utf8').split('\n');
    lines[0] = JSON.stringify(copiedHeader);
    fs.writeFileSync(imported, lines.join('\n'));
    assert.equal(scope.snapshot(imported, parsed), null);
});
