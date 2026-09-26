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
    maxRunsPerDay: 4, maxTokensPerDay: 24000, periodicReviewMinutes: 0, consolidationInputChars: 12000,
    triggerPhrases: { correction: [], preference: [], temporary: [], ignore: [] } };
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-chat-knowledge.css">
<style>:root{--line:#ccc;--text-main:#222;--text-soft:#555;--text-muted:#777;--surface-1:#fff;--surface-2:#eee;--accent:#168a68}body{margin:0;font-family:Arial,sans-serif;background:#f8f8f8;color:#222}main{max-width:720px;padding:12px;margin:auto;min-width:0}button{cursor:pointer}section{min-width:0}#pi-transcript-content{display:grid;gap:6px;padding:8px 0}</style></head><body><main><section id="pi-profiles-memory"></section><div id="pi-chat-knowledge"></div><div id="pi-transcript-content"></div></main>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-chat-knowledge.js"></script>
<script>
window.current = { cwd: '/synthetic', sessionId: 'thread-one', profileId: 'profile-one', generation: 1 };
window.calls = []; window.events = [];
window.PiAgentProfilesUI = { revealKnowledge: (profileId, itemId, kind, sessionId) => window.calls.push({ reveal: [profileId, itemId, kind, sessionId] }),
    revealProjectMemory: (profileId, sessionId) => window.calls.push({ revealProject: [profileId, sessionId] }) };
window.addEventListener('workspace:open-settings', event => window.events.push(event.detail));
window.addEventListener('chat:reload-resources', event => window.events.push({ reload: event.detail }));
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
    transcript, anchors: () => window.fixtureEntries.entries.map(entry => [entry.id, entry.message.role, entry.message.timestamp, '']),
    scope: () => window.current });
window.manager.open('profile-one'); window.chat.update();
window.refreshAll = () => { window.manager.refresh(); window.chat.refresh(); };
</script></body></html>`));
app.get('/profiles-fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/pi-agent-profiles.css"><link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-chat-knowledge.css">
<style>:root{--line:#ccc;--text-main:#222;--text-soft:#555;--text-muted:#777;--surface-1:#fff;--surface-2:#eee;--accent:#168a68}body{margin:0;font-family:Arial,sans-serif;background:#f8f8f8;color:#222}main{max-width:720px;padding:12px;margin:auto;min-width:0}button{cursor:pointer}</style></head><body><main>
<div id="pi-profiles-panel"><h3></h3><div class="settings-panel-header"><p></p></div></div>
<div id="pi-profiles-content"></div><button id="pi-profiles-refresh" type="button"></button>
<dl id="pi-meta-profile-row"><dt></dt><dd id="pi-meta-profile"></dd></dl><div id="pi-session-profile"></div>
</main>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-agent-profiles.js"></script>
<script>
window.api = async (url, options) => {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { status: response.status, data });
    return data;
};
window.profiles = PiAgentProfiles.create({ apiFetch: window.api, currentCwd: () => '/synthetic' });
window.profiles.setEnabled(true, true); window.profiles.open();
</script></body></html>`));

