'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const jitiPath = process.env.PIVANE_TEST_PI_JITI;

test('isolated Pi 0.87.1 upstream components enforce profile index, recall, skill and lifecycle', {
    skip: !bundle || !jitiPath ? 'Set PIVANE_TEST_HERMES_BUNDLE and PIVANE_TEST_PI_JITI for isolated integration' : false,
}, async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-hermes-integration-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const agent = path.join(base, 'agent');
    const sessionsRoot = path.join(agent, 'sessions');
    const cwdA = path.join(base, 'one', 'shared');
    const cwdB = path.join(base, 'two', 'shared');
    for (const dir of [sessionsRoot, cwdA, cwdB]) fs.mkdirSync(dir, { recursive: true });
    const create = (id, profileId, cwd, text) => {
        const dir = path.join(sessionsRoot, `--${id}--`);
        fs.mkdirSync(dir);
        const file = path.join(dir, `${id}.jsonl`);
        const header = { type: 'session', id, cwd, timestamp: new Date().toISOString() };
        const entries = [header];
        if (profileId !== undefined) entries.push({ type: 'custom', id: `${id}-binding`, customType: 'pivane-agent-profile',
            data: { version: 1, sessionId: id, profileId } });
        entries.push({ type: 'message', id: `${id}-msg`, timestamp: new Date().toISOString(),
            message: { role: 'user', content: [{ type: 'text', text }] } });
        fs.writeFileSync(file, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
        return { header, entries, file, cwd };
    };
    const alphaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const betaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const registryDir = path.join(agent, 'pivane-profiles');
    fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(registryDir, 'profiles.json'), JSON.stringify({ version: 1, defaults: {},
        profiles: [alphaId, betaId].map(id => ({ id, name: 'Synthetic', description: '', soul: '', enabled: true,
            memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true } })) }));
    const a = create('a', alphaId, cwdA, '极限 alpha-notes');
    create('none', undefined, cwdA, '极限 none-secret');
    create('foreign', betaId, cwdA, '秩 beta-secret');
    const b = create('b', alphaId, cwdB, '秩 alpha-notes 栈');
    const archives = Array.from({ length: 27 }, (_, i) => create(`archive-${String(i).padStart(2, '0')}`, alphaId, cwdA,
        `archive-key-${String(i).padStart(2, '0')}`));
    const manager = session => ({ getHeader: () => session.header, getEntries: () => session.entries,
        getSessionId: () => session.header.id, getSessionFile: () => session.file });
    const fakePi = () => {
        const events = new Map(), tools = new Map();
        return { events, tools, records: [], on(name, fn) { events.set(name, [...(events.get(name) || []), fn]); },
            appendEntry(type, data) { this.records.push({ type, data }); },
            registerTool(tool) { tools.set(tool.name, tool); },
            async emit(name, event, ctx) { for (const fn of events.get(name) || []) await fn(event, ctx); } };
    };
    const jiti = require(jitiPath).createJiti(path.join(__dirname, '..', 'server/profile-memory/extension.ts'));
    const { registerProfileMemory } = jiti(path.join(__dirname, '..', 'server/profile-memory/extension.ts'));
    const start = async (session, profileId, autoLearn = false) => {
        const context = { version: 1, profileId, sessionId: session.header.id, sessionPath: session.file, cwd: session.cwd,
            profileRoot: path.join(agent, 'pivane-profiles', 'data', profileId), sessionsRoot,
            memory: { enabled: true, autoLearn, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } };
        process.env.PIVANE_AGENT_PROFILE_CONTEXT = JSON.stringify(context);
        process.env.PIVANE_HERMES_BUNDLE = bundle;
        const pi = fakePi();
        await registerProfileMemory(pi);
        const ctx = { mode: 'rpc', cwd: session.cwd, sessionManager: manager(session) };
        await pi.emit('session_start', {}, ctx);
        await new Promise(resolve => setTimeout(resolve, 80));
        return { pi, ctx, root: context.profileRoot, close: () => pi.emit('session_shutdown', {}, ctx) };
    };
    t.after(() => { delete process.env.PIVANE_AGENT_PROFILE_CONTEXT; delete process.env.PIVANE_HERMES_BUNDLE;
        delete process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL; });
    const alpha = await start(a, alphaId);
    assert.ok(alpha.pi.tools.has('memory_add'));
    const add = alpha.pi.tools.get('memory_add');
    const payloads = ['极限推导法', '线性代数的秩', '数据结构栈'];
    // Concurrent same-base writes race on the profile-local mutation lock; a 409
    // "Knowledge revision changed" is the documented optimistic-concurrency gate,
    // and a fresh retry deterministically reconciles (PROFILE_MEMORY.md).
    const writes = await Promise.all(payloads.map(async content => {
        for (let attempt = 0; attempt < 8; attempt++) {
            const result = await add.execute('call', { target: 'memory', content }, undefined, undefined, alpha.ctx);
            if (result.details.success) return result;
            if (!/revision/i.test(String(result.details.error || '')) || attempt === 7) return result;
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw Error('unreachable');
    }));
    assert.ok(writes.every(result => result.details.success), JSON.stringify(writes.map(result => result.details)));
    const replaced = await alpha.pi.tools.get('memory_replace').execute('call', {
        target: 'memory', old_text: '极限推导法', content: '极限证明法',
    }, undefined, undefined, alpha.ctx);
    assert.equal(replaced.details.success, true);
    const removed = await alpha.pi.tools.get('memory_remove').execute('call', {
        target: 'memory', old_text: '数据结构栈',
    }, undefined, undefined, alpha.ctx);
    assert.equal(removed.details.success, true);
    const restored = await add.execute('call', { target: 'memory', content: '栈的操作' }, undefined, undefined, alpha.ctx);
    assert.equal(restored.details.success, true);
    for (const term of ['极限', '秩', '栈']) {
        const result = await alpha.pi.tools.get('memory_search').execute('call', { query: term }, undefined, undefined, alpha.ctx);
        assert.equal(result.details.count >= 1, true, term);
    }
    const skill = await alpha.pi.tools.get('skill_manage').execute('call', { action: 'create', name: 'synthetic-proof',
        description: 'Synthetic verification procedure', scope: 'global', when_to_use: 'Synthetic checks',
        procedure_steps: ['Check input'], verification_steps: ['Check output'] }, undefined, undefined, alpha.ctx);
    assert.equal(skill.details.success, true, JSON.stringify(skill.details));
    assert.ok(fs.existsSync(path.join(alpha.root, 'skills', 'synthetic-proof', 'SKILL.md')));
    const listed = await alpha.pi.tools.get('skill_manage').execute('call', { action: 'view' }, undefined, undefined, alpha.ctx);
    assert.ok(JSON.stringify(listed.details).includes('synthetic-proof'), 'view lists profile-owned skills');
    const viewed = await alpha.pi.tools.get('skill_manage').execute('call', { action: 'view', skill_id: 'global:synthetic-proof' },
        undefined, undefined, alpha.ctx);
    assert.equal(viewed.details.success, true, JSON.stringify(viewed.details));
    const sharedSkill = path.join(agent, 'skills', 'shared-synthetic', 'SKILL.md');
    fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
    fs.writeFileSync(sharedSkill, '# Shared synthetic skill\n');
    const collision = await alpha.pi.tools.get('skill_manage').execute('call', { action: 'create', name: 'shared-synthetic',
        description: 'Shared synthetic procedure', scope: 'global', when_to_use: 'Synthetic checks',
        procedure_steps: ['Check input'], verification_steps: ['Check output'] }, undefined, undefined, alpha.ctx);
    assert.equal(collision.details.success, false);
    assert.equal(fs.readFileSync(sharedSkill, 'utf8'), '# Shared synthetic skill\n');
    assert.equal(fs.existsSync(path.join(alpha.root, 'skills', 'shared-synthetic')), false);
    const redirected = path.join(alpha.root, 'skills', 'redirected');
    fs.mkdirSync(redirected);
    fs.symlinkSync(sharedSkill, path.join(redirected, 'SKILL.md'));
    await assert.rejects(alpha.pi.tools.get('skill_manage').execute('call', { action: 'delete',
        skill_id: 'global:redirected' }, undefined, undefined, alpha.ctx), /not private/);
    assert.equal(fs.readFileSync(sharedSkill, 'utf8'), '# Shared synthetic skill\n');
    fs.unlinkSync(path.join(redirected, 'SKILL.md'));
    fs.rmdirSync(redirected);
    const localSkill = await alpha.pi.tools.get('skill_manage').execute('call', { action: 'create', name: 'cwd-only',
        description: 'Project-specific procedure', scope: 'project', when_to_use: 'Project work',
        procedure_steps: ['Check project'], verification_steps: ['Check directory'] }, undefined, undefined, alpha.ctx);
    assert.equal(localSkill.details.success, true);
    assert.ok(fs.existsSync(path.join(alpha.root, 'projects', createHash('sha256').update(cwdA).digest('hex'),
        'skills', 'cwd-only', 'SKILL.md')));
    process.env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL = JSON.stringify({ provider: 'synthetic', modelId: 'cheap' });
    const same = await start(b, alphaId, true);
    for (let i = 0; i < 5; i++) await same.pi.emit('agent_settled', {}, same.ctx);
    const lateArchive = await same.pi.tools.get('session_search').execute('call', { query: 'archive-key-26' }, undefined, undefined, same.ctx);
    assert.equal(lateArchive.details.count, 1, 'backfill cursor must progress beyond the first 20 files');
    fs.unlinkSync(archives[26].file);
    const removedArchive = await same.pi.tools.get('session_search').execute('call', { query: 'archive-key-26' }, undefined, undefined, same.ctx);
    assert.equal(removedArchive.details.count, 0, 'deleted source cannot remain searchable');
    fs.writeFileSync(archives[25].file, archives[25].entries.map(item => JSON.stringify(item.type === 'custom'
        ? { ...item, data: { ...item.data, profileId: betaId } } : item)).join('\n') + '\n');
    const reboundArchive = await same.pi.tools.get('session_search').execute('call', { query: 'archive-key-25' }, undefined, undefined, same.ctx);
    assert.equal(reboundArchive.details.count, 0, 'rebound source cannot remain searchable');
    fs.writeFileSync(archives[24].file, archives[24].entries.filter(item => item.type !== 'message').map(item => JSON.stringify(item)).join('\n') + '\n');
    const editedArchive = await same.pi.tools.get('session_search').execute('call', { query: 'archive-key-24' }, undefined, undefined, same.ctx);
    assert.equal(editedArchive.details.count, 0, 'removed messages must be deleted from the derived index');
    const parallel = await Promise.all([
        add.execute('call', { target: 'memory', content: 'parallel-alpha' }, undefined, undefined, alpha.ctx),
        same.pi.tools.get('memory_add').execute('call', { target: 'memory', content: 'parallel-beta' }, undefined, undefined, same.ctx),
    ]);
    assert.ok(parallel.every(result => result.details.success), JSON.stringify(parallel.map(result => result.details)));
    const beforePrompt = await Promise.all((same.pi.events.get('before_agent_start') || [])
        .map(fn => fn({ systemPrompt: 'synthetic system' }, same.ctx)));
    assert.ok(beforePrompt[0]?.systemPrompt.includes('parallel-beta'));
    const provided = same.pi.records.findLast(item => item.type === 'pivane-profile-memory-read');
    assert.equal(provided.data.provided, true);
    assert.equal(provided.data.scope, 'profile-and-physical-cwd');
    // The read entry records the injected block size and its rendered entry count.
    assert.equal(provided.data.chars, beforePrompt[0].systemPrompt.length - 'synthetic system\n\n'.length);
    assert.ok(Number.isSafeInteger(provided.data.entries) && provided.data.entries >= 2, JSON.stringify(provided.data));
    assert.equal((same.pi.events.get('agent_before_settle') || []).length, 0,
        'background learning is owned by the gateway, not the active worker boundary');
    assert.equal((await same.pi.tools.get('memory_search').execute('call', { query: 'stale-review-fact' }, undefined, undefined, same.ctx)).details.count, 0);
    await alpha.close();
    const remembered = await same.pi.tools.get('memory_search').execute('call', { query: '秩' }, undefined, undefined, same.ctx);
    assert.equal(remembered.details.count >= 1, true);
    for (const term of ['极限', '秩', '栈']) {
        const result = await same.pi.tools.get('session_search').execute('call', { query: term }, undefined, undefined, same.ctx);
        assert.equal(result.details.count >= 1, true, `${term}: ${JSON.stringify(result.details)}`);
        assert.doesNotMatch(result.details.output || '', /none-secret|beta-secret/);
    }
    const resources = await Promise.all((same.pi.events.get('resources_discover') || []).map(fn => fn({ cwd: cwdB }, same.ctx)));
    assert.ok(resources[0].skillPaths[0].startsWith(same.root));
    assert.equal(fs.existsSync(path.join(resources[0].skillPaths[1], 'cwd-only', 'SKILL.md')), false);
    assert.notEqual(createHash('sha256').update(cwdA).digest('hex'), createHash('sha256').update(cwdB).digest('hex'));
    fs.appendFileSync(b.file, JSON.stringify({ type: 'message', id: 'b-late', timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'profile-settled-index' }] } }) + '\n');
    await same.pi.emit('agent_settled', {}, same.ctx);
    const settled = await same.pi.tools.get('session_search').execute('call', { query: 'profile-settled-index' }, undefined, undefined, same.ctx);
    assert.equal(settled.details.count >= 1, true);
    await same.close();
    const { createRequire } = require('node:module');
    const Database = createRequire(bundle)('better-sqlite3');
    const staleDb = new Database(path.join(same.root, 'sessions.db'));
    staleDb.prepare('INSERT INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)')
        .run('unproven', cwdA, cwdA, '2026-01-01');
    staleDb.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('unproven-msg', 'unproven', 'user', 'unproven-derived-secret', '2026-01-01');
    staleDb.close();
    const reopened = await start(a, alphaId);
    const unproven = await reopened.pi.tools.get('session_search').execute('call', { query: 'unproven-derived-secret' }, undefined, undefined, reopened.ctx);
    assert.equal(unproven.details.count, 0, 'rows without verified native provenance are removed on reopen');
    for (const term of ['parallel-alpha', 'parallel-beta']) {
        const result = await reopened.pi.tools.get('memory_search').execute('call', { query: term }, undefined, undefined, reopened.ctx);
        assert.equal(result.details.count >= 1, true, term);
    }
    await reopened.close();
    const beta = await start(create('beta-session', betaId, cwdA, '栈 beta-note'), betaId);
    const noRecall = await beta.pi.tools.get('memory_search').execute('call', { query: '秩' }, undefined, undefined, beta.ctx);
    assert.equal(noRecall.details.success, false);
    const noSession = await beta.pi.tools.get('session_search').execute('call', { query: '极限' }, undefined, undefined, beta.ctx);
    assert.equal(noSession.details.count || 0, 0);
    assert.equal(fs.existsSync(path.join(beta.root, 'skills', 'synthetic-proof', 'SKILL.md')), false);
    await beta.close();
    process.env.PIVANE_AGENT_PROFILE_CONTEXT = JSON.stringify({ version: 1, profileId: alphaId,
        sessionId: a.header.id, cwd: cwdA, profileRoot: alpha.root, sessionsRoot,
        memory: { enabled: true, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } });
    const noPath = fakePi();
    await registerProfileMemory(noPath);
    assert.equal(noPath.tools.size, 0, 'factory cannot register tools before native path verification');
    delete process.env.PIVANE_AGENT_PROFILE_CONTEXT;
    const none = fakePi();
    await registerProfileMemory(none);
    assert.equal(none.tools.size, 0);
});
