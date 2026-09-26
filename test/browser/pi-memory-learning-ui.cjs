// U1 learning-interface rehearsal (chat "remembered" hints, learning health + one-click enable,
// legacy auto-learning banner, memory usage bars). Backend contract fields are mocked through
// route interception; absent fields must fall back to the old display without page errors.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const hash = letter => letter.repeat(64);
const app = express();
for (const [url, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
    app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', directory)));
app.use(express.static(path.join(root, 'public')));
const settings = { enabled: false, correctionEnabled: true, reviewEnabled: false, extractionEnabled: false,
    maxRunsPerDay: 4, maxTokensPerDay: 24000, periodicReviewMinutes: 0 };
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-chat-knowledge.css">
<style>:root{--line:#ccc;--text-main:#222;--text-soft:#555;--text-muted:#777;--surface-1:#fff;--surface-2:#eee;--accent:#168a68}body{margin:0;font-family:Arial,sans-serif;background:#f8f8f8;color:#222}main{max-width:720px;padding:12px;margin:auto;min-width:0}button{cursor:pointer}section{min-width:0}#pi-transcript-content{display:grid;gap:6px;padding:8px 0}</style></head><body><main><section id="pi-profiles-memory"></section><div id="pi-chat-knowledge"></div><div id="pi-transcript-content"></div></main>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-chat-knowledge.js"></script>
<script>
window.current = { cwd: '/synthetic', sessionId: 'thread-one', profileId: 'profile-one', generation: 1 };
window.calls = []; window.events = [];
window.PiAgentProfilesUI = { revealKnowledge: (profileId, itemId) => window.calls.push({ reveal: [profileId, itemId] }) };
window.addEventListener('workspace:open-settings', event => window.events.push(event.detail));
window.fixtureEntries = { leafId: 'entry-user-2', entries: [
    { id: 'entry-user-1', type: 'message', timestamp: 10, message: { role: 'user', content: 'First question', timestamp: 10 } },
    { id: 'entry-reply-1', type: 'message', timestamp: 11, message: { role: 'assistant', content: [{ type: 'text', text: 'First reply' }], timestamp: 11 } },
    { id: 'entry-user-2', type: 'message', timestamp: 20, message: { role: 'user', content: 'Second question', timestamp: 20 } } ] };
const transcript = document.getElementById('pi-transcript-content');
for (const [role, timestamp, text] of [['user', 10, 'First question'], ['assistant', 11, 'First reply'], ['user', 20, 'Second question']]) {
    const article = document.createElement('article');
    article.className = 'pi-message ' + role;
    article.dataset.messageKey = JSON.stringify([role, timestamp, '']);
    article.textContent = text;
    transcript.append(article);
}
window.api = async (url, options) => {
    window.calls.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { status: response.status, data });
    return data;
};
window.manager = PiProfileKnowledge.create({ apiFetch: window.api, root: document.getElementById('pi-profiles-memory') });
window.chat = PiChatKnowledge.create({ fetch: window.api, root: document.getElementById('pi-chat-knowledge'),
    transcript, entries: () => Promise.resolve(window.fixtureEntries), scope: () => window.current });
window.manager.open('profile-one'); window.chat.update();
window.refreshAll = () => { window.manager.refresh(); window.chat.refresh(); };
</script></body></html>`));

async function runFixture(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
    const page = await context.newPage(), errors = [], dialogs = [], state = {
        usage: { memory: { chars: 5000, limit: 16000 }, user: { chars: 7000, limit: 8000 } },
        learningRevision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
        health: { state: 'needs-model', missingModels: ['memory-correction', 'memory-extraction'], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
        legacy: null, rejectMemoryFull: false, hintConflict: false,
        actions: ['save', 'enable', 'adopt-legacy', 'dismiss-legacy', 'cancel'] };
    const receipts = [
        { id: 'receipt-learning', requestId: 'learning-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'learning', reason: 'extraction',
            category: 'preference', preview: '以后默认用 pnpm 安装依赖', summary: 'create memory', undoable: true, itemId: hash('a'), afterRevision: hash('c'),
            source: { sessionId: 'thread-one', entryId: 'entry-user-1' } },
        { id: 'receipt-agent', requestId: 'tool-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'agent',
            category: 'fact', preview: '服务监听 4321 端口', undoable: true, itemId: hash('d'), afterRevision: hash('e'),
            source: { sessionId: 'thread-one', entryId: 'entry-missing' } },
        { id: 'receipt-skill', requestId: 'tool-2', kind: 'skill', operation: 'create', status: 'saved', origin: 'learning', reason: 'review',
            preview: 'pnpm-install — 用 pnpm 安装依赖', undoable: false, itemId: hash('f'), afterRevision: hash('g'), activation: 'reload-required',
            source: { sessionId: 'thread-one', entryId: 'entry-user-2' } },
        { id: 'receipt-old', requestId: 'native-1', kind: 'memory', operation: 'create', status: 'saved',
            summary: 'create memory', undoable: true, source: { sessionId: 'thread-one', entryId: 'entry-user-1' } } ];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        const learning = () => ({ version: 1, status: 'ready', revision: state.learningRevision, settings: state.settings,
            jobs: state.jobs, recentRuns: state.recentRuns, health: state.health, legacy: state.legacy,
            capabilities: { installed: true, settingsWrite: true, reservedTokensPerRun: 6000, actions: state.actions,
                limits: { maxRunsPerDay: { min: 1, max: 20 }, maxTokensPerDay: { min: 6000, max: 200000 }, periodicReviewMinutes: { min: 0, max: 10800 } } } });
        const snapshot = () => ({ version: 1, status: 'ready', revision: hash('a'), items: [], receipts, hasMore: false,
            usage: state.usage, capabilities: { memory: true, skill: true, projectWrites: false, operations: ['create', 'update', 'delete', 'undo'], maxContentLength: 65536 } });
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill(snapshot());
        if (p.endsWith('/learning') && req.method() === 'GET') return fulfill(learning());
        if (p.endsWith('/learning/actions')) {
            const input = req.postDataJSON();
            if (input.action === 'enable') {
                state.settings = { ...state.settings, enabled: true, correctionEnabled: true };
                state.health = { ...state.health, state: 'needs-model', missingModels: ['memory-correction'] };
            }
            if (input.action === 'adopt-legacy' || input.action === 'dismiss-legacy') state.legacy = null;
            state.learningRevision++;
            return fulfill(learning());
        }
        if (p.endsWith('/knowledge/mutations')) {
            const input = req.postDataJSON();
            if (state.hintConflict) { state.hintConflict = false; return fulfill({ error: 'Conflict' }, 409); }
            if (state.rejectMemoryFull) { state.rejectMemoryFull = false; return fulfill({ error: 'Memory is full', code: 'memory-full', details: { target: 'memory', chars: 16000, limit: 16000, needed: 16120 } }, 409); }
            return fulfill({ version: 1, status: 'saved', revision: hash('b'), receipt: { id: 'mutated', requestId: input.requestId,
                kind: input.kind, operation: input.operation, status: 'saved', undoable: false, source: { sessionId: 'thread-one', entryId: 'entry-user-1' } } });
        }
        if (p === '/api/pi/settings/models') return fulfill({ version: 1, providers: [{ id: 'fixture', name: 'Fixture provider' }],
            models: [{ provider: 'fixture', id: 'new-model', name: 'New model', available: true, input: ['text'] },
                { provider: 'fixture', id: 'batch-1:batch', name: 'Batch', available: true, input: ['text'] },
                { provider: 'fixture', id: 'vision-model', name: 'Vision model', available: true, input: ['image'] },
                { provider: 'fixture', id: 'down-model', name: 'Down model', available: false, input: ['text'] }] });
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/fixture`);
    const text = selector => page.locator(selector).first().innerText();
    const zh = locale.startsWith('zh');
    const say = (source, english) => zh ? source : english;
    const managerStatus = '#pi-profiles-memory .pi-knowledge-status', chatStatus = '#pi-chat-knowledge .pi-knowledge-status';
    // U1.4: usage bars come from the knowledge snapshot usage; 80% warns, 100% blocks.
    await page.locator('.pi-usage-bars').waitFor();
    assert.match(await text('.pi-usage-bars'), /5000 \/ 16000/);
    assert.match(await text('.pi-usage-bars'), /7000 \/ 8000/);
    assert.equal(await page.locator('.pi-usage-bar.pi-usage-near').count(), 1);
    assert.ok((await text('.pi-usage-bars')).includes(say('接近上限，下一步可整理合并', 'Near the limit; the next step is consolidating entries')));
    state.usage = { memory: { chars: 16000, limit: 16000 }, user: { chars: 8000, limit: 8000 } };
    state.recentRuns = [{ id: hash('r'), reason: 'review', status: 'skipped', error: 'memory-full', createdAt: '2026-01-01' }];
    await page.evaluate(() => window.refreshAll());
    await page.waitForFunction(() => document.querySelectorAll('.pi-usage-full').length >= 2);
    assert.ok((await text('.pi-learning')).includes(say('记忆已满，未保存', 'Memory full; not saved')));
    // A rejected write keeps the memory bar red even below the cap.
    state.usage = { memory: { chars: 5000, limit: 16000 }, user: { chars: 100, limit: 8000 } };
    await page.evaluate(() => window.refreshAll());
    await page.waitForFunction(() => document.querySelectorAll('.pi-usage-bar.pi-usage-ok').length === 2);
    state.rejectMemoryFull = true;
    await page.locator('.pi-profile-kinds button').first().click();
    await page.locator('.pi-knowledge-tools button').click();
    await page.locator('.pi-knowledge-editor textarea').fill('A new fact');
    await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-usage-bar.pi-usage-full')));
    assert.ok((await text(managerStatus)).includes(say('记忆已满', 'Memory is full')));
    // U1.2: health dot and one-click enable with the missing-model list and settings link.
    const healthText = await text('.pi-learning-health');
    assert.ok(healthText.includes(say('缺少学习模型配置', 'A learning model is not configured')), healthText);
    const missing = page.locator('.pi-learning > p').filter({ hasText: say('还需要配置', 'Still to configure') });
    assert.ok((await missing.innerText()).includes(say('纠错模型 / 提炼模型', 'Correction model / Extraction model')));
    await page.locator('.pi-learning > button').filter({ hasText: say('前往设置', 'Go to Settings') }).click();
    assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { tab: 'models' });
    await page.locator('.pi-learning > button').filter({ hasText: say('一键开启自学习', 'Enable self-learning') }).click();
    await page.waitForFunction(() => /已开启|enabled/.test(document.querySelector('#pi-profiles-memory .pi-knowledge-status')?.textContent || ''));
    const enable = await page.evaluate(() => window.calls.filter(call => call.body && call.body.action === 'enable').at(-1));
    assert.equal(enable.url, '/api/pi/profiles/profile-one/learning/actions');
    assert.equal(typeof enable.body.requestId, 'string');
    assert.ok((await missing.innerText()).includes(say('纠错模型', 'Correction model')));
    assert.ok(!(await missing.innerText()).includes(say('提炼模型', 'Extraction model')));
    // U1.3: legacy banner lists purposes and the old model; unavailable model adds a catalog dropdown.
    state.legacy = { autoLearn: true, reviewModel: { provider: 'fixture', modelId: 'old-model' }, reviewModelAvailable: false,
        purposes: ['memory-correction', 'memory-review'] };
    await page.evaluate(() => window.refreshAll());
    const banner = page.locator('.pi-learning-legacy');
    await banner.waitFor();
    assert.ok((await banner.innerText()).includes(say('此身份开启过旧版自动学习，新版需要确认后才会继续学习。', 'This profile used the old auto-learning')));
    assert.ok((await banner.innerText()).includes(say('将设置的用途：纠错模型、复盘模型', 'Purposes to configure: Correction model、Review model')));
    assert.ok((await banner.innerText()).includes('fixture/old-model'));
    assert.deepEqual(await banner.locator('select').last().locator('option').evaluateAll(options => options.map(option => option.value)), ['new-model']);
    await banner.locator('button').filter({ hasText: say('迁移并开启', 'Migrate and enable') }).click();
    await page.waitForFunction(() => !document.querySelector('.pi-learning-legacy'));
    const adopt = await page.evaluate(() => window.calls.filter(call => call.body && call.body.action === 'adopt-legacy').at(-1));
    assert.deepEqual(adopt.body.model, { provider: 'fixture', modelId: 'new-model' });
    state.legacy = { autoLearn: true, reviewModel: null, reviewModelAvailable: true, purposes: ['memory-extraction'] };
    await page.evaluate(() => window.refreshAll());
    await banner.waitFor();
    assert.equal(await banner.locator('select').count(), 0);
    await banner.locator('button').filter({ hasText: say('不再提示', 'Do not show') }).click();
    await page.waitForFunction(() => !document.querySelector('.pi-learning-legacy'));
    const dismiss = await page.evaluate(() => window.calls.filter(call => call.body && call.body.action === 'dismiss-legacy').at(-1));
    assert.equal(dismiss.body.action, 'dismiss-legacy');
    // U1.1: contract receipts render under their source message; unknown entries fall back to the card.
    await page.locator('#pi-chat-knowledge summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-transcript-content > .pi-memory-hint').length === 2);
    const hints = await page.locator('#pi-transcript-content > .pi-memory-hint').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, after: node.previousElementSibling?.textContent })));
    assert.equal(hints.length, 2, JSON.stringify(hints));
    assert.ok(hints[0].text.includes(say('已记住：以后默认用 pnpm 安装依赖', 'Remembered: 以后默认用 pnpm 安装依赖')), JSON.stringify(hints));
    assert.equal(hints[0].after, 'First question');
    assert.ok(hints[1].text.includes(say('已学习技能：', 'Learned skill: ')) && hints[1].text.includes('pnpm-install'), JSON.stringify(hints));
    assert.equal(hints[1].after, 'Second question');
    assert.ok(hints[0].text.includes(say('偏好', 'Preference')), JSON.stringify(hints[0]));
    assert.ok(hints[1].text.includes(say('需重载会话后生效', 'Reload the session to apply')), JSON.stringify(hints[1]));
    const fallback = page.locator('.pi-memory-hint-fallback');
    assert.equal(await fallback.count(), 1);
    assert.ok((await fallback.innerText()).includes(say('Agent 记下：', 'Agent noted: ')));
    assert.ok((await text('#pi-chat-knowledge summary')).includes(say('本会话已记住 3 条', '3 entries remembered in this session')));
    assert.equal(await page.locator('.pi-chat-knowledge-receipt').count(), 1, 'old receipts keep the previous card rows');
    // The undoable:false skill hint hides its buttons; the two memory hints keep three each.
    assert.equal(await page.locator('.pi-memory-hint button').count(), 6);
    // Undo posts the receipt identity with the confirmed revision.
    await page.locator('#pi-transcript-content > .pi-memory-hint').first().locator('button').filter({ hasText: say('撤销', 'Undo') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'undo'));
    const undo = await page.evaluate(() => window.calls.filter(call => call.body && call.body.operation === 'undo').at(-1));
    assert.deepEqual(Object.keys(undo.body).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId']);
    assert.equal(undo.body.receiptId, 'receipt-learning');
    assert.equal(undo.body.expectedRevision, hash('a'));
    // "不对" deletes the memory (anti-revival tombstone) after confirmation.
    await page.locator('#pi-transcript-content > .pi-memory-hint').first().locator('button').filter({ hasText: say('不对', 'Not right') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'delete'));
    const removal = await page.evaluate(() => window.calls.filter(call => call.body && call.body.operation === 'delete').at(-1));
    assert.deepEqual(Object.keys(removal.body).sort(), ['expectedRevision', 'itemId', 'itemRevision', 'kind', 'operation', 'requestId']);
    assert.equal(removal.body.itemId, hash('a'));
    assert.equal(removal.body.itemRevision, hash('c'));
    assert.ok(dialogs.some(message => message.includes(say('这条记忆不对吗', 'Is this memory wrong'))), JSON.stringify(dialogs));
    // "编辑" jumps to the identity page memory management and locates the entry.
    await page.locator('#pi-transcript-content > .pi-memory-hint').first().locator('button').filter({ hasText: say('编辑', 'Edit') }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { reveal: ['profile-one', hash('a')] });
    assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { tab: 'profiles', profileId: 'profile-one', section: 'skills' });
    // A 409 on a hint refreshes and tells the user instead of silently failing.
    state.hintConflict = true;
    await page.locator('#pi-transcript-content > .pi-memory-hint').first().locator('button').first().click();
    await page.waitForFunction(() => /conflict|冲突/i.test(document.querySelector('#pi-chat-knowledge .pi-knowledge-status')?.textContent || ''));
    assert.ok((await text(chatStatus)).includes(say('已刷新数据', 'data refreshed')));
    // Mobile: 16px form controls, no horizontal overflow, no page errors.
    if (width < 900) {
        await page.waitForFunction(() => [...document.querySelectorAll('textarea,input,select')].every(el => parseFloat(getComputedStyle(el).fontSize) >= 16), undefined, { timeout: 5000 }).catch(() => {});
        const sizes = await page.evaluate(() => [...document.querySelectorAll('textarea,input,select')].map(el => [el.tagName.toLowerCase(), parseFloat(getComputedStyle(el).fontSize)]));
        assert.ok(sizes.every(entry => entry[1] >= 16), `mobile form font sizes: ${JSON.stringify(sizes)}`);
    }
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(geometry.body <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ui fixture ${width} ${locale}: ${JSON.stringify(geometry)}`);
    await context.close();
}

async function runChat(browser, base, width, locale) {
    // Real chat shell: verifies the pi-chat.js wiring (entries lookup and transcript placement).
    const context = await browser.newContext({ viewport: { width, height: 820 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'thread-one'); }, '/tmp/chat-knowledge-fixture');
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
        const respond = (json, status = 200) => route.fulfill({ json, status });
        if (request.method() !== 'GET') {
            const body = request.postDataJSON(); writes.push({ endpoint, body });
            if (endpoint.endsWith('/knowledge/mutations')) return respond({ version: 1, status: 'saved', revision: 'a'.repeat(64),
                receipt: { id: 'mutated', requestId: body.requestId, operation: body.operation, kind: body.kind, status: 'saved', undoable: false } });
            return respond({ error: 'Unexpected write' }, 400);
        }
        if (endpoint.endsWith('/knowledge')) return respond({ version: 1, status: 'ready', revision: 'a'.repeat(64), items: [], hasMore: false,
            capabilities: { memory: true, skill: true, operations: ['create', 'undo', 'delete'], maxContentLength: 65536 },
            receipts: [
                { id: 'receipt-learning', requestId: 'learning-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'learning',
                    category: 'fact', preview: '记下端口 4321', undoable: true, itemId: 'b'.repeat(64), afterRevision: 'c'.repeat(64),
                    source: { sessionId: 'thread-one', entryId: 'entry-user' } },
                { id: 'receipt-agent', requestId: 'tool-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'agent',
                    category: 'procedure', preview: '用 pnpm 安装', undoable: true, itemId: 'd'.repeat(64), afterRevision: 'e'.repeat(64),
                    source: { sessionId: 'thread-one', entryId: 'entry-reply' } } ] });
        if (endpoint.endsWith('/learning')) return respond({ version: 1, status: 'ready', revision: 1, settings, jobs: [], recentRuns: [],
            health: { state: 'ok', missingModels: [], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
            capabilities: { installed: true, settingsWrite: true, actions: ['save'] } });
        if (endpoint === '/api/pi/status') return respond({ ok: true, agentProfiles: true, profileLearning: true,
            projectRoots: ['/tmp'], defaultProject: '/tmp/chat-knowledge-fixture', runtimeConfiguration: true });
        if (endpoint === '/api/pi/projects') return respond({ projects: [{ cwd: '/tmp/chat-knowledge-fixture', name: 'Fixture', sessionCount: 1 }], roots: ['/tmp'] });
        if (endpoint === '/api/pi/sessions') return respond({ sessions: [{ id: 'thread-one', cwd: '/tmp/chat-knowledge-fixture', name: 'Thread one', messageCount: 2,
            agentProfile: { id: 'profile-one', name: 'Research', enabled: true, available: true } }] });
        if (endpoint === '/api/pi/activity') return respond({ runtimes: [], replyNotices: [] });
        if (endpoint === '/api/pi/profiles') return respond({ version: 1, revision: 'p1', profiles: [{ id: 'profile-one', name: 'Research', enabled: true,
            memory: { enabled: true }, skills: { learnedEnabled: true } }] });
        if (endpoint === '/api/prompts' || endpoint.includes('/history')) return respond([]);
        return respond({});
    });
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
        const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
        if (cmd.type === 'open_session') return reply(ws, cmd, { session: { id: 'thread-one', cwd: '/tmp/chat-knowledge-fixture', name: 'Thread one',
            agentProfile: { id: 'profile-one', name: 'Research', enabled: true, available: true } }, state,
            messages: { messages: [{ role: 'user', content: 'Fixture question', timestamp: 1 },
                { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }] },
            stats: { totalMessages: 2, contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 } },
            models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        if (cmd.type === 'get_state') return reply(ws, cmd, state);
        if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [] });
        if (cmd.type === 'get_session_stats') return reply(ws, cmd, { totalMessages: 2 });
        if (cmd.type === 'get_entries') return reply(ws, cmd, { leafId: 'entry-reply', entries: [
            { id: 'entry-user', type: 'message', timestamp: 1, message: { role: 'user', content: 'Fixture question', timestamp: 1 } },
            { id: 'entry-reply', type: 'message', timestamp: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 } } ] });
        if (cmd.type === 'get_runtime_configuration') return reply(ws, cmd, { runtimeId: 'fixture-runtime', revision: 'cfg', agentProfile: {
            saved: { id: 'profile-one', name: 'Research', enabled: true, available: true }, loadedProfileId: 'profile-one', loadedConfirmed: true, matchesSavedProfile: true } });
        return reply(ws, cmd, {});
    }));
    await page.goto(base);
    await page.locator('#pi-input:not([disabled])').waitFor();
    const zh = locale.startsWith('zh');
    const say = (source, english) => zh ? source : english;
    await page.waitForFunction(() => document.querySelectorAll('#pi-transcript-content > .pi-memory-hint').length === 2);
    const placed = await page.locator('#pi-transcript-content > .pi-memory-hint').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, previous: node.previousElementSibling?.className })));
    assert.ok(placed[0].text.includes(say('已记住：记下端口 4321', 'Remembered: 记下端口 4321')), JSON.stringify(placed));
    assert.match(placed[0].previous || '', /pi-message user/);
    assert.ok(placed[1].text.includes(say('Agent 记下：用 pnpm 安装', 'Agent noted: 用 pnpm 安装')), JSON.stringify(placed));
    assert.match(placed[1].previous || '', /pi-message assistant/);
    assert.ok((await page.locator('#pi-chat-knowledge summary').innerText()).includes(say('本会话已记住 2 条', '2 entries remembered in this session')));
    await page.locator('#pi-transcript-content > .pi-memory-hint').first().locator('button').filter({ hasText: say('撤销', 'Undo') }).click();
    const end = Date.now() + 10000;
    while (Date.now() < end && !writes.some(write => write.body?.operation === 'undo')) await page.waitForTimeout(100);
    const undo = writes.filter(write => write.body?.operation === 'undo').at(-1);
    assert.ok(undo, `undo write missing: ${JSON.stringify(writes)}`);
    assert.equal(undo.body.receiptId, 'receipt-learning');
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(geometry.body <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ui chat ${width} ${locale}: ${JSON.stringify(geometry)}, writes=${writes.length}`);
    await context.close();
}

(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try {
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runFixture(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runChat(browser, base, width, locale);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