async function runFixture(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
    const page = await context.newPage(), errors = [], dialogs = [], state = {
        usage: { memory: { chars: 5000, limit: 16000 }, user: { chars: 7000, limit: 8000 } },
        learningRevision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
        health: { state: 'needs-model', missingModels: ['memory-correction', 'memory-extraction'], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
        legacy: null, rejectMemoryFull: false, rejectBlocked: false, hintConflict: false, learningPuts: [],
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
        if (p.endsWith('/learning') && req.method() === 'PUT' && state.learningPuts) {
            const input = req.postDataJSON(); state.learningPuts.push(input);
            state.settings = { ...state.settings, ...input.changes }; state.learningRevision++;
            return fulfill(learning());
        }
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
            if (state.rejectBlocked) { state.rejectBlocked = false; return fulfill({ error: 'Content looks like a credential or secret and cannot be saved to memory or skills',
                code: 'content-blocked', details: { rule: 'github_token', kind: 'secret' } }, 400); }
            if (state.rejectMemoryFull) { state.rejectMemoryFull = false; return fulfill({ error: 'Memory is full', code: 'memory-full', details: { target: 'memory', chars: 16000, limit: 16000, needed: 16120 } }, 409); }
            return fulfill({ version: 1, status: 'saved', revision: hash('b'), receipt: { id: 'mutated', requestId: input.requestId,
                kind: input.kind, operation: input.operation, status: 'saved', undoable: false, source: { sessionId: 'thread-one', entryId: 'entry-user-1' } } });
        }
        if (p === '/api/pi/settings/models') return fulfill({ version: 1, providers: [{ id: 'fixture', name: 'Fixture provider' }],
            models: [{ provider: 'fixture', id: 'new-model', name: 'New model', available: true, input: ['text'] },
                { provider: 'fixture', id: 'batch-1:batch', name: 'Batch', available: true, input: ['text'] },
                { provider: 'fixture', id: 'vision-model', name: 'Vision model', available: true, input: ['image'] },
                { provider: 'fixture', id: 'down-model', name: 'Down model', available: false, input: ['text'] }] });
        if (p === '/api/pi/profiles' && req.method() === 'GET') return fulfill({ version: 1, revision: 'p1', cwd: '/synthetic',
            profiles: [{ id: 'profile-one', name: 'Research', enabled: true, memory: { enabled: true }, skills: { learnedEnabled: true } },
                { id: 'profile-two', name: 'Archive', enabled: false, memory: { enabled: true }, skills: { learnedEnabled: true } }] });
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
    // A scanned-out credential is explained without echoing the content, and the draft stays.
    state.rejectBlocked = true;
    await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.waitForFunction(expected => (document.querySelector('#pi-profiles-memory .pi-knowledge-status')?.textContent || '').includes(expected),
        say('内容疑似密钥或凭据', 'looks like a key or credential'));
    assert.equal(await page.locator('.pi-knowledge-editor textarea').inputValue(), 'A new fact');
    // Custom trigger phrases: one per line, saved as the only changed setting.
    await page.locator('.pi-learning-triggers summary').click();
    const triggerAreas = page.locator('.pi-learning-triggers textarea');
    assert.equal(await triggerAreas.count(), 4);
    await triggerAreas.first().fill(' Nein \n\nnope');
    await page.locator('.pi-learning-settings button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.pi-learning-triggers textarea')?.value === 'Nein\nnope');
    assert.deepEqual(state.learningPuts.at(-1).changes, { triggerPhrases: { correction: ['Nein', 'nope'], preference: [], temporary: [], ignore: [] } });
    await triggerAreas.nth(3).fill('x'.repeat(81));
    await page.locator('.pi-learning-settings button[type=submit]').click();
    assert.equal(state.learningPuts.length, 1, 'an over-long phrase is refused by form validation');
    await triggerAreas.nth(3).fill('');
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
    // Compat: without the injection endpoint the learning area keeps the old display and
    // the card reports that the injection content is unavailable.
    assert.equal(await page.locator('.pi-injection').count(), 0, 'absent injection keeps the plain display');
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('查看本会话注入内容', "View this session's injected content") }).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-injection-preview .pi-injection-error')));
    assert.ok((await text('.pi-injection-preview')).includes(say('注入内容不可用', 'Injected content is unavailable')), await text('.pi-injection-preview'));
    // The undoable:false skill hint keeps only its session-reload button; the two memory hints keep three buttons each.
    assert.equal(await page.locator('.pi-memory-hint button').count(), 7);
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
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { reveal: ['profile-one', hash('a'), 'memory', 'thread-one'] });
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

async function runProfiles(browser, base, width, locale) {
    // Identity list: health dots come from each profile's learning snapshot; absent health keeps the plain row.
    const context = await browser.newContext({ viewport: { width, height: 800 }, locale });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        if (p === '/api/pi/profiles') return fulfill({ version: 1, revision: 'p1', cwd: '/synthetic',
            profiles: [{ id: 'profile-one', name: 'Research', enabled: true, memory: { enabled: true }, skills: { learnedEnabled: true } },
                { id: 'profile-two', name: 'Archive', enabled: false, memory: { enabled: true }, skills: { learnedEnabled: true } }] });
        if (p.endsWith('/learning')) {
            const id = p.split('/')[4];
            if (id === 'profile-one') return fulfill({ version: 1, status: 'ready', revision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
                drafts: { pending: 2, capped: false },
                health: { state: 'needs-model', missingModels: ['memory-review'], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
                capabilities: { installed: true, settingsWrite: true, actions: ['save'] } });
            // Older backends return no health field at all.
            return fulfill({ version: 1, status: 'ready', revision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
                capabilities: { installed: true, settingsWrite: true, actions: ['save'] } });
        }
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill({ version: 1, status: 'ready', revision: 'a'.repeat(64),
            items: [{ id: 'b'.repeat(64), kind: 'skill', name: 'draft-skill', description: 'Draft', state: 'draft', scope: 'profile', revision: 'c'.repeat(64) },
                { id: 'd'.repeat(64), kind: 'skill', name: 'active-skill', description: 'Active', state: 'active', scope: 'profile', revision: 'e'.repeat(64) }],
            receipts: [], hasMore: false, capabilities: { memory: true, skill: true, operations: ['create', 'update', 'delete', 'undo'], maxContentLength: 65536 } });
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/profiles-fixture`);
    await page.locator('.pi-profile-row').first().waitFor();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-profile-row .pi-health-dot')));
    const zh = locale.startsWith('zh'), say = (source, english) => zh ? source : english;
    const warned = page.locator('.pi-profile-row[data-profile-id="profile-one"]');
    assert.ok((await warned.locator('.pi-health-dot').getAttribute('class')).includes('pi-health-warn'));
    assert.equal(await warned.locator('.pi-health-dot').getAttribute('title'), say('缺少学习模型配置', 'A learning model is not configured'));
    assert.ok((await warned.innerText()).includes(say('已启用 · 缺少学习模型配置', 'Enabled · A learning model is not configured')));
    const plain = page.locator('.pi-profile-row[data-profile-id="profile-two"]');
    assert.equal(await plain.locator('.pi-health-dot').count(), 0, 'absent health keeps the plain list row');
    assert.ok(!(await plain.innerText()).includes(say('缺少学习模型配置', 'A learning model is not configured')));
    // U2.4: draft skills awaiting review show on the identity row and clicking filters the skills.
    const badge = warned.locator('.pi-profile-drafts');
    assert.ok((await badge.innerText()).includes(say('2 个草稿技能待审', '2 draft skills awaiting review')), await badge.innerText());
    assert.equal(await plain.locator('.pi-profile-drafts').count(), 0, 'absent drafts keep the plain list row');
    await badge.click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-profiles-memory .pi-knowledge-row').length === 1);
    assert.ok((await page.locator('#pi-profiles-memory .pi-knowledge-row').first().innerText()).includes('draft-skill'));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ui profiles ${width} ${locale}`);
    await context.close();
}

async function runChat(browser, base, width, locale) {
    // Real chat shell: verifies the pi-chat.js wiring (context anchors and transcript placement).
    const context = await browser.newContext({ viewport: { width, height: 820 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [], reloads = [];
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
                    source: { sessionId: 'thread-one', entryId: 'entry-reply' } },
                { id: 'receipt-skill', requestId: 'tool-2', kind: 'skill', operation: 'create', status: 'saved', origin: 'learning',
                    preview: 'pnpm-install — 用 pnpm 安装依赖', undoable: false, itemId: 'f'.repeat(64), afterRevision: 'g'.repeat(64), activation: 'reload-required',
                    source: { sessionId: 'thread-one', entryId: 'entry-user' } } ] });
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
        if (cmd.type === 'reload_resources') { reloads.push(cmd.type); return reply(ws, cmd, { commands: [] }); }
        if (cmd.type === 'open_session') return reply(ws, cmd, { session: { id: 'thread-one', cwd: '/tmp/chat-knowledge-fixture', name: 'Thread one',
            agentProfile: { id: 'profile-one', name: 'Research', enabled: true, available: true } }, state,
            messages: { messages: [{ role: 'user', content: 'Fixture question', timestamp: 1 },
                { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }],
                webAnchors: [['entry-user', 'user', 1, ''], ['entry-reply', 'assistant', 2, '']] },
            stats: { totalMessages: 2, contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 } },
            models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        if (cmd.type === 'get_state') return reply(ws, cmd, state);
        if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [{ role: 'user', content: 'Fixture question', timestamp: 1 },
            { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }],
            webAnchors: [['entry-user', 'user', 1, ''], ['entry-reply', 'assistant', 2, '']] });
        if (cmd.type === 'get_session_stats') return reply(ws, cmd, { totalMessages: 2 });
        if (cmd.type === 'get_runtime_configuration') return reply(ws, cmd, { runtimeId: 'fixture-runtime', revision: 'cfg', agentProfile: {
            saved: { id: 'profile-one', name: 'Research', enabled: true, available: true }, loadedProfileId: 'profile-one', loadedConfirmed: true, matchesSavedProfile: true } });
        return reply(ws, cmd, {});
    }));
    await page.goto(base);
    await page.locator('#pi-input:not([disabled])').waitFor();
    const zh = locale.startsWith('zh');
    const say = (source, english) => zh ? source : english;
    await page.waitForFunction(() => document.querySelectorAll('#pi-transcript-content > .pi-memory-hint').length === 3);
    const placed = await page.locator('#pi-transcript-content > .pi-memory-hint').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, previous: node.previousElementSibling?.className })));
    // Both hints sit under the turn's user message (tool-call messages fold away), oldest first.
    assert.match(placed[0].previous || '', /pi-message user/);
    assert.match(placed[1].previous || '', /pi-memory-hint/);
    assert.ok(placed.some(row => row.text.includes(say('已记住：记下端口 4321', 'Remembered: 记下端口 4321'))), JSON.stringify(placed));
    assert.ok(placed.some(row => row.text.includes(say('Agent 记下：用 pnpm 安装', 'Agent noted: 用 pnpm 安装'))), JSON.stringify(placed));
    assert.ok((await page.locator('#pi-chat-knowledge summary').innerText()).includes(say('本会话已记住 3 条', '3 entries remembered in this session')));
    // U2.4: the learned-skill hint reloads the current chat session through pi-chat.js.
    await page.locator('#pi-transcript-content > .pi-memory-hint').filter({ hasText: 'pnpm-install' }).locator('button').filter({ hasText: say('重载会话', 'Reload the session') }).click();
    const reloadEnd = Date.now() + 10000;
    while (Date.now() < reloadEnd && !reloads.length) await page.waitForTimeout(100);
    assert.deepEqual(reloads, ['reload_resources'], 'session reload reaches the native runtime');
    await page.locator('#pi-transcript-content > .pi-memory-hint').filter({ hasText: say('已记住：记下端口 4321', 'Remembered: 记下端口 4321') }).locator('button').filter({ hasText: say('撤销', 'Undo') }).click();
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

// U2 wave-2 rehearsal (consolidation proposals, injection preview, project memory with a
// session id, skill reload and draft-skill counts). Contract fields do not exist on the
// backend yet: route interception mocks them and absent fields must keep the old display.
async function runWave2(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
    const page = await context.newPage(), errors = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
    const zh = locale.startsWith('zh'), say = (source, english) => zh ? source : english;
    const item = (letter, revision, content, category = 'fact') => ({ id: hash(letter), kind: 'memory', scope: 'profile', target: 'memory',
        category, state: 'active', revision: hash(revision), content, updatedAt: '2026-01-01' });
    const items = [item('a', '1', 'First source entry'), item('b', '2', 'Second source entry'), item('c', '3', 'Third source entry', 'preference'),
        { id: hash('p'), kind: 'memory', scope: 'project', target: 'project', projectKey: hash('k'), category: 'fact', state: 'active',
            revision: hash('r'), content: 'Project entry', updatedAt: '2026-01-01' },
        { id: hash('d'), kind: 'skill', name: 'draft-skill', description: 'Draft skill', state: 'draft', scope: 'profile', revision: hash('u'), updatedAt: '2026-01-01' },
        { id: hash('e'), kind: 'skill', name: 'active-skill', description: 'Active skill', state: 'active', scope: 'profile', revision: hash('v'), updatedAt: '2026-01-01' }];
    const receipts = [
        { id: 'receipt-hint', requestId: 'learning-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'learning',
            category: 'fact', preview: 'First source entry', undoable: true, itemId: hash('a'), afterRevision: hash('1'),
            source: { sessionId: 'thread-one', entryId: 'entry-user-1' } },
        { id: 'receipt-project-hint', requestId: 'learning-2', kind: 'memory', operation: 'create', status: 'saved', origin: 'agent',
            category: 'fact', preview: 'Project entry', undoable: true, itemId: hash('p'), afterRevision: hash('r'), scope: 'project', projectKey: hash('k'),
            source: { sessionId: 'thread-one', entryId: 'entry-user-2' } },
        { id: 'receipt-skill', requestId: 'tool-9', kind: 'skill', operation: 'create', status: 'saved', origin: 'learning', reason: 'review',
            preview: 'pnpm-install — 用 pnpm 安装依赖', undoable: false, itemId: hash('s'), afterRevision: hash('t'), activation: 'reload-required',
            source: { sessionId: 'thread-one', entryId: 'entry-reply-1' } } ];
    const proposal = { id: 'proposal-one', target: 'memory', createdAt: '2026-02-01', model: { provider: 'fixture', modelId: 'review-model' },
        groups: [
            { items: [{ itemId: hash('a'), itemRevision: hash('1'), preview: 'First source entry', category: 'fact' },
                { itemId: hash('b'), itemRevision: hash('2'), preview: 'Second source entry', category: 'fact' }],
                content: 'Merged source entry', category: 'procedure' },
            { items: [{ itemId: hash('c'), itemRevision: hash('9'), preview: 'Third source entry', category: 'preference' },
                { itemId: hash('b'), itemRevision: hash('2'), preview: 'Second source entry', category: 'fact' }],
                content: 'Stale merge', category: 'fact' } ] };
    const state = { learningRevision: 1, proposals: undefined, drafts: undefined, usage: { memory: { chars: 13600, limit: 16000 }, user: { chars: 100, limit: 8000 } },
        settings: structuredClone(settings), actions: ['save', 'propose-consolidation', 'dismiss-proposal'], consolidates: [], undos: [], mutations: [],
        health: { state: 'ok', missingModels: [], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } } };
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        const learning = () => ({ version: 1, status: 'ready', revision: state.learningRevision, settings: state.settings,
            jobs: [], recentRuns: [], proposals: state.proposals, drafts: state.drafts,
            health: state.health,
            capabilities: { installed: true, settingsWrite: true, reservedTokensPerRun: 6000, actions: state.actions,
                limits: { maxRunsPerDay: { min: 1, max: 20 }, maxTokensPerDay: { min: 6000, max: 200000 }, periodicReviewMinutes: { min: 0, max: 10800 } } } });
        const snapshot = () => ({ version: 1, status: 'ready', revision: hash('a'), items, receipts, hasMore: false,
            usage: state.usage, capabilities: { memory: true, skill: true, projectWrites: false, projectWritesBySession: true,
                operations: ['create', 'update', 'delete', 'undo', 'consolidate'], maxContentLength: 65536 } });
        if (p.endsWith('/knowledge/injection') && req.method() === 'GET')
            return fulfill(url.searchParams.get('sessionId')
                ? { version: 1, status: 'ready', block: 'PROFILE BLOCK\nPROJECT BLOCK', chars: 40, entries: 5,
                    profile: { chars: 21, entries: 3 }, project: { chars: 19, entries: 2 },
                    lastRead: { at: '2026-02-01', generation: 1, provided: true, chars: 30, entries: 4 }, truncated: false }
                : { version: 1, status: 'ready', block: 'PROFILE BLOCK TEXT', chars: 21, entries: 3,
                    profile: { chars: 21, entries: 3 }, project: null, lastRead: null });
        if (p.includes('/knowledge/items/') && req.method() === 'GET') {
            const row = items.find(entry => entry.id === p.split('/').pop());
            return fulfill(row ? { version: 1, status: 'ready', item: row } : { version: 1, status: 'missing' });
        }
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill(snapshot());
        if (p.endsWith('/learning') && req.method() === 'GET') return fulfill(learning());
        if (p.endsWith('/learning/actions')) {
            const input = req.postDataJSON();
            if (input.action === 'propose-consolidation') state.proposals = [structuredClone(proposal)];
            if (input.action === 'dismiss-proposal') state.proposals = (state.proposals || []).map(row => row.id === input.proposalId
                ? { ...row, groups: row.groups.filter((_, index) => index !== input.groupIndex) } : row).filter(row => row.groups.length);
            state.learningRevision++;
            return fulfill(learning());
        }
        if (p.endsWith('/knowledge/mutations')) {
            const input = req.postDataJSON();
            if (input.operation === 'consolidate') {
                state.consolidates.push(input);
                return fulfill({ version: 1, status: 'saved', revision: hash('5'), receipt: { id: 'receipt-consolidate', requestId: input.requestId,
                    operation: 'consolidate', kind: 'memory', status: 'saved', undoable: true, origin: 'manual', preview: input.content.slice(0, 160),
                    category: input.category, consolidated: [hash('n')], summary: 'consolidate memory' } });
            }
            if (input.operation === 'undo') { state.undos.push(input); return fulfill({ version: 1, status: 'saved', revision: hash('6'),
                receipt: { id: 'receipt-undo', requestId: input.requestId, operation: 'undo', kind: input.kind, status: 'saved', undoable: false, summary: 'undo memory' } }); }
            if (input.operation === 'update' || input.operation === 'delete') {
                state.mutations.push(input);
                return fulfill({ version: 1, status: 'saved', revision: hash('7'), receipt: { id: 'receipt-project-write', requestId: input.requestId,
                    operation: input.operation, kind: input.kind, status: 'saved', undoable: false, scope: 'project', summary: `${input.operation} memory` } });
            }
            return fulfill({ error: 'unexpected mutation' }, 400);
        }
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/fixture`);
    const text = selector => page.locator(selector).first().innerText();
    // Compat: without proposal fields nothing new renders next to the usage bars.
    await page.locator('.pi-usage-bars').waitFor();
    assert.equal(await page.locator('.pi-proposals').count(), 0, 'absent proposals keep the plain display');
    // U2.1: at 80% usage the consolidation button queues a propose-consolidation job.
    const propose = page.locator('.pi-usage-bars button').filter({ hasText: say('整理合并', 'Consolidate') });
    assert.equal(await propose.count(), 1);
    await propose.click();
    await page.waitForFunction(() => document.querySelectorAll('.pi-proposal-group').length === 2);
    const asked = await page.evaluate(() => window.calls.filter(call => call.body && call.body.action === 'propose-consolidation').at(-1));
    assert.equal(asked.url, '/api/pi/profiles/profile-one/learning/actions');
    assert.equal(asked.body.target, 'memory');
    assert.equal(typeof asked.body.requestId, 'string');
    // Each group lists its source entries and edits the merged body and category.
    const groups = page.locator('.pi-proposal-group');
    assert.ok((await groups.nth(0).innerText()).includes('First source entry'), 'source previews list on the left');
    await groups.nth(0).locator('textarea').fill('Merged source entry edited');
    await groups.nth(0).locator('select').selectOption('procedure');
    await groups.nth(0).locator('button').filter({ hasText: say('应用', 'Apply') }).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-knowledge-receipt')));
    const apply = state.consolidates.at(-1);
    assert.deepEqual(Object.keys(apply).sort(), ['category', 'content', 'expectedRevision', 'items', 'kind', 'operation', 'requestId', 'target']);
    assert.equal(apply.operation, 'consolidate'); assert.equal(apply.kind, 'memory'); assert.equal(apply.target, 'memory');
    assert.deepEqual(apply.items, [{ itemId: hash('a'), itemRevision: hash('1') }, { itemId: hash('b'), itemRevision: hash('2') }]);
    assert.equal(apply.expectedRevision, hash('a'));
    assert.equal(apply.content, 'Merged source entry edited');
    assert.equal(apply.category, 'procedure');
    // The applied group disappears; the receipt shows with an undo entry.
    await page.waitForFunction(() => document.querySelectorAll('.pi-proposal-group').length === 1);
    assert.ok((await text('.pi-knowledge-receipt')).includes(say('整理合并', 'Consolidate')), await text('.pi-knowledge-receipt'));
    await page.locator('.pi-knowledge-receipt button').filter({ hasText: say('撤销', 'Undo') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'undo'));
    const undo = state.undos.at(-1);
    assert.deepEqual(Object.keys(undo).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId']);
    assert.equal(undo.receiptId, 'receipt-consolidate');
    assert.equal(undo.expectedRevision, hash('a'));
    // A stale group is marked out of date and its apply button is disabled.
    const stale = groups.nth(0);
    assert.ok((await stale.innerText()).includes(say('已过期', 'Out of date')), await stale.innerText());
    assert.equal(await stale.locator('textarea').isDisabled(), true);
    assert.equal(await stale.locator('button').filter({ hasText: say('应用', 'Apply') }).isDisabled(), true);
    await stale.locator('button').filter({ hasText: say('忽略', 'Ignore') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.action === 'dismiss-proposal'));
    const dismissed = await page.evaluate(() => window.calls.filter(call => call.body && call.body.action === 'dismiss-proposal').at(-1));
    assert.equal(dismissed.body.proposalId, 'proposal-one');
    assert.equal(dismissed.body.groupIndex, 1);
    await page.waitForFunction(() => document.querySelectorAll('.pi-proposal-group').length === 0);
    // Below 80% the consolidation button is not offered.
    state.usage = { memory: { chars: 100, limit: 16000 }, user: { chars: 100, limit: 8000 } };
    await page.evaluate(() => window.refreshAll());
    await page.waitForFunction(() => document.querySelectorAll('.pi-usage-bars button').length === 0);
    // U2.2: the learning area shows the identity-level injection counts and the raw block.
    const injection = page.locator('.pi-injection');
    await injection.waitFor();
    assert.ok((await injection.innerText()).includes(say('身份记忆：3 条 / 21 字', 'Profile memory: 3 entries / 21 chars')), await injection.innerText());
    assert.ok((await injection.innerText()).includes(say('注入不代表模型一定遵守。', 'Injection does not prove the model will follow it.')));
    await injection.locator('summary').click();
    assert.match(await injection.locator('pre').innerText(), /PROFILE BLOCK TEXT/);
    // The chat card can show this session's injection including the project block and last read.
    await page.locator('#pi-chat-knowledge summary').click();
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('查看本会话注入内容', "View this session's injected content") }).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-injection-preview pre')));
    const preview = page.locator('.pi-injection-preview');
    assert.ok((await preview.innerText()).includes(say('项目记忆：2 条 / 19 字', 'Project memory: 2 entries / 19 chars')), await preview.innerText());
    assert.ok((await preview.innerText()).includes(say('上一轮已注入 4 条 / 30 字', 'The previous turn received 4 entries / 30 chars')), await preview.innerText());
    await preview.locator('summary').click();
    assert.match(await preview.locator('pre').innerText(), /PROJECT BLOCK/);
    const askedInjection = await page.evaluate(() => window.calls.filter(call => call.url.includes('/knowledge/injection')).at(-1));
    assert.ok(askedInjection.url.includes('sessionId=thread-one'), askedInjection.url);
    // U2.3: a project hint keeps only the edit entry, and "edit" opens the management page
    // with the session id; the card's project entry does the same.
    const projectHint = page.locator('#pi-transcript-content .pi-memory-hint').filter({ hasText: 'Project entry' });
    assert.equal(await projectHint.locator('button').count(), 1, 'project hints keep only the edit entry');
    await projectHint.locator('button').filter({ hasText: say('编辑', 'Edit') }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { reveal: ['profile-one', hash('p'), 'memory', 'thread-one'] });
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('本项目记忆', 'Project memory') }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { revealProject: ['profile-one', 'thread-one'] });
    // The management page unlocks project entries only with the session id.
    await page.evaluate(() => window.manager.open('profile-one', { sessionId: 'thread-one' }));
    assert.ok((await text('#pi-profiles-memory')).includes(say('项目记忆按当前会话目录核实。', 'Project memory is verified against the current session directory.')));
    await page.locator('.pi-profile-kinds button').first().click();
    const projectRow = page.locator('.pi-knowledge-row').filter({ hasText: 'Project entry' });
    await projectRow.click();
    await page.waitForFunction(() => (document.querySelector('.pi-knowledge-detail')?.textContent || '').includes('r'.repeat(64)));
    const detail = page.locator('.pi-knowledge-detail');
    assert.equal(await detail.locator('button').filter({ hasText: say('编辑', 'Edit') }).count(), 1, 'project entry is editable with a session id');
    assert.equal(await detail.locator('button').filter({ hasText: say('删除', 'Delete') }).count(), 1, 'project entry can be deleted with a session id');
    // Undo of the project receipt is offered from the receipt history with the session id.
    await detail.locator('details summary').filter({ hasText: say('近期版本回执', 'Recent version receipts') }).click();
    await detail.locator('.pi-knowledge-version button').filter({ hasText: say('撤销', 'Undo') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'undo'));
    const projectUndo = state.undos.at(-1);
    assert.deepEqual(Object.keys(projectUndo).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId', 'scope', 'sessionId']);
    assert.equal(projectUndo.scope, 'project'); assert.equal(projectUndo.sessionId, 'thread-one');
    // Writes carry scope:'project' with the session id and never a client-side projectKey.
    await projectRow.click();
    await detail.locator('button').filter({ hasText: say('编辑', 'Edit') }).click();
    await page.locator('.pi-knowledge-editor textarea').fill('Project entry updated');
    assert.ok((await text('.pi-knowledge-editor')).includes(say('当前目录范围（按当前会话核实）', 'Current directory scope (verified per session)')));
    assert.ok((await text('.pi-knowledge-editor')).includes(say('项目记忆按当前会话目录核实。', 'Project memory is verified against the current session directory.')));
    await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'update'));
    const update = state.mutations.at(-1);
    assert.deepEqual(Object.keys(update).sort(), ['category', 'content', 'expectedRevision', 'itemId', 'itemRevision', 'kind', 'operation', 'requestId', 'scope', 'sessionId']);
    assert.equal(update.scope, 'project'); assert.equal(update.sessionId, 'thread-one'); assert.equal(update.projectKey, undefined);
    assert.equal(update.itemId, hash('p')); assert.equal(update.itemRevision, hash('r'));
    await projectRow.click();
    await detail.locator('button').filter({ hasText: say('删除', 'Delete') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'delete'));
    const removal = state.mutations.at(-1);
    assert.deepEqual(Object.keys(removal).sort(), ['expectedRevision', 'itemId', 'itemRevision', 'kind', 'operation', 'requestId', 'scope', 'sessionId']);
    assert.equal(removal.scope, 'project'); assert.equal(removal.sessionId, 'thread-one');
    // Without the session id project memory stays read-only.
    await page.evaluate(() => { window.manager.close(); window.manager.open('profile-one'); });
    await page.locator('.pi-profile-kinds button').first().click();
    await projectRow.click();
    await page.waitForFunction(() => (document.querySelector('.pi-knowledge-detail')?.textContent || '').includes('r'.repeat(64)));
    assert.equal(await detail.locator('button').filter({ hasText: say('编辑', 'Edit') }).count(), 0, 'without a session id project entries stay read-only');
    assert.equal(await detail.locator('button').filter({ hasText: say('删除', 'Delete') }).count(), 0, 'without a session id project entries cannot be deleted');
    // U2.4: skill hints offer a session reload that is disabled while the chat is busy.
    await page.evaluate(() => { window.current = { ...window.current, busy: true }; window.chat.update(); });
    const skillHint = page.locator('#pi-transcript-content .pi-memory-hint').filter({ hasText: 'pnpm-install' });
    assert.ok((await skillHint.innerText()).includes(say('需重载会话后生效', 'Reload the session to apply')));
    assert.equal(await skillHint.locator('button').filter({ hasText: say('重载会话', 'Reload the session') }).isDisabled(), true);
    await page.evaluate(() => { window.current = { ...window.current, busy: false }; window.chat.update(); });
    await skillHint.locator('button').filter({ hasText: say('重载会话', 'Reload the session') }).click();
    assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { reload: { sessionId: 'thread-one' } });
    // U2.4: draft skills awaiting review are listed in the learning area and filter the skills.
    state.drafts = { pending: 2, capped: false };
    await page.evaluate(() => window.refreshAll());
    const draftsBadge = page.locator('.pi-learning-drafts button');
    await draftsBadge.waitFor();
    assert.ok((await draftsBadge.innerText()).includes(say('2 个草稿技能待审', '2 draft skills awaiting review')), await draftsBadge.innerText());
    await draftsBadge.click();
    await page.waitForFunction(() => document.querySelectorAll('.pi-knowledge-row').length === 1);
    assert.ok((await text('.pi-knowledge-list')).includes('draft-skill'), await text('.pi-knowledge-list'));
    assert.equal(await page.locator('.pi-knowledge-filter button[aria-pressed="true"]').count(), 1, 'the draft filter is active');
    // L2.3 health state renders with its reason instead of an untranslated id.
    state.health = { state: 'memory-full', missingModels: [], lastFailure: null, today: { runs: 1, maxRuns: 4, reservedTokens: 6000, maxTokens: 24000 } };
    await page.evaluate(() => window.refreshAll());
    await page.waitForFunction(() => ['记忆已满', 'Memory is full'].some(text => (document.querySelector('.pi-learning-health')?.textContent || '').includes(text)));
    assert.ok((await text('.pi-learning-health')).includes(say('记忆已满', 'Memory is full')), await text('.pi-learning-health'));
    // Mobile: 16px form controls, no horizontal overflow, no page errors.
    if (width < 900) {
        await page.waitForFunction(() => [...document.querySelectorAll('textarea,input,select')].every(el => parseFloat(getComputedStyle(el).fontSize) >= 16), undefined, { timeout: 5000 }).catch(() => {});
        const sizes = await page.evaluate(() => [...document.querySelectorAll('textarea,input,select')].map(el => [el.tagName.toLowerCase(), parseFloat(getComputedStyle(el).fontSize)]));
        assert.ok(sizes.every(entry => entry[1] >= 16), `mobile form font sizes: ${JSON.stringify(sizes)}`);
    }
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(geometry.body <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS wave2 ui ${width} ${locale}: ${JSON.stringify(geometry)}`);
    await context.close();
}

(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try {
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runFixture(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runProfiles(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runChat(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runWave2(browser, base, width, locale);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
